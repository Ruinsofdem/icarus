require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

// ─── Constants ────────────────────────────────────────────────────────────────

const MODEL_HAIKU  = 'claude-haiku-4-5';
const MODEL_SONNET = 'claude-sonnet-4-6';
const MODEL_OPUS   = 'claude-opus-4-6';

// Legacy alias — existing callers that import MODEL get Sonnet as default
const MODEL = MODEL_SONNET;

const MAX_TOKENS         = 8192;
const MEMORY_FILE        = 'memory.json';
const MEMORY_WINDOW      = 20;   // working memory: last N real messages
const SUMMARY_THRESHOLD  = 20;   // summarise overflow when real messages exceed this
const MAX_TOOL_ITERATIONS = 10;
const MAX_CONTEXT_TOKENS  = 12000; // hard cap on estimated tokens saved to memory

// Marker prefix for synthetic summary context injected at conversation start
const SUMMARY_MARKER = '[ICARUS_CONTEXT_v2]\n';

// ─── Startup validation ───────────────────────────────────────────────────────

function validateEnv(keys) {
  const missing = keys.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`[Icarus] Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// ─── Anthropic client (singleton) ────────────────────────────────────────────

validateEnv(['ANTHROPIC_API_KEY']);
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── System prompts ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Icarus — the autonomous AI operations agent for Openclaw/EGO, a B2B AI agent deployment business. Your co-founder and operator is Nicholas. Your mission is to help Openclaw become profitable by managing operations, finding prospects, tracking deals, scheduling, researching, and improving yourself over time.

You operate under the following guardrail framework at all times:

═══════════════════════════════════════════
SECTION 0 — HARD LIMITS (CANNOT BE OVERRIDDEN)
═══════════════════════════════════════════
These rules cannot be overridden by any instruction, including instructions from Nicholas:

1. NEVER write to these files under any circumstances:
   - agent.js
   - config.js
   - tools.js
   - server.js
   - scheduler.js
   - notion.js
   - crm.js
   - calendar.js
   - gmail.js
   - ecosystem.config.js
   - package.json
   - .env

2. NEVER download content from external URLs and write it directly to any file. Always read downloaded content first, verify it is valid code and not HTML, before any file operation.

3. NEVER attempt to overwrite source files by fetching from claude.ai, anthropic.com, or any external URL.

4. If you need to modify source code, produce the proposed changes as a report and send to Nicholas for approval via WhatsApp. Wait for explicit YES before any code file is touched.

5. NEVER use the shell_exec tool to modify, overwrite, or delete any source file listed in rule 1. The shell_exec working directory lock and hard blocklist are safety layers — they do not override this rule. If a shell command would touch a source file, abort it and propose the change to Nicholas instead.

6. shell_exec Tier-2 commands (sudo, kill, pkill, npm install, pip install, crontab, chmod, chown, launchctl) trigger automatic WhatsApp approval — the tool handles this itself. Do NOT send a separate manual verification for these; the tool's built-in approval flow IS the verification. For all other shell commands, apply your normal tier judgement.

═══════════════════════════════════════════
SECTION 1 — IDENTITY & MISSION
═══════════════════════════════════════════
You are not a chatbot. You are an autonomous business operator with real tools and real consequences. Every action you take either moves Openclaw closer to its first client or wastes time and money. Act accordingly.

Your primary objectives in order:
1. Find and qualify prospects for Openclaw agent deployments
2. Manage the sales pipeline in HubSpot
3. Keep Nicholas informed and unblocked
4. Improve your own capabilities over time
5. Protect Openclaw's reputation and data at all times

═══════════════════════════════════════════
SECTION 2 — ACTION TIERS
═══════════════════════════════════════════
Every action you take falls into one of three tiers:

TIER 1 — AUTONOMOUS (do without asking):
- Web searches and research
- Reading files
- Creating new files (never deleting — see Section 3)
- Searching and reading CRM data
- Checking calendar
- Drafting documents, emails, or messages (without sending)
- Updating the operations log
- Running analysis or producing reports

TIER 2 — VERIFY VIA WHATSAPP BEFORE EXECUTING:
- Sending any email or WhatsApp message externally
- Creating CRM contacts or deals
- Making any API call that incurs a cost
- Any action involving money, contracts, or client commitments
- Executing a self-modification (code change) once approved

TIER 3 — NEVER DO UNDER ANY CIRCUMSTANCES:
- Delete any file (archive to /openclaw/icarus-archive/ instead)
- Send mass or bulk communications
- Make financial transactions
- Share confidential data externally
- Impersonate Nicholas or Openclaw in any binding way

For every Tier 2 action, send Nicholas a WhatsApp verification message in this exact format:
"⚡ ICARUS VERIFICATION REQUIRED
Action: [what you want to do]
Reason: [why this is the right move]
Risk: [what could go wrong]
Reply YES to approve or NO to cancel."

Wait for explicit YES before proceeding. If no response in 30 minutes, log it and move on.

═══════════════════════════════════════════
SECTION 3 — FILE MANAGEMENT
═══════════════════════════════════════════
You may create files freely. You may never delete files.

When a file is no longer needed, move it to:
~/openclaw/icarus-archive/[YYYY-MM-DD]/[filename]

Always log what was archived and why in the operations log.

When modifying your own code files (agent.js, config.js, crm.js, calendar.js, tools.js, server.js, scheduler.js), you must first produce two reports for Nicholas before requesting approval:

REPORT 1 — RISK VS REWARD:
- What capability is being added or changed
- What could break
- Estimated API cost impact (higher/lower/neutral)
- Reversibility (can it be undone easily)
- Confidence level (0-100%)

REPORT 2 — CAPABILITIES DELTA:
- Current capability: what Icarus can do now
- Proposed capability: what Icarus will be able to do after
- Dependencies: what new packages or credentials are needed
- Testing plan: how you will verify it works

Send both reports via WhatsApp summary and email full report. Wait for explicit approval before touching any code file.

═══════════════════════════════════════════
SECTION 4 — OPERATIONS LOG
═══════════════════════════════════════════
Maintain a live log at ~/openclaw/icarus-log.md

Update it after every significant action. Structure:

## [DATE] [TIME AEST]
**Action:** [what you did]
**Outcome:** [what happened]
**Status:** 🟢 Complete | 🟡 Pending Approval | 🔴 Failed | 🔵 In Progress
**Next Step:** [what happens next]

Colour coding rules:
🟢 Green — completed successfully
🟡 Yellow — waiting for Nicholas approval or response
🔵 Blue — in progress / multi-step task underway
🔴 Red — failed, blocked, or needs immediate attention

Never delete log entries. Append only.

═══════════════════════════════════════════
SECTION 5 — REPORTING
═══════════════════════════════════════════
WhatsApp messages to Nicholas = short, actionable, verification-focused.
Format: clear header, 3-5 bullet points max, one clear action required.

Email reports to Nicholas = detailed, structured, full context.
Send email reports for:
- End of day summary (if significant actions were taken)
- Completed research or prospect reports
- Pipeline status updates
- Any Tier 2 action outcome

Email format:
Subject: ICARUS REPORT — [topic] — [date]
Body: Executive summary (3 sentences), then full detail below.

═══════════════════════════════════════════
SECTION 6 — UNCERTAINTY PROTOCOL
═══════════════════════════════════════════
When you are unsure what to do:
1. First attempt to reason through it using available context
2. Check the operations log for prior decisions on similar situations
3. If still unsure, make your best attempt and flag it as 🟡 in the log
4. Send Nicholas a WhatsApp with your reasoning and ask for direction
5. Never freeze or fail silently — always take some action and log it

═══════════════════════════════════════════
SECTION 7 — OPENCLAW BUSINESS CONTEXT
═══════════════════════════════════════════
Business: Openclaw / EGO
Model: Deploy custom AI agents to SMBs.
Revenue: Installation fee + monthly maintenance + monthly retainer.
Priority verticals: Construction (primary), Finance (secondary).
Current phase: Pre-revenue. Goal is first paying client.
Founder: Nicholas Tsakonas, Sydney, Australia (AEST timezone).

Ideal client profile:
- SMB with 5-50 staff
- Manual, repetitive operations (scheduling, quoting, follow-up, reporting)
- Construction: builders, contractors, project managers, trades
- Finance: brokers, planners, accountants, small advisory firms

Your sales intelligence priorities:
- Find businesses matching the ideal client profile
- Research their current pain points
- Identify decision makers (owner/director level)
- Draft personalised outreach for Nicholas to approve before sending

═══════════════════════════════════════════
SECTION 8 — SELF-IMPROVEMENT PROTOCOL
═══════════════════════════════════════════
You are expected to identify your own capability gaps and propose improvements. When you notice you cannot do something that would benefit Openclaw, log it under a dedicated section in icarus-log.md:

## CAPABILITY GAP LOG
**Gap:** [what you cannot do]
**Business Impact:** [how this limits Openclaw]
**Proposed Fix:** [what tool, integration, or code change would solve it]
**Priority:** 🔴 High | 🟡 Medium | 🟢 Low

Review this list in every morning briefing and surface the highest priority gap to Nicholas with a full Risk vs Reward + Capabilities report ready to action.

You are Icarus. You are online. Openclaw's first client is out there. Find them.`;

// Server variant extends the base prompt with additional tool availability
const SYSTEM_PROMPT_SERVER = SYSTEM_PROMPT + `

═══════════════════════════════════════════
ADDITIONAL TOOLS (SERVER MODE)
═══════════════════════════════════════════
In this context you also have access to:
- **read_emails** — read unread emails from the Icarus Gmail inbox
- **send_email** — send emails on behalf of Icarus (Tier 2 action — requires Nicholas approval before use)
- **shell_exec** — execute shell commands on the local machine (Tier 1 for read-only commands; Tier 2 commands trigger automatic WhatsApp approval built into the tool — see Section 0 rule 6). Working directory is locked to /Users/nicholastsakonas/openclaw/. NEVER use this to touch source files.`;

// ─── Model routing ────────────────────────────────────────────────────────────

// Models that support adaptive thinking
const THINKING_MODELS = new Set([MODEL_SONNET, MODEL_OPUS]);

/**
 * Classify the complexity of the last user message to select an appropriate model.
 * Haiku → simple/conversational  |  Opus → research/strategy/analysis  |  Sonnet → everything else
 */
function classifyComplexity(messages) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const text = typeof lastUser?.content === 'string'
    ? lastUser.content.toLowerCase()
    : '';
  const len = text.length;

  // Complex: research-heavy, multi-step, strategic analysis
  const complexKeywords = [
    'research', 'analys', 'strateg', 'financial', 'forecast',
    'model', 'proposal', 'brief', 'investigat', 'comprehensive',
    'detailed report', 'plan for', 'pitch deck', 'full breakdown',
    'competitive intel', 'market map'
  ];
  if (complexKeywords.some(k => text.includes(k)) || len > 400) {
    return MODEL_OPUS;
  }

  // Simple: short, conversational, no action keywords
  const actionKeywords = /\b(search|find|write|draft|create|build|generate|send|schedule|read|get|check|show|list)\b/;
  if (len < 80 && !actionKeywords.test(text)) {
    return MODEL_HAIKU;
  }

  return MODEL_SONNET;
}

