'use strict';
require('dotenv').config();

const express    = require('express');
const { execSync } = require('child_process');
const fs         = require('fs');
const path       = require('path');

const PORT     = parseInt(process.env.DASHBOARD_PORT) || 4000;
const WORK_DIR = path.resolve(__dirname);
const LOG_FILE = path.join(WORK_DIR, 'icarus-log.md');
const AGENT_LOG = path.join(WORK_DIR, 'logs', 'agent.log');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function aestTime() {
  return new Date().toLocaleString('en-AU', {
    timeZone: 'Australia/Sydney',
    weekday: 'short', year: 'numeric', month: 'short',
    day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function getPm2Status() {
  try {
    const raw = execSync('pm2 jlist', { timeout: 5000 }).toString();
    const list = JSON.parse(raw);
    return list.map(p => ({
      name:   p.name,
      status: p.pm2_env?.status || 'unknown',
      uptime: p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : null,
      restarts: p.pm2_env?.restart_time || 0,
      mem: p.monit?.memory ? Math.round(p.monit.memory / 1024 / 1024) : null,
      cpu: p.monit?.cpu ?? null,
    }));
  } catch {
    return [];
  }
}

function formatUptime(ms) {
  if (!ms) return '—';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function readTail(filePath, lines = 50) {
  try {
    if (!fs.existsSync(filePath)) return '(log file not found)';
    const content = fs.readFileSync(filePath, 'utf8');
    const all = content.split('\n');
    return all.slice(-lines).join('\n') || '(empty)';
  } catch {
    return '(error reading log)';
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Lightweight markdown → HTML for icarus-log.md
function renderMarkdown(md) {
  if (!md) return '<em>No log entries yet.</em>';
  const lines = md.split('\n');
  const out = [];
  let inCode = false;

  for (const raw of lines) {
    const line = escapeHtml(raw);

    if (line.startsWith('```')) {
      if (inCode) { out.push('</pre>'); inCode = false; }
      else { out.push('<pre>'); inCode = true; }
      continue;
    }
    if (inCode) { out.push(line); continue; }

    if (line.startsWith('## '))       { out.push(`<h2>${line.slice(3)}</h2>`); continue; }
    if (line.startsWith('### '))      { out.push(`<h3>${line.slice(4)}</h3>`); continue; }
    if (line.startsWith('#### '))     { out.push(`<h4>${line.slice(5)}</h4>`); continue; }
    if (line.startsWith('---'))       { out.push('<hr>'); continue; }
    if (line.trim() === '')           { out.push('<br>'); continue; }

    // Inline: **bold**, *italic*, `code`
    let l = line
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>');

    // Status emoji shortcuts → coloured badges
    l = l
      .replace(/🟢/g, '<span class="badge green">●</span>')
      .replace(/🔴/g, '<span class="badge red">●</span>')
      .replace(/🟡/g, '<span class="badge yellow">●</span>')
      .replace(/🔵/g, '<span class="badge blue">●</span>')
      .replace(/⚡/g, '<span class="badge white">⚡</span>');

    if (line.startsWith('- ') || line.startsWith('* ')) {
      out.push(`<li>${l.slice(2)}</li>`);
    } else {
      out.push(`<p>${l}</p>`);
    }
  }
  if (inCode) out.push('</pre>');
  return out.join('\n');
}

function getAuthStatus() {
  const gmailToken = fs.existsSync(path.join(WORK_DIR, 'gmail_token.json'));
  return {
    gmail_token:   gmailToken,
    anthropic:     !!process.env.ANTHROPIC_API_KEY,
    hubspot:       !!process.env.HUBSPOT_TOKEN,
    twilio_auth:   !!process.env.TWILIO_AUTH_TOKEN,
    twilio_sid:    !!process.env.TWILIO_ACCOUNT_SID,
    google_id:     !!process.env.GOOGLE_CLIENT_ID,
    google_secret: !!process.env.GOOGLE_CLIENT_SECRET,
    brave:         !!process.env.BRAVE_API_KEY,
    gmail_refresh: !!process.env.GMAIL_REFRESH_TOKEN,
  };
}

// ─── HTML renderer ────────────────────────────────────────────────────────────

function buildPage(processes, auth, logMd, agentTail) {
  const now = aestTime();

  const processRows = processes.length === 0
    ? '<tr><td colspan="5" class="muted">pm2 not available or no processes found</td></tr>'
    : processes.map(p => {
        const online = p.status === 'online';
        const statusClass = online ? 'green' : (p.status === 'stopped' ? 'muted' : 'red');
        return `
          <tr>
            <td><strong>${escapeHtml(p.name)}</strong></td>
            <td><span class="badge ${statusClass}">${escapeHtml(p.status)}</span></td>
            <td>${formatUptime(p.uptime)}</td>
            <td>${p.restarts}</td>
            <td>${p.mem !== null ? p.mem + ' MB' : '—'} ${p.cpu !== null ? '/ ' + p.cpu + '%' : ''}</td>
          </tr>`;
      }).join('');

  const authRows = Object.entries(auth).map(([key, ok]) => {
    const label = key.replace(/_/g, ' ');
    return `<tr>
      <td>${escapeHtml(label)}</td>
      <td><span class="badge ${ok ? 'green' : 'red'}">${ok ? '✓ OK' : '✗ Missing'}</span></td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Icarus Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: #080c14;
      color: #c8d6e5;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      font-size: 14px;
      line-height: 1.6;
    }

    /* ── Header ── */
    .header {
      background: #0d1526;
      border-bottom: 1px solid #1a2540;
      padding: 16px 28px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }

    .header-brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo {
      width: 36px; height: 36px;
      background: #e8edf5;
      border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-weight: 800; font-size: 16px; color: #080c14;
      letter-spacing: -1px; flex-shrink: 0;
    }

    .header-brand h1 {
      font-size: 16px; font-weight: 700;
      letter-spacing: 0.1em; color: #e8edf5;
    }

    .header-brand p { font-size: 11px; color: #4a6080; margin-top: 1px; }

    .header-meta {
      display: flex; align-items: center; gap: 16px;
      font-size: 12px; color: #4a6080;
    }

    #countdown {
      font-size: 11px;
      color: #2a4060;
      font-variant-numeric: tabular-nums;
    }

    /* ── Layout ── */
    .main { padding: 24px 28px; display: flex; flex-direction: column; gap: 24px; }

    .row { display: grid; gap: 20px; }
    .row-2 { grid-template-columns: 1fr 1fr; }
    .row-3 { grid-template-columns: 1fr 1fr 1fr; }

    @media (max-width: 900px) {
      .row-2, .row-3 { grid-template-columns: 1fr; }
    }

    /* ── Cards ── */
    .card {
      background: #0d1526;
      border: 1px solid #1a2540;
      border-radius: 10px;
      overflow: hidden;
    }

    .card-header {
      padding: 12px 18px;
      border-bottom: 1px solid #1a2540;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #4a6080;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .card-body { padding: 16px 18px; }

    /* ── Tables ── */
    table { width: 100%; border-collapse: collapse; }

    th {
      text-align: left;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #2a4060;
      padding: 0 10px 10px 0;
      border-bottom: 1px solid #1a2540;
    }

    td {
      padding: 9px 10px 9px 0;
      border-bottom: 1px solid #111d30;
      vertical-align: middle;
    }

    tr:last-child td { border-bottom: none; }

    /* ── Badges ── */
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.03em;
    }

    .badge.green  { background: #0d2e1a; color: #22c55e; }
    .badge.red    { background: #2e0d0d; color: #ef4444; }
    .badge.yellow { background: #2e2300; color: #f59e0b; }
    .badge.blue   { background: #0d1e3a; color: #60a5fa; }
    .badge.white  { background: #1a2540; color: #e8edf5; }
    .badge.muted  { background: #111d30; color: #4a6080; }

    .muted { color: #2a4060; }

    /* ── Log area ── */
    .log-area {
      background: #060a10;
      border: 1px solid #111d30;
      border-radius: 6px;
      padding: 14px 16px;
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      font-size: 12px;
      line-height: 1.7;
      overflow-x: auto;
      max-height: 360px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
      color: #7a9ab8;
    }

    .log-area::-webkit-scrollbar { width: 4px; }
    .log-area::-webkit-scrollbar-thumb { background: #1a2540; border-radius: 2px; }

    /* ── Markdown log ── */
    .md-log {
      max-height: 500px;
      overflow-y: auto;
      padding: 4px 2px;
    }

    .md-log::-webkit-scrollbar { width: 4px; }
    .md-log::-webkit-scrollbar-thumb { background: #1a2540; border-radius: 2px; }

    .md-log h2 {
      font-size: 13px; font-weight: 700; color: #e8edf5;
      margin: 16px 0 6px; padding-bottom: 4px;
      border-bottom: 1px solid #1a2540;
    }

    .md-log h3 { font-size: 12px; font-weight: 600; color: #c8d6e5; margin: 10px 0 4px; }
    .md-log h4 { font-size: 12px; font-weight: 600; color: #7a9ab8; margin: 8px 0 4px; }
    .md-log p  { margin: 4px 0; color: #8fa8c0; font-size: 13px; }
    .md-log li { margin: 2px 0 2px 18px; list-style: disc; color: #8fa8c0; font-size: 13px; }
    .md-log hr { border: none; border-top: 1px solid #1a2540; margin: 12px 0; }
    .md-log br { display: block; margin: 4px 0; content: ''; }
    .md-log strong { color: #c8d6e5; font-weight: 600; }
    .md-log em { font-style: italic; color: #7a9ab8; }
    .md-log code {
      background: #060a10; color: #93c5fd;
      padding: 1px 5px; border-radius: 4px;
      font-family: monospace; font-size: 12px;
    }
    .md-log pre {
      background: #060a10; border: 1px solid #111d30;
      border-radius: 6px; padding: 10px 12px;
      font-family: monospace; font-size: 12px;
      overflow-x: auto; margin: 8px 0; color: #7a9ab8;
      white-space: pre-wrap;
    }
  </style>
  <script>
    let remaining = 30;
    function tick() {
      remaining--;
      const el = document.getElementById('countdown');
      if (el) el.textContent = 'Refresh in ' + remaining + 's';
      if (remaining <= 0) location.reload();
      else setTimeout(tick, 1000);
    }
    setTimeout(tick, 1000);
  </script>
</head>
<body>
  <header class="header">
    <div class="header-brand">
      <div class="logo">I</div>
      <div>
        <h1>ICARUS</h1>
        <p>Operations Dashboard · Openclaw</p>
      </div>
    </div>
    <div class="header-meta">
      <span>${escapeHtml(now)} AEST</span>
      <span id="countdown" class="muted">Refresh in 30s</span>
    </div>
  </header>

  <main class="main">

    <!-- Processes + Auth -->
    <div class="row row-2">

      <div class="card">
        <div class="card-header">
          <span>Process Status</span>
          <span class="muted">${processes.filter(p => p.status === 'online').length}/${processes.length} online</span>
        </div>
        <div class="card-body">
          <table>
            <thead>
              <tr>
                <th>Name</th><th>Status</th><th>Uptime</th><th>↺</th><th>Resources</th>
              </tr>
            </thead>
            <tbody>${processRows}</tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><span>Credentials &amp; Auth</span></div>
        <div class="card-body">
          <table>
            <thead><tr><th>Service</th><th>Status</th></tr></thead>
            <tbody>${authRows}</tbody>
          </table>
        </div>
      </div>

    </div>

    <!-- Agent log tail -->
    <div class="card">
      <div class="card-header">
        <span>Agent Log</span>
        <span class="muted">Last 50 lines · ${escapeHtml(AGENT_LOG)}</span>
      </div>
      <div class="card-body">
        <div class="log-area">${escapeHtml(agentTail)}</div>
      </div>
    </div>

    <!-- Operations log -->
    <div class="card">
      <div class="card-header">
        <span>Operations Log</span>
        <span class="muted">icarus-log.md</span>
      </div>
      <div class="card-body">
        <div class="md-log">${logMd}</div>
      </div>
    </div>

  </main>
</body>
</html>`;
}

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get('/status', (_req, res) => {
  res.json({
    gmail:     fs.existsSync(path.join(WORK_DIR, 'gmail_token.json')) || !!process.env.GMAIL_REFRESH_TOKEN,
    hubspot:   !!process.env.HUBSPOT_TOKEN,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    twilio:    !!process.env.TWILIO_AUTH_TOKEN,
    uptime:    process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (_req, res) => {
  const processes  = getPm2Status();
  const auth       = getAuthStatus();
  const rawLog     = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
  const logMd      = renderMarkdown(rawLog);
  const agentTail  = readTail(AGENT_LOG, 50);

  res.type('text/html').send(buildPage(processes, auth, logMd, agentTail));
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`⚡ Icarus Dashboard running on port ${PORT}`);
});
