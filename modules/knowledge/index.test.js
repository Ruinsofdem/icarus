// Set env vars before any require
process.env.PINECONE_API_KEY = 'pk-test';
process.env.OPENAI_API_KEY = 'ok-test';
process.env.BRAVE_API_KEY = 'bk-test';

jest.mock('@pinecone-database/pinecone');
jest.mock('openai');
jest.mock('axios');
jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn().mockReturnValue(true),
    mkdirSync: jest.fn(),
    readdirSync: jest.fn().mockReturnValue(['2025-01-01.md']),
    readFileSync: jest.fn().mockReturnValue('# Knowledge Feed'),
    writeFileSync: jest.fn(),
  };
});

const { Pinecone } = require('@pinecone-database/pinecone');
const OpenAI = require('openai');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const express = require('express');

// ─── Mock implementations ─────────────────────────────────────────────────────
const mockUpsert = jest.fn().mockResolvedValue({});
const mockPineconeIndex = { upsert: mockUpsert };
const mockIndexFactory = jest.fn().mockReturnValue(mockPineconeIndex);
Pinecone.mockImplementation(() => ({ index: mockIndexFactory }));

const mockEmbedCreate = jest.fn().mockResolvedValue({ data: [{ embedding: new Array(1536).fill(0.1) }] });
OpenAI.mockImplementation(() => ({ embeddings: { create: mockEmbedCreate } }));

const mockBraveResults = [
  { title: 'AI news headline', description: 'Some AI news', url: 'https://example.com/ai' },
  { title: 'Finance update', description: 'Market moves', url: 'https://example.com/finance' },
];
axios.get = jest.fn().mockResolvedValue({ data: { web: { results: mockBraveResults } } });

// Require module ONCE
const knowledge = require('./index');

// ─── Tests ────────────────────────────────────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks();
  Pinecone.mockImplementation(() => ({ index: mockIndexFactory }));
  OpenAI.mockImplementation(() => ({ embeddings: { create: mockEmbedCreate } }));
  mockIndexFactory.mockReturnValue(mockPineconeIndex);
  mockEmbedCreate.mockResolvedValue({ data: [{ embedding: new Array(1536).fill(0.1) }] });
  mockUpsert.mockResolvedValue({});
  axios.get = jest.fn().mockResolvedValue({ data: { web: { results: mockBraveResults } } });
  knowledge.init();
});

describe('knowledge module', () => {
  test('init() schedules cron every 6 hours', () => {
    expect(cron.schedule).toHaveBeenCalledWith('0 */6 * * *', expect.any(Function));
  });

  test('init() creates Pinecone index and OpenAI client', () => {
    expect(Pinecone).toHaveBeenCalledWith({ apiKey: 'pk-test' });
    expect(OpenAI).toHaveBeenCalledWith({ apiKey: 'ok-test' });
    expect(mockIndexFactory).toHaveBeenCalledWith('icarus-knowledge');
  });

  test('braveSearch() calls Brave API with correct headers and params', async () => {
    const results = await knowledge.braveSearch('AI news', 3);
    expect(axios.get).toHaveBeenCalledWith(
      'https://api.search.brave.com/res/v1/web/search',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Subscription-Token': 'bk-test' }),
        params: { q: 'AI news', count: 3 },
      })
    );
    expect(results).toHaveLength(2);
  });

  test('scrapeAll() embeds and upserts results to Pinecone', async () => {
    const results = await knowledge.scrapeAll();
    expect(mockEmbedCreate).toHaveBeenCalled();
    expect(mockUpsert).toHaveBeenCalled();
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toMatchObject({ topic: expect.any(String), title: expect.any(String) });
  });

  test('scrapeAll() writes markdown to knowledge-feed/', async () => {
    await knowledge.scrapeAll();
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('knowledge-feed'),
      expect.stringContaining('Knowledge Feed')
    );
  });

  test('scrapeAll() continues when one topic fails', async () => {
    axios.get
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue({ data: { web: { results: mockBraveResults } } });
    const results = await knowledge.scrapeAll();
    expect(results.length).toBeGreaterThan(0);
  });

  test('handler() registers GET /knowledge/latest and POST /knowledge/trigger', () => {
    const router = express.Router();
    knowledge.handler(router);
    const routes = router.stack.map(l =>
      `${Object.keys(l.route?.methods || {})[0]?.toUpperCase()} ${l.route?.path}`
    );
    expect(routes).toContain('GET /knowledge/latest');
    expect(routes).toContain('POST /knowledge/trigger');
  });
});
