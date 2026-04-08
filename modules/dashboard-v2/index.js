'use strict';

const axios = require('axios');

// ─── In-memory data cache ─────────────────────────────────────────────────────

let cache = {
  pipeline:    null,
  hubspot:     null,
  stripe:      null,
  markets:     null,
  calendar:    null,
  performance: null,
  lastUpdate:  null,
};

// ─── Data fetchers ────────────────────────────────────────────────────────────

async function fetchPipeline() {
  const apiKey = process.env.AIRTABLE_API_KEY;
  if (!apiKey) return { error: 'AIRTABLE_API_KEY not set' };

  try {
    let records = [];
    let offset;
    do {
      const params = { 'fields[]': 'Status', pageSize: 100 };
      if (offset) params.offset = offset;
      const res = await axios.get(
        'https://api.airtable.com/v0/app6B6clOJP8i0J4Q/tblhqZra5YY2XCqyU',
        { headers: { Authorization: `Bearer ${apiKey}` }, params, timeout: 10_000 }
      );
      records = records.concat(res.data.records || []);
      offset = res.data.offset;
    } while (offset);

    const counts = {};
    for (const r of records) {
      const status = r.fields.Status || 'Unknown';
      counts[status] = (counts[status] || 0) + 1;
    }
    return { counts, total: records.length };
  } catch (err) {
    return { error: err.message };
  }
}

async function fetchHubspot() {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return { error: 'HUBSPOT_TOKEN not set' };

  try {
    const res = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/deals/search',
      {
        filterGroups: [{
          filters: [{ propertyName: 'dealstage', operator: 'NOT_IN', values: ['closedlost', 'closedwon'] }],
        }],
        properties: ['amount', 'dealstage'],
        limit: 100,
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10_000 }
    );

    const deals = res.data.results || [];
    const total = deals.reduce((sum, d) => sum + parseFloat(d.properties.amount || 0), 0);
    return { total: Math.round(total), count: deals.length };
  } catch (err) {
    return { error: err.message };
  }
}

async function fetchStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return { error: 'STRIPE_SECRET_KEY not set' };

  try {
    const res = await axios.get('https://api.stripe.com/v1/subscriptions', {
      headers: { Authorization: `Bearer ${key}` },
      params: { status: 'active', limit: 100, expand: ['data.items'] },
      timeout: 10_000,
    });

    const subs = res.data.data || [];
    let mrr = 0;
    for (const sub of subs) {
      for (const item of (sub.items?.data || [])) {
        const amount   = item.price?.unit_amount || 0;
        const interval = item.price?.recurring?.interval;
        const qty      = item.quantity || 1;
        if (interval === 'month')      mrr += (amount / 100) * qty;
        else if (interval === 'year')  mrr += (amount / 100 / 12) * qty;
        else if (interval === 'week')  mrr += (amount / 100 * 4.33) * qty;
        else if (interval === 'day')   mrr += (amount / 100 * 30.44) * qty;
      }
    }
    return { mrr: Math.round(mrr), count: subs.length };
  } catch (err) {
    return { error: err.message };
  }
}

async function fetchMarkets() {
  const apiKey = process.env.MASSIVE_API_KEY;
  if (!apiKey) return { error: 'MASSIVE_API_KEY not set' };

  const TICKERS = [
    { label: 'XAG/USD', poly: 'C:XAGUSD' },
    { label: 'BTC/AUD', poly: 'X:BTCAUD' },
    { label: 'ETH/AUD', poly: 'X:ETHAUD' },
  ];

  const prices = {};
  await Promise.all(TICKERS.map(async ({ label, poly }) => {
    try {
      const res = await axios.get(
        `https://api.polygon.io/v2/aggs/ticker/${poly}/prev`,
        { params: { apiKey }, timeout: 8_000 }
      );
      const r = res.data.results?.[0];
      prices[label] = r ? { price: r.c, change: r.c - r.o } : null;
    } catch {
      prices[label] = null;
    }
  }));

  return prices;
}

