'use strict';

// ─── Mock external dependencies ───────────────────────────────────────────────

// Paths are relative to THIS test file (tests/), so one level up reaches project root
jest.mock('../gmail', () => ({
  readEmails: jest.fn().mockResolvedValue('Email 1: Meeting request from Alice\nEmail 2: Invoice from Bob'),
}));

jest.mock('../calendar', () => ({
  checkCalendar: jest.fn().mockResolvedValue('10:00 AM — Prospect call with Apex Construction\n2:00 PM — Team standup'),
}));

jest.mock('../tools', () => ({
  webSearch: jest.fn().mockResolvedValue('1. AI agents reshape SMB automation — TechCrunch\n2. GPT-5 released — The Verge'),
}));

jest.mock('axios');
jest.mock('twilio');
jest.mock('node-cron', () => ({
  schedule: jest.fn(),
}));

const axios = require('axios');
const twilio = require('twilio');
const cron = require('node-cron');

// ─── Import module after mocks ────────────────────────────────────────────────

const briefing = require('../modules/briefing/index');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Briefing module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'test'; // prevent cron scheduling in init()
  });

  describe('exports', () => {
    it('exports tools array with generate_briefing definition', () => {
      expect(Array.isArray(briefing.tools)).toBe(true);
      const tool = briefing.tools.find((t) => t.name === 'generate_briefing');
      expect(tool).toBeDefined();
    });

    it('exports init, handler, generateBriefing, fetchAirtableUpdates, sendBriefingWhatsApp', () => {
      expect(typeof briefing.init).toBe('function');
      expect(typeof briefing.handler).toBe('function');
      expect(typeof briefing.generateBriefing).toBe('function');
      expect(typeof briefing.fetchAirtableUpdates).toBe('function');
      expect(typeof briefing.sendBriefingWhatsApp).toBe('function');
    });
  });

  describe('generateBriefing()', () => {
    it('returns a formatted string containing all four sections', async () => {
      const result = await briefing.generateBriefing({});
      expect(typeof result).toBe('string');
      expect(result).toMatch(/Icarus Morning Briefing/);
      expect(result).toMatch(/Calendar/);
      expect(result).toMatch(/Email/);
      expect(result).toMatch(/Airtable/);
      expect(result).toMatch(/News/);
    });

    it('includes calendar event data', async () => {
      const result = await briefing.generateBriefing({});
      expect(result).toContain('Apex Construction');
    });

    it('includes email data', async () => {
      const result = await briefing.generateBriefing({});
      expect(result).toContain('Invoice');
    });

    it('accepts a custom news_query', async () => {
      const { webSearch } = require('../tools');
      await briefing.generateBriefing({ newsQuery: 'construction tech trends 2025' });
      expect(webSearch).toHaveBeenCalledWith('construction tech trends 2025');
    });

    it('handles partial failures gracefully (shows Error: in affected section)', async () => {
      const { readEmails } = require('../gmail');
      readEmails.mockRejectedValueOnce(new Error('Gmail token expired'));
      const result = await briefing.generateBriefing({});
      expect(result).toMatch(/Error:/);
      // Other sections should still appear
      expect(result).toMatch(/Calendar/);
    });
  });

  describe('fetchAirtableUpdates()', () => {
    it('returns config-missing message when env vars absent', async () => {
      delete process.env.AIRTABLE_API_KEY;
      delete process.env.AIRTABLE_BASE_ID;
      delete process.env.AIRTABLE_TABLE_NAME;
      const result = await briefing.fetchAirtableUpdates();
      expect(result).toMatch(/not configured/i);
    });

    it('formats Airtable records into bullet list', async () => {
      process.env.AIRTABLE_API_KEY = 'key_test';
      process.env.AIRTABLE_BASE_ID = 'app_test';
      process.env.AIRTABLE_TABLE_NAME = 'Prospects';

      axios.get = jest.fn().mockResolvedValue({
        data: {
          records: [
            { id: 'rec1', fields: { Name: 'Apex Construction', Status: 'Qualified' } },
            { id: 'rec2', fields: { Company: 'BuildRight', Stage: 'Proposal' } },
          ],
        },
      });

      const result = await briefing.fetchAirtableUpdates();
      expect(result).toContain('Apex Construction');
      expect(result).toContain('Qualified');
      expect(result).toContain('BuildRight');
    });

    it('returns error string when Airtable API fails', async () => {
      process.env.AIRTABLE_API_KEY = 'key_test';
      process.env.AIRTABLE_BASE_ID = 'app_test';
      process.env.AIRTABLE_TABLE_NAME = 'Prospects';

      axios.get = jest.fn().mockRejectedValue(new Error('Network error'));
      const result = await briefing.fetchAirtableUpdates();
      expect(result).toMatch(/fetch failed/i);
    });

    afterEach(() => {
      delete process.env.AIRTABLE_API_KEY;
      delete process.env.AIRTABLE_BASE_ID;
      delete process.env.AIRTABLE_TABLE_NAME;
    });
  });

  describe('handler()', () => {
    it('returns briefing text for generate_briefing', async () => {
      const result = await briefing.handler('generate_briefing', { send_whatsapp: false });
      expect(typeof result).toBe('string');
      expect(result).toMatch(/Icarus Morning Briefing/);
    });

    it('appends WhatsApp success note when send_whatsapp is true', async () => {
      const mockCreate = jest.fn().mockResolvedValue({ sid: 'SM123' });
      twilio.mockReturnValue({ messages: { create: mockCreate } });

      process.env.TWILIO_ACCOUNT_SID = 'AC_test';
      process.env.TWILIO_AUTH_TOKEN = 'auth_test';
      process.env.TWILIO_WHATSAPP_NUMBER = '+15005550006';
      process.env.MY_WHATSAPP_NUMBER = '+61400000000';

      const result = await briefing.handler('generate_briefing', { send_whatsapp: true });
      expect(result).toMatch(/sent via WhatsApp/i);
    });

    it('appends WhatsApp failure note when Twilio is not configured', async () => {
      delete process.env.TWILIO_ACCOUNT_SID;
      const result = await briefing.handler('generate_briefing', { send_whatsapp: true });
      expect(result).toMatch(/WhatsApp send failed/i);
    });

    it('returns error string for unknown tool name', async () => {
      const result = await briefing.handler('unknown_tool', {});
      expect(result).toMatch(/unknown tool/i);
    });
  });

  describe('init()', () => {
    it('registers POST /modules/briefing/generate route', () => {
      const routes = [];
      const mockApp = { post: jest.fn((path) => routes.push(path)) };
      briefing.init(mockApp);
      expect(routes).toContain('/modules/briefing/generate');
    });

    it('does NOT schedule cron job in test environment', () => {
      process.env.NODE_ENV = 'test';
      const mockApp = { post: jest.fn() };
      briefing.init(mockApp);
      expect(cron.schedule).not.toHaveBeenCalled();
    });
  });
});
