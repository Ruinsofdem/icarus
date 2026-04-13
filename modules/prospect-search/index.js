/**
 * Prospect Search Module
 * Gives Icarus (Claude) direct access to the Airtable Scraped Leads table
 * so it can answer questions about prospects, find outreach targets, and
 * check fit before recommending actions.
 */

const express = require('express');

const BASE_ID = process.env.AIRTABLE_BASE_ID || 'app6B6clOJP8i0J4Q';
const TABLE_NAME = 'Scraped Leads';
const API_KEY = process.env.AIRTABLE_API_KEY || '';
const BASE_URL = 'https://api.airtable.com/v0';

const FIELDS = [
  'Business Name', 'Category', 'Suburb', 'State', 'Phone', 'Email',
  'Website', 'Google Rating', 'Review Count', 'ICP Score',
  'Openclaw Fit', 'Recommended Agent', 'Pain Angle',
  'Has Chat', 'Has Booking', 'Multi Location', 'Tech Stack',
];

async function airtableFetch(formula, maxRecords = 20) {
  if (!API_KEY) return { error: 'AIRTABLE_API_KEY not set' };

  const params = new URLSearchParams();
  FIELDS.forEach(f => params.append('fields[]', f));
  if (formula) params.set('filterByFormula', formula);
  params.set('pageSize', String(Math.min(maxRecords, 100)));
  params.set('sort[0][field]', 'Openclaw Fit');
  params.set('sort[0][direction]', 'desc');
  params.set('sort[1][field]', 'Review Count');
  params.set('sort[1][direction]', 'desc');

  const url = `${BASE_URL}/${BASE_ID}/${encodeURIComponent(TABLE_NAME)}?${params}`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });

  if (!resp.ok) {
    const body = await resp.text();
    return { error: `Airtable ${resp.status}: ${body.slice(0, 200)}` };
  }

  const data = await resp.json();
  return data.records.map(r => ({
    id: r.id,
    ...r.fields,
  }));
}

function formatCard(rec) {
  const stars = rec['Google Rating'] ? `${rec['Google Rating']}★ (${rec['Review Count'] || 0} reviews)` : 'No rating';
  const fit = rec['Openclaw Fit'] ? `Fit: ${rec['Openclaw Fit']}/5` : '';
  const chat = rec['Has Chat'] ? '💬 Has chatbot' : '❌ No chatbot';
  const booking = rec['Has Booking'] ? '📅 Has booking' : '';
  const multi = rec['Multi Location'] ? '📍 Multi-location' : '';
  const tech = rec['Tech Stack'] ? `Tech: ${rec['Tech Stack']}` : '';

  return [
    `**${rec['Business Name']}** | ${rec['Category']} | ${rec['Suburb']}, ${rec['State']}`,
    `${stars} | ${fit} | ${chat}${booking ? ' | ' + booking : ''}${multi ? ' | ' + multi : ''}`,
    `📞 ${rec['Phone'] || '—'} | ✉️ ${rec['Email'] || '—'}`,
    `🌐 ${rec['Website'] || '—'}`,
    rec['Recommended Agent'] ? `Agent: ${rec['Recommended Agent']}` : '',
    rec['Pain Angle'] ? `Pain: ${rec['Pain Angle']}` : '',
    tech,
  ].filter(Boolean).join('\n');
}