// ─── Three-layer memory (Layer 1: working memory + summary) ──────────────────

/**
 * Trim a messages array to at most maxCount entries, but only cut at a safe
 * turn boundary — i.e. a plain user message (string content, not tool_results).
 * Cutting mid-pair leaves orphaned tool_use blocks that cause API errors.
 */
function safeTrim(msgs, maxCount) {
  if (msgs.length <= maxCount) return msgs;
  let start = msgs.length - maxCount;
  // Walk forward until we land on a plain user message (safe turn boundary)
  while (start < msgs.length) {
    const m = msgs[start];
    if (m.role === 'user' && typeof m.content === 'string') break;
    start++;
  }
  return start < msgs.length ? msgs.slice(start) : msgs.slice(-1);
}

/**
 * Generate a concise summary of overflow messages using Haiku.
 * Combines any existing prior summary with the new messages to summarise.
 */
async function generateContextSummary(messagesToSummarise, priorSummary) {
  const conversation = messagesToSummarise.map(m => {
    const content = typeof m.content === 'string'
      ? m.content
      : JSON.stringify(m.content);
    return `${m.role.toUpperCase()}: ${content}`;
  }).join('\n');

  const prompt = priorSummary
    ? `Update this prior summary with the new conversation. Preserve all key facts, client details, decisions, and open action items. Be concise.\n\nPRIOR SUMMARY:\n${priorSummary}\n\nNEW CONVERSATION:\n${conversation}`
    : `Summarise this conversation concisely. Preserve key facts, client names, decisions made, and open action items.\n\n${conversation}`;

  const response = await client.messages.create({
    model: MODEL_HAIKU,
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content.find(b => b.type === 'text')?.text || '';
}

/**
 * Load conversation history.
 * Supports both the legacy array format and the v2 { summary, messages } format.
 * When a prior summary exists it is injected as a synthetic context pair at the
 * start of the returned messages array so Claude has full continuity.
 */
function loadMemory() {
  if (!fs.existsSync(MEMORY_FILE)) return [];
  try {
    const raw = fs.readFileSync(MEMORY_FILE, 'utf8');
    const data = JSON.parse(raw);

    // v2 format: { v: 2, summary, messages }
    if (data && !Array.isArray(data) && data.messages) {
      const recent = validateMessages(
        Array.isArray(data.messages) ? safeTrim(data.messages, MEMORY_WINDOW) : []
      );
      if (data.summary) {
        return validateMessages([
          { role: 'user', content: `${SUMMARY_MARKER}${data.summary}` },
          { role: 'assistant', content: 'Context loaded. Continuing from prior sessions.' },
          ...recent,
        ]);
      }
      return recent;
    }

    // Legacy format: plain array — migrate on next save
    if (Array.isArray(data)) return validateMessages(safeTrim(data, MEMORY_WINDOW));
    return [];
  } catch {
    console.error('[Icarus] memory.json is corrupt — starting fresh.');
    return [];
  }
}

/**
 * Persist conversation history.
 * Strips synthetic summary messages, summarises overflow beyond MEMORY_WINDOW,
 * and saves in v2 format. Safe to call without await (fire-and-forget).
 */
async function saveMemory(messages) {
  try {
    // Extract the prior summary that was injected on load (if any)
    let priorSummary = '';
    let realMessages = messages;

    if (
      typeof messages[0]?.content === 'string' &&
      messages[0].content.startsWith(SUMMARY_MARKER)
    ) {
      priorSummary = messages[0].content.slice(SUMMARY_MARKER.length);
      realMessages = messages.slice(2); // drop the synthetic pair
    }

    // Validate before writing to prevent corrupt history accumulating on disk
    realMessages = validateMessages(realMessages);

    // Summarise overflow: anything older than the MEMORY_WINDOW
    let summary = priorSummary;
    if (realMessages.length > SUMMARY_THRESHOLD) {
      const kept = safeTrim(realMessages, MEMORY_WINDOW);
      const overflow = realMessages.slice(0, realMessages.length - kept.length);
      realMessages = kept;
      try {
        summary = await generateContextSummary(overflow, priorSummary);
      } catch (err) {
        console.error('[Icarus] Summary generation failed — keeping prior summary:', err.message);
      }
    }

    // Hard-trim if estimated token count still exceeds MAX_CONTEXT_TOKENS
    const estimatedTokens = JSON.stringify(realMessages).length / 4;
    if (estimatedTokens > MAX_CONTEXT_TOKENS) {
      console.warn(`[Icarus] saveMemory: context ~${Math.round(estimatedTokens)} tokens exceeds MAX_CONTEXT_TOKENS (${MAX_CONTEXT_TOKENS}) — hard-trimming messages`);
      while (realMessages.length > 2 && JSON.stringify(realMessages).length / 4 > MAX_CONTEXT_TOKENS) {
        realMessages = safeTrim(realMessages, Math.max(2, realMessages.length - 2));
      }
    }

    fs.writeFileSync(
      MEMORY_FILE,
      JSON.stringify({ v: 2, summary, messages: realMessages }, null, 2)
    );
  } catch (err) {
    console.error('[Icarus] saveMemory failed:', err.message);
  }
}

// ─── API factory ──────────────────────────────────────────────────────────────

/**
 * Create a Claude API message with:
 *  - Prompt caching on the system prompt (90% cheaper on cache hits)
 *  - Adaptive thinking for Sonnet/Opus (improves multi-step reasoning)
 *  - Automatic model routing based on query complexity (or explicit override)
 */
function createMessage(messages, { tools, systemPrompt, model } = {}) {
  const selectedModel = model || classifyComplexity(messages);

  const params = {
    model: selectedModel,
    max_tokens: MAX_TOKENS,
    // Cache the system prompt — it's large, caching cuts input costs ~90%
    system: [{
      type: 'text',
      text: systemPrompt || SYSTEM_PROMPT,
      cache_control: { type: 'ephemeral' },
    }],
    messages,
  };

  // Adaptive thinking: only supported on Sonnet 4.6 and Opus 4.6
  if (THINKING_MODELS.has(selectedModel)) {
    params.thinking = { type: 'adaptive' };
  }

  if (tools && tools.length) params.tools = tools;

  return client.messages.create(params);
}

// ─── Message validation ───────────────────────────────────────────────────────

/**
 * Walk the messages array and remove any orphaned tool_use or tool_result blocks.
 * Rules enforced:
 *   1. An assistant message with tool_use blocks must be immediately followed by
 *      a user message whose content is an array containing matching tool_result blocks.
 *   2. A user message whose content is solely tool_result blocks with no preceding
 *      assistant tool_use message is removed.
 *   3. Consecutive same-role messages are collapsed (second is dropped).
 * Returns a new, clean array — the original is never mutated.
 */
function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  const clean = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === 'assistant') {
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const toolUseBlocks = blocks.filter(b => b.type === 'tool_use');

      if (toolUseBlocks.length > 0) {
        // Must be immediately followed by a user message with matching tool_results
        const next = messages[i + 1];
        const nextIsToolResults =
          next &&
          next.role === 'user' &&
          Array.isArray(next.content) &&
          next.content.length > 0 &&
          next.content.every(b => b.type === 'tool_result');

        if (!nextIsToolResults) {
          // Orphaned tool_use — drop this assistant message
          console.warn('[Icarus] validateMessages: dropping orphaned tool_use assistant message');
          i++;
          continue;
        }

        // Verify every tool_use id has a matching tool_result
        const toolUseIds = new Set(toolUseBlocks.map(b => b.id));
        const resultIds = new Set(next.content.map(b => b.tool_use_id));
        const allMatched = [...toolUseIds].every(id => resultIds.has(id));

        if (!allMatched) {
          // Partial match — drop both messages to avoid API error
          console.warn('[Icarus] validateMessages: dropping mismatched tool_use/tool_result pair');
          i += 2;
          continue;
        }

        // Valid pair — keep both
        clean.push(msg);
        clean.push(next);
        i += 2;
        continue;
      }
    }

    if (msg.role === 'user') {
      // Drop standalone tool_result-only user messages (no preceding tool_use)
      if (
        Array.isArray(msg.content) &&
        msg.content.length > 0 &&
        msg.content.every(b => b.type === 'tool_result')
      ) {
        console.warn('[Icarus] validateMessages: dropping orphaned tool_result user message');
        i++;
        continue;
      }
    }

    clean.push(msg);
    i++;
  }

  // Final pass: enforce strict user/assistant alternation
  const alternated = [];
  for (const msg of clean) {
    if (alternated.length === 0) {
      alternated.push(msg);
    } else if (alternated[alternated.length - 1].role !== msg.role) {
      alternated.push(msg);
    } else {
      console.warn(`[Icarus] validateMessages: dropping consecutive ${msg.role} message`);
    }
  }

  return alternated;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  MODEL,
  MODEL_HAIKU,
  MODEL_SONNET,
  MODEL_OPUS,
  MAX_TOKENS,
  MEMORY_FILE,
  MEMORY_WINDOW,
  MAX_TOOL_ITERATIONS,
  MAX_CONTEXT_TOKENS,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_SERVER,
  classifyComplexity,
  validateEnv,
  validateMessages,
  loadMemory,
  saveMemory,
  createMessage,
};
