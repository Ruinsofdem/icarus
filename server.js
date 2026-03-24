const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const { getAuthUrl, saveToken, readEmails, sendEmail } = require('./gmail');
const { shellExec, resolveApproval } = require('./tools');
const { checkCalendar } = require('./calendar');
const { manageCrm } = require('./crm');
const {
  MAX_TOOL_ITERATIONS,
  SYSTEM_PROMPT_SERVER,
  validateEnv,
  validateMessages,
  loadMemory,
  saveMemory,
  createMessage,
} = require('./config');

validateEnv([
  'TWILIO_AUTH_TOKEN',
  'TWILIO_WHATSAPP_NUMBER',
  'MY_WHATSAPP_NUMBER',
]);

const app = express();
app.set('trust proxy', 1); // required for correct URL reconstruction behind ngrok/proxy
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Rate limiter (per sender phone number) ───────────────────────────────────

const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 10;        // messages per window
const senderCounts = new Map();

function isRateLimited(sender) {
  const now = Date.now();
  const entry = senderCounts.get(sender) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW;
  }
  entry.count++;
  senderCounts.set(sender, entry);
  return entry.count > RATE_LIMIT_MAX;
}

// ─── Twilio signature validation ──────────────────────────────────────────────

function validateTwilioSignature(req, res, next) {
  const signature = req.headers['x-twilio-signature'];
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  if (!signature || !twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, req.body)) {
    return res.status(403).send('Forbidden');
  }
  next();
}

