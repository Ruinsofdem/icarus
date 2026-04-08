// Set env vars before any require
process.env.AIRTABLE_API_KEY = 'airtable-test-key';
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'auth-test';
process.env.TWILIO_WHATSAPP_NUMBER = '+1234567890';
process.env.MY_WHATSAPP_NUMBER = '+0987654321';

jest.mock('airtable');
jest.mock('twilio');
jest.mock('googleapis');
jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, existsSync: jest.fn().mockReturnValue(false), readFileSync: jest.fn() };
});

const Airtable = require('airtable');
const twilio = require('twilio');
const { google } = require('googleapis');
const cron = require('node-cron');
const express = require('express');

// ─── Airtable mock ────────────────────────────────────────────────────────────
const now = Date.now();
const threeDaysAgo = new Date(now - 72 * 60 * 60 * 1000).toISOString();
const recentTime   = new Date(now - 60 * 1000).toISOString();

const fakeRecords = [
  { id: 'rec1', get: (f) => ({ Name: 'Stale Lead', 'Last Activity': threeDaysAgo }[f]) },
  { id: 'rec2', get: (f) => ({ Name: 'Fresh Lead', 'Last Activity': recentTime }[f]) },
];

const mockEachPage = jest.fn((cb, done) => { cb(fakeRecords, () => {}); done(null); });
const mockSelect   = jest.fn().mockReturnValue({ eachPage: mockEachPage });
const mockAirtableTable = jest.fn().mockReturnValue({ select: mockSelect });
const mockBase     = jest.fn().mockReturnValue(mockAirtableTable);
Airtable.mockImplementation(() => ({ base: mockBase }));

// ─── Twilio mock ──────────────────────────────────────────────────────────────
const mockTwilioCreate = jest.fn().mockResolvedValue({ sid: 'SM123' });
twilio.mockReturnValue({ messages: { create: mockTwilioCreate } });

// ─── Google/Gmail mock ────────────────────────────────────────────────────────
const mockOAuth2Instance = { setCredentials: jest.fn() };
google.auth = { OAuth2: jest.fn().mockImplementation(() => mockOAuth2Instance) };

const mockThreadsList = jest.fn().mockResolvedValue({ data: { threads: [] } });
const mockThreadsGet  = jest.fn();
google.gmail = jest.fn().mockReturnValue({
  users: { threads: { list: mockThreadsList, get: mockThreadsGet } },
});

// Require module ONCE
const anomaly = require('./index');

// ─── Tests ────────────────────────────────────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks();
  Airtable.mockImplementation(() => ({ base: mockBase }));
  twilio.mockReturnValue({ messages: { create: mockTwilioCreate } });
  mockTwilioCreate.mockResolvedValue({ sid: 'SM123' });
  mockSelect.mockReturnValue({ eachPage: mockEachPage });
  mockEachPage.mockImplementation((cb, done) => { cb(fakeRecords, () => {}); done(null); });
  mockThreadsList.mockResolvedValue({ data: { threads: [] } });
  google.gmail = jest.fn().mockReturnValue({
    users: { threads: { list: mockThreadsList, get: mockThreadsGet } },
  });
  anomaly.init();
});

describe('anomaly module', () => {
  test('init() schedules cron every 30 minutes', () => {
    expect(cron.schedule).toHaveBeenCalledWith('*/30 * * * *', expect.any(Function));
  });

  test('checkStaleLeads() flags lead with no activity > 48h', async () => {
    const anomalies = await anomaly.checkStaleLeads();
    expect(anomalies.length).toBeGreaterThanOrEqual(1);
    const stale = anomalies.find(a => a.name === 'Stale Lead');
    expect(stale).toBeDefined();
    expect(stale.type).toBe('stale_lead');
    expect(stale.message).toContain('STALE LEAD');
  });

  test('checkStaleLeads() does NOT flag recently active leads', async () => {
    const anomalies = await anomaly.checkStaleLeads();
    expect(anomalies.map(a => a.name)).not.toContain('Fresh Lead');
  });

  test('runScan() sends WhatsApp alert for each anomaly found', async () => {
    const anomalies = await anomaly.runScan();
    expect(anomalies.length).toBeGreaterThan(0);
    expect(mockTwilioCreate).toHaveBeenCalledTimes(anomalies.length);
    expect(mockTwilioCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        from: expect.stringContaining('whatsapp:'),
        body: expect.stringContaining('STALE LEAD'),
      })
    );
  });

  test('runScan() flags unanswered email threads', async () => {
    const emailDate = new Date(now - 36 * 60 * 60 * 1000).toUTCString();
    mockThreadsList.mockResolvedValueOnce({ data: { threads: [{ id: 'thread1' }] } });
    mockThreadsGet.mockResolvedValueOnce({
      data: {
        messages: [{
          payload: {
            headers: [
              { name: 'From', value: 'contact@example.com' },
              { name: 'Subject', value: 'Follow up please' },
              { name: 'Date', value: emailDate },
            ],
          },
        }],
      },
    });

    // GMAIL_REFRESH_TOKEN must be set for getGmailAuth to return non-null
    process.env.GMAIL_REFRESH_TOKEN = 'fake-refresh-token';
    const anomalies = await anomaly.runScan();
    delete process.env.GMAIL_REFRESH_TOKEN;

    const emailAnomalies = anomalies.filter(a => a.type === 'unanswered_email');
    expect(emailAnomalies.length).toBeGreaterThanOrEqual(1);
    expect(emailAnomalies[0].message).toContain('UNANSWERED EMAIL');
  });

  test('handler() registers GET /anomaly/status and POST /anomaly/scan', () => {
    const router = express.Router();
    anomaly.handler(router);
    const routes = router.stack.map(l =>
      `${Object.keys(l.route?.methods || {})[0]?.toUpperCase()} ${l.route?.path}`
    );
    expect(routes).toContain('GET /anomaly/status');
    expect(routes).toContain('POST /anomaly/scan');
  });

  test('GET /anomaly/status returns scan state', async () => {
    const request = require('supertest');
    const app = express();
    app.use(express.json());
    const router = express.Router();
    anomaly.handler(router);
    app.use(router);
    const res = await request(app).get('/anomaly/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok');
  });
});
