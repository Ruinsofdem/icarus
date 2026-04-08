require('dotenv').config();
const cron = require('node-cron');
const Airtable = require('airtable');
const twilio = require('twilio');
const fs = require('fs');
const path = require('path');
const { createMessage } = require('../../config');

const AIRTABLE_BASE_ID = 'app6B6clOJP8i0J4Q';
const AIRTABLE_TABLE = 'Icarus Performance';
const DIGEST_DIR = path.join(__dirname, '../../knowledge-feed');

let airtableBase = null;
let twilioClient = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  if (!process.env.AIRTABLE_API_KEY) {
    console.warn('[SelfLog] AIRTABLE_API_KEY missing — performance logging disabled.');
  } else {
    airtableBase = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
  }

  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    console.warn('[SelfLog] Twilio env missing — weekly WhatsApp digest disabled.');
  } else {
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }

  if (!fs.existsSync(DIGEST_DIR)) fs.mkdirSync(DIGEST_DIR, { recursive: true });

  // Sunday 6PM AEST = Sunday 08:00 UTC (AEST UTC+10)
  cron.schedule('0 8 * * 0', () => {
    generateWeeklyDigest().catch(err => console.error('[SelfLog] Weekly digest failed:', err.message));
  }, { timezone: 'UTC' });

  console.log('[SelfLog] Performance logger ready (digest: Sunday 6PM AEST).');
}

// ─── Core logging ─────────────────────────────────────────────────────────────

/**
 * Log a completed Icarus task to Airtable.
 * @param {string} taskType   - e.g. 'prospect_research', 'email_send', 'crm_update'
 * @param {number} durationMs - wall-clock time in milliseconds
 * @param {'success'|'partial'|'fail'} outcome
 * @param {number} [tokensUsed] - total Claude tokens consumed
 * @returns {string} Airtable record ID
 */
async function logTask(taskType, durationMs, outcome, tokensUsed = 0) {
  if (!airtableBase) {
    console.warn('[SelfLog] logTask skipped — Airtable not configured.');
    return null;
  }

  const validOutcomes = ['success', 'partial', 'fail'];
  const safeOutcome = validOutcomes.includes(outcome) ? outcome : 'partial';

  const record = await airtableBase(AIRTABLE_TABLE).create({
    'Task Type': String(taskType).slice(0, 100),
    'Duration (ms)': Math.round(durationMs),
    'Outcome': safeOutcome,
    'Tokens Used': Math.round(tokensUsed),
    'Timestamp': new Date().toISOString(),
  });

  return record.id;
}

// ─── Stats / retrieval ────────────────────────────────────────────────────────

async function getWeekLogs() {
  if (!airtableBase) return [];

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const records = await new Promise((resolve, reject) => {
    const all = [];
    airtableBase(AIRTABLE_TABLE)
      .select({
        filterByFormula: `IS_AFTER({Timestamp}, '${weekAgo}')`,
        sort: [{ field: 'Timestamp', direction: 'desc' }],
        maxRecords: 500,
      })
      .eachPage(
        (recs, next) => { all.push(...recs); next(); },
        (err) => (err ? reject(err) : resolve(all))
      );
  });

  return records.map(r => ({
    taskType: r.get('Task Type') || '',
    durationMs: r.get('Duration (ms)') || 0,
    outcome: r.get('Outcome') || '',
    tokensUsed: r.get('Tokens Used') || 0,
    timestamp: r.get('Timestamp') || '',
  }));
}

function buildStats(logs) {
  const byOutcome = logs.reduce((acc, l) => {
    acc[l.outcome] = (acc[l.outcome] || 0) + 1;
    return acc;
  }, {});
  const avgDuration = logs.length
    ? Math.round(logs.reduce((s, l) => s + (l.durationMs || 0), 0) / logs.length)
    : 0;
  const totalTokens = logs.reduce((s, l) => s + (l.tokensUsed || 0), 0);
  const successRate = logs.length
    ? Math.round(((byOutcome.success || 0) / logs.length) * 100)
    : 0;

  return { total: logs.length, byOutcome, avgDuration, totalTokens, successRate };
}

// ─── Weekly digest ────────────────────────────────────────────────────────────

async function generateWeeklyDigest() {
  const logs = await getWeekLogs();
  const stats = buildStats(logs);

  const logsText = logs.length
    ? logs.map(l =>
        `- [${l.timestamp}] ${l.taskType}: ${l.outcome} (${l.durationMs}ms, ${l.tokensUsed} tokens)`
      ).join('\n')
    : 'No tasks logged this week.';

  const prompt = `You are Icarus analyzing your own weekly performance. Here are this week's task logs:

${logsText}

Summary stats:
- Total tasks: ${stats.total}
- Success rate: ${stats.successRate}%
- Avg duration: ${stats.avgDuration}ms
- Total tokens: ${stats.totalTokens}
- By outcome: ${JSON.stringify(stats.byOutcome)}

Generate a concise markdown performance digest (max 400 words) covering: key patterns, top wins, notable failures, token efficiency, and 2-3 actionable improvement suggestions for next week.`;

  const response = await createMessage(
    [{ role: 'user', content: prompt }],
    { systemPrompt: 'You are Icarus, an autonomous AI agent, writing your own performance review. Be honest, specific, and improvement-focused.' }
  );

  const digest = response.content?.find(b => b.type === 'text')?.text || 'No analysis generated.';

  // Write to file
  const date = new Date().toISOString().slice(0, 10);
  const digestFile = path.join(DIGEST_DIR, `digest-${date}.md`);
  fs.writeFileSync(digestFile, `# Icarus Weekly Performance Digest — ${date}\n\n${digest}`);

  // Send via WhatsApp (truncate to Twilio's 1600 char limit)
  if (twilioClient) {
    const waSummary = digest.length > 1400 ? digest.slice(0, 1400) + '\n…(full report in /knowledge-feed)' : digest;
    await twilioClient.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:${process.env.MY_WHATSAPP_NUMBER}`,
      body: `📊 ICARUS WEEKLY DIGEST — ${date}\n\n${waSummary}`,
    });
  }

  return digest;
}

// ─── HTTP handler ─────────────────────────────────────────────────────────────

function handler(router) {
  router.get('/selflog/stats', async (req, res) => {
    try {
      const logs = await getWeekLogs();
      res.json(buildStats(logs));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/selflog/log', async (req, res) => {
    const { taskType, durationMs, outcome, tokensUsed } = req.body;
    if (!taskType || typeof taskType !== 'string') {
      return res.status(400).json({ error: 'taskType is required.' });
    }
    if (!outcome || !['success', 'partial', 'fail'].includes(outcome)) {
      return res.status(400).json({ error: 'outcome must be success | partial | fail.' });
    }
    try {
      const id = await logTask(taskType, durationMs || 0, outcome, tokensUsed || 0);
      res.json({ ok: true, id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { init, handler, logTask, getWeekLogs, buildStats, generateWeeklyDigest };
