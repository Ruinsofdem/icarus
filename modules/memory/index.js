require('dotenv').config();
const { Pinecone } = require('@pinecone-database/pinecone');
const OpenAI = require('openai');

const INDEX_NAME = 'icarus-memory';
const EMBED_MODEL = 'text-embedding-3-small';
const TOP_K = 5;

let pinecone = null;
let pineconeIndex = null;
let openai = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  if (!process.env.PINECONE_API_KEY) {
    console.warn('[Memory] PINECONE_API_KEY missing — vector memory disabled.');
    return;
  }
  if (!process.env.OPENAI_API_KEY) {
    console.warn('[Memory] OPENAI_API_KEY missing — vector memory disabled.');
    return;
  }

  pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  pineconeIndex = pinecone.index(INDEX_NAME);
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  console.log(`[Memory] Vector memory ready (Pinecone index: ${INDEX_NAME}).`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function embed(text) {
  if (!openai) throw new Error('[Memory] Module not initialised.');
  const res = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: text.slice(0, 8000),
  });
  return res.data[0].embedding;
}

// ─── Core operations ──────────────────────────────────────────────────────────

/**
 * Upsert a user↔assistant exchange into Pinecone.
 * Safe to call fire-and-forget — errors are logged, not thrown.
 */
async function upsertTurn(userMsg, assistantMsg) {
  if (!pineconeIndex) return;
  const text = `User: ${userMsg}\nAssistant: ${assistantMsg}`;
  const vector = await embed(text);
  const id = `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await pineconeIndex.upsert([{
    id,
    values: vector,
    metadata: { text, ts: Date.now() },
  }]);
}

/**
 * Query the top-K most relevant past exchanges for a given query string.
 * Returns a single formatted string ready for system prompt injection.
 */
async function queryMemory(query) {
  if (!pineconeIndex) return '';
  const vector = await embed(query);
  const result = await pineconeIndex.query({ vector, topK: TOP_K, includeMetadata: true });
  const matches = result.matches || [];
  if (!matches.length) return '';
  return matches.map(m => m.metadata.text).join('\n\n---\n\n');
}

// ─── Agent handler wrapper ────────────────────────────────────────────────────

/**
 * Wrap any agentHandler(messages, options) function with memory injection.
 * Before the call: relevant past context is injected into the system prompt.
 * After the call: the exchange is upserted to Pinecone in the background.
 */
function wrapHandler(agentHandler) {
  return async function wrappedHandler(messages, options = {}) {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const query = typeof lastUser?.content === 'string' ? lastUser.content : '';

    let memoryContext = '';
    if (query) {
      try {
        memoryContext = await queryMemory(query);
      } catch (err) {
        console.error('[Memory] Query failed:', err.message);
      }
    }

    const enhancedOptions = {
      ...options,
      systemPrompt: memoryContext
        ? `${options.systemPrompt || ''}\n\n─── RELEVANT MEMORY (top ${TOP_K}) ───\n${memoryContext}\n──────────────────────────────────────`
        : options.systemPrompt,
    };

    const response = await agentHandler(messages, enhancedOptions);

    // Upsert exchange in background — never blocks the response
    const assistantText = Array.isArray(response.content)
      ? (response.content.find(b => b.type === 'text')?.text || '')
      : '';
    if (query && assistantText) {
      upsertTurn(query, assistantText).catch(err =>
        console.error('[Memory] Upsert failed:', err.message)
      );
    }

    return response;
  };
}

// ─── HTTP handler (no routes needed — memory wraps the agent) ─────────────────

function handler(router) {
  // Memory is injected at the agent handler level, not via HTTP routes.
  // Expose a status endpoint for diagnostics.
  router.get('/memory/status', (_req, res) => {
    res.json({
      ready: !!(pineconeIndex && openai),
      index: INDEX_NAME,
      topK: TOP_K,
    });
  });
  return router;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { init, handler, embed, upsertTurn, queryMemory, wrapHandler };