async function fetchCalendar() {
  try {
    const { listEvents } = require('../../calendar');
    const today    = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().split('T')[0];
    const result   = await listEvents(today, tomorrow, 10);
    return { events: result };
  } catch (err) {
    return { error: err.message };
  }
}

async function fetchPerformance() {
  const apiKey = process.env.AIRTABLE_API_KEY;
  if (!apiKey) return { error: 'AIRTABLE_API_KEY not set' };

  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().split('T')[0];

  try {
    const res = await axios.get(
      'https://api.airtable.com/v0/app6B6clOJP8i0J4Q/tblhqZra5YY2XCqyU',
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        params: {
          filterByFormula: `IS_AFTER({Created}, '${sevenDaysAgo}')`,
          'fields[]': 'Created',
          pageSize: 100,
        },
        timeout: 10_000,
      }
    );

    const byDay = {};
    for (const record of res.data.records || []) {
      const day = (record.fields.Created || '').split('T')[0];
      if (day) byDay[day] = (byDay[day] || 0) + 1;
    }
    return { byDay };
  } catch (err) {
    return { error: err.message };
  }
}

async function refreshAll() {
  const results = await Promise.allSettled([
    fetchPipeline(),
    fetchHubspot(),
    fetchStripe(),
    fetchMarkets(),
    fetchCalendar(),
    fetchPerformance(),
  ]);

  const [pipeline, hubspot, stripe, markets, calendar, performance] = results.map(r =>
    r.status === 'fulfilled' ? r.value : { error: r.reason?.message || 'Unknown error' }
  );

  cache = { pipeline, hubspot, stripe, markets, calendar, performance, lastUpdate: new Date().toISOString() };
  return cache;
}

// ─── HTML page ────────────────────────────────────────────────────────────────

