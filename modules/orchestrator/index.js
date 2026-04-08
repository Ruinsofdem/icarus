'use strict';

/**
 * Multi-Agent Orchestrator
 *
 * Accepts a high-level task string, maps it to a sub-agent sequence,
 * calls Claude for each step, and synthesises a final result.
 *
 * Supported task prefixes:
 *   lead [name]   → prospect-researcher → agent-scoper → proposal-writer (sequential)
 *   scope [name]  → agent-scoper
 *   brief         → briefing agent
 *   market [topic]→ knowledge-researcher + decisions (parallel)
 */

const Anthropic = require('@anthropic-ai/sdk');

const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;

// ─── Sub-agent system prompts ─────────────────────────────────────────────────

const AGENT_PROMPTS = {
  'prospect-researcher': `You are a prospect researcher for Openclaw, an AI automation agency for SMEs.
Given a company name or description, produce a structured business profile:
- Industry, size, and location
- Likely tools and tech stack in use
- Inferred pain points and manual processes ripe for automation
- Openclaw readiness score (1–10) with brief reasoning
- Key decision maker roles to target
Be concise, specific, and actionable.`,

  'agent-scoper': `You are an AI agent architect for Openclaw.
Given a business profile or company name, design the right agent architecture:
- Which agents to build (e.g. intake, scheduling, outreach, reporting)
- Estimated build hours per agent
- Priority order and rationale
- Integration requirements (CRM, email, calendar, etc.)
- Total project scope and indicative investment range
Output a structured scoping document suitable for a proposal.`,

  'proposal-writer': `You are a proposal writer for Openclaw, an AI automation agency.
Given a scoping document, write a client-ready proposal including:
- Executive summary (2–3 sentences)
- Problem statement
- Proposed solution with agent descriptions
- Timeline and milestones
- Pricing tiers: Basic / Growth / Elite
- Next steps and call to action
Be professional, confident, and results-focused. Avoid jargon.`,

  'briefing': `You are Icarus, Openclaw's autonomous business intelligence operator.
Produce a concise daily briefing covering:
- Pipeline summary (deals, leads, prospects in progress)
- Priority tasks for today
- Any risks or blockers to flag
- Suggested first action
Be short and action-oriented — this is a morning brief, not a report.`,

  'knowledge-researcher': `You are a market intelligence researcher for Openclaw.
Given a topic or market, produce:
- Market overview and 3 key trends
- Top players and their positioning
- Opportunity gaps relevant to AI automation
- SME segments most likely to need Openclaw's services
- 3 actionable insights for Openclaw's go-to-market
Be specific and evidence-grounded.`,

  'decisions': `You are a strategic decision-support analyst for Openclaw.
Given research output or market data, produce:
- The 2–3 key decisions that need to be made
- A clear recommendation with reasoning for each
- Risk factors and mitigation notes
- Confidence level (High / Medium / Low) per recommendation
- Suggested immediate next action
Be direct and decisive.`,
};

// ─── Task routing ─────────────────────────────────────────────────────────────

/**
 * Parse a task string into a workflow descriptor.
 * Returns { steps: [{agents, input}], context }
 * - steps with a single agent run sequentially, passing output forward
 * - steps with multiple agents run in parallel from the same input
 */
function parseTask(task) {
  const lower = task.toLowerCase().trim();

  if (lower.startsWith('lead ')) {
    const name = task.slice(5).trim();
    return {
      workflow: 'lead',
      context: name,
      steps: [
        { agents: ['prospect-researcher'], input: `Research this company/prospect for Openclaw: ${name}` },
        { agents: ['agent-scoper'],        input: null }, // receives previous output
        { agents: ['proposal-writer'],     input: null },
      ],
    };
  }

  if (lower.startsWith('scope ')) {
    const name = task.slice(6).trim();
    return {
      workflow: 'scope',
      context: name,
      steps: [
        { agents: ['agent-scoper'], input: `Scope an Openclaw AI engagement for: ${name}` },
      ],
    };
  }

  if (lower === 'brief' || lower === 'briefing' || lower === 'daily brief') {
    return {
      workflow: 'brief',
      context: 'daily briefing',
      steps: [
        { agents: ['briefing'], input: 'Produce the Icarus daily business briefing for Openclaw.' },
      ],
    };
  }

  if (lower.startsWith('market ')) {
    const topic = task.slice(7).trim();
    return {
      workflow: 'market',
      context: topic,
      steps: [
        // Both agents run in parallel from the same input
        { agents: ['knowledge-researcher', 'decisions'], input: `Market analysis topic: ${topic}` },
      ],
    };
  }

  // Default: treat as a briefing-style request
  return {
    workflow: 'general',
    context: task,
    steps: [
      { agents: ['briefing'], input: task },
    ],
  };
}

// ─── Claude call helpers ──────────────────────────────────────────────────────

function getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

async function callAgent(agentName, input) {
  const client     = getClient();
  const systemPrompt = AGENT_PROMPTS[agentName] || AGENT_PROMPTS['briefing'];
  const response   = await client.messages.create({
    model:      MODEL,
    max_tokens: MAX_TOKENS,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: input }],
  });
  return response.content.find(b => b.type === 'text')?.text || '';
}

// ─── Orchestration engine ─────────────────────────────────────────────────────

async function runOrchestration(task) {
  const { workflow, context, steps } = parseTask(task);
  const subResults = {};
  let lastOutput   = null;

  for (const step of steps) {
    const input = step.input !== null ? step.input : (lastOutput || task);

    if (step.agents.length > 1) {
      // Run multiple agents in parallel
      const results = await Promise.all(
        step.agents.map(async (agent) => {
          const output = await callAgent(agent, input);
          return { agent, output };
        })
      );
      results.forEach(r => { subResults[r.agent] = r.output; });
      lastOutput = results.map(r => `### ${r.agent}\n${r.output}`).join('\n\n');
    } else {
      // Single agent — sequential
      const agent  = step.agents[0];
      const output = await callAgent(agent, input);
      subResults[agent] = output;
      lastOutput        = output;
    }
  }

  // Synthesise across all sub-results
  const synthInput = Object.entries(subResults)
    .map(([k, v]) => `### ${k}\n${v}`)
    .join('\n\n');

  const client   = getClient();
  const synthesis = await client.messages.create({
    model:      MODEL,
    max_tokens: MAX_TOKENS,
    system:     `You are Icarus, Openclaw's orchestrator. Synthesise the following sub-agent outputs into a single coherent, action-ready result for the task: "${task}". Lead with the most important insight or next step.`,
    messages:   [{ role: 'user', content: synthInput }],
  });
  const summary = synthesis.content.find(b => b.type === 'text')?.text || '';

  return {
    task,
    workflow,
    context,
    sub_results:  subResults,
    summary,
    completed_at: new Date().toISOString(),
  };
}

// ─── Express handler ──────────────────────────────────────────────────────────

function handler(app) {
  app.post('/orchestrate', async (req, res) => {
    const { task } = req.body;
    if (!task || typeof task !== 'string' || !task.trim()) {
      return res.status(400).json({ error: 'task is required.' });
    }
    try {
      const result = await runOrchestration(task.trim());
      res.json(result);
    } catch (err) {
      console.error('[Orchestrator] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}

function init() {
  console.log('[Orchestrator] Module ready.');
}

module.exports = { init, handler, runOrchestration, parseTask, callAgent };
