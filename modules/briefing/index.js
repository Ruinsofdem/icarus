'use strict';

const axios = require('axios');
const twilio = require('twilio');
const cron = require('node-cron');

const { readEmails } = require('../../gmail');
const { checkCalendar } = require('../../calendar');
const { webSearch } = require('../../tools');

// ─── Tool definitions (Claude tool schema) ────────────────────────────────────

const tools = [
  {
    name: 'generate_briefing',
    description:
      'Generate a comprehensive daily briefing drawing from Google Calendar events, unread Gmail, ' +
      'Airtable pipeline records, and live news via Brave Search. ' +
      'Optionally sends the formatted briefing to the configured WhatsApp number via Twilio.',
    input_schema: {
      type: 'object',
      properties: {
        send_whatsapp: {
          type: 'boolean',
          description: 'Send the briefing via WhatsApp to MY_WHATSAPP_NUMBER. Default: true.',
        },
        news_query: {
          type: 'string',
          description: 'Custom Brave Search query for the news section. Default: AI agents SMB Australia.',
        },
        date: {
          type: 'string',
          description: 'ISO date string for the briefing (YYYY-MM-DD). Default: today.',
        },
      },
      required: [],
    },
  },
];

// ─── Airtable fetch ───────────────────────────────────────────────────────────

async function fetchAirtableUpdates() {
  const { AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME } = process.env;

  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE_NAME) {
    return 'Airtable not configured (set AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME).';
  }

  try {
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`;
    const params = { maxRecords: 10, pageSize: 10 };

    // Use configurable sort field — default to 'Last Modified' if set
    const sortField = process.env.AIRTABLE_SORT_FIELD;
    if (sortField) {
      params['sort[0][field]'] = sortField;
      params['sort[0][direction]'] = 'desc';
    }

    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
      params,
    });

    const records = data.records || [];
    if (!records.length) return 'No records found in Airtable.';

    return records
      .map((r) => {
        const f = r.fields;
        // Try common field names; surface whatever exists
        const label =
          f.Name || f.Company || f['Business Name'] || f.Title || r.id;
        const status = f.Status || f.Stage || f.Phase || '';
        const extra = f.Notes || f.Email || f.Owner || '';
        return `• ${label}${status ? ` — ${status}` : ''}${extra ? ` (${extra})` : ''}`;
      })
      .join('\n');
  } catch (err) {
    return `Airtable fetch failed: ${err.response?.data?.error?.message || err.message}`;
  }
}

// ─── Briefing assembly ────────────────────────────────────────────────────────

async function generateBriefing({ newsQuery, date } = {}) {
  const targetDate = date ? new Date(date) : new Date();
  const dateStr = targetDate.toLocaleDateString('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const startDate = targetDate.toISOString().split('T')[0];

  const [calendarResult, emailResult, airtableResult, newsResult] = await Promise.allSettled([
    checkCalendar('list_events', { start_date: startDate, end_date: startDate, max_results: 10 }),
    readEmails(5),
    fetchAirtableUpdates(),
    webSearch(newsQuery || 'AI agents SMB Australia business automation news'),
  ]);

  const section = (label, result) =>
    result.status === 'fulfilled' ? result.value : `Error: ${result.reason?.message || 'unknown'}`;

  const calendar = section('calendar', calendarResult);
  const emails   = section('emails', emailResult);
  const airtable = section('airtable', airtableResult);
  const news     = section('news', newsResult);

  const timeAEST = new Date().toLocaleTimeString('en-AU', {
    timeZone: 'Australia/Sydney',
    hour: '2-digit',
    minute: '2-digit',
  });

  return [
    `*Icarus Morning Briefing — ${dateStr}*`,
    '',
    '*📅 Today\'s Calendar*',
    calendar || 'No events.',
    '',
    '*📧 Unread Emails*',
    emails || 'Inbox clear.',
    '',
    '*📊 Airtable Pipeline*',
    airtable || 'No records.',
    '',
    '*🌐 News*',
    news || 'No results.',
    '',
    `_Generated ${timeAEST} AEST_`,
  ].join('\n');
}

// ─── WhatsApp dispatch ────────────────────────────────────────────────────────

async function sendBriefingWhatsApp(body) {
  const {
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_WHATSAPP_NUMBER,
    MY_WHATSAPP_NUMBER,
  } = process.env;

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error('Twilio credentials not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN).');
  }
  if (!TWILIO_WHATSAPP_NUMBER || !MY_WHATSAPP_NUMBER) {
    throw new Error('WhatsApp numbers not configured (TWILIO_WHATSAPP_NUMBER / MY_WHATSAPP_NUMBER).');
  }

  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  return client.messages.create({
    from: `whatsapp:${TWILIO_WHATSAPP_NUMBER}`,
    to:   `whatsapp:${MY_WHATSAPP_NUMBER}`,
    body,
  });
}

// ─── Module interface ─────────────────────────────────────────────────────────

function init(app) {
  // Schedule daily briefing at 7:00 AM AEST = 21:00 UTC (previous day)
  // Only schedule in non-test environments
  if (process.env.NODE_ENV !== 'test') {
    cron.schedule(
      '0 21 * * *',
      async () => {
        console.log('[Icarus Briefing] Generating scheduled morning briefing...');
        try {
          const briefing = await generateBriefing({
            newsQuery: 'AI agents SMB Australia business news',
          });
          await sendBriefingWhatsApp(briefing);
          console.log('[Icarus Briefing] Morning briefing sent successfully.');
        } catch (err) {
          console.error('[Icarus Briefing] Scheduled briefing failed:', err.message);
        }
      },
      { timezone: 'UTC' }
    );
    console.log('[Icarus] Briefing module initialised — daily 7:00 AM AEST, POST /modules/briefing/generate');
  }

  // POST /modules/briefing/generate — on-demand via REST
  app.post('/modules/briefing/generate', async (req, res) => {
    const { news_query, date, send_whatsapp = true } = req.body;
    try {
      const briefing = await generateBriefing({ newsQuery: news_query, date });
      let sent = false;
      if (send_whatsapp) {
        await sendBriefingWhatsApp(briefing);
        sent = true;
      }
      res.json({ briefing, sent });
    } catch (err) {
      console.error('[Briefing] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}

async function handler(name, input) {
  if (name === 'generate_briefing') {
    const briefing = await generateBriefing({
      newsQuery: input.news_query,
      date: input.date,
    });

    if (input.send_whatsapp !== false) {
      try {
        await sendBriefingWhatsApp(briefing);
        return briefing + '\n\n✅ Briefing sent via WhatsApp.';
      } catch (err) {
        return briefing + `\n\n⚠️ WhatsApp send failed: ${err.message}`;
      }
    }

    return briefing;
  }
  return `[Briefing] Unknown tool: ${name}`;
}

module.exports = { tools, init, handler, generateBriefing, fetchAirtableUpdates, sendBriefingWhatsApp };
