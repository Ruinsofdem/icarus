'use strict';

// ─── Mock external dependencies before requiring the module ──────────────────

jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: {
      create: jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'The screen shows a terminal window.' }],
      }),
    },
  }));
});

jest.mock('child_process', () => ({
  exec: jest.fn((cmd, cb) => cb(null, '', '')),
}));

jest.mock('fs', () => ({
  readFileSync: jest.fn(() => Buffer.alloc(1024, 'x')), // non-empty buffer
  existsSync: jest.fn(() => true),
  writeFileSync: jest.fn(),
}));

// ─── Import module after mocks are in place ───────────────────────────────────

const vision = require('../modules/vision/index');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Vision module', () => {
  describe('exports', () => {
    it('exports tools array with capture_screen definition', () => {
      expect(Array.isArray(vision.tools)).toBe(true);
      const tool = vision.tools.find((t) => t.name === 'capture_screen');
      expect(tool).toBeDefined();
      expect(tool.input_schema.required).toContain('prompt');
    });

    it('exports init function', () => {
      expect(typeof vision.init).toBe('function');
    });

    it('exports handler function', () => {
      expect(typeof vision.handler).toBe('function');
    });

    it('exports analyseScreen function', () => {
      expect(typeof vision.analyseScreen).toBe('function');
    });
  });

  describe('handler()', () => {
    it('returns analysis string for capture_screen', async () => {
      const result = await vision.handler('capture_screen', { prompt: 'What is on the screen?' });
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('returns error string for unknown tool name', async () => {
      const result = await vision.handler('nonexistent_tool', {});
      expect(result).toMatch(/unknown tool/i);
    });
  });

  describe('analyseScreen()', () => {
    it('returns a string analysis', async () => {
      const result = await vision.analyseScreen('Describe the screen.');
      expect(typeof result).toBe('string');
      expect(result).toContain('terminal');
    });

    it('returns error string when screenshot fails', async () => {
      const fs = require('fs');
      fs.readFileSync.mockImplementationOnce(() => { throw new Error('Permission denied'); });

      const result = await vision.analyseScreen('What is visible?');
      expect(result).toMatch(/screenshot capture failed/i);
    });
  });

  describe('init()', () => {
    it('registers POST /modules/vision/capture on Express app', () => {
      const routes = [];
      const mockApp = {
        post: jest.fn((path) => routes.push(path)),
      };
      vision.init(mockApp);
      expect(routes).toContain('/modules/vision/capture');
    });
  });
});
