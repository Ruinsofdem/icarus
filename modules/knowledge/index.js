require('dotenv').config();
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Pinecone } = require('@pinecone-database/pinecone');
const OpenAI = require('openai');

const INDEX_NAME = 'icarus-knowledge';
const EMBED_MODEL = 'text-embedding-3-small';
const FEED_DIR = path.join(__dirname, '../../knowledge-feed');

const TOPICS = [
  'AI news latest',
  'finance news Australia',
  'SME small business Sydney news',
];

let pineconeIndex = null;
let openai = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  if (!process.env.PINECONE_API_KEY || !process.env.OPENAI_API_KEY || !process.env.BRAVE_API_KEY) {
    console.warn('[Knowledge] Missing PINECONE_API_KEY / OPENAI_API_KEY / BRAVE_API_KEY — knowledge scraper disabled.');
    return;
  }

  const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  pineconeIndex = pinecone.index(INDEX_NAME);
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  if (!fs.existsSync(FEED_DIR)) fs.mkdirSync(FEED_DIR, { recursive: true });

  // Every 6 hours
  cron.schedule('0 */6 * * *', () => {
    scrapeAll().catch(err => console.error('[Knowledge] Scheduled scrape failed:', err.message));
  });

  console.log(`[Knowledge] Scraper ready (every 6h). Index: ${INDEX_NAME}.`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function embed(text) {
  const res = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: text.slice(0, 8000),
  });
  return res.data[0].embedding;
}

async function braveSearch(query, count = 5) {
  const res = await axios.get('https://api.search.brave.com/res/v1/web/search', {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': process.env.BRAVE_API_KEY,
    },
    params: { q: query, count },
    timeout: 10000,
  });
  return res.data.web?.results || [];
}

// ─── Core scrape ──────────────────────────────────────────────────────────────

async function scrapeAll() {
  if (!pineconeIndex || !openai) {
    throw new Error('[Knowledge] Module not initialised.');
  }

  const results = [];

  for (const topic of TOPICS) {
    try {
      const items = await braveSearch(topic);
      for (const item of items) {
        const summary = `${item.title}: ${item.description || '(no description)'}`;
        const vector = await embed(summary);
        // Stable ID — prevents duplicate upserts for same URL
        const urlHash = Buffer.from(item.url || '').toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
        const id = `kb_${urlHash}_${Date.now()}`;

        await pineconeIndex.upsert([{
          id,
          values: vector,
          metadata: {
            summary,
            url: item.url || '',
            topic,
            ts: Date.now(),
          },
        }]);

        results.push({ topic, title: item.title, url: item.url || '', summary });
      }
    } catch (err) {
      console.error(`[Knowledge] Scrape failed for "${topic}":`, err.message);
    }
  }

  // Write markdown summary
  if (results.length > 0) {
    const date = new Date().toISOString().slice(0, 10);
    const time = new Date().toISOString().slice(11, 16);
    const mdFile = path.join(FEED_DIR, `${date}.md`);
    const existingContent = fs.existsSync(mdFile) ? fs.readFileSync(mdFile, 'utf8') + '\n\n---\n\n' : '';
    const newSection = results.map(r =>
      `### ${r.topic}\n**${r.title}**\n${r.summary}\n[${r.url}](${r.url})`
    ).join('\n\n');
    fs.writeFileSync(mdFile, `${existingContent}# Knowledge Feed — ${date} ${time} UTC\n\n${newSection}`);
  }

  return results;
}

// ─── HTTP handler ─────────────────────────────────────────────────────────────

function handler(router) {
  router.get('/knowledge/latest', (req, res) => {
    try {
      if (!fs.existsSync(FEED_DIR)) return res.json({ articles: [] });
      const files = fs.readdirSync(FEED_DIR)
        .filter(f => f.endsWith('.md') && !f.startsWith('digest-'))
        .sort()
        .reverse();
      if (!files.length) return res.json({ articles: [] });
      const content = fs.readFileSync(path.join(FEED_DIR, files[0]), 'utf8');
      res.json({ file: files[0], content });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/knowledge/trigger', async (req, res) => {
    try {
      const results = await scrapeAll();
      res.json({ ok: true, count: results.length, results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { init, handler, scrapeAll, braveSearch };
