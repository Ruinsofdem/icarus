// Set ALL env vars before any module is loaded
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
process.env.BRAVE_API_KEY = 'test-brave-key';

// Mock config using factory to prevent real config.js from executing process.exit
jest.mock('../../config', () => ({
  createMessage: jest.fn(),
  MODEL_SONNET: 'claude-sonnet-4-6',
  MODEL_HAIKU: 'claude-haiku-4-5',
  MODEL_OPUS: 'claude-opus-4-6',
  MAX_TOKENS: 8192,
  MAX_TOOL_ITERATIONS: 10,
  validateEnv: jest.fn(),
  validateMessages: jest.fn(msgs => msgs),
  loadMemory: jest.fn().mockReturnValue([]),
  saveMemory: jest.fn().mockResolvedValue(undefined),
  SYSTEM_PROMPT: 'mock system prompt',
  SYSTEM_PROMPT_SERVER: 'mock server prompt',
}));

jest.mock('axios');
// Memory module is optional and may not be initialised — mock it
jest.mock('../memory', () => ({
  queryMemory: jest.fn().mockResolvedValue('Past context: expanded to Melbourne, outcome: success'),
  init: jest.fn(),
  wrapHandler: jest.fn(),
}), { virtual: true });

const axios = require('axios');
const { createMessage } = require('../../config');
const express = require('express');

// ─── Mock implementations ─────────────────────────────────────────────────────
const mockDecisionResponse = {
  content: [{ type: 'text', text: '{"confidence":75,"risk":"LOW","recommendation":"YES","rationale":"Strong signals."}' }],
};

createMessage.mockResolvedValue(mockDecisionResponse);
axios.get = jest.fn().mockResolvedValue({
  data: { web: { results: [{ title: 'Market insight', description: 'Growth expected', url: 'https://x.com' }] } },
});

// Require module ONCE
const decisions = require('./index');

// ─── Tests ────────────────────────────────────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks();
  createMessage.mockResolvedValue(mockDecisionResponse);
  axios.get = jest.fn().mockResolvedValue({
    data: { web: { results: [{ title: 'Insight', description: 'Detail', url: 'https://x.com' }] } },
  });
  decisions.init();
});

describe('decisions module', () => {
  test('analyzeDecision() returns valid structured JSON', async () => {
    const result = await decisions.analyzeDecision('Should we expand to Melbourne?');
    expect(result).toMatchObject({
      confidence: expect.any(Number),
      risk: expect.stringMatching(/LOW|MED|HIGH/),
      recommendation: expect.stringMatching(/YES|NO|WAIT/),
      rationale: expect.any(String),
    });
  });

  test('analyzeDecision() confidence is 0-100', async () => {
    const result = await decisions.analyzeDecision('Should we hire a BDM?');
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(100);
  });

  test('analyzeDecision() calls Brave Search when BRAVE_API_KEY is set', async () => {
    await decisions.analyzeDecision('Should we partner with Xero?');
    expect(axios.get).toHaveBeenCalledWith(
      'https://api.search.brave.com/res/v1/web/search',
      expect.objectContaining({
        params: expect.objectContaining({ q: 'Should we partner with Xero?' }),
      })
    );
  });

  test('analyzeDecision() handles malformed Claude response gracefully', async () => {
    createMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'This is not JSON at all.' }],
    });
    const result = await decisions.analyzeDecision('edge case');
    expect(result.recommendation).toBe('WAIT');
    expect(result.risk).toBe('HIGH');
    expect(result.rationale).toContain('Parse error');
  });

  test('analyzeDecision() skips Brave Search when BRAVE_API_KEY is missing', async () => {
    const saved = process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_API_KEY;
    const result = await decisions.analyzeDecision('No search key decision');
    expect(result).toHaveProperty('recommendation');
    expect(axios.get).not.toHaveBeenCalled();
    process.env.BRAVE_API_KEY = saved;
  });

  test('handler() registers POST /decisions', () => {
    const router = express.Router();
    decisions.handler(router);
    const routes = router.stack.map(l =>
      `${Object.keys(l.route?.methods || {})[0]?.toUpperCase()} ${l.route?.path}`
    );
    expect(routes).toContain('POST /decisions');
  });

  test('POST /decisions returns 400 when description is missing', async () => {
    const request = require('supertest');
    const app = express();
    app.use(express.json());
    const router = express.Router();
    decisions.handler(router);
    app.use(router);
    const res = await request(app).post('/decisions').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('description is required');
  });

  test('POST /decisions returns structured result for valid input', async () => {
    const request = require('supertest');
    const app = express();
    app.use(express.json());
    const router = express.Router();
    decisions.handler(router);
    app.use(router);
    const res = await request(app).post('/decisions').send({ description: 'Should we invest in new tooling?' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('recommendation');
  });
});
