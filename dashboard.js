'use strict';
require('dotenv').config();

const express = require('express');
const { execSync, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios  = require('axios');
const twilio = require('twilio');
const { Client: NotionClient } = require('@notionhq/client');

const PORT     = parseInt(process.env.DASHBOARD_PORT) || 4000;
const PASSWORD = process.env.DASHBOARD_PASSWORD || 'icarus';
const WORK_DIR = path.resolve(__dirname);

// ─── Session store (disk-backed so pm2 restarts don't log users out) ──────────
const SESSION_TTL    = 24 * 60 * 60 * 1000;
const SESSIONS_FILE  = path.join(WORK_DIR, '.dashboard-sessions.json');

function loadSessions() {
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')))); } catch (e) { return new Map(); }
}
function saveSessions(map) {
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(map)), 'utf8'); } catch (e) {}
}

const sessions = loadSessions();

function makeSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL);
  saveSessions(sessions);
  return token;
}

function checkSession(token) {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(token); saveSessions(sessions); return false; }
  return true;
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(pair => {
    const [k, ...vs] = pair.trim().split('=');
    if (k) out[decodeURIComponent(k.trim())] = decodeURIComponent(vs.join('=').trim());
  });
  return out;
}

// ─── Express setup ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

function authMiddleware(req, res, next) {
  if (checkSession(parseCookies(req).session)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  res.redirect('/login');
}

// ─── Login ────────────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (checkSession(parseCookies(req).session)) return res.redirect('/');
  res.send(loginPage());
});