// ─── XML helper ───────────────────────────────────────────────────────────────

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function twimlResponse(text) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(text)}</Message>\n</Response>`;
}

// ─── Tools ────────────────────────────────────────────────────────────────────

const tools = [
  {
    name: 'read_emails',
    description: 'Read unread emails from the Icarus Gmail inbox.',
    input_schema: {
      type: 'object',
      properties: {
        max_results: { type: 'number', description: 'Number of emails to retrieve. Default 5.' }
      },
      required: []
    }
  },
  {
    name: 'send_email',
    description: 'Send an email from the Icarus Gmail account.',
    input_schema: {
      type: 'object',
      properties: {
        to:      { type: 'string', description: 'Recipient email address.' },
        subject: { type: 'string', description: 'Email subject.' },
        body:    { type: 'string', description: 'Email body.' }
      },
      required: ['to', 'subject', 'body']
    }
  },
  {
    name: 'check_calendar',
    description: 'Manage Google Calendar: list upcoming events, check availability for scheduling, or create new events for prospect calls and client meetings.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_events', 'check_availability', 'create_event'],
          description: 'list_events: show events in a date range. check_availability: find free slots on a day. create_event: add a new calendar event.'
        },
        params: {
          type: 'object',
          description: 'Action parameters. list_events: { start_date, end_date?, max_results? }. check_availability: { date, duration_minutes? }. create_event: { title, start_time, end_time, description?, location? }.'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'manage_crm',
    description: 'Manage the HubSpot CRM pipeline: search contacts, create contacts, view deals, create deals, and log activity notes.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search_contacts', 'create_contact', 'get_deals', 'create_deal', 'log_note'],
          description: 'search_contacts: find contacts by name/email/company. create_contact: add a new contact. get_deals: list pipeline deals (optionally filter by stage). create_deal: add a new deal. log_note: log an activity note against a contact or deal.'
        },
        params: {
          type: 'object',
          description: 'Action parameters. search_contacts: { query }. create_contact: { firstname, lastname, email, company, phone }. get_deals: { stage? }. create_deal: { dealname, stage?, amount?, closedate?, contact_id? }. log_note: { body, contact_id?, deal_id? }.'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'shell_exec',
    description: 'Execute a shell command on the local machine with 6 security layers: (1) Hard blocklist permanently blocks destructive patterns (rm -rf, sudo rm, mkfs, dd if=, chmod 777, fork bomb, curl|bash, wget|sh). (2) Tier 2 commands (sudo, kill, pkill, npm install, pip install, crontab, chmod, chown, launchctl) require WhatsApp approval via Twilio before executing — approval times out after TWILIO_APPROVAL_TIMEOUT_MS (default 60s). (3) All processes are killed after 30 seconds. (4) Working directory is locked to /Users/nicholastsakonas/openclaw — cd outside this path is blocked. (5) Every execution is audit-logged to icarus-log.md with risk score 1-10, label (1-3=Low, 4-6=Medium, 7-8=High, 9-10=Critical), and factor breakdown; a WhatsApp alert fires for score >= 7. (6) stdout+stderr are capped at 2000 characters. NEVER use this to modify source files.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute.' },
        reason:  { type: 'string', description: 'Why this command is being run — used in audit logs and approval messages.' }
      },
      required: ['command', 'reason']
    }
  }
];

async function executeTool(name, input) {
  if (name === 'read_emails')    return await readEmails(input.max_results || 5);
  if (name === 'send_email')     return await sendEmail(input.to, input.subject, input.body);
  if (name === 'check_calendar') return await checkCalendar(input.action, input.params || {});
  if (name === 'manage_crm')     return await manageCrm(input.action, input.params || {});
  if (name === 'shell_exec')     return await shellExec(input.command, input.reason || '');
  return `Unknown tool: ${name}`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/auth/status', (_req, res) => {
  const fs = require('fs');
  const tokenPath = 'gmail_token.json';
  if (!fs.existsSync(tokenPath)) {
    return res.json({ authenticated: false, message: 'No token found. Visit /auth to authenticate.' });
  }
  try {
    const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    const hasAccess  = !!token.access_token;
    const hasRefresh = !!token.refresh_token;
    const expiry     = token.expiry_date ? new Date(token.expiry_date).toISOString() : 'unknown';
    const expired    = token.expiry_date ? Date.now() > token.expiry_date : null;
    const scopes     = (token.scope || '').split(' ').filter(Boolean);
    const hasCalendar = scopes.some(s => s.includes('calendar'));
    const hasGmail    = scopes.some(s => s.includes('gmail'));
    return res.json({
      authenticated: hasAccess || hasRefresh,
      hasRefreshToken: hasRefresh,
      expiry,
      expired,
      hasCalendarScope: hasCalendar,
      hasGmailScope: hasGmail,
      scopes,
      action: (!hasCalendar || !hasGmail) ? 'Missing scopes — visit /auth to re-authenticate' : (expired ? 'Token expired — visit /auth to re-authenticate' : 'OK'),
    });
  } catch {
    return res.json({ authenticated: false, message: 'Token file is corrupt. Visit /auth to re-authenticate.' });
  }
});

app.get('/auth', async (_req, res) => {
  const url = await getAuthUrl();
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    await saveToken(req.query.code);
    res.send('Icarus Gmail + Calendar access granted. You can close this tab.');
  } catch (error) {
    console.error('Auth callback error:', error.message);
    res.status(500).send('Auth failed: ' + error.message);
  }
});

// ─── Web chat endpoint ────────────────────────────────────────────────────────

app.post('/chat', async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required.' });
  }

  let messages = loadMemory();
  messages.push({ role: 'user', content: message.trim() });
  messages = validateMessages(messages);

  try {
    let response = await createMessage(messages, { tools, systemPrompt: SYSTEM_PROMPT_SERVER });
    let iterations = 0;

    while (response.stop_reason === 'tool_use') {
      if (++iterations > MAX_TOOL_ITERATIONS) {
        console.error('[Icarus] Web chat: max tool iterations reached.');
        break;
      }

      messages.push({ role: 'assistant', content: response.content });

      const toolResults = await Promise.all(
        response.content
          .filter(b => b.type === 'tool_use')
          .map(async (block) => ({
            type: 'tool_result',
            tool_use_id: block.id,
            content: await executeTool(block.name, block.input),
          }))
      );

      messages.push({ role: 'user', content: toolResults });
      messages = validateMessages(messages);

      response = await createMessage(messages, { tools, systemPrompt: SYSTEM_PROMPT_SERVER });
    }

    const reply = response.content.find(b => b.type === 'text')?.text || 'No response.';
    messages.push({ role: 'assistant', content: reply });
    await saveMemory(messages);

    res.json({ reply });

  } catch (error) {
    console.error('[Icarus] Web chat error:', error.message);
    res.status(500).json({ error: 'Icarus encountered an error. Try again.' });
  }
});

// ─── WhatsApp webhook ─────────────────────────────────────────────────────────

app.post('/whatsapp', validateTwilioSignature, async (req, res) => {
  const sender = req.body.From;
  const incomingMsg = req.body.Body;

  if (isRateLimited(sender)) {
    res.type('text/xml').send(twimlResponse('Slow down — rate limit reached. Try again in a minute.'));
    return;
  }

  // ─── Approval intercept ────────────────────────────────────────────────────
  const decision = incomingMsg.trim().toUpperCase();
  if (decision === 'YES' || decision === 'NO') {
    const fs = require('fs');
    const path = require('path');
    const APPROVALS_DIR = '/tmp/icarus_approvals';
    try {
      const files = fs.existsSync(APPROVALS_DIR)
        ? fs.readdirSync(APPROVALS_DIR)
            .map(f => ({ name: f, mtime: fs.statSync(path.join(APPROVALS_DIR, f)).mtimeMs }))
            .filter(f => fs.readFileSync(path.join(APPROVALS_DIR, f.name), 'utf8').trim() === 'PENDING')
            .sort((a, b) => b.mtime - a.mtime)
        : [];

      if (files.length > 0) {
        resolveApproval(files[0].name, decision);
        const replyText = decision === 'YES' ? '✅ Approved.' : '❌ Cancelled.';
        res.type('text/xml').send(twimlResponse(replyText));
        return;
      }
    } catch (err) {
      console.error('[Icarus] Approval intercept error:', err.message);
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  let messages = loadMemory();
  messages.push({ role: 'user', content: incomingMsg });

  // Strip orphaned tool_use/tool_result blocks before the first API call
  messages = validateMessages(messages);

  try {
    let response = await createMessage(messages, { tools, systemPrompt: SYSTEM_PROMPT_SERVER });
    let iterations = 0;

    while (response.stop_reason === 'tool_use') {
      if (++iterations > MAX_TOOL_ITERATIONS) {
        console.error('[Icarus] Max tool iterations reached — breaking loop.');
        break;
      }

      messages.push({ role: 'assistant', content: response.content });

      const toolResults = await Promise.all(
        response.content
          .filter(b => b.type === 'tool_use')
          .map(async (block) => ({
            type: 'tool_result',
            tool_use_id: block.id,
            content: await executeTool(block.name, block.input),
          }))
      );

      messages.push({ role: 'user', content: toolResults });

      // Validate after each tool round to prevent accumulated orphans
      messages = validateMessages(messages);

      response = await createMessage(messages, { tools, systemPrompt: SYSTEM_PROMPT_SERVER });
    }

    const reply = response.content.find(b => b.type === 'text')?.text || 'No response.';
    messages.push({ role: 'assistant', content: reply });
    await saveMemory(messages);

    res.type('text/xml').send(twimlResponse(reply));

  } catch (error) {
    console.error('[Icarus] WhatsApp handler error:', error.message);
    res.type('text/xml').send(twimlResponse('Icarus encountered an error. Try again.'));
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`⚡ Icarus WhatsApp server running on port ${PORT}`);
  const fs = require('fs');
  if (process.env.GMAIL_REFRESH_TOKEN) {
    console.log('[Icarus] Gmail auth ready — using GMAIL_REFRESH_TOKEN env var.');
  } else if (fs.existsSync('gmail_token.json')) {
    console.log('[Icarus] Gmail token found — Gmail/Calendar tools ready.');
  } else {
    console.warn('[Icarus] WARNING: No Gmail auth found (no GMAIL_REFRESH_TOKEN env var and no gmail_token.json). Visit /auth to authenticate.');
  }
});
