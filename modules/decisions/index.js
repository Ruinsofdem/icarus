require('dotenv').config();
const axios = require('axios');
const { createMessage } = require('../../config');

// Lazy-load memory module to avoid circular init ordering issues
let memoryModule = null;
function getMemory() {
  if (!memoryModule) {
    try { memoryModule = require('../memory'); } catch { /* optional */ }
  }
  return memoryModule;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  console.log('[Decisions] Decision support module ready.');
}

// ─── Brave Search ─────────────────────────────────────────────────────────────

async function searchCurrent(query, count = 3) {
  if (!process.env.BRAVE_API_KEY) return '';
  try {
    const res = await axios.get('https://api.search.brave.com/res/v1/web/search', {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': process.env.BRAVE_API_KEY,
      },
      params: { q: query, count },
      timeout: 8000,
    });
    const items = res.data.web?.results || [];
    return items.map(r => `${r.title}: ${r.description || ''}`).join('\n');
  } catch (err) {
    console.error('[Decisions] Brave search failed:', err.message);
    return '';
  }
}

// ─── Core analysis ────────────────────────────────────────────────────────────

const DECISION_SYSTEM = `You are Icarus's decision support engine for Openclaw. Analyze the decision and return ONLY valid JSON — no prose, no markdown fences. Use this exact schema:
{
  "confidence": <integer 0-100>,
  "risk": "<LOW|MED|HIGH>",
  "recommendation": "<YES|NO|WAIT>",
  "rationale": "<concise explanation, max 3 sentences>"
}`;

async function analyzeDecision(description) {
  // 1. Query vector memory for relevant past context
  let memoryContext = '';
  try {
    const mem = getMemory();
    if (mem) memoryContext = await mem.queryMemory(description);
  } catch (err) {
    console.error('[Decisions] Memory query failed:', err.message);
  }

  // 2. Brave Search for current data
  const searchContext = await searchCurrent(description);

  // 3. Build user content
  const parts = [`Decision to analyze: ${description}`];
  if (memoryContext) parts.push(`Relevant past context:\n${memoryContext}`);
  if (searchContext) parts.push(`Current data from web:\n${searchContext}`);

  // 4. Claude structured reasoning
  const messages = [{ role: 'user', content: parts.join('\n\n') }];
  const response = await createMessage(messages, {
    systemPrompt: DECISION_SYSTEM,
    model: 'claude-sonnet-4-6',
  });

  const text = response.content?.find(b => b.type === 'text')?.text || '{}';

  // Extract JSON robustly — strip any accidental markdown fences
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const errorStruct = {
    confidence: 0,
    risk: 'HIGH',
    recommendation: 'WAIT',
    rationale: `Parse error — raw response: ${text.slice(0, 200)}`,
  };
  if (!jsonMatch) return errorStruct;
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return errorStruct;
  }
}

// ─── HTTP handler ─────────────────────────────────────────────────────────────

function handler(router) {
  router.post('/decisions', async (req, res) => {
    const { description } = req.body;
    if (!description || typeof description !== 'string' || !description.trim()) {
      return res.status(400).json({ error: 'description is required.' });
    }
    try {
      const result = await analyzeDecision(description.trim());
      res.json(result);
    } catch (err) {
      console.error('[Decisions] Analysis error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { init, handler, analyzeDecision };