function buildV2Page(socketPath) {
  const path = socketPath || '/v2/socket.io';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Icarus · Live Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <script src="/socket.io/socket.io.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:         #0a0a0a;
      --surface:    #111111;
      --surface2:   #161616;
      --border:     #1e1e1e;
      --gold:       #d4a017;
      --gold-dim:   #7a5c0a;
      --green:      #00ff41;
      --green-dim:  #003d0f;
      --red:        #ff3b3b;
      --blue:       #3b82f6;
      --text:       #b8b8b8;
      --muted:      #444;
      --font:       'JetBrains Mono', 'Courier New', monospace;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
      font-size: 13px;
      line-height: 1.6;
      min-height: 100vh;
    }

    /* ── Header ── */
    .header {
      background: var(--surface);
      border-bottom: 1px solid var(--gold-dim);
      padding: 12px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .header-left { display: flex; align-items: center; gap: 14px; }

    .logo {
      width: 32px; height: 32px;
      border: 1px solid var(--gold);
      display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 13px; color: var(--gold);
      letter-spacing: 1px; flex-shrink: 0;
    }

    .header-title { font-size: 13px; font-weight: 700; color: var(--gold); letter-spacing: 0.2em; }
    .header-sub   { font-size: 9px; color: var(--muted); letter-spacing: 0.1em; margin-top: 2px; }

    .header-right { display: flex; align-items: center; gap: 20px; font-size: 10px; }

    .clock { color: var(--muted); font-variant-numeric: tabular-nums; }

    .ws-badge {
      display: flex; align-items: center; gap: 6px;
      color: var(--muted); letter-spacing: 0.05em;
    }

    .ws-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--muted); transition: background 0.4s, box-shadow 0.4s;
    }
    .ws-dot.live  { background: var(--green); box-shadow: 0 0 8px var(--green); }
    .ws-dot.error { background: var(--red); }

    /* ── Layout ── */
    .main { padding: 18px 24px; display: flex; flex-direction: column; gap: 14px; }

    .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }

    @media (max-width: 1100px) { .grid-3 { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 700px)  { .grid-3, .grid-2 { grid-template-columns: 1fr; } }

    /* ── Panels ── */
    .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 3px;
      overflow: hidden;
      position: relative;
      transition: border-color 0.4s;
    }

    .panel-hdr {
      padding: 9px 14px;
      border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
    }

    .panel-title { font-size: 9px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: var(--gold); }
    .panel-meta  { font-size: 9px; color: var(--muted); }

    .panel-body { padding: 14px; }

    /* ── Metric ── */
    .metric-val  { font-size: 26px; font-weight: 700; color: var(--green); letter-spacing: -0.02em; line-height: 1; }
    .metric-lbl  { font-size: 9px; color: var(--muted); letter-spacing: 0.1em; text-transform: uppercase; margin-top: 4px; }
    .metric-sub  { font-size: 10px; color: var(--muted); margin-top: 6px; }

    /* ── Pipeline bars ── */
    .pl-row {
      display: flex; align-items: center; gap: 10px;
      padding: 5px 0; border-bottom: 1px solid var(--border);
    }
    .pl-row:last-child { border-bottom: none; }
    .pl-stage { font-size: 10px; color: var(--text); min-width: 100px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pl-bar-wrap { flex: 1; height: 3px; background: var(--border); border-radius: 2px; overflow: hidden; }
    .pl-bar { height: 100%; background: var(--gold); border-radius: 2px; transition: width 0.6s ease; }
    .pl-cnt { font-size: 10px; color: var(--gold); font-weight: 700; min-width: 20px; text-align: right; }

    /* ── Markets ── */
    .mkt-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 0; border-bottom: 1px solid var(--border);
    }
    .mkt-row:last-child { border-bottom: none; }
    .mkt-ticker { font-size: 11px; font-weight: 600; color: var(--text); }
    .mkt-price  { font-size: 12px; font-weight: 700; color: var(--green); }
    .mkt-chg    { font-size: 9px; margin-top: 1px; }
    .mkt-chg.up   { color: var(--green); }
    .mkt-chg.down { color: var(--red); }

    /* ── Calendar ── */
    .cal-item { padding: 7px 0; border-bottom: 1px solid var(--border); }
    .cal-item:last-child { border-bottom: none; }
    .cal-time  { font-size: 9px; color: var(--gold); letter-spacing: 0.05em; }
    .cal-title { font-size: 11px; color: var(--text); margin-top: 1px; }

    /* ── Performance chart ── */
    .perf-chart {
      display: flex; align-items: flex-end; gap: 8px;
      height: 80px; padding: 8px 0 0;
    }
    .perf-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 5px; height: 100%; }
    .perf-bar {
      width: 100%; background: var(--green); border-radius: 2px 2px 0 0;
      opacity: 0.75; transition: height 0.6s ease; min-height: 2px;
    }
    .perf-day { font-size: 8px; color: var(--muted); }

    /* ── States ── */
    .dim      { color: var(--muted); font-size: 10px; font-style: italic; }
    .err-text { color: var(--red); font-size: 10px; }

    /* ── Flash on update ── */
    @keyframes flash-gold {
      0%   { border-color: var(--gold); }
      100% { border-color: var(--border); }
    }
    .panel.flash { animation: flash-gold 1.2s ease forwards; }
  </style>
</head>
<body>

<header class="header">
  <div class="header-left">
    <div class="logo">I</div>
    <div>
      <div class="header-title">ICARUS · LIVE</div>
      <div class="header-sub">Operations Dashboard v2 &middot; Openclaw</div>
    </div>
  </div>
  <div class="header-right">
    <div id="clock" class="clock">--:--:-- AEST</div>
    <div class="ws-badge">
      <div id="ws-dot" class="ws-dot"></div>
      <span id="ws-lbl">connecting</span>
    </div>
  </div>
</header>

