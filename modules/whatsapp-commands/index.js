'use strict';

const axios = require('axios');

// Internal base URL for module-to-module HTTP calls
function baseUrl() {
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}`;
}

// POST to an internal module endpoint, return response text
async function callModule(path, body = {}) {
  try {
    const res = await axios.post(`${baseUrl()}${path}`, body, { timeout: 25_000 });
    return res.data?.result || res.data?.message || JSON.stringify(res.data);
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) return `Module not yet available (${path}).`;
    return `Error calling ${path}: ${err.message}`;
  }
}

// ─── Data helpers (for /status) ───────────────────────────────────────────────

async function getPipelineSummary() {
  const apiKey = process.env.AIRTABLE_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await axios.get(
      'https://api.airtable.com/v0/app6B6clOJP8i0J4Q/tblhqZra5YY2XCqyU',
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        params: { 'fields[]': 'Status', pageSize: 100 },
        timeout: 10_000,
      }
    );
    const counts = {};
    for (const r of res.data.records || []) {
      const s = r.fields.Status || 'Unknown';
      counts[s] = (counts[s] || 0) + 1;
    }
    return { counts, total: res.data.records?.length || 0 };
  } catch {
    return null;
  }
}

async function getStripeMrr() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;

  try {
    const res = await axios.get('https://api.stripe.com/v1/subscriptions', {
      headers: { Authorization: `Bearer ${key}` },
      params: { status: 'active', limit: 100 },
      timeout: 10_000,
    });
    const subs = res.data.data || [];
    let mrr = 0;
    for (const sub of subs) {
      for (const item of (sub.items?.data || [])) {
        const amount   = item.price?.unit_amount || 0;
        const interval = item.price?.recurring?.interval;
        const qty      = item.quantity || 1;
        if (interval === 'month')     mrr += (amount / 100) * qty;
        else if (interval === 'year') mrr += (amount / 100 / 12) * qty;
        else if (interval === 'week') mrr += (amount / 100 * 4.33) * qty;
        else if (interval === 'day')  mrr += (amount / 100 * 30.44) * qty;
      }
    }
    return { mrr: Math.round(mrr), count: subs.length };
  } catch {
    return null;
  }
}

// ─── Command handlers ─────────────────────────────────────────────────────────

async function cmdBrief() {
  const result = await callModule('/briefing/trigger', {});
  return `*Briefing triggered.*\n\n${result}`;
}

async function cmdStatus() {
  const [pipeline, stripe] = await Promise.allSettled([
    getPipelineSummary(),
    getStripeMrr(),
  ]);

  const pl = pipeline.status === 'fulfilled' ? pipeline.value : null;
  const st = stripe.status   === 'fulfilled' ? stripe.value   : null;

  const lines = ['*Icarus Status*'];

  if (pl) {
    lines.push('');
    lines.push(`Pipeline (${pl.total} total):`);
    const sorted = Object.entries(pl.counts || {}).sort((a, b) => b[1] - a[1]);
    for (const [stage, count] of sorted) {
      lines.push(`  ${stage}: ${count}`);
    }
  } else {
    lines.push('Pipeline: unavailable (check AIRTABLE_API_KEY)');
  }

  lines.push('');
  if (st) {
    lines.push(`Stripe MRR: $${st.mrr.toLocaleString()} AUD (${st.count} active subs)`);
  } else {
    lines.push('Stripe MRR: unavailable (check STRIPE_SECRET_KEY)');
  }

  return lines.join('\n');
}

async function cmdPitch(name) {
  if (!name || !name.trim()) return 'Usage: /pitch [prospect name]';
  const task = `lead ${name.trim()}`;
  const result = await callModule('/orchestrator/task', { task });
  return `*Pitch triggered for ${name.trim()}*\n\n${result}`;
}

async function cmdTrade(asset) {
  if (!asset || !asset.trim()) return 'Usage: /trade [asset] e.g. /trade BTC';
  const sym = asset.trim().toUpperCase();

  const [marketRes, decisionRes] = await Promise.allSettled([
    callModule('/markets/price', { symbol: sym }),
    callModule('/decisions/analyse', { context: `Market trade analysis for ${sym}` }),
  ]);

  const lines = [`*Trade analysis: ${sym}*`, ''];
  lines.push(marketRes.status === 'fulfilled' ? marketRes.value : 'Market data unavailable.');
  lines.push('');
  lines.push(decisionRes.status === 'fulfilled' ? decisionRes.value : 'Decision module unavailable.');
  return lines.join('\n');
}

async function cmdScan() {
  const result = await callModule('/anomaly/scan', {});
  return `*Anomaly scan initiated.*\n\n${result}`;
}

async function cmdBrain() {
  const result = await callModule('/brain-sync/trigger', {});
  return `*Brain-sync triggered.*\n\n${result}`;
}

async function cmdCall(args) {
  const topic  = args ? args.trim() : '';
  const body   = topic ? { topic } : {};
  const result = await callModule('/api/voice/call', body);
  const header = topic
    ? `*Calling +61478764417 now...*\nTopic: ${topic}`
    : `*Calling +61478764417 now...*`;
  return `${header}\n\n${result}`;
}

function cmdHelp() {
  return [
    '*Icarus Command Centre*',
    '',
    '/brief         — run morning briefing',
    '/status        — pipeline counts + Stripe MRR',
    '/pitch [name]  — trigger outreach for prospect',
    '/trade [asset] — market price + decision analysis',
    '/scan          — run anomaly detection now',
    '/brain         — trigger brain-sync, return stats',
    '/call [topic]  — call Nick\'s phone via Twilio',
    '/help          — show this message',
    '',
    '_All other messages are handled by Icarus normally._',
  ].join('\n');
}

// ─── Command parser ───────────────────────────────────────────────────────────

const COMMANDS = {
  '/brief':  () => cmdBrief(),
  '/status': () => cmdStatus(),
  '/pitch':  (args) => cmdPitch(args),
  '/trade':  (args) => cmdTrade(args),
  '/scan':   () => cmdScan(),
  '/brain':  () => cmdBrain(),
  '/call':   (args) => cmdCall(args),
  '/help':   () => Promise.resolve(cmdHelp()),
};

/**
 * Parse an incoming WhatsApp message body.
 * Returns a response string if the message is a command, or null to fall through.
 */
async function handler(messageBody) {
  if (!messageBody || typeof messageBody !== 'string') return null;
  const trimmed = messageBody.trim();
  if (!trimmed.startsWith('/')) return null;

  // Split into command + remainder args
  const spaceIdx = trimmed.indexOf(' ');
  const cmd  = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  const fn = COMMANDS[cmd];
  if (!fn) {
    return `Unknown command: ${cmd}\n\nSend /help for a list of commands.`;
  }

  try {
    return await fn(args);
  } catch (err) {
    console.error(`[WhatsApp commands] Error in ${cmd}:`, err.message);
    return `Command failed: ${err.message}`;
  }
}

function init() {
  console.log('[WhatsApp commands] Command centre ready. Registered:', Object.keys(COMMANDS).join(', '));
}

module.exports = {
  init,
  handler,
  // Exported for testing
  cmdBrief,
  cmdStatus,
  cmdPitch,
  cmdTrade,
  cmdScan,
  cmdBrain,
  cmdCall,
  cmdHelp,
  getPipelineSummary,
  getStripeMrr,
};
