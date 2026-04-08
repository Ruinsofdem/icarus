'use strict';

/**
 * Autonomous Outreach Module
 *
 * Polls Airtable every 15 minutes for prospects eligible for email sequences.
 * Sends Touch 1, Touch 2 (4 days), Touch 3 (9 days) via Gmail.
 * Detects replies and stops sequences on response.
 * Sends WhatsApp notifications on each send and on reply.
 *
 * Airtable: base app6B6clOJP8i0J4Q, table tblhqZra5YY2XCqyU
 *
 * Required env vars:
 *   AIRTABLE_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
 *   GMAIL_REFRESH_TOKEN (or gmail_token.json), TWILIO_ACCOUNT_SID,
 *   TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM, TWILIO_WHATSAPP_TO
 */

const cron    = require('node-cron');
const { google } = require('googleapis');
const fs      = require('fs');
const twilio  = require('twilio');

const AIRTABLE_BASE  = 'app6B6clOJP8i0J4Q';
const AIRTABLE_TABLE = 'tblhqZra5YY2XCqyU';
const AIRTABLE_URL   = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`;
const FROM_EMAIL     = 'icarus.openclaw@gmail.com';

const TOUCH_DELAYS = {
  touch2: 4, // days after Sequence_Started
  touch3: 9,
};

// Track in-progress sends to avoid double-sends during overlapping cron ticks
const sending = new Set();

// ─── WhatsApp helper ──────────────────────────────────────────────────────────

function sendWhatsApp(body) {
  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    return client.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`,
      to:   `whatsapp:${process.env.TWILIO_WHATSAPP_TO}`,
      body,
    });
  } catch (err) {
    console.error('[Outreach] WhatsApp send failed:', err.message);
  }
}

// ─── Gmail helper ─────────────────────────────────────────────────────────────

const TOKEN_FILE = 'gmail_token.json';

function getGmailAuth() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  if (process.env.GMAIL_REFRESH_TOKEN) {
    auth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  } else if (fs.existsSync(TOKEN_FILE)) {
    auth.setCredentials(JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')));
  }
  return auth;
}

async function sendGmail(to, subject, body) {
  const auth  = getGmailAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const raw = Buffer.from(
    `From: ${FROM_EMAIL}\r\nTo: ${to}\r\nSubject: ${subject}\r\n\r\n${body}`
  ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });

  return res.data.id; // message ID for reply tracking
}

/**
 * Search Gmail sent folder for messages matching a subject sent to a given email.
 * Returns the thread ID if found.
 */
async function findSentThreadId(to, subject) {
  const auth  = getGmailAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const safeSubject = subject.replace(/"/g, '\\"');
  const res = await gmail.users.messages.list({
    userId: 'me',
    q:      `in:sent to:${to} subject:"${safeSubject}"`,
    maxResults: 1,
  });

  const messages = res.data.messages || [];
  if (!messages.length) return null;

  const msg = await gmail.users.messages.get({ userId: 'me', id: messages[0].id, format: 'metadata' });
  return msg.data.threadId || null;
}

/**
 * Check if any message in the thread was NOT sent by us (i.e. a reply).
 */
async function hasReplyInThread(threadId) {
  const auth  = getGmailAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const thread = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'metadata' });
  const messages = thread.data.messages || [];

  for (const msg of messages) {
    const fromHeader = msg.payload?.headers?.find(h => h.name === 'From');
    if (fromHeader && !fromHeader.value.includes(FROM_EMAIL)) {
      return { replied: true, messageId: msg.id, date: new Date(parseInt(msg.internalDate)).toISOString() };
    }
  }
  return { replied: false };
}

// ─── Airtable helpers ─────────────────────────────────────────────────────────