<main class="main">

  <!-- Row 1: Key metrics -->
  <div class="grid-3">

    <div class="panel" id="p-stripe">
      <div class="panel-hdr">
        <span class="panel-title">Stripe MRR</span>
        <span class="panel-meta" id="stripe-ts">—</span>
      </div>
      <div class="panel-body">
        <div class="metric-val" id="stripe-mrr">—</div>
        <div class="metric-lbl">Monthly Recurring Revenue AUD</div>
        <div class="metric-sub" id="stripe-sub"></div>
      </div>
    </div>

    <div class="panel" id="p-hubspot">
      <div class="panel-hdr">
        <span class="panel-title">HubSpot Pipeline</span>
        <span class="panel-meta" id="hs-ts">—</span>
      </div>
      <div class="panel-body">
        <div class="metric-val" id="hs-val">—</div>
        <div class="metric-lbl">Open Deal Value AUD</div>
        <div class="metric-sub" id="hs-sub"></div>
      </div>
    </div>

    <div class="panel" id="p-markets">
      <div class="panel-hdr">
        <span class="panel-title">Markets</span>
        <span class="panel-meta" id="mkt-ts">—</span>
      </div>
      <div class="panel-body" id="mkt-body"><div class="dim">Loading...</div></div>
    </div>

  </div>

  <!-- Row 2: Pipeline stages + Calendar -->
  <div class="grid-2">

    <div class="panel" id="p-pipeline">
      <div class="panel-hdr">
        <span class="panel-title">Airtable Pipeline</span>
        <span class="panel-meta" id="pl-ts">—</span>
      </div>
      <div class="panel-body" id="pl-body"><div class="dim">Loading...</div></div>
    </div>

    <div class="panel" id="p-calendar">
      <div class="panel-hdr">
        <span class="panel-title">Today's Events</span>
        <span class="panel-meta" id="cal-ts">—</span>
      </div>
      <div class="panel-body" id="cal-body"><div class="dim">Loading...</div></div>
    </div>

  </div>

  <!-- Row 3: Performance chart -->
  <div class="panel" id="p-perf">
    <div class="panel-hdr">
      <span class="panel-title">Icarus Performance — Last 7 Days</span>
      <span class="panel-meta">activity by day</span>
    </div>
    <div class="panel-body" id="perf-body"><div class="dim">Loading...</div></div>
  </div>

</main>

