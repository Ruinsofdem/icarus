'use strict';

const axios = require('axios');
const twilio = require('twilio');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── Constants ────────────────────────────────────────────────────────────────
const LOCKED_DIR = '/Users/nicholastsakonas/openclaw';
const APPROVALS_DIR = '/tmp/icarus_approvals';

const HARD_BLOCKLIST = [
  'rm -rf', 'sudo rm', 'mkfs', 'dd if=',
  'chmod 777', ':(){:|:&};:', 'curl | bash', 'wget | sh',
];

const TIER2_PATTERNS = [
  /\bsudo\b/,
  /\bkill\b/,
  /\bpkill\b/,
  /\bnpm\s+install\b/,
  /\bpip\s+install\b/,
  /\bcrontab\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\blaunchctl\b/,
];

// ─── In-memory frequency tracker (not persisted to disk) ─────────────────────
const commandFrequency = new Map();

// ─── Existing tools ───────────────────────────────────────────────────────────

async function webSearch(query) {
  try {
    const response = await axios.get('https://api.search.brave.com/res/v1/web/search', {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': process.env.BRAVE_API_KEY,
      },
      params: {
        q: query,
        count: 5,
        text_decorations: false,
        search_lang: 'en',
        country: 'AU',
      }
    });

    const results = response.data.web?.results || [];

    if (results.length === 0) {
      return 'No results found for that query.';
    }

    return results.map((r, i) =>
      `[${i + 1}] ${r.title}\n${r.description}\nSource: ${r.url}`
    ).join('\n\n');

  } catch (error) {
    return `Search failed: ${error.message}`;
  }
}

async function readFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return `File not found: ${filePath}`;
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return `Failed to read file: ${error.message}`;
  }
}

async function writeFile(filePath, content) {
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return `File written successfully: ${filePath}`;
  } catch (error) {
    return `Failed to write file: ${error.message}`;
  }
}

// ─── Risk scoring ─────────────────────────────────────────────────────────────

