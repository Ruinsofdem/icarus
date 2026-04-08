// Set env vars before any require
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
process.env.AIRTABLE_API_KEY = 'at-test-key';
process.env.TWILIO_ACCOUNT_SID = 'AC-test';
process.env.TWILIO_AUTH_TOKEN = 'auth-test';
process.env.TWILIO_WHATSAPP_NUMBER = '+1234567890';
process.env.MY_WHATSAPP_NUMBER  = '+0987654321';

jest.mock('airtable');
jest.mock('twilio');
jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, existsSync: jest.fn().mockReturnValue(true), mkdirSync: jest.fn(), writeFileSync: jest.fn() };
});
// Prevent process.exit from real config
jest.mock('../../config', () => ({
  createMessage: jest.fn(),
  MODEL_SONNET: 'claude-sonnet-4-6',
  MODEL_HAIKU: 'claude-haiku-4-5',
  validateEnv: jest.fn(),
  validateMessages: jest.fn(msgs => msgs),
  loadMemory: jest.fn().mockReturnValue([]),
  saveMemory: jest.fn().mockResolvedValue(undefined),
  SYSTEM_PROMPT: 'mock',
  SYSTEM_PROMPT_SERVER: 'mock',
}));

const Airtable = require('airtable');
const twilio   = require('twilio');
const cron     = require('node-cron');
const fs       = require('fs');
const { createMessage } = require('../../config');
const express  = require('express');

// ─── Airtable mock ────────────────────────────────────────────────────────────
const now = Date.now();
const fakeRecords = [
  {
    id: 'r1',
    get: (f) => ({
      'Task Type': 'prospect_research', 'Duration (ms)': 3200,
      'Outcome': 'success', 'Tokens Used': 1800,
      'Timestamp': new Date(now - 1000).toISOString(),
    }[f]),
  },
  {
    id: 'r2',
    get: (f) => ({
      'Task Type': 'email_send', 'Duration (ms)': 800,
      'Outcome': 'fail', 'Tokens Used': 400,
      'Timestamp': new Date(now - 2000).toISOString(),
    }[f]),
  },
];

const mockEachPage    = jest.fn((cb, done) => { cb(fakeRecords, () => {}); done(null); });
const mockSelect      = jest.fn().mockReturnValue({ eachPage: mockEachPage });
const mockAirtableCreate = jest.fn().mockResolvedValue({ id: 'rec_new_123' });
const mockTable       = jest.fn().mockReturnValue({ select: mockSelect, create: mockAirtableCreate });
const mockBase        = jest.fn().mockReturnValue(mockTable);
Airtable.mockImplementation(() => ({ base: mockBase }));

const mockTwilioCreate = jest.fn().mockResolvedValue({ sid: 'SM456' });
twilio.mockReturnValue({ messages: { create: mockTwilioCreate } });

createMessage.mockResolvedValue({
  content: [{ type: 'text', text: '## Performance\n\nGood week. Improve retry logic.' }],
});

// Require module ONCE
const selflog = require('./index');

// ─── Tests ────────────────────────────────────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks();
  Airtable.mockImplementation(() => ({ base: mockBase }));
  twilio.mockReturnValue({ messages: { create: mockTwilioCreate } });
  mockTwilioCreate.mockResolvedValue({ sid: 'SM456' });
  mockAirtableCreate.mockResolvedValue({ id: 'rec_new_123' });
  mockSelect.mockReturnValue({ eachPage: mockEachPage });
  mockEachPage.mockImplementation((cb, done) => { cb(fakeRecords, () => {}); done(null); });
  createMessage.mockResolvedValue({
    content: [{ type: 'text', text: '## Performance\n\nGood week. Improve retry logic.' }],
  });
  selflog.init();
});

describe('selflog module', () => {
  test('init() schedules weekly Sunday 6PM AEST cron (Sunday 08:00 UTC)', () => {
    expect(cron.schedule).toHaveBeenCalledWith('0 8 * * 0', expect.any(Function), { timezone: 'UTC' });
  });

  test('logTask() creates Airtable record with correct fields', async () => {
    const id = await selflog.logTask('email_send', 1200, 'success', 750);
    expect(mockAirtableCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        'Task Type': 'email_send',
        'Duration (ms)': 1200,
        'Outcome': 'success',
        'Tokens Used': 750,
        'Timestamp': expect.any(String),
      })
    );
    expect(id).toBe('rec_new_123');
  });

  test('logTask() sanitises invalid outcome to partial', async () => {
    await selflog.logTask('test', 100, 'invalid_outcome', 0);
    expect(mockAirtableCreate).toHaveBeenCalledWith(
      expect.objectContaining({ 'Outcome': 'partial' })
    );
  });

  test('getWeekLogs() returns mapped records', async () => {
    const logs = await selflog.getWeekLogs();
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({
      taskType: 'prospect_research',
      durationMs: 3200,
      outcome: 'success',
      tokensUsed: 1800,
    });
  });

  test('buildStats() calculates correct aggregates', () => {
    const logs = [
      { taskType: 'a', durationMs: 1000, outcome: 'success', tokensUsed: 500, timestamp: '' },
      { taskType: 'b', durationMs: 3000, outcome: 'success', tokensUsed: 300, timestamp: '' },
      { taskType: 'c', durationMs: 2000, outcome: 'fail',    tokensUsed: 200, timestamp: '' },
    ];
    const stats = selflog.buildStats(logs);
    expect(stats.total).toBe(3);
    expect(stats.successRate).toBe(67);
    expect(stats.avgDuration).toBe(2000);
    expect(stats.totalTokens).toBe(1000);
    expect(stats.byOutcome).toEqual({ success: 2, fail: 1 });
  });

  test('generateWeeklyDigest() writes digest file', async () => {
    await selflog.generateWeeklyDigest();
    expect(createMessage).toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('digest-'),
      expect.stringContaining('Icarus Weekly Performance Digest')
    );
  });

  test('generateWeeklyDigest() sends WhatsApp with digest content', async () => {
    await selflog.generateWeeklyDigest();
    expect(mockTwilioCreate).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('ICARUS WEEKLY DIGEST') })
    );
  });

  test('handler() registers GET /selflog/stats and POST /selflog/log', () => {
    const router = express.Router();
    selflog.handler(router);
    const routes = router.stack.map(l =>
      `${Object.keys(l.route?.methods || {})[0]?.toUpperCase()} ${l.route?.path}`
    );
    expect(routes).toContain('GET /selflog/stats');
    expect(routes).toContain('POST /selflog/log');
  });

  test('POST /selflog/log returns 400 for missing taskType', async () => {
    const request = require('supertest');
    const app = express();
    app.use(express.json());
    const router = express.Router();
    selflog.handler(router);
    app.use(router);
    const res = await request(app).post('/selflog/log').send({ outcome: 'success' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('taskType');
  });

  test('POST /selflog/log returns 400 for invalid outcome', async () => {
    const request = require('supertest');
    const app = express();
    app.use(express.json());
    const router = express.Router();
    selflog.handler(router);
    app.use(router);
    const res = await request(app).post('/selflog/log').send({ taskType: 'test', outcome: 'wrong' });
    expect(res.status).toBe(400);
  });
});