app.post('/login', (req, res) => {
  if (req.body.password === PASSWORD) {
    const token = makeSession();
    res.setHeader('Set-Cookie', 'session=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + (SESSION_TTL / 1000));
    res.redirect('/');
  } else {
    res.send(loginPage('Incorrect password.'));
  }
});

app.get('/logout', (req, res) => {
  sessions.delete(parseCookies(req).session);
  res.setHeader('Set-Cookie', 'session=; Path=/; Max-Age=0');
  res.redirect('/login');
});

app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ─── Dashboard page (only this route requires login) ─────────────────────────
app.get('/', (req, res) => {
  if (!checkSession(parseCookies(req).session)) return res.redirect('/login');
  res.setHeader('Cache-Control', 'no-store');
  res.send(dashboardPage());
});

// ─── Utility helpers ──────────────────────────────────────────────────────────
function parseAuditLog() {
  const logPath = path.join(WORK_DIR, 'icarus-log.md');
  if (!fs.existsSync(logPath)) return [];
  try {
    const content = fs.readFileSync(logPath, 'utf8');
    const entries = [];
    // Split on the separator written by appendAuditLog in tools.js
    const blocks = content.split(/\n?---\n/).filter(b => b.includes('Shell Exec Audit'));
    for (const block of blocks.slice(-20)) {
      try {
        const tsMatch      = block.match(/\[([^\]]+T[^\]]+)\] Shell Exec Audit/);
        const cmdMatch     = block.match(/\*\*Command:\*\*\s*`([^`]*)`/);
        const reasonMatch  = block.match(/\*\*Reason:\*\*\s*(.+)/);
        const scoreMatch   = block.match(/\*\*Risk Score:\*\*\s*(\d+)\/10\s*[—\-]+\s*(\w+)/);
        const factorsMatch = block.match(/\*\*Risk Factors:\*\*\s*(.+)/);
        if (tsMatch && cmdMatch) {
          entries.push({
            timestamp: tsMatch[1],
            command:   cmdMatch[1],
            reason:    reasonMatch  ? reasonMatch[1].trim()   : '',
            score:     scoreMatch   ? parseInt(scoreMatch[1]) : 0,
            label:     scoreMatch   ? scoreMatch[2]           : 'Unknown',
            factors:   factorsMatch ? factorsMatch[1].trim()  : '',
          });
        }
      } catch {}
    }
    return entries;
  } catch { return []; }
}

function parseMemory() {
  const memPath = path.join(WORK_DIR, 'memory.json');
  if (!fs.existsSync(memPath)) return { turns: 0, summary: '', lastSaved: null, format: 'none' };
  try {
    const data = JSON.parse(fs.readFileSync(memPath, 'utf8'));
    const msgs = data.messages || (Array.isArray(data) ? data : []);
    return {
      turns:     msgs.length,
      summary:   (data.summary || '').slice(0, 300),
      lastSaved: fs.statSync(memPath).mtime.toISOString(),
      format:    data.v ? 'v' + data.v : 'legacy',
    };
  } catch { return { turns: 0, summary: 'Parse error', lastSaved: null, format: 'corrupt' }; }
}

function parseBriefings() {
  // Try project log first, then PM2 default log location
  const candidates = [
    path.join(WORK_DIR, 'logs/scheduler.log'),
    path.join(process.env.HOME || '/Users/' + process.env.USER, '.pm2/logs/icarus-scheduler-out.log'),
  ];
  for (const logPath of candidates) {
    if (!fs.existsSync(logPath)) continue;
    try {
      const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
      const out = [];
      for (const line of lines) {
        const m = line.match(/(\S+).*?✅\s+(\w+) briefing sent \((\d+) message/);
        if (m) out.push({ timestamp: m[1], type: m[2], chunks: parseInt(m[3]) });
      }
      if (out.length) return out.slice(-10).reverse();
    } catch {}
  }
  return [];
}

function getLogTail(name, lines = 50) {
  const base    = name.replace(/^icarus-/, '');
  const outPath = path.join(WORK_DIR, 'logs/' + base + '.log');
  const errPath = path.join(WORK_DIR, 'logs/' + base + '-error.log');
  const read = p => {
    if (!fs.existsSync(p)) return [];
    try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(-lines); } catch { return []; }
  };
  return { out: read(outPath), err: read(errPath) };
}

// ─── API Routes ───────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  try {
    let pm2 = [];
    try {
      const raw = execSync('pm2 jlist', { encoding: 'utf8', timeout: 5000 });
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) pm2 = parsed;
    } catch {
      // pm2 not available — return mock so UI doesn't break
      pm2 = [{ name: 'icarus-agent', pm2_env: { status: 'unknown' }, monit: {} },
             { name: 'icarus-server', pm2_env: { status: 'unknown' }, monit: {} },
             { name: 'icarus-scheduler', pm2_env: { status: 'unknown' }, monit: {} },
             { name: 'icarus-dashboard', pm2_env: { status: 'online' }, monit: {} }];
    }
    res.json({ ok: true, data: { pm2, memory: parseMemory(), serverUptime: process.uptime() } });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

app.get('/api/audit', (req, res) => {
  try {
    const entries = parseAuditLog();
    const now = Date.now();
    const recentHigh = entries.some(e => {
      const age = now - new Date(e.timestamp).getTime();
      return age < 3600000 && (e.label === 'High' || e.label === 'Critical');
    });
    res.json({ ok: true, data: { entries, recentHigh } });
  } catch (err) { res.json({ ok: true, data: { entries: [], recentHigh: false, error: err.message } }); }
});

app.post('/api/pm2/restart/:name', (req, res) => {
  try {
    execSync('pm2 restart ' + req.params.name, { encoding: 'utf8', timeout: 10000 });
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

app.post('/api/pm2/restartall', (req, res) => {
  try { execSync('pm2 restart all', { encoding: 'utf8', timeout: 15000 }); res.json({ ok: true }); }
  catch (err) { res.json({ ok: false, error: err.message }); }
});

app.post('/api/pm2/killall', (req, res) => {
  try { execSync('pm2 stop all', { encoding: 'utf8', timeout: 15000 }); res.json({ ok: true }); }
  catch (err) { res.json({ ok: false, error: err.message }); }
});

app.get('/api/logs/:name', (req, res) => {
  try { res.json({ ok: true, data: getLogTail(req.params.name) }); }
  catch (err) { res.json({ ok: false, error: err.message }); }
});

app.get('/api/crm', async (req, res) => {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return res.json({ ok: true, data: { deals: [], contacts: [], totalValue: 0, byStage: {}, totalDeals: 0, error: 'HubSpot not configured' } });
  try {
    const headers = { Authorization: 'Bearer ' + token };
    const [dRes, cRes] = await Promise.all([
      axios.post('https://api.hubapi.com/crm/v3/objects/deals/search', {
        filters:    [{ propertyName: 'dealstage', operator: 'NEQ', value: 'closedlost' }],
        properties: ['dealname', 'dealstage', 'amount', 'closedate'],
        limit: 20, sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
      }, { headers }),
      axios.post('https://api.hubapi.com/crm/v3/objects/contacts/search', {
        properties: ['firstname', 'lastname', 'email', 'company', 'lifecyclestage'],
        limit: 10, sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
      }, { headers }),
    ]);
    const deals    = dRes.data.results || [];
    const contacts = cRes.data.results || [];
    const totalValue = deals.reduce((s, d) => s + (parseFloat(d.properties.amount) || 0), 0);
    const byStage = {};
    for (const d of deals) { const st = d.properties.dealstage || 'unknown'; byStage[st] = (byStage[st] || 0) + 1; }
    res.json({ ok: true, data: { deals, contacts, totalValue, byStage, totalDeals: deals.length } });
  } catch (err) { res.json({ ok: true, data: { deals: [], contacts: [], totalValue: 0, byStage: {}, totalDeals: 0, error: err.response?.data?.message || err.message } }); }
});

app.get('/api/notion', async (req, res) => {
  const token = process.env.NOTION_TOKEN;
  const dbId  = process.env.NOTION_OPS_LOG_DB;
  if (!token || !dbId) return res.json({ ok: true, data: { entries: [], error: !token ? 'Notion not configured' : 'NOTION_OPS_LOG_DB not set — run setup' } });
  try {
    const notion = new NotionClient({ auth: token });
    const resp   = await notion.databases.query({
      database_id: dbId,
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
      page_size: 15,
    });
    const entries = resp.results.map(page => {
      const p = page.properties;
      return {
        id:       page.id,
        date:     page.created_time,
        action:   p.Action?.title?.[0]?.text?.content || p.Name?.title?.[0]?.text?.content || '—',
        outcome:  p.Outcome?.rich_text?.[0]?.text?.content || '—',
        status:   p.Status?.select?.name  || '—',
        category: p.Category?.select?.name || '—',
      };
    });
    res.json({ ok: true, data: { entries } });
  } catch (err) { res.json({ ok: true, data: { entries: [], error: err.message } }); }
});

app.get('/api/memory', (req, res) => {
  try { res.json({ ok: true, data: parseMemory() }); }
  catch (err) { res.json({ ok: true, data: { turns: 0, summary: '', lastSaved: null, format: 'none', error: err.message } }); }
});

app.post('/api/memory/wipe', (req, res) => {
  try {
    const memPath = path.join(WORK_DIR, 'memory.json');
    if (fs.existsSync(memPath)) fs.renameSync(memPath, path.join(WORK_DIR, 'memory-backup-' + Date.now() + '.json'));
    fs.writeFileSync(memPath, JSON.stringify({ v: 2, summary: '', messages: [] }, null, 2));
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

app.get('/api/briefings', (req, res) => {
  try { res.json({ ok: true, data: parseBriefings() }); }
  catch (err) { res.json({ ok: true, data: [] }); }
});

app.post('/api/whatsapp/send', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.json({ ok: false, error: 'message required' });
  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.messages.create({ from: process.env.TWILIO_WHATSAPP_NUMBER, to: 'whatsapp:' + process.env.MY_WHATSAPP_NUMBER, body: message });
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

app.post('/api/briefing/trigger', (req, res) => {
  const { type } = req.body;
  if (!['morning', 'evening'].includes(type)) return res.json({ ok: false, error: 'type must be morning or evening' });
  try {
    spawn('node', ['-e', 'require("./scheduler").sendBriefing("' + type + '").catch(console.error).finally(()=>process.exit(0))'],
      { cwd: WORK_DIR, env: process.env, detached: true, stdio: 'ignore' }).unref();
    res.json({ ok: true, message: type + ' briefing triggered' });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

app.get('/api/auth/status', (req, res) => {
  const tokenPath = path.join(WORK_DIR, 'gmail_token.json');
  if (!fs.existsSync(tokenPath)) return res.json({ authenticated: false, action: 'No token — re-authenticate', hasCalendarScope: false, hasGmailScope: false });
  try {
    const token  = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    const scopes = (token.scope || '').split(' ').filter(Boolean);
    const expired = token.expiry_date ? Date.now() > token.expiry_date : null;
    const hasCal  = scopes.some(s => s.includes('calendar'));
    const hasGml  = scopes.some(s => s.includes('gmail'));
    res.json({
      authenticated: !!(token.access_token || token.refresh_token),
      hasRefreshToken: !!token.refresh_token,
      expiry: token.expiry_date ? new Date(token.expiry_date).toISOString() : 'unknown',
      expired, hasCalendarScope: hasCal, hasGmailScope: hasGml, scopes,
      action: (!hasCal || !hasGml) ? 'Missing scopes — re-authenticate' : (expired ? 'Token expired — re-authenticate' : 'OK'),
    });
  } catch { res.json({ authenticated: false, action: 'Token corrupt — re-authenticate', hasCalendarScope: false, hasGmailScope: false }); }
});

app.post('/api/audit/clear', (req, res) => {
  try {
    const logPath = path.join(WORK_DIR, 'icarus-log.md');
    if (fs.existsSync(logPath)) fs.renameSync(logPath, path.join(WORK_DIR, 'icarus-log-archive-' + Date.now() + '.md'));
    fs.writeFileSync(logPath, '# ICARUS OPERATIONS LOG\n*Maintained by Icarus. Append only. Never delete entries.*\n\n');
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

// ─── HTML pages ───────────────────────────────────────────────────────────────

function loginPage(error) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ICARUS // ACCESS</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#050505;color:#00ff9d;font-family:'JetBrains Mono','Courier New',monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;overflow:hidden}
canvas{position:fixed;top:0;left:0;z-index:0;opacity:.06}
.scanlines{position:fixed;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,.03) 2px,rgba(0,0,0,.04) 4px);pointer-events:none;z-index:1}
.box{position:relative;z-index:2;border:1px solid #00ff9d;padding:52px 60px;box-shadow:0 0 40px rgba(0,255,157,.12),0 0 80px rgba(0,255,157,.04);min-width:380px}
.logo{font-size:.65rem;letter-spacing:.5em;color:#446644;margin-bottom:28px;text-align:center}
h1{font-size:1.15rem;letter-spacing:.35em;margin-bottom:6px;text-align:center}
h1 em{animation:blink 1s step-end infinite;font-style:normal}
.sub{font-size:.6rem;letter-spacing:.2em;color:#446644;text-align:center;margin-bottom:36px}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
label{display:block;font-size:.65rem;letter-spacing:.2em;color:#446644;margin-bottom:8px}
input{width:100%;background:#0a0a0a;border:1px solid #1a2e1a;color:#00ff9d;padding:12px 14px;font-family:inherit;font-size:.9rem;outline:none;margin-bottom:28px;transition:border-color .2s}
input:focus{border-color:#00ff9d;box-shadow:0 0 8px rgba(0,255,157,.15)}
button{width:100%;background:transparent;border:1px solid #00ff9d;color:#00ff9d;padding:13px;font-family:inherit;font-size:.8rem;letter-spacing:.3em;cursor:pointer;transition:all .2s;position:relative;overflow:hidden}
button::before{content:'';position:absolute;inset:0;background:#00ff9d;transform:translateX(-100%);transition:transform .2s;z-index:0}
button:hover::before{transform:translateX(0)}
button span{position:relative;z-index:1;transition:color .2s}
button:hover span{color:#050505}
.err{color:#ff3366;font-size:.7rem;margin-bottom:18px;text-align:center;border:1px solid rgba(255,51,102,.3);padding:8px;background:rgba(255,51,102,.05)}
</style>
</head>
<body>
<canvas id="c"></canvas>
<div class="scanlines"></div>
<div class="box">
  <div class="logo">OPENCLAW // EGO</div>
  <h1>ICARUS<em>_</em></h1>
  <div class="sub">COMMAND CENTRE // AUTHENTICATE</div>
  ${error ? '<div class="err">⚠ ' + error + '</div>' : ''}
  <form method="POST" action="/login">
    <label>ACCESS CODE</label>
    <input type="password" name="password" autofocus autocomplete="current-password">
    <button type="submit"><span>[ AUTHENTICATE ]</span></button>
  </form>
</div>
<script>
var c=document.getElementById('c'),x=c.getContext('2d');
c.width=window.innerWidth;c.height=window.innerHeight;
var cols=Math.floor(c.width/18),drops=[];
for(var i=0;i<cols;i++)drops[i]=Math.random()*c.height/18;
setInterval(function(){
  x.fillStyle='rgba(5,5,5,0.07)';x.fillRect(0,0,c.width,c.height);
  x.fillStyle='rgba(0,255,157,0.5)';x.font='13px monospace';
  for(var i=0;i<drops.length;i++){
    x.fillText(String.fromCharCode(0x30A0+Math.random()*96),i*18,drops[i]*18);
    if(drops[i]*18>c.height&&Math.random()>.975)drops[i]=0;
    drops[i]++;
  }
},55);
</script>
</body>
</html>`;
}

function dashboardPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ICARUS COMMAND CENTRE</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#050505;--bg-card:#0d0d0d;--bg-card2:#0a0a0a;
  --border:#00ff9d;--border-dim:#003322;
  --g:#00ff9d;--b:#00b4ff;--r:#ff3366;--a:#ffaa00;--p:#bf00ff;
  --tp:#e0ffe0;--td:#446644;
}
html,body{height:100%}
body{background:var(--bg);color:var(--tp);font-family:'JetBrains Mono','Courier New',monospace;font-size:12px;padding-bottom:148px;overflow-x:hidden}
canvas#mx{position:fixed;top:0;left:0;width:100%;height:100%;z-index:0;opacity:.04;pointer-events:none}
.scanlines{position:fixed;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,.03) 2px,rgba(0,0,0,.03) 4px);pointer-events:none;z-index:1}