function calcRiskFactors(command) {
  const cmdLower = command.toLowerCase();

  // Factor 1: Command type — network+4, write+3, execute+2, read+0
  let cmdTypeScore = 0;
  if (/\bcurl\b|\bwget\b|https?:\/\//.test(cmdLower)) {
    cmdTypeScore = 4;
  } else if (/\brm\b|echo\s.*>|tee\s|\bcp\b|\bmv\b|sed\s+-i|awk\s.*>/.test(cmdLower)) {
    cmdTypeScore = 3;
  } else if (/\bnode\b|\bpython\b|\bbash\b|\bsh\s|\bexec\b|\beval\b|npm\s+run|\.\//.test(cmdLower)) {
    cmdTypeScore = 2;
  }

  // Factor 2: Target directory — system+5, home+2, openclaw+0
  let dirScore = 0;
  const targetsSystem = /\/etc\/|\/usr\/|\/bin\/|\/sbin\/|\/System\/|\/Library\//.test(command);
  const targetsOpenClaw = command.includes(LOCKED_DIR) || /~\/openclaw/.test(command);
  const targetsHome = !targetsOpenClaw && (
    /(?:^|[\s"'])~\//.test(command) ||
    /\/Users\/nicholastsakonas\//.test(command)
  );
  if (targetsSystem) dirScore = 5;
  else if (targetsHome) dirScore = 2;

  // Factor 3: Time of day — night (before 6AM or from 10PM) AEST +2, daytime +0
  const aestHour = (new Date().getUTCHours() + 10) % 24;
  const timeScore = (aestHour < 6 || aestHour >= 22) ? 2 : 0;

  // Factor 4: Frequency — same command 3+ times in last 10 min +2
  const now = Date.now();
  const recent = (commandFrequency.get(command.trim()) || []).filter(t => now - t < 10 * 60 * 1000);
  const freqScore = recent.length >= 2 ? 2 : 0;

  const total = Math.min(1 + cmdTypeScore + dirScore + timeScore + freqScore, 10);

  return { total, cmdTypeScore, dirScore, timeScore, freqScore };
}

function getRiskLabel(score) {
  if (score <= 3) return 'Low';
  if (score <= 6) return 'Medium';
  if (score <= 8) return 'High';
  return 'Critical';
}

function updateFrequency(command) {
  const now = Date.now();
  const key = command.trim();
  const recent = (commandFrequency.get(key) || []).filter(t => now - t < 10 * 60 * 1000);
  recent.push(now);
  commandFrequency.set(key, recent);
}

// ─── Twilio WhatsApp ──────────────────────────────────────────────────────────

async function sendWhatsApp(body) {
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return client.messages.create({
    from: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`,
    to:   `whatsapp:${process.env.TWILIO_WHATSAPP_TO}`,
    body,
  });
}

// ─── Approval IPC (temp-file based, works cross-process with server.js) ──────
//
// server.js Twilio webhook should call resolveApproval(id, 'YES'/'NO')
// where `id` is the Token included in the approval WhatsApp message.

function ensureApprovalsDir() {
  if (!fs.existsSync(APPROVALS_DIR)) {
    fs.mkdirSync(APPROVALS_DIR, { recursive: true });
  }
}

function resolveApproval(id, decision) {
  const filePath = path.join(APPROVALS_DIR, id);
  if (fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, decision.toUpperCase().trim(), 'utf8');
  }
}

function waitForApproval(id, timeoutMs = 60000) {
  ensureApprovalsDir();
  const filePath = path.join(APPROVALS_DIR, id);
  fs.writeFileSync(filePath, 'PENDING', 'utf8');

  return new Promise((resolve) => {
    const POLL_MS = 2000;
    const maxAttempts = Math.ceil(timeoutMs / POLL_MS);
    let attempts = 0;

    const poll = setInterval(() => {
      attempts++;
      try {
        const content = fs.readFileSync(filePath, 'utf8').trim();
        if (content === 'YES') {
          clearInterval(poll);
          try { fs.unlinkSync(filePath); } catch {}
          resolve(true);
        } else if (content === 'NO' || attempts >= maxAttempts) {
          clearInterval(poll);
          try { fs.unlinkSync(filePath); } catch {}
          resolve(false);
        }
      } catch {
        clearInterval(poll);
        resolve(false);
      }
    }, POLL_MS);
  });
}

// ─── Audit log ────────────────────────────────────────────────────────────────

function appendAuditLog(command, output, factors, reason) {
  const { total, cmdTypeScore, dirScore, timeScore, freqScore } = factors;
  const label = getRiskLabel(total);
  const timestamp = new Date().toISOString();
  const preview = output.length > 500 ? output.slice(0, 500) + '...' : output;

  const cmdTypeLabel = cmdTypeScore === 4 ? 'network(+4)' : cmdTypeScore === 3 ? 'write(+3)' : cmdTypeScore === 2 ? 'execute(+2)' : 'read(+0)';
  const dirLabel     = dirScore === 5 ? 'system(+5)' : dirScore === 2 ? 'home(+2)' : 'openclaw(+0)';
  const timeLabel    = timeScore === 2 ? 'night(+2)' : 'daytime(+0)';
  const freqLabel    = freqScore === 2 ? 'repeat3x(+2)' : 'normal(+0)';

  const entry = [
    '',
    '---',
    `**[${timestamp}] Shell Exec Audit**`,
    `- **Command:** \`${command}\``,
    `- **Reason:** ${reason || '(none)'}`,
    `- **Risk Score:** ${total}/10 — ${label}`,
    `- **Risk Factors:** cmd=${cmdTypeLabel}, dir=${dirLabel}, time=${timeLabel}, freq=${freqLabel}`,
    '- **Output:**',
    '```',
    preview,
    '```',
    '',
  ].join('\n');

  const logPath = path.join(LOCKED_DIR, 'icarus-log.md');
  fs.appendFileSync(logPath, entry, 'utf8');
}

// ─── shellExec ────────────────────────────────────────────────────────────────

async function shellExec(command, reason = '') {
  // Layer 1: Hard blocklist — immediate reject, no logging
  for (const pattern of HARD_BLOCKLIST) {
    if (command.includes(pattern)) {
      return `BLOCKED [Layer 1]: Command contains prohibited pattern "${pattern}". This action is permanently disallowed.`;
    }
  }

  // Layer 4: Working directory lock — block cd outside LOCKED_DIR
  const cdMatch = command.match(/\bcd\s+([^\s;&|]+)/);
  if (cdMatch) {
    const rawTarget = cdMatch[1].replace(/^~/, process.env.HOME || '/Users/nicholastsakonas');
    const resolved = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(LOCKED_DIR, rawTarget);
    if (!resolved.startsWith(LOCKED_DIR)) {
      return `BLOCKED [Layer 4]: cd outside of ${LOCKED_DIR} is not allowed. Attempted: ${rawTarget}`;
    }
  }

  // Calculate risk
  const factors = calcRiskFactors(command);
  const { total: score } = factors;
  const label = getRiskLabel(score);

  // Layer 2: Tier 2 WhatsApp approval for sensitive commands
  if (TIER2_PATTERNS.some(re => re.test(command))) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const msg = [
      '⚡ ICARUS VERIFICATION REQUIRED',
      `Action: ${command}`,
      `Reason: ${reason || '(none)'}`,
      `Risk: ${score}/10 (${label})`,
      `Token: ${id}`,
      'Reply YES to approve or NO to cancel.',
    ].join('\n');

    try {
      await sendWhatsApp(msg);
    } catch (err) {
      return `BLOCKED [Layer 2]: Could not send WhatsApp approval request — ${err.message}`;
    }

    const approvalTimeoutMs = parseInt(process.env.TWILIO_APPROVAL_TIMEOUT_MS) || 60000;
    const approved = await waitForApproval(id, approvalTimeoutMs);
    if (!approved) {
      appendAuditLog(command, 'DENIED — WhatsApp approval timed out or rejected', factors, reason);
      return `BLOCKED [Layer 2]: WhatsApp approval denied or timed out for: ${command}`;
    }
  }

  // Layer 3: Execute with 30-second timeout; kill on breach
  let output = '';
  await new Promise((resolve) => {
    exec(
      command,
      { cwd: LOCKED_DIR, timeout: 30000, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        const combined = (stdout || '') + (stderr ? `\n[stderr]: ${stderr}` : '');
        if (err) {
          output = err.killed
            ? `[TIMEOUT] Process killed after 30 seconds.\n${combined}`
            : `[ERROR] ${err.message}\n${combined}`;
        } else {
          output = combined;
        }
        resolve();
      }
    );
  });

  // Layer 6: Cap combined stdout+stderr at 2000 characters
  if (output.length > 2000) {
    output = output.slice(0, 2000) + '\n[OUTPUT TRUNCATED AT 2000 CHARS]';
  }

  // Update in-memory frequency map
  updateFrequency(command);

  // Layer 5: Audit log to icarus-log.md
  appendAuditLog(command, output, factors, reason);

  // Immediate WhatsApp alert for score >= 7
  if (score >= 7) {
    const alert = [
      '🚨 ICARUS HIGH-RISK EXECUTION COMPLETED',
      `Command: ${command}`,
      `Risk: ${score}/10 — ${label}`,
      `Preview: ${output.slice(0, 200)}`,
    ].join('\n');
    sendWhatsApp(alert).catch(() => {}); // non-fatal
  }

  return output || '(no output)';
}

module.exports = { webSearch, readFile, writeFile, shellExec, resolveApproval };
