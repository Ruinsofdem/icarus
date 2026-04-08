require('dotenv').config();
const cron = require('node-cron');
const Airtable = require('airtable');
const twilio = require('twilio');
const { google } = require('googleapis');
const fs = require('fs');

const AIRTABLE_BASE_ID = 'app6B6clOJP8i0J4Q';
const AIRTABLE_TABLE_ID = 'tblhqZra5YY2XCqyU';
const LEAD_STALE_HOURS = 48;
const EMAIL_STALE_HOURS = 24;
const TOKEN_FILE = 'gmail_token.json';

let airtableBase = null;
let twilioClient = null;
let scanResults = { lastRun: null, anomalies: [], ok: true };

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  if (!process.env.AIRTABLE_API_KEY) {
    console.warn('[Anomaly] AIRTABLE_API_KEY missing — Airtable checks disabled.');
  } else {
    airtableBase = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
  }

  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    console.warn('[Anomaly] Twilio env missing — WhatsApp alerts disabled.');
  } else {
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }

  // Every 30 minutes
  cron.schedule('*/30 * * * *', () => {
    runScan().catch(err => console.error('[Anomaly] Scan error:', err.message));
  });

  console.log('[Anomaly] Anomaly scanner ready (every 30m).');
}

// ─── WhatsApp alert ───────────────────────────────────────────────────────────

async function sendAlert(message) {
  if (!twilioClient) {
    console.warn('[Anomaly] WhatsApp alert skipped — Twilio not configured.');
    return;
  }
  await twilioClient.messages.create({
    from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
    to: `whatsapp:${process.env.MY_WHATSAPP_NUMBER}`,
    body: message,
  });
}

// ─── Airtable: stale leads ─────────────────────────────────────────────────────

async function checkStaleLeads() {
  if (!airtableBase) return [];

  const cutoffMs = Date.now() - LEAD_STALE_HOURS * 60 * 60 * 1000;
  const anomalies = [];

  const records = await new Promise((resolve, reject) => {
    const all = [];
    airtableBase(AIRTABLE_TABLE_ID)
      .select({ maxRecords: 100 })
      .eachPage(
        (recs, next) => { all.push(...recs); next(); },
        (err) => (err ? reject(err) : resolve(all))
      );
  });

  for (const rec of records) {
    // Try common field names for last activity
    const lastActivity = rec.get('Last Activity') || rec.get('Last Modified') || rec.get('Updated');
    const name = rec.get('Name') || rec.get('Lead Name') || rec.get('Contact') || rec.id;

    if (lastActivity) {
      const ts = new Date(lastActivity).getTime();
      if (!isNaN(ts) && ts < cutoffMs) {
        const hoursAgo = Math.round((Date.now() - ts) / (1000 * 60 * 60));
        anomalies.push({
          type: 'stale_lead',
          id: rec.id,
          name: String(name),
          lastActivity,
          message: `⚠️ STALE LEAD: "${name}" — no activity for ${hoursAgo}h (last: ${lastActivity})`,
        });
      }
    }
  }

  return anomalies;
}

// ─── Gmail: unanswered threads > 24h ──────────────────────────────────────────

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
  } else {
    return null;
  }
  return auth;
}

async function checkUnansweredEmails() {
  const auth = getGmailAuth();
  if (!auth) {
    console.warn('[Anomaly] Gmail not configured — email anomaly check skipped.');
    return [];
  }

  const gmail = google.gmail({ version: 'v1', auth });
  const anomalies = [];

  // Fetch inbox threads older than 24h not sent by us
  const listRes = await gmail.users.threads.list({
    userId: 'me',
    q: `in:inbox -from:me older_than:${EMAIL_STALE_HOURS}h`,
    maxResults: 20,
  });

  const threads = listRes.data.threads || [];
  if (!threads.length) return [];

  for (const thread of threads) {
    try {
      const detail = await gmail.users.threads.get({
        userId: 'me',
        id: thread.id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });

      const msgs = detail.data.messages || [];
      if (!msgs.length) continue;

      // Check if last message in thread is NOT from us
      const lastMsg = msgs[msgs.length - 1];
      const headers = lastMsg.payload?.headers || [];
      const from = headers.find(h => h.name === 'From')?.value || '';
      const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
      const date = headers.find(h => h.name === 'Date')?.value || '';

      const myEmail = process.env.GMAIL_ADDRESS || '';
      const fromMe = myEmail && from.includes(myEmail);

      if (!fromMe) {
        const sentAt = date ? new Date(date).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }) : 'unknown time';
        anomalies.push({
          type: 'unanswered_email',
          threadId: thread.id,
          from,
          subject,
          date,
          message: `📧 UNANSWERED EMAIL: "${subject}" from ${from} — received ${sentAt} (no reply in >${EMAIL_STALE_HOURS}h)`,
        });
      }
    } catch (err) {
      console.error(`[Anomaly] Thread check failed for ${thread.id}:`, err.message);
    }
  }

  return anomalies;
}

// ─── Full scan ────────────────────────────────────────────────────────────────

async function runScan() {
  const anomalies = [];

  const [leads, emails] = await Promise.allSettled([checkStaleLeads(), checkUnansweredEmails()]);

  if (leads.status === 'fulfilled') anomalies.push(...leads.value);
  else console.error('[Anomaly] Lead check failed:', leads.reason?.message);

  if (emails.status === 'fulfilled') anomalies.push(...emails.value);
  else console.error('[Anomaly] Email check failed:', emails.reason?.message);

  scanResults = { lastRun: new Date().toISOString(), anomalies, ok: true };

  for (const anomaly of anomalies) {
    try {
      await sendAlert(anomaly.message);
    } catch (err) {
      console.error('[Anomaly] Alert failed:', err.message);
    }
  }

  return anomalies;
}

// ─── HTTP handler ─────────────────────────────────────────────────────────────

function handler(router) {
  router.get('/anomaly/status', (_req, res) => {
    res.json(scanResults);
  });

  router.post('/anomaly/scan', async (req, res) => {
    try {
      const anomalies = await runScan();
      res.json({ ok: true, count: anomalies.length, anomalies });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { init, handler, runScan, checkStaleLeads, checkUnansweredEmails };