<script>
(function () {
  // ── Clock ──────────────────────────────────────────────────────────────────
  function tick() {
    document.getElementById('clock').textContent =
      new Date().toLocaleTimeString('en-AU', { timeZone: 'Australia/Sydney' }) + ' AEST';
  }
  tick(); setInterval(tick, 1000);

  // ── Helpers ────────────────────────────────────────────────────────────────
  function aud(n) {
    if (n == null || isNaN(+n)) return '—';
    return '$' + Math.round(+n).toLocaleString('en-AU');
  }
  function num(n, d) {
    if (n == null || isNaN(+n)) return '—';
    return (+n).toLocaleString('en-AU', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  }
  function ts() {
    return new Date().toLocaleTimeString('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit' });
  }
  function flash(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }
  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Socket.io ──────────────────────────────────────────────────────────────
  const socket = io({ path: '${path}' });
  const dot = document.getElementById('ws-dot');
  const lbl = document.getElementById('ws-lbl');
  socket.on('connect',    function() { dot.className = 'ws-dot live'; lbl.textContent = 'live'; });
  socket.on('disconnect', function() { dot.className = 'ws-dot error'; lbl.textContent = 'disconnected'; });

  // ── Stripe ────────────────────────────────────────────────────────────────
  socket.on('stripe', function(d) {
    flash('p-stripe');
    if (d.error) { document.getElementById('stripe-mrr').textContent = 'ERR'; document.getElementById('stripe-sub').textContent = d.error; return; }
    document.getElementById('stripe-mrr').textContent = aud(d.mrr);
    document.getElementById('stripe-sub').textContent = d.count + ' active subscriptions';
    document.getElementById('stripe-ts').textContent  = ts();
  });

  // ── HubSpot ───────────────────────────────────────────────────────────────
  socket.on('hubspot', function(d) {
    flash('p-hubspot');
    if (d.error) { document.getElementById('hs-val').textContent = 'ERR'; document.getElementById('hs-sub').textContent = d.error; return; }
    document.getElementById('hs-val').textContent = aud(d.total);
    document.getElementById('hs-sub').textContent = d.count + ' open deals';
    document.getElementById('hs-ts').textContent  = ts();
  });

  // ── Markets ───────────────────────────────────────────────────────────────
  socket.on('markets', function(d) {
    flash('p-markets');
    const body = document.getElementById('mkt-body');
    if (d.error) { body.innerHTML = '<div class="err-text">' + esc(d.error) + '</div>'; return; }
    let h = '';
    for (const ticker in d) {
      const m = d[ticker];
      if (!m) { h += '<div class="mkt-row"><span class="mkt-ticker">' + esc(ticker) + '</span><span class="dim">N/A</span></div>'; continue; }
      const up  = m.change >= 0;
      h += '<div class="mkt-row">' +
        '<span class="mkt-ticker">' + esc(ticker) + '</span>' +
        '<div style="text-align:right">' +
          '<div class="mkt-price">' + num(m.price, 2) + '</div>' +
          '<div class="mkt-chg ' + (up ? 'up' : 'down') + '">' + (up ? '+' : '') + num(m.change, 2) + '</div>' +
        '</div>' +
      '</div>';
    }
    body.innerHTML = h || '<div class="dim">No data</div>';
    document.getElementById('mkt-ts').textContent = ts();
  });

  // ── Pipeline ──────────────────────────────────────────────────────────────
  socket.on('pipeline', function(d) {
    flash('p-pipeline');
    const body = document.getElementById('pl-body');
    if (d.error) { body.innerHTML = '<div class="err-text">' + esc(d.error) + '</div>'; return; }
    const counts = d.counts || {};
    const total  = d.total || 1;
    const sorted = Object.entries(counts).sort(function(a, b) { return b[1] - a[1]; });
    let h = '';
    for (const [stage, cnt] of sorted) {
      const pct = Math.round((cnt / total) * 100);
      h += '<div class="pl-row">' +
        '<span class="pl-stage">' + esc(stage) + '</span>' +
        '<div class="pl-bar-wrap"><div class="pl-bar" style="width:' + pct + '%"></div></div>' +
        '<span class="pl-cnt">' + cnt + '</span>' +
      '</div>';
    }
    body.innerHTML = h || '<div class="dim">No stages found</div>';
    document.getElementById('pl-ts').textContent = total + ' total';
  });

  // ── Calendar ──────────────────────────────────────────────────────────────
  socket.on('calendar', function(d) {
    flash('p-calendar');
    const body = document.getElementById('cal-body');
    if (d.error) { body.innerHTML = '<div class="err-text">' + esc(d.error) + '</div>'; return; }
    const raw = typeof d.events === 'string' ? d.events : JSON.stringify(d.events || '');
    const lines = raw.split('\\n').map(function(l) { return l.trim(); }).filter(Boolean);
    if (!lines.length) { body.innerHTML = '<div class="dim">No events today</div>'; return; }
    let h = '';
    for (const line of lines.slice(0, 8)) {
      const dash = line.indexOf(' - ');
      if (dash > -1) {
        h += '<div class="cal-item"><div class="cal-time">' + esc(line.slice(0, dash)) + '</div>' +
          '<div class="cal-title">' + esc(line.slice(dash + 3)) + '</div></div>';
      } else {
        h += '<div class="cal-item"><div class="cal-title">' + esc(line) + '</div></div>';
      }
    }
    body.innerHTML = h;
    document.getElementById('cal-ts').textContent = new Date().toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', weekday: 'short', month: 'short', day: 'numeric' });
  });

  // ── Performance ───────────────────────────────────────────────────────────
  socket.on('performance', function(d) {
    flash('p-perf');
    const body = document.getElementById('perf-body');
    if (d.error) { body.innerHTML = '<div class="err-text">' + esc(d.error) + '</div>'; return; }
    const byDay = d.byDay || {};
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const dt  = new Date(Date.now() - i * 86400000);
      const key = dt.toISOString().split('T')[0];
      const lbl = dt.toLocaleDateString('en-AU', { weekday: 'short' });
      days.push({ key, lbl, cnt: byDay[key] || 0 });
    }
    const max = Math.max.apply(null, days.map(function(x) { return x.cnt; }).concat([1]));
    let h = '<div class="perf-chart">';
    for (const day of days) {
      const hpx = Math.round((day.cnt / max) * 64);
      h += '<div class="perf-col">' +
        '<div style="flex:1;display:flex;align-items:flex-end;width:100%">' +
          '<div class="perf-bar" style="height:' + hpx + 'px" title="' + day.cnt + ' on ' + day.key + '"></div>' +
        '</div>' +
        '<div class="perf-day">' + esc(day.lbl) + '</div>' +
      '</div>';
    }
    h += '</div>';
    body.innerHTML = h;
  });

}());
</script>
</body>
</html>`;
}

// ─── Module init ──────────────────────────────────────────────────────────────

let _io;
let _interval;

function init(app, httpServer) {
  const SOCKET_PATH = '/v2/socket.io';

  if (!httpServer) {
    console.warn('[Dashboard v2] No HTTP server passed — socket.io disabled.');
  } else {
    const { Server } = require('socket.io');
    _io = new Server(httpServer, { path: SOCKET_PATH });

    _io.on('connection', (socket) => {
      console.log('[Dashboard v2] WS client connected:', socket.id);
      // Push current cache immediately, or trigger first refresh
      if (cache.lastUpdate) {
        emitAll(socket);
      } else {
        refreshAll().then(() => emitAll(socket)).catch(console.error);
      }
    });

    // Broadcast refresh every 30s
    _interval = setInterval(async () => {
      try {
        await refreshAll();
        _io.emit('pipeline',    cache.pipeline);
        _io.emit('hubspot',     cache.hubspot);
        _io.emit('stripe',      cache.stripe);
        _io.emit('markets',     cache.markets);
        _io.emit('calendar',    cache.calendar);
        _io.emit('performance', cache.performance);
      } catch (err) {
        console.error('[Dashboard v2] Refresh error:', err.message);
      }
    }, 30_000);

    console.log('[Dashboard v2] socket.io attached on', SOCKET_PATH);
  }

  // Register routes on the Express app
  app.get('/v2', handler);
  app.get('/v2/data', (_req, res) => res.json(cache));

  console.log('[Dashboard v2] Routes registered: GET /v2, GET /v2/data');
}

function handler(_req, res) {
  res.type('text/html').send(buildV2Page('/v2/socket.io'));
}

function emitAll(socket) {
  socket.emit('pipeline',    cache.pipeline    || {});
  socket.emit('hubspot',     cache.hubspot     || {});
  socket.emit('stripe',      cache.stripe      || {});
  socket.emit('markets',     cache.markets     || {});
  socket.emit('calendar',    cache.calendar    || {});
  socket.emit('performance', cache.performance || {});
}

function stop() {
  if (_interval) clearInterval(_interval);
  if (_io) _io.close();
}

module.exports = {
  init,
  handler,
  stop,
  refreshAll,
  fetchPipeline,
  fetchHubspot,
  fetchStripe,
  fetchMarkets,
  fetchCalendar,
  fetchPerformance,
  getCache: () => cache,
};