function airtableHeaders() {
  return {
    Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function fetchProspects() {
  const params = new URLSearchParams({
    filterByFormula: `AND({ICP_Score} >= 12, {Status} = "Active")`,
    pageSize: '100',
  });

  const res = await fetch(`${AIRTABLE_URL}?${params}`, { headers: airtableHeaders() });
  if (!res.ok) throw new Error(`Airtable fetch failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.records || [];
}

async function updateRecord(recordId, fields) {
  const res = await fetch(`${AIRTABLE_URL}/${recordId}`, {
    method:  'PATCH',
    headers: airtableHeaders(),
    body:    JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`Airtable update failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ─── Sequence logic ───────────────────────────────────────────────────────────

function daysSince(isoDate) {
  return (Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * Process a single prospect record through the outreach sequence.
 */
async function processProspect(record) {
  const { id, fields } = record;
  if (sending.has(id)) return;
  sending.add(id);

  try {
    const email   = fields.Email || fields.email;
    const name    = fields.Name  || fields.name || email;

    if (!email) {
      console.warn(`[Outreach] Record ${id} has no email — skipping.`);
      return;
    }

    // ── Touch 1: initial send ────────────────────────────────────────────────
    if (!fields.Sequence_Started) {
      const subject = fields.T1_Subject;
      const body    = fields.T1_Body;

      if (!subject || !body) {
        console.warn(`[Outreach] Record ${id} missing T1 content — skipping.`);
        return;
      }

      console.log(`[Outreach] Sending Touch 1 to ${email}`);
      await sendGmail(email, subject, body);
      await updateRecord(id, { Sequence_Started: new Date().toISOString() });
      sendWhatsApp(`📧 Touch 1 sent to ${name} (${email})`).catch(() => {});
      return;
    }

    const started = fields.Sequence_Started;

    // ── Check for reply ──────────────────────────────────────────────────────
    if (!fields.Replied_At) {
      try {
        const threadId = await findSentThreadId(email, fields.T1_Subject || '');
        if (threadId) {
          const replyCheck = await hasReplyInThread(threadId);
          if (replyCheck.replied) {
            const repliedAfterDays = Math.round(daysSince(started) * 10) / 10;
            console.log(`[Outreach] Reply detected from ${email}`);
            await updateRecord(id, {
              Replied_At:    replyCheck.date,
              Replied_After: String(repliedAfterDays),
            });
            sendWhatsApp(`💬 Reply from ${name} (${email}) — ${repliedAfterDays}d after sequence start`).catch(() => {});
            return; // stop sequence
          }
        }
      } catch (err) {
        console.error(`[Outreach] Reply check error for ${id}:`, err.message);
      }
    } else {
      // Already replied — don't send further touches
      return;
    }

    // ── Touch 2: 4 days ──────────────────────────────────────────────────────
    if (!fields.Sequence_T2_Sent && daysSince(started) >= TOUCH_DELAYS.touch2) {
      const subject = fields.T3_Subject; // T3 = 2nd email touch
      const body    = fields.T3_Body;

      if (subject && body) {
        console.log(`[Outreach] Sending Touch 2 to ${email}`);
        await sendGmail(email, subject, body);
        await updateRecord(id, { Sequence_T2_Sent: new Date().toISOString() });
        sendWhatsApp(`📧 Touch 2 sent to ${name} (${email})`).catch(() => {});
      }
      return;
    }

    // ── Touch 3: 9 days ──────────────────────────────────────────────────────
    if (!fields.Sequence_T3_Sent && daysSince(started) >= TOUCH_DELAYS.touch3) {
      const subject = fields.T5_Subject; // T5 = 3rd email touch
      const body    = fields.T5_Body;

      if (subject && body) {
        console.log(`[Outreach] Sending Touch 3 to ${email}`);
        await sendGmail(email, subject, body);
        await updateRecord(id, { Sequence_T3_Sent: new Date().toISOString() });
        sendWhatsApp(`📧 Touch 3 (final) sent to ${name} (${email})`).catch(() => {});
      }
    }
  } catch (err) {
    console.error(`[Outreach] Error processing record ${id}:`, err.message);
  } finally {
    sending.delete(id);
  }
}

async function runOutreachCycle() {
  console.log('[Outreach] Running outreach cycle...');
  try {
    const prospects = await fetchProspects();
    console.log(`[Outreach] ${prospects.length} eligible prospects found.`);
    // Process sequentially to avoid Gmail rate limits
    for (const record of prospects) {
      await processProspect(record);
    }
  } catch (err) {
    console.error('[Outreach] Cycle error:', err.message);
  }
}

// ─── Status state ─────────────────────────────────────────────────────────────

const status = {
  last_run:        null,
  last_run_status: null,
  records_processed: 0,
};

// ─── Express handler ──────────────────────────────────────────────────────────

function handler(app) {
  app.get('/outreach/status', (_req, res) => {
    res.json({
      ...status,
      now: new Date().toISOString(),
    });
  });

  app.post('/outreach/trigger', async (req, res) => {
    res.json({ ok: true, message: 'Outreach cycle triggered.' });
    // Run async after response
    try {
      await runOutreachCycle();
      status.last_run        = new Date().toISOString();
      status.last_run_status = 'ok';
    } catch (err) {
      status.last_run_status = `error: ${err.message}`;
    }
  });
}

// ─── init ─────────────────────────────────────────────────────────────────────

function init() {
  // Every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    try {
      await runOutreachCycle();
      status.last_run        = new Date().toISOString();
      status.last_run_status = 'ok';
    } catch (err) {
      status.last_run_status = `error: ${err.message}`;
    }
  });

  console.log('[Outreach] Module ready — polling Airtable every 15 minutes.');
}

module.exports = {
  init,
  handler,
  runOutreachCycle,
  processProspect,
  daysSince,
  // Export for testing
  _fetchProspects: fetchProspects,
  _updateRecord:   updateRecord,
};