/* Header */
#hdr{position:sticky;top:0;z-index:50;background:rgba(5,5,5,.97);border-bottom:1px solid #0a1a0a;padding:14px 24px 12px;display:flex;align-items:center;justify-content:space-between}
.hdr-left h1{font-size:1.5rem;font-weight:700;letter-spacing:.3em;color:var(--g);line-height:1;position:relative;display:inline-block}
.hdr-left h1::after{content:'_';animation:blink 1s step-end infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
.glitch{animation:glitch 5s infinite}
@keyframes glitch{
  0%,88%,100%{clip-path:none;transform:none;color:var(--g)}
  89%{clip-path:polygon(0 20%,100% 20%,100% 45%,0 45%);transform:translate(-3px,0);color:var(--r)}
  90%{clip-path:polygon(0 55%,100% 55%,100% 78%,0 78%);transform:translate(3px,0);color:var(--b)}
  91%{clip-path:none;transform:none;color:var(--g)}
  92%{clip-path:polygon(0 5%,100% 5%,100% 25%,0 25%);transform:translate(-2px,0)}
  93%{clip-path:none;transform:none}
}
.hdr-sub{font-size:.55rem;letter-spacing:.25em;color:var(--td);margin-top:4px}
.hdr-right{display:flex;align-items:center;gap:20px}
#live-clock{font-size:.8rem;color:var(--g);letter-spacing:.1em;min-width:120px;text-align:right}
#countdown{font-size:.6rem;color:var(--td);letter-spacing:.1em}
.hdr-btns{display:flex;gap:8px}
.btn-hdr{font-family:inherit;font-size:.6rem;background:transparent;border:1px solid #1a2e1a;color:var(--td);padding:5px 10px;cursor:pointer;letter-spacing:.1em;transition:all .15s}
.btn-hdr:hover{border-color:var(--r);color:var(--r)}

/* Grid */
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;padding:14px 20px;position:relative;z-index:2}
@media(max-width:1200px){.grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:700px){.grid{grid-template-columns:1fr}}
.span2{grid-column:span 2}
@media(max-width:1200px){.span2{grid-column:span 1}}

/* Cards */
.card{background:var(--bg-card);border:1px solid var(--border-dim);border-radius:4px;box-shadow:0 0 8px rgba(0,255,157,.04);transition:border-color .3s,box-shadow .3s;position:relative;z-index:2;animation:card-enter .5s ease both}
.card:hover{border-color:var(--border);box-shadow:0 0 15px rgba(0,255,157,.12),0 0 30px rgba(0,255,157,.05)}
@keyframes card-enter{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.card:nth-child(1){animation-delay:.05s}.card:nth-child(2){animation-delay:.1s}
.card:nth-child(3){animation-delay:.15s}.card:nth-child(4){animation-delay:.2s}
.card:nth-child(5){animation-delay:.25s}.card:nth-child(6){animation-delay:.3s}
.card-alert{border-color:var(--r)!important;box-shadow:0 0 12px rgba(255,51,102,.15)!important}
.card-hdr{padding:11px 14px;border-bottom:1px solid #111;display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:40px}
.card-title{font-size:.68rem;font-weight:700;letter-spacing:.2em;color:var(--g);display:flex;align-items:center;gap:8px}
.title-dot{width:6px;height:6px;border-radius:50%;background:var(--g);box-shadow:0 0 6px var(--g);animation:pdot 2s ease-in-out infinite;flex-shrink:0}
@keyframes pdot{0%,100%{box-shadow:0 0 4px var(--g)}50%{box-shadow:0 0 10px var(--g),0 0 20px rgba(0,255,157,.3)}}
.card-body{padding:12px 14px;max-height:400px;overflow-y:auto}
.card-body::-webkit-scrollbar{width:3px}
.card-body::-webkit-scrollbar-track{background:#0a0a0a}
.card-body::-webkit-scrollbar-thumb{background:#1a2e1a}
.card-footer{padding:6px 14px;border-top:1px solid #0d0d0d;font-size:.6rem;color:var(--td);text-align:right}
.card-body.scrollable{max-height:320px;overflow-y:auto}

/* Buttons */
.btn{font-family:inherit;font-size:.65rem;letter-spacing:.08em;background:transparent;border:1px solid #1e1e1e;color:#666;padding:4px 9px;cursor:pointer;transition:all .15s;white-space:nowrap;border-radius:2px}
.btn:hover{border-color:var(--g);color:var(--g);box-shadow:0 0 6px rgba(0,255,157,.15)}
.btn-danger:hover{border-color:var(--r);color:var(--r);box-shadow:0 0 6px rgba(255,51,102,.15)}
.btn-amber:hover{border-color:var(--a);color:var(--a)}
.btn-sm{padding:3px 7px;font-size:.6rem}
.btn-group{display:flex;gap:5px;flex-wrap:wrap;align-items:center}

/* Status dots */
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex-shrink:0;vertical-align:middle}
.dot-g{background:var(--g);box-shadow:0 0 5px var(--g);animation:pg 2s ease-in-out infinite}
.dot-r{background:var(--r);box-shadow:0 0 5px var(--r)}
.dot-a{background:var(--a);box-shadow:0 0 5px var(--a);animation:pa 2s ease-in-out infinite}
.dot-u{background:#333}
@keyframes pg{0%,100%{box-shadow:0 0 3px var(--g)}50%{box-shadow:0 0 10px var(--g)}}
@keyframes pa{0%,100%{box-shadow:0 0 3px var(--a)}50%{box-shadow:0 0 10px var(--a)}}

/* Badges */
.badge{font-size:.58rem;letter-spacing:.08em;padding:2px 7px;border:1px solid;border-radius:2px;font-weight:700;white-space:nowrap;display:inline-block}
.bl{color:var(--g);border-color:var(--g)}
.bm{color:var(--b);border-color:var(--b)}
.bh{color:var(--a);border-color:var(--a);box-shadow:0 0 4px rgba(255,170,0,.2)}
.bc{color:var(--r);border-color:var(--r);animation:pcrit 1s ease-in-out infinite}
@keyframes pcrit{0%,100%{box-shadow:0 0 4px rgba(255,51,102,.3)}50%{box-shadow:0 0 12px rgba(255,51,102,.6)}}
.alert-badge{font-size:.6rem;background:var(--r);color:#fff;padding:2px 8px;border-radius:2px;animation:pcrit 1s ease-in-out infinite;letter-spacing:.1em}

/* Process rows */
.proc{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #0f0f0f}
.proc:last-child{border-bottom:none}
.proc-info{flex:1;min-width:0}
.proc-name{color:var(--g);font-weight:700;font-size:.75rem}
.proc-meta{display:flex;gap:12px;margin-top:4px;flex-wrap:wrap}
.proc-meta span{font-size:.62rem;color:var(--td)}
.mem-bar-wrap{width:60px;flex-shrink:0}
.mem-bar-bg{height:5px;background:#111;border-radius:2px;overflow:hidden}
.mem-bar-fill{height:100%;background:var(--g);border-radius:2px;box-shadow:0 0 4px rgba(0,255,157,.4);transition:width .5s}
.mem-label{font-size:.58rem;color:var(--td);margin-top:2px;text-align:center}

/* Audit table */
.atbl{width:100%;border-collapse:collapse}
.atbl th{font-size:.6rem;letter-spacing:.1em;color:var(--td);padding:4px 8px;border-bottom:1px solid #111;font-weight:400;text-align:left}
.atbl td{padding:6px 8px;border-bottom:1px solid #0d0d0d;vertical-align:middle}
.atbl tr:last-child td{border-bottom:none}
.atbl tr:hover td{background:rgba(0,255,157,.02)}
.cmd-code{font-family:inherit;color:var(--g);font-size:.7rem;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
.ts-small{color:var(--td);font-size:.6rem;white-space:nowrap}

/* CRM */
.crm-summary{display:flex;gap:20px;margin-bottom:12px;flex-wrap:wrap}
.crm-stat{text-align:center;padding:8px 16px;border:1px solid #111;background:#0a0a0a}
.crm-num{font-size:2rem;font-weight:700;line-height:1}
.crm-lbl{font-size:.58rem;letter-spacing:.15em;color:var(--td);margin-top:3px}
.pipeline-stages{display:flex;align-items:center;gap:0;margin:10px 0;overflow-x:auto;padding-bottom:4px}
.ps-box{border:1px solid #1a2e1a;padding:6px 10px;min-width:90px;text-align:center;flex-shrink:0;transition:border-color .2s}
.ps-box:hover{border-color:var(--g)}
.ps-count{font-size:1.2rem;font-weight:700;color:var(--g)}
.ps-name{font-size:.55rem;color:var(--td);margin-top:2px;line-height:1.3}
.ps-arrow{color:var(--border-dim);padding:0 4px;font-size:.8rem;flex-shrink:0}
.deal-row{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid #0d0d0d}
.deal-row:last-child{border-bottom:none}
.deal-bar{width:3px;height:32px;border-radius:1px;flex-shrink:0}
.deal-name{flex:1;color:var(--g);font-size:.72rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.deal-meta{font-size:.6rem;color:var(--td)}
.contact-row{display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid #0d0d0d}
.contact-row:last-child{border-bottom:none}
.contact-name{color:var(--tp);font-size:.72rem;min-width:100px}
.contact-meta{font-size:.6rem;color:var(--td);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Notion feed */
.notion-entry{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #0d0d0d}
.notion-entry:last-child{border-bottom:none}
.notion-bar{width:3px;border-radius:1px;flex-shrink:0;align-self:stretch;min-height:28px}
.notion-action{color:var(--tp);font-size:.72rem;line-height:1.4}
.notion-out{font-size:.62rem;color:var(--td);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px}
.notion-date{font-size:.58rem;color:var(--td);white-space:nowrap;margin-left:auto;padding-left:8px}

/* Memory */
.mem-stats{display:flex;gap:0;margin-bottom:10px}
.mem-stat{flex:1;text-align:center;padding:10px 8px;border:1px solid #0f0f0f}
.mem-stat-n{font-size:1.8rem;font-weight:700;color:var(--g);line-height:1}
.mem-stat-l{font-size:.58rem;letter-spacing:.12em;color:var(--td);margin-top:3px}
.summary-box{background:#070707;border:1px solid #0f1a0f;padding:10px 12px;font-size:.68rem;color:var(--td);line-height:1.7;max-height:82px;overflow:hidden;position:relative;margin-top:8px}
.summary-box::after{content:'';position:absolute;bottom:0;left:0;right:0;height:20px;background:linear-gradient(transparent,#070707)}

/* Briefings */
.br-row{border-bottom:1px solid #0d0d0d}
.br-row:last-child{border-bottom:none}
.br-header{display:flex;align-items:center;gap:8px;padding:8px 0;cursor:pointer;user-select:none}
.br-header:hover .br-title{color:var(--g)}
.br-title{flex:1;font-size:.7rem;color:var(--tp);transition:color .15s}
.br-arrow{color:var(--td);font-size:.6rem;transition:transform .2s;flex-shrink:0}
.br-detail{max-height:0;overflow:hidden;transition:max-height .3s ease,opacity .3s ease;opacity:0}
.br-detail.open{max-height:200px;opacity:1}
.br-content{background:#070707;border:1px solid #0f1a0f;padding:8px 10px;font-size:.65rem;color:var(--td);line-height:1.6;overflow-y:auto;max-height:180px;margin-bottom:8px;white-space:pre-wrap}

/* Stage bar chart (CSS only) */
.bar-row{display:flex;align-items:center;gap:8px;margin:3px 0}
.bar-label{min-width:110px;font-size:.65rem;color:var(--td);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-fill{height:8px;background:var(--g);border-radius:1px;min-width:3px;box-shadow:0 0 4px rgba(0,255,157,.3)}
.bar-count{font-size:.65rem;color:var(--tp)}

/* Skeleton loader */
.skel{background:#0f0f0f;border-radius:2px;animation:sk 1.5s ease-in-out infinite}
@keyframes sk{0%,100%{opacity:.4}50%{opacity:.7}}
.skel-row{display:flex;gap:8px;margin:8px 0;align-items:center}

/* Section sub-header */
.sec-sub{font-size:.58rem;letter-spacing:.15em;color:var(--td);margin:10px 0 6px;padding-bottom:4px;border-bottom:1px solid #0f0f0f}

/* Info/error states */
.state-info{font-size:.7rem;color:var(--td);padding:12px 0;text-align:center;line-height:1.7}
.state-err{font-size:.7rem;color:var(--r);padding:12px 0;text-align:center}

/* Controls panel */
#ctrl{position:fixed;bottom:0;left:0;right:0;z-index:100;background:rgba(8,8,8,.98);border-top:1px solid var(--border-dim);box-shadow:0 -4px 30px rgba(0,255,157,.06)}
.ctrl-inner{display:flex;flex-wrap:wrap;gap:2px;align-items:stretch;padding:0 12px}
.ctrl-group{display:flex;align-items:center;gap:8px;padding:10px 14px;border-right:1px solid #0f0f0f}
.ctrl-group:last-child{border-right:none;margin-left:auto}
.ctrl-lbl{font-size:.58rem;letter-spacing:.2em;color:var(--td);white-space:nowrap}
.ctrl-input{background:#0a0a0a;border:1px solid #1a1a1a;color:var(--g);padding:6px 9px;font-family:inherit;font-size:.7rem;outline:none;transition:border-color .2s;min-width:0}
.ctrl-input:focus{border-color:var(--g);box-shadow:0 0 6px rgba(0,255,157,.1)}
.ctrl-select{background:#0a0a0a;border:1px solid #1a1a1a;color:var(--g);padding:6px 8px;font-family:inherit;font-size:.7rem;outline:none;cursor:pointer}
.ctrl-select:focus{border-color:var(--g)}
.ctrl-auth-dot{width:8px;height:8px;border-radius:50%;background:#333;flex-shrink:0}
.ctrl-auth-txt{font-size:.62rem;color:var(--td);min-width:60px;white-space:nowrap}
.shortcuts{font-size:.58rem;color:var(--td);opacity:.6;letter-spacing:.05em;padding:10px 14px;display:flex;align-items:center;white-space:nowrap}
.shortcut-hint{display:inline-block;border:1px solid #1a1a1a;padding:1px 5px;margin:0 2px;font-size:.55rem;color:#555}

/* Modal */
#modal-ov{display:none;position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:500;align-items:center;justify-content:center}
#modal-ov.open{display:flex}
#modal-box{background:#0a0a0a;border:1px solid var(--border-dim);box-shadow:0 0 40px rgba(0,255,157,.08);width:92%;max-width:860px;max-height:82vh;display:flex;flex-direction:column;border-radius:4px}
#modal-box:hover{border-color:var(--border)}
#modal-hdr{padding:11px 14px;border-bottom:1px solid #111;display:flex;justify-content:space-between;align-items:center}
#modal-title{color:var(--g);font-size:.7rem;letter-spacing:.2em}
#modal-body{padding:14px;overflow-y:auto;flex:1;font-size:.68rem;line-height:1.75;white-space:pre-wrap;color:#888;background:#070707;font-family:inherit}
#modal-body::-webkit-scrollbar{width:3px}
#modal-body::-webkit-scrollbar-thumb{background:#1a2e1a}
#modal-poll{font-size:.58rem;color:var(--td);padding:6px 14px;border-top:1px solid #111}

/* Confirm modal */
#confirm-ov{display:none;position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:600;align-items:center;justify-content:center}
#confirm-ov.open{display:flex}
#confirm-box{background:#0a0a0a;border:1px solid var(--r);box-shadow:0 0 30px rgba(255,51,102,.1);padding:36px 44px;max-width:420px;text-align:center;border-radius:4px}
.confirm-icon{font-size:1.8rem;margin-bottom:16px;color:var(--r)}
.confirm-title{font-size:.85rem;letter-spacing:.2em;color:var(--r);margin-bottom:12px;font-weight:700}
.confirm-msg{font-size:.72rem;color:#888;line-height:1.7;margin-bottom:24px}
.confirm-btns{display:flex;gap:10px;justify-content:center}
.btn-confirm-yes{font-family:inherit;font-size:.7rem;background:transparent;border:1px solid var(--r);color:var(--r);padding:9px 20px;cursor:pointer;letter-spacing:.15em;transition:all .2s}
.btn-confirm-yes:hover{background:var(--r);color:#0a0a0a}
.btn-confirm-no{font-family:inherit;font-size:.7rem;background:transparent;border:1px solid #333;color:#666;padding:9px 20px;cursor:pointer;letter-spacing:.15em;transition:all .2s}
.btn-confirm-no:hover{border-color:var(--td);color:var(--td)}

/* Toasts */
#toasts{position:fixed;bottom:145px;right:18px;z-index:700;display:flex;flex-direction:column;gap:7px;max-width:300px}
.toast{padding:9px 14px;border:1px solid;font-size:.7rem;animation:tst-in .2s ease;border-radius:2px;line-height:1.4}
.toast-ok{background:#030d05;border-color:var(--g);color:var(--g)}
.toast-err{background:#0d0305;border-color:var(--r);color:var(--r)}
@keyframes tst-in{from{opacity:0;transform:translateX(15px)}to{opacity:1;transform:translateX(0)}}

/* Counting animation class */
.counting{color:var(--g);font-weight:700}
</style>
</head>
<body>
<canvas id="mx"></canvas>
<div class="scanlines"></div>

<!-- Header -->
<div id="hdr">
  <div class="hdr-left">
    <h1 class="glitch">ICARUS COMMAND CENTRE</h1>
    <div class="hdr-sub">AUTONOMOUS OPERATIONS SYSTEM // OPENCLAW</div>
  </div>
  <div class="hdr-right">
    <div>
      <div id="live-clock">00:00:00 AEST</div>
      <div id="countdown" style="text-align:right">REFRESH IN 10s</div>
    </div>
    <div class="hdr-btns">
      <button class="btn-hdr" onclick="location.href='/logout'">[ LOGOUT ]</button>
    </div>
  </div>
</div>

<!-- Grid -->
<div class="grid">

  <!-- 1. SYSTEM STATUS -->
  <div class="card span2" id="card-status">
    <div class="card-hdr">
      <div class="card-title"><span class="title-dot"></span>SYSTEM STATUS</div>
      <div class="btn-group">
        <button class="btn btn-sm" onclick="pm2Do('restartall')">[ RESTART ALL ]</button>
        <button class="btn btn-sm btn-danger" onclick="pm2Do('killall')">[ STOP ALL ]</button>
      </div>
    </div>
    <div class="card-body" id="s-status"><div class="skel-row"><div class="skel" style="width:60%;height:14px"></div><div class="skel" style="width:20%;height:14px"></div></div><div class="skel-row"><div class="skel" style="width:50%;height:14px"></div><div class="skel" style="width:25%;height:14px"></div></div></div>
    <div class="card-footer" id="su-status"></div>
  </div>

  <!-- 2. MEMORY -->
  <div class="card" id="card-memory">
    <div class="card-hdr">
      <div class="card-title"><span class="title-dot" style="background:var(--b);box-shadow:0 0 6px var(--b)"></span>MEMORY</div>
      <button class="btn btn-sm btn-danger" onclick="openWipe()">[ WIPE ]</button>
    </div>
    <div class="card-body" id="s-memory"><div class="skel" style="width:100%;height:60px;margin-bottom:8px"></div><div class="skel" style="width:80%;height:10px"></div></div>
    <div class="card-footer" id="su-memory"></div>
  </div>

  <!-- 3. AUDIT LOG -->
  <div class="card span2" id="card-audit">
    <div class="card-hdr">
      <div class="card-title" id="audit-title-el"><span class="title-dot" style="background:var(--a);box-shadow:0 0 6px var(--a)"></span>SHELL AUDIT LOG</div>
      <button class="btn btn-sm btn-danger" onclick="openClearAudit()">[ CLEAR AUDIT ]</button>
    </div>
    <div class="card-body scrollable" id="s-audit"><div class="skel-row"><div class="skel" style="width:15%;height:12px"></div><div class="skel" style="width:45%;height:12px"></div><div class="skel" style="width:15%;height:12px"></div></div><div class="skel-row"><div class="skel" style="width:15%;height:12px"></div><div class="skel" style="width:40%;height:12px"></div><div class="skel" style="width:15%;height:12px"></div></div></div>
    <div class="card-footer" id="su-audit"></div>
  </div>

  <!-- 4. BRIEFINGS -->
  <div class="card" id="card-briefings">
    <div class="card-hdr">
      <div class="card-title"><span class="title-dot" style="background:var(--b);box-shadow:0 0 6px var(--b)"></span>BRIEFINGS</div>
    </div>
    <div class="card-body scrollable" id="s-briefings"><div class="skel" style="width:100%;height:12px;margin:8px 0"></div><div class="skel" style="width:80%;height:12px;margin:8px 0"></div></div>
    <div class="card-footer" id="su-briefings"></div>
  </div>

  <!-- 5. CRM PIPELINE -->
  <div class="card span2" id="card-crm">
    <div class="card-hdr">
      <div class="card-title"><span class="title-dot" style="background:var(--p);box-shadow:0 0 6px var(--p)"></span>CRM PIPELINE</div>
    </div>
    <div class="card-body scrollable" id="s-crm"><div class="skel" style="width:100%;height:50px;margin-bottom:10px"></div><div class="skel-row"><div class="skel" style="width:70%;height:12px"></div></div><div class="skel-row"><div class="skel" style="width:60%;height:12px"></div></div></div>
    <div class="card-footer" id="su-crm"></div>
  </div>

  <!-- 6. NOTION OPS LOG -->
  <div class="card" id="card-notion">
    <div class="card-hdr">
      <div class="card-title"><span class="title-dot" style="background:var(--b);box-shadow:0 0 6px var(--b)"></span>NOTION OPS LOG</div>
    </div>
    <div class="card-body scrollable" id="s-notion"><div class="skel" style="width:100%;height:12px;margin:8px 0"></div><div class="skel" style="width:85%;height:12px;margin:8px 0"></div><div class="skel" style="width:90%;height:12px;margin:8px 0"></div></div>
    <div class="card-footer" id="su-notion"></div>
  </div>

</div>

<!-- Controls -->
<div id="ctrl">
  <div class="ctrl-inner">
    <div class="ctrl-group">
      <span class="ctrl-lbl">WHATSAPP</span>
      <input class="ctrl-input" id="wa-msg" placeholder="Message to Nicholas..." style="width:200px">
      <button class="btn" onclick="doSendWA()">[ SEND ]</button>
    </div>
    <div class="ctrl-group">
      <span class="ctrl-lbl">BRIEFING</span>
      <select class="ctrl-select" id="br-type"><option value="morning">Morning</option><option value="evening">Evening</option></select>
      <button class="btn" onclick="doTriggerBriefing()">[ TRIGGER ]</button>
    </div>
    <div class="ctrl-group">
      <span class="ctrl-lbl">AUTH</span>
      <div class="ctrl-auth-dot" id="auth-dot"></div>
      <span class="ctrl-auth-txt" id="auth-txt">Checking...</span>
      <button class="btn btn-sm" onclick="checkAuth()">[ CHECK ]</button>
      <button class="btn btn-sm" onclick="window.open('http://'+location.hostname+':3000/auth','_blank')">[ RE-AUTH ]</button>
    </div>
    <div class="ctrl-group">
      <span class="ctrl-lbl">MEMORY</span>
      <button class="btn btn-sm btn-danger" onclick="openWipe()">[ WIPE ]</button>
    </div>
    <div class="shortcuts">
      <span class="shortcut-hint">R</span>restart
      <span class="shortcut-hint" style="margin-left:8px">B</span>briefing
      <span class="shortcut-hint" style="margin-left:8px">W</span>wipe
      <span class="shortcut-hint" style="margin-left:8px">L</span>logs
      <span class="shortcut-hint" style="margin-left:8px">ESC</span>close
    </div>
  </div>
</div>

<!-- Log modal -->
<div id="modal-ov" onclick="if(event.target===this)closeModal()">
  <div id="modal-box">
    <div id="modal-hdr">
      <span id="modal-title">LOGS</span>
      <button class="btn btn-sm" onclick="closeModal()">[ CLOSE ]</button>
    </div>
    <div id="modal-body">Loading...</div>
    <div id="modal-poll"></div>
  </div>
</div>

<!-- Confirm modal -->
<div id="confirm-ov">
  <div id="confirm-box">
    <div class="confirm-icon">(!)</div>
    <div class="confirm-title" id="confirm-title">CONFIRM ACTION</div>
    <div class="confirm-msg" id="confirm-msg">Are you sure?</div>
    <div class="confirm-btns">
      <button class="btn-confirm-yes" id="confirm-yes-btn">[ CONFIRM ]</button>
      <button class="btn-confirm-no" onclick="closeConfirm()">[ CANCEL ]</button>
    </div>
  </div>
</div>

<!-- Toasts -->
<div id="toasts"></div>

<script>
console.log('ICARUS BOOT OK', new Date().toISOString());
// Matrix canvas - wrapped in try/catch so any failure does not halt the rest of the script
try{(function(){
  var c=document.getElementById('mx');
  if(!c)return;
  var x=c.getContext('2d');
  if(!x)return;
  function resize(){c.width=window.innerWidth;c.height=window.innerHeight;}
  resize();window.addEventListener('resize',resize);
  var cols=Math.floor(c.width/18),drops=[];
  for(var i=0;i<cols;i++)drops[i]=Math.random()*(c.height/18);
  setInterval(function(){
    x.fillStyle='rgba(5,5,5,0.06)';x.fillRect(0,0,c.width,c.height);
    x.fillStyle='rgba(0,255,157,0.45)';x.font='13px JetBrains Mono,monospace';
    for(var i=0;i<drops.length;i++){
      x.fillText(String.fromCharCode(0x30A0+Math.floor(Math.random()*96)),i*18,drops[i]*18);
      if(drops[i]*18>c.height&&Math.random()>.975)drops[i]=0;
      drops[i]++;
    }
  },55);
})();}catch(e){}

// Clock - pure manual string build, no Intl API
function updateClock(){
  var d=new Date();
  var utc=d.getTime()+d.getTimezoneOffset()*60000;
  var aest=new Date(utc+10*3600000);
  var hh=String(aest.getHours()).padStart(2,'0');
  var mm=String(aest.getMinutes()).padStart(2,'0');
  var ss=String(aest.getSeconds()).padStart(2,'0');
  document.getElementById('live-clock').textContent=hh+':'+mm+':'+ss+' AEST';
}
setInterval(updateClock,1000);updateClock();

// Countdown
var cdVal=10;
function updateCd(){
  cdVal--;
  document.getElementById('countdown').textContent='REFRESH IN '+cdVal+'s';
  if(cdVal<=0){cdVal=10;refreshAll();}
}
setInterval(updateCd,1000);

// Helpers
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function fmtTs(ts){if(!ts)return '--';try{var d=new Date(ts);var utc=d.getTime()+d.getTimezoneOffset()*60000;var a=new Date(utc+10*3600000);var mon=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];return mon[a.getMonth()]+' '+a.getDate()+' '+String(a.getHours()).padStart(2,'0')+':'+String(a.getMinutes()).padStart(2,'0');}catch(e){return String(ts).slice(0,16).replace('T',' ');}}
function fmtBytes(b){if(b==null)return '--';if(b<1048576)return (b/1024).toFixed(1)+' KB';return (b/1048576).toFixed(1)+' MB';}
function fmtUptime(ms){if(!ms)return '--';var s=Math.floor((Date.now()-ms)/1000);if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m';return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';}
function setUpdated(id){var el=document.getElementById('su-'+id);if(!el)return;var d=new Date();var utc=d.getTime()+d.getTimezoneOffset()*60000;var a=new Date(utc+10*3600000);el.textContent='Updated '+String(a.getHours()).padStart(2,'0')+':'+String(a.getMinutes()).padStart(2,'0')+':'+String(a.getSeconds()).padStart(2,'0');}
function animate(el,target,prefix,suffix,dur){
  if(!el)return;var start=0,step=Math.max(1,Math.ceil(target/40)),t=setInterval(function(){
    start=Math.min(start+step,target);el.textContent=prefix+start+suffix;
    if(start>=target)clearInterval(t);
  },dur||20);
}

// Toast
function toast(msg,ok){
  var el=document.createElement('div');
  el.className='toast '+(ok!==false?'toast-ok':'toast-err');
  el.textContent=msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(function(){el.style.opacity='0';el.style.transition='opacity .3s';setTimeout(function(){el.remove();},300);},3000);
}

// Log modal
var _logName=null,_logTimer=null;
function openLogModal(name){
  _logName=name;
  document.getElementById('modal-title').textContent='LOGS -- '+name;
  document.getElementById('modal-body').textContent='Loading...';
  document.getElementById('modal-ov').classList.add('open');
  pollLog();
  if(_logTimer)clearInterval(_logTimer);
  _logTimer=setInterval(pollLog,3000);
}
function pollLog(){
  if(!_logName)return;
  fetch('/api/logs/'+encodeURIComponent(_logName)).then(function(r){return r.json();}).then(function(d){
    if(!d.ok){document.getElementById('modal-body').textContent='Error: '+d.error;return;}
    var lines=d.data.out.slice();
    if(d.data.err.length)lines=lines.concat(['','-- STDERR --',''].concat(d.data.err));
    document.getElementById('modal-body').textContent=lines.join('\n')||'(no output)';
    var mb=document.getElementById('modal-body');mb.scrollTop=mb.scrollHeight;
    var _pd=new Date();var _utc=_pd.getTime()+_pd.getTimezoneOffset()*60000;var _a=new Date(_utc+10*3600000);document.getElementById('modal-poll').textContent='Polling every 3s | '+String(_a.getHours()).padStart(2,'0')+':'+String(_a.getMinutes()).padStart(2,'0')+':'+String(_a.getSeconds()).padStart(2,'0');
  });
}
function closeModal(){
  document.getElementById('modal-ov').classList.remove('open');
  if(_logTimer){clearInterval(_logTimer);_logTimer=null;}_logName=null;
  document.getElementById('modal-poll').textContent='';
}

// Confirm modal
var _confirmCb=null;
function openConfirm(title,msg,cb){
  document.getElementById('confirm-title').textContent=title;
  document.getElementById('confirm-msg').textContent=msg;
  document.getElementById('confirm-ov').classList.add('open');
  _confirmCb=cb;
  document.getElementById('confirm-yes-btn').onclick=function(){closeConfirm();if(_confirmCb)_confirmCb();};
}
function closeConfirm(){document.getElementById('confirm-ov').classList.remove('open');_confirmCb=null;}

// PM2
function pm2Do(action,name){
  var url=action==='restartall'?'/api/pm2/restartall':action==='killall'?'/api/pm2/killall':'/api/pm2/restart/'+encodeURIComponent(name);
  fetch(url,{method:'POST'}).then(function(r){return r.json();}).then(function(d){
    toast(d.ok?'Done: '+action:'Error: '+d.error,d.ok);
    if(d.ok)setTimeout(function(){refreshStatus();},1500);
  }).catch(function(e){toast('Error: '+e.message,false);});
}

// Wipe
function openWipe(){
  openConfirm('WIPE MEMORY','THIS WILL DELETE CONVERSATION MEMORY.\nCurrent memory backed up to memory-backup-[ts].json.\nIcarus will lose all conversation context.',function(){
    fetch('/api/memory/wipe',{method:'POST'}).then(function(r){return r.json();}).then(function(d){
      toast(d.ok?'Memory wiped. Backup saved.':'Error: '+d.error,d.ok);
      if(d.ok)refreshMemory();
    });
  });
}

// Audit clear
function openClearAudit(){
  openConfirm('CLEAR AUDIT LOG','icarus-log.md will be archived to icarus-log-archive-[ts].md and reset.',function(){
    fetch('/api/audit/clear',{method:'POST'}).then(function(r){return r.json();}).then(function(d){
      toast(d.ok?'Audit log archived.':'Error: '+d.error,d.ok);
      if(d.ok)refreshAudit();
    });
  });
}

// WhatsApp
function doSendWA(){
  var msg=document.getElementById('wa-msg').value.trim();
  if(!msg){toast('Enter a message.',false);return;}
  fetch('/api/whatsapp/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg})})
    .then(function(r){return r.json();}).then(function(d){
      toast(d.ok?'Sent via WhatsApp.':'Error: '+d.error,d.ok);
      if(d.ok)document.getElementById('wa-msg').value='';
    });
}

// Briefing
function doTriggerBriefing(){
  var type=document.getElementById('br-type').value;
  fetch('/api/briefing/trigger',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:type})})
    .then(function(r){return r.json();}).then(function(d){
      toast(d.ok?type+' briefing triggered.':'Error: '+d.error,d.ok);
    });
}

// Auth
function checkAuth(){
  fetch('/api/auth/status').then(function(r){return r.json();}).then(function(d){
    var dot=document.getElementById('auth-dot');
    var txt=document.getElementById('auth-txt');
    if(d.action==='OK'){dot.style.background='var(--g)';dot.style.boxShadow='0 0 6px var(--g)';txt.textContent='CAL+GML OK';}
    else if(!d.authenticated){dot.style.background='var(--r)';dot.style.boxShadow='0 0 6px var(--r)';txt.textContent='NOT AUTH';}
    else{dot.style.background='var(--a)';dot.style.boxShadow='0 0 6px var(--a)';txt.textContent=d.action.slice(0,20);}
  }).catch(function(){document.getElementById('auth-txt').textContent='Error';});
}

// --- RENDERERS ---

function renderStatus(data){
  console.log('[icarus] renderStatus', data);
  var pm2=data.pm2||[];
  if(!pm2.length){document.getElementById('s-status').innerHTML='<div class="state-info">No PM2 processes found.</div>';return;}
  var maxMem=pm2.reduce(function(m,p){return Math.max(m,(p.monit||{}).memory||0);},1);
  var html=[];
  for(var i=0;i<pm2.length;i++){
    var p=pm2[i],env=p.pm2_env||{},mon=p.monit||{},st=env.status||'unknown';
    var dotCls=st==='online'?'dot-g':st==='erroring'?'dot-a':st==='unknown'?'dot-u':'dot-r';
    var memPct=mon.memory?Math.round((mon.memory/maxMem)*100):0;
    html.push(
      '<div class="proc">'+
        '<span class="dot '+dotCls+'" style="margin-right:4px"></span>'+
        '<div class="proc-info">'+
          '<div style="display:flex;align-items:center;gap:8px">'+
            '<span class="proc-name">'+esc(p.name)+'</span>'+
            '<span class="badge '+(st==='online'?'bl':st==='erroring'?'bh':st==='unknown'?'':' ')+'">'+st.toUpperCase()+'</span>'+
          '</div>'+
          '<div class="proc-meta">'+
            '<span>restarts: '+(env.restart_time||0)+'</span>'+
            '<span>up: '+fmtUptime(env.pm_uptime)+'</span>'+
            '<span>CPU '+(mon.cpu!=null?mon.cpu.toFixed(1)+'%':'--')+'</span>'+
          '</div>'+
        '</div>'+
        '<div class="mem-bar-wrap">'+
          '<div class="mem-bar-bg"><div class="mem-bar-fill" style="width:'+memPct+'%"></div></div>'+
          '<div class="mem-label">'+fmtBytes(mon.memory)+'</div>'+
        '</div>'+
        '<div class="btn-group" style="margin-left:8px">'+
          '<button class="btn btn-sm" onclick="pm2Do(\'restart\',\''+esc(p.name)+'\')">[ RESTART ]</button>'+
          '<button class="btn btn-sm" onclick="openLogModal(\''+esc(p.name)+'\')">[ LOGS ]</button>'+
        '</div>'+
      '</div>'
    );
  }
  document.getElementById('s-status').innerHTML=html.join('');
  setUpdated('status');
}

function renderAudit(data){
  console.log('[icarus] renderAudit', data);
  var entries=data.entries||[],hi=data.recentHigh;
  var titleEl=document.getElementById('audit-title-el');
  var cardEl=document.getElementById('card-audit');
  if(hi){
    titleEl.innerHTML='<span class="title-dot" style="background:var(--r);box-shadow:0 0 6px var(--r)"></span>SHELL AUDIT LOG <span class="alert-badge">! ALERT</span>';
    cardEl.classList.add('card-alert');
  }else{
    titleEl.innerHTML='<span class="title-dot" style="background:var(--a);box-shadow:0 0 6px var(--a)"></span>SHELL AUDIT LOG';
    cardEl.classList.remove('card-alert');
  }
  if(!entries.length){document.getElementById('s-audit').innerHTML='<div class="state-info">No audit entries yet. Shell commands will appear here.</div>';setUpdated('audit');return;}
  var html=['<table class="atbl"><thead><tr><th>TIME</th><th>COMMAND</th><th>RISK</th><th>REASON</th></tr></thead><tbody>'];
  for(var i=entries.length-1;i>=0;i--){
    var e=entries[i];
    var bc=e.label==='Low'?'bl':e.label==='Medium'?'bm':e.label==='High'?'bh':'bc';
    html.push('<tr>'+
      '<td class="ts-small">'+esc(fmtTs(e.timestamp))+'</td>'+
      '<td><span class="cmd-code" title="'+esc(e.command)+'">'+esc(e.command.slice(0,42))+'</span></td>'+
      '<td><span class="badge '+bc+'">'+esc(e.label.toUpperCase())+'</span> <span style="color:var(--td);font-size:.6rem">'+e.score+'</span></td>'+
      '<td class="ts-small">'+esc((e.reason||'').slice(0,32))+'</td>'+
    '</tr>');
  }
  html.push('</tbody></table>');
  document.getElementById('s-audit').innerHTML=html.join('');
  setUpdated('audit');
}

function renderMemory(data){
  console.log('[icarus] renderMemory', data);
  var html='<div class="mem-stats">'+
    '<div class="mem-stat"><div class="mem-stat-n counting" id="mem-turns-n">0</div><div class="mem-stat-l">TURNS</div></div>'+
    '<div class="mem-stat"><div class="mem-stat-n" style="font-size:.9rem;color:var(--b)">'+esc(data.format||'--')+'</div><div class="mem-stat-l">FORMAT</div></div>'+
  '</div>'+
  '<div style="font-size:.62rem;color:var(--td);margin-bottom:6px">Last saved: '+esc(fmtTs(data.lastSaved))+'</div>';
  if(data.summary){html+='<div class="summary-box">'+esc(data.summary)+(data.summary.length>=300?'...':'')+'</div>';}
  else{html+='<div class="state-info" style="padding:8px 0">No summary stored.</div>';}
  document.getElementById('s-memory').innerHTML=html;
  animate(document.getElementById('mem-turns-n'),data.turns||0,'','');
  setUpdated('memory');
}

function renderCRM(data){
  console.log('[icarus] renderCRM', data);
  var html='';
  if(data.error&&!data.totalDeals){
    html='<div class="state-info">'+esc(data.error)+'</div>';
    document.getElementById('s-crm').innerHTML=html;setUpdated('crm');return;
  }
  // Summary
  html+='<div class="crm-summary">'+
    '<div class="crm-stat"><div class="crm-num counting" id="crm-deals-n">0</div><div class="crm-lbl">OPEN DEALS</div></div>'+
    '<div class="crm-stat"><div class="crm-num counting" id="crm-val-n" style="color:var(--b)">0</div><div class="crm-lbl">PIPELINE VALUE $</div></div>'+
  '</div>';
  // Stage pipeline
  var stages=Object.keys(data.byStage||{});
  if(stages.length){
    html+='<div class="pipeline-stages">';
    for(var i=0;i<stages.length;i++){
      if(i>0)html+='<div class="ps-arrow">&rarr;</div>';
      html+='<div class="ps-box"><div class="ps-count">'+data.byStage[stages[i]]+'</div><div class="ps-name">'+esc(stages[i])+'</div></div>';
    }
    html+='</div>';
  }
  // Deals
  var deals=data.deals||[];
  if(deals.length){
    html+='<div class="sec-sub">DEALS ('+deals.length+')</div>';
    var stageColors=['var(--g)','var(--b)','var(--a)','var(--p)','var(--r)'];
    for(var j=0;j<Math.min(deals.length,6);j++){
      var d=deals[j],pr=d.properties||{};
      var sc=stageColors[j%stageColors.length];
      html+='<div class="deal-row">'+
        '<div class="deal-bar" style="background:'+sc+';box-shadow:0 0 4px '+sc+'"></div>'+
        '<div style="flex:1;min-width:0">'+
          '<div class="deal-name" title="'+esc(pr.dealname||'--')+'">'+esc(pr.dealname||'Unnamed')+'</div>'+
          '<div class="deal-meta">'+esc(pr.dealstage||'--')+(pr.closedate?' | close: '+esc(pr.closedate):'')+'</div>'+
        '</div>'+
        '<div style="font-size:.7rem;color:var(--g);white-space:nowrap">'+(pr.amount?'$'+Math.round(parseFloat(pr.amount)):'--')+'</div>'+
      '</div>';
    }
  }
  // Contacts
  var contacts=data.contacts||[];
  if(contacts.length){
    html+='<div class="sec-sub">RECENT CONTACTS</div>';
    for(var k=0;k<Math.min(contacts.length,5);k++){
      var cp=contacts[k].properties||{};
      var nm=([cp.firstname,cp.lastname].filter(Boolean).join(' '))||'--';
      html+='<div class="contact-row">'+
        '<div class="contact-name">'+esc(nm)+'</div>'+
        '<div class="contact-meta">'+esc(cp.company||'')+(cp.email?' | '+esc(cp.email):'')+'</div>'+
        '<div style="font-size:.6rem;color:var(--td)">'+esc(cp.lifecyclestage||'--')+'</div>'+
      '</div>';
    }
  }
  document.getElementById('s-crm').innerHTML=html;
  animate(document.getElementById('crm-deals-n'),data.totalDeals||0,'','');
  animate(document.getElementById('crm-val-n'),Math.round((data.totalValue||0)/1000),'','K');
  setUpdated('crm');
}

function renderNotion(data){
  console.log('[icarus] renderNotion', data);
  if(data.error&&!(data.entries&&data.entries.length)){
    document.getElementById('s-notion').innerHTML='<div class="state-info">'+esc(data.error)+'</div>';
    setUpdated('notion');return;
  }
  var entries=data.entries||[];
  if(!entries||!entries.length){document.getElementById('s-notion').innerHTML='<div class="state-info">No entries found.</div>';setUpdated('notion');return;}
  var statusColor=function(s){
    var sl=(s||'').toLowerCase();
    if(sl.includes('complete')||sl.includes('done'))return 'var(--g)';
    if(sl.includes('fail'))return 'var(--r)';
    if(sl.includes('pending'))return 'var(--a)';
    if(sl.includes('progress'))return 'var(--b)';
    return 'var(--td)';
  };
  var html=[];
  for(var i=0;i<entries.length;i++){
    var e=entries[i],sc=statusColor(e.status);
    html.push('<div class="notion-entry">'+
      '<div class="notion-bar" style="background:'+sc+';box-shadow:0 0 4px '+sc+'"></div>'+
      '<div style="flex:1;min-width:0">'+
        '<div class="notion-action">'+esc(e.action.slice(0,50))+'</div>'+
        '<div class="notion-out" title="'+esc(e.outcome)+'">'+esc(e.outcome.slice(0,60))+'</div>'+
        '<div style="font-size:.58rem;color:'+sc+';margin-top:2px">'+esc(e.status)+' | '+esc(e.category)+'</div>'+
      '</div>'+
      '<div class="notion-date">'+esc(fmtTs(e.date))+'</div>'+
    '</div>');
  }
  document.getElementById('s-notion').innerHTML=html.join('');
  setUpdated('notion');
}

function renderBriefings(entries){
  console.log('[icarus] renderBriefings', entries);
  if(!entries||!entries.length){document.getElementById('s-briefings').innerHTML='<div class="state-info">No briefings logged yet.</div>';setUpdated('briefings');return;}
  var html=[];
  for(var i=0;i<entries.length;i++){
    var e=entries[i],id='br'+i;
    var bc=e.type==='morning'?'bl':'bm';
    html.push('<div class="br-row">'+
      '<div class="br-header" onclick="toggleBriefing(\''+id+'\')">'+
        '<span class="badge '+bc+'">'+e.type.toUpperCase()+'</span>'+
        '<span class="br-title">'+esc(fmtTs(e.timestamp))+' &mdash; '+e.chunks+' msg'+(e.chunks>1?'s':'')+'</span>'+
        '<span class="br-arrow" id="br-arrow-'+id+'">&gt;</span>'+
      '</div>'+
      '<div class="br-detail" id="br-detail-'+id+'">'+
        '<div class="br-content">Briefing sent via WhatsApp in '+e.chunks+' message'+(e.chunks>1?'s':'')+'. Full text delivered to Nicholas at '+esc(fmtTs(e.timestamp))+'.\n\nCheck scheduler.log for full output.</div>'+
      '</div>'+
    '</div>');
  }
  document.getElementById('s-briefings').innerHTML=html.join('');
  setUpdated('briefings');
}

function toggleBriefing(id){
  var det=document.getElementById('br-detail-'+id);
  var arr=document.getElementById('br-arrow-'+id);
  if(det.classList.contains('open')){det.classList.remove('open');arr.textContent='>';}
  else{det.classList.add('open');arr.textContent='v';}
}

// --- DATA FETCHERS ---

function refreshStatus(){
  fetch('/api/status').then(function(r){return r.json();}).then(function(d){
    console.log('[icarus] /api/status response', d);
    if(d.ok){renderStatus(d.data);if(d.data&&d.data.memory)renderMemory(d.data.memory);}
    else document.getElementById('s-status').innerHTML='<div class="state-err">Error: '+esc(d.error)+'</div>';
  }).catch(function(e){console.error('[icarus] refreshStatus error',e);document.getElementById('s-status').innerHTML='<div class="state-err">Fetch error: '+esc(e.message)+'</div>';});
}
function refreshAudit(){
  fetch('/api/audit').then(function(r){return r.json();}).then(function(d){
    console.log('[icarus] /api/audit response', d);
    if(d.ok)renderAudit(d.data);
    else document.getElementById('s-audit').innerHTML='<div class="state-err">Error: '+esc(d.error)+'</div>';
  }).catch(function(e){console.error('[icarus] refreshAudit error',e);document.getElementById('s-audit').innerHTML='<div class="state-err">Fetch error: '+esc(e.message)+'</div>';});
}
function refreshMemory(){
  fetch('/api/memory').then(function(r){return r.json();}).then(function(d){
    console.log('[icarus] /api/memory response', d);
    if(d.ok)renderMemory(d.data);
    else document.getElementById('s-memory').innerHTML='<div class="state-err">Error: '+esc(d.error)+'</div>';
  }).catch(function(e){console.error('[icarus] refreshMemory error',e);document.getElementById('s-memory').innerHTML='<div class="state-err">Fetch error: '+esc(e.message)+'</div>';});
}
function refreshCRM(){
  fetch('/api/crm').then(function(r){return r.json();}).then(function(d){
    console.log('[icarus] /api/crm response', d);
    if(d.ok)renderCRM(d.data);
    else document.getElementById('s-crm').innerHTML='<div class="state-err">Error: '+esc(d.error)+'</div>';
  }).catch(function(e){console.error('[icarus] refreshCRM error',e);document.getElementById('s-crm').innerHTML='<div class="state-err">Fetch error: '+esc(e.message)+'</div>';});
}
function refreshNotion(){
  fetch('/api/notion').then(function(r){return r.json();}).then(function(d){
    console.log('[icarus] /api/notion response', d);
    if(d.ok)renderNotion(d.data);
    else document.getElementById('s-notion').innerHTML='<div class="state-err">Error: '+esc(d.error)+'</div>';
  }).catch(function(e){console.error('[icarus] refreshNotion error',e);document.getElementById('s-notion').innerHTML='<div class="state-err">Fetch error: '+esc(e.message)+'</div>';});
}
function refreshBriefings(){
  fetch('/api/briefings').then(function(r){return r.json();}).then(function(d){
    console.log('[icarus] /api/briefings response', d);
    if(d.ok)renderBriefings(d.data);
    else document.getElementById('s-briefings').innerHTML='<div class="state-err">Error: '+esc(d.error)+'</div>';
  }).catch(function(e){console.error('[icarus] refreshBriefings error',e);document.getElementById('s-briefings').innerHTML='<div class="state-err">Fetch error: '+esc(e.message)+'</div>';});
}

function refreshAll(){
  refreshStatus();
  refreshAudit();
  refreshCRM();
  refreshNotion();
  refreshBriefings();
  checkAuth();
}

// Keyboard shortcuts
document.addEventListener('keydown',function(e){
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'||e.target.tagName==='SELECT')return;
  if(e.key==='Escape'){closeModal();closeConfirm();}
  else if(e.key==='r'||e.key==='R'){pm2Do('restartall');}
  else if(e.key==='b'||e.key==='B'){doTriggerBriefing();}
  else if(e.key==='w'||e.key==='W'){openWipe();}
  else if(e.key==='l'||e.key==='L'){openLogModal('icarus-server');}
});

// Boot -- countdown timer drives all refreshes
refreshAll();
</script>
</body>
</html>`;
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('⚡ Icarus Dashboard running on port ' + PORT);
});