async function searchProspects(action, params = {}) {
  try {
    if (action === 'search') {
      const q = (params.query || '').trim();
      if (!q) return 'Please provide a search query.';
      const formula = `SEARCH(LOWER("${q}"), LOWER({Business Name}))`;
      const results = await airtableFetch(formula, params.limit || 10);
      if (results.error) return results.error;
      if (!results.length) return `No prospects found matching "${q}".`;
      return results.map(formatCard).join('\n\n---\n\n');
    }

    if (action === 'filter') {
      const conditions = [];

      if (params.category) conditions.push(`SEARCH(LOWER("${params.category}"), LOWER({Category}))`);
      if (params.state) conditions.push(`{State} = "${params.state}"`);
      if (params.suburb) conditions.push(`SEARCH(LOWER("${params.suburb}"), LOWER({Suburb}))`);
      if (params.min_icp) conditions.push(`{ICP Score} >= ${params.min_icp}`);
      if (params.min_fit) conditions.push(`{Openclaw Fit} >= ${params.min_fit}`);
      if (params.has_chat === false) conditions.push(`{Has Chat} = FALSE()`);
      if (params.has_chat === true) conditions.push(`{Has Chat} = TRUE()`);
      if (params.has_email === true) conditions.push(`{Email} != ""`);
      if (params.has_booking === false) conditions.push(`{Has Booking} = FALSE()`);
      if (params.multi_location === true) conditions.push(`{Multi Location} = TRUE()`);
      if (params.recommended_agent) conditions.push(`{Recommended Agent} = "${params.recommended_agent}"`);

      if (!conditions.length) conditions.push('{ICP Score} >= 2');

      const formula = conditions.length === 1 ? conditions[0] : `AND(${conditions.join(', ')})`;
      const results = await airtableFetch(formula, params.limit || 15);
      if (results.error) return results.error;
      if (!results.length) return 'No prospects match those filters.';
      return `Found ${results.length} prospects:\n\n` + results.map(formatCard).join('\n\n---\n\n');
    }

    if (action === 'top') {
      const n = params.limit || 10;
      const formula = '{Openclaw Fit} >= 4';
      const results = await airtableFetch(formula, n);
      if (results.error) return results.error;
      if (!results.length) return 'No top prospects found.';
      return `Top ${results.length} prospects by fit + reviews:\n\n` + results.map(formatCard).join('\n\n---\n\n');
    }

    if (action === 'stats') {
      // Get all researched records
      const formula = '{Openclaw Fit} >= 1';
      const all = await airtableFetch(formula, 100);
      if (all.error) return all.error;

      const total = all.length;
      const byCat = {};
      const byFit = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
      const noChat = all.filter(r => !r['Has Chat']).length;

      for (const r of all) {
        const cat = r['Category'] || 'Unknown';
        byCat[cat] = (byCat[cat] || 0) + 1;
        const fit = r['Openclaw Fit'] || 0;
        if (byFit[fit] !== undefined) byFit[fit]++;
      }

      return [
        `**Prospect Intelligence Stats** (showing up to 100 researched records)`,
        `Total researched: ${total}`,
        ``,
        `**By Fit Score:**`,
        ...Object.entries(byFit).map(([k, v]) => `  Fit ${k}: ${v}`),
        ``,
        `**By Sector:**`,
        ...Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k}: ${v}`),
        ``,
        `**No chatbot:** ${noChat} (${total ? Math.round(noChat * 100 / total) : 0}%)`,
      ].join('\n');
    }

    return `Unknown action: ${action}. Use search, filter, top, or stats.`;
  } catch (e) {
    return `Prospect search error: ${e.message}`;
  }
}

function init() {
  const router = express.Router();

  router.get('/search', async (req, res) => {
    const result = await searchProspects('search', { query: req.query.q, limit: req.query.limit });
    res.json({ result });
  });

  router.get('/filter', async (req, res) => {
    const result = await searchProspects('filter', req.query);
    res.json({ result });
  });

  router.get('/top', async (req, res) => {
    const result = await searchProspects('top', { limit: req.query.limit });
    res.json({ result });
  });

  router.get('/stats', async (req, res) => {
    const result = await searchProspects('stats', {});
    res.json({ result });
  });

  return router;
}

const tools = [
  {
    name: 'search_prospects',
    description: 'Search and filter the Openclaw prospect database (3,600+ scraped leads in Airtable). 307 leads are fully researched with Openclaw fit scores (1-5), pain angles, recommended agents, and tech stack detection. Use this to answer questions about prospects, find outreach targets, or check fit. Actions: search (by name), filter (by category/state/fit/signals), top (best prospects), stats (summary counts).',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'filter', 'top', 'stats'],
          description: 'search: find by business name. filter: filter by category, state, fit score, signals (has_chat, has_booking, multi_location). top: return highest-fit prospects. stats: summary counts.',
        },
        params: {
          type: 'object',
          description: 'search: { query, limit? }. filter: { category?, state?, suburb?, min_icp?, min_fit?, has_chat?, has_email?, has_booking?, multi_location?, recommended_agent?, limit? }. top: { limit? }. stats: {}.',
        },
      },
      required: ['action'],
    },
  },
];

async function handler(name, input) {
  if (name === 'search_prospects') {
    return await searchProspects(input.action, input.params || {});
  }
  return `Unknown tool: ${name}`;
}

module.exports = { init, tools, handler };
