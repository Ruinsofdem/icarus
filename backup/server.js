const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const { getAuthUrl, saveToken, readEmails, sendEmail } = require('./gmail');
const { checkCalendar } = require('./calendar');
const { manageCrm } = require('./crm');
const { manageNotion } = require('./notion');
const {
  MAX_TOOL_ITERATIONS,
  SYSTEM_PROMPT_SERVER,
  validateEnv,
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
    name: 'manage_notion',
    description: 'Interact with Notion workspace. Log actions to operations log, create and update workflow tasks, log weekly performance metrics, create and search SOPs. Use this after every significant action to keep the Notion workspace updated.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['setup', 'log', 'create_task', 'update_task', 'log_performance', 'create_sop', 'search_sops', 'create_client_profile'],
          description: 'The Notion action to perform'
        },
        params: {
          type: 'object',
          description: 'Parameters for the action. For log: {action, outcome, status, category, nextStep, apiCostImpact}. For create_task: {task, status, priority, owner, dueDate, notes}. For update_task: {pageId, status, notes}. For log_performance: {week, tasksCompleted, tasksFailed, verificationsent, verificationsApproved, capabilityGapsIdentified, capabilityGapsResolved, apiCallsMade, prospectsResearched, dealsCreated, notes, overallScore}. For create_sop: {title, category, content, version}. For search_sops: {query}. For create_client_profile: {name, summary, businessType, size, website, contactInfo, painPoints, fitScore, fitReason, researchNotes}'
        }
      },
      required: ['action']
    }
  }
];

async function executeTool(name, input) {
  if (name === 'read_emails')    return await readEmails(input.max_results || 5);
  if (name === 'send_email')     return await sendEmail(input.to, input.subject, input.body);
  if (name === 'check_calendar') return await checkCalendar(input.action, input.params || {});
  if (name === 'manage_crm')     return await manageCrm(input.action, input.params || {});
  if (name === 'manage_notion')  return await manageNotion(input.action, input.params || {});
  return `Unknown tool: ${name}`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true }));

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

app.post('/whatsapp', validateTwilioSignature, async (req, res) => {
  const sender = req.body.From;
  const incomingMsg = req.body.Body;

  if (isRateLimited(sender)) {
    res.type('text/xml').send(twimlResponse('Slow down — rate limit reached. Try again in a minute.'));
    return;
  }

  const messages = loadMemory();
  messages.push({ role: 'user', content: incomingMsg });

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
app.listen(PORT, () => {
  console.log(`⚡ Icarus WhatsApp server running on port ${PORT}`);
});
