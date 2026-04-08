'use strict';

// ─── Mock Playwright before requiring the module ──────────────────────────────

const mockPage = {
  goto: jest.fn().mockResolvedValue(undefined),
  screenshot: jest.fn().mockResolvedValue(Buffer.alloc(512, 'x')),
  click: jest.fn().mockResolvedValue(undefined),
  fill: jest.fn().mockResolvedValue(undefined),
  selectOption: jest.fn().mockResolvedValue(undefined),
  keyboard: { press: jest.fn().mockResolvedValue(undefined) },
  waitForTimeout: jest.fn().mockResolvedValue(undefined),
  $$eval: jest.fn().mockResolvedValue('Extracted text content'),
};

const mockContext = {
  newPage: jest.fn().mockResolvedValue(mockPage),
};

const mockBrowser = {
  newContext: jest.fn().mockResolvedValue(mockContext),
  close: jest.fn().mockResolvedValue(undefined),
};

jest.mock('playwright', () => ({
  chromium: {
    launch: jest.fn().mockResolvedValue(mockBrowser),
  },
}), { virtual: true });

// ─── Mock Anthropic SDK ───────────────────────────────────────────────────────

// Default: returns "done" action so we don't loop forever
const mockCreate = jest.fn().mockResolvedValue({
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        action: 'done',
        reason: 'Task complete',
        result: 'Found the pricing: Basic $29/mo, Pro $79/mo.',
      }),
    },
  ],
});

jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }));
});

// ─── Import module after mocks ────────────────────────────────────────────────

const browser = require('../modules/browser/index');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Browser module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Restore default "done" response
    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            action: 'done',
            reason: 'Task complete',
            result: 'Found the pricing: Basic $29/mo, Pro $79/mo.',
          }),
        },
      ],
    });
    mockPage.screenshot.mockResolvedValue(Buffer.alloc(512, 'x'));
  });

  describe('exports', () => {
    it('exports tools array with browser_task definition', () => {
      expect(Array.isArray(browser.tools)).toBe(true);
      const tool = browser.tools.find((t) => t.name === 'browser_task');
      expect(tool).toBeDefined();
      expect(tool.input_schema.required).toContain('url');
      expect(tool.input_schema.required).toContain('task');
    });

    it('exports init, handler, runTask', () => {
      expect(typeof browser.init).toBe('function');
      expect(typeof browser.handler).toBe('function');
      expect(typeof browser.runTask).toBe('function');
    });
  });

  describe('runTask()', () => {
    it('navigates to the given URL', async () => {
      await browser.runTask('https://example.com', 'Extract heading');
      expect(mockPage.goto).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({ waitUntil: 'domcontentloaded' })
      );
    });

    it('takes a screenshot on each step', async () => {
      await browser.runTask('https://example.com', 'Extract heading');
      expect(mockPage.screenshot).toHaveBeenCalled();
    });

    it('calls Claude vision with the task prompt', async () => {
      await browser.runTask('https://example.com', 'Find the price');
      expect(mockCreate).toHaveBeenCalled();
      const callArgs = mockCreate.mock.calls[0][0];
      const textBlock = callArgs.messages[0].content.find((c) => c.type === 'text');
      expect(textBlock.text).toContain('Find the price');
    });

    it('returns the result from done action', async () => {
      const result = await browser.runTask('https://example.com', 'Extract pricing');
      expect(result).toContain('Basic $29/mo');
    });

    it('executes click action when Claude returns click', async () => {
      mockCreate
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: JSON.stringify({ action: 'click', selector: '#submit-btn', reason: 'Submit form' }) }],
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: JSON.stringify({ action: 'done', result: 'Form submitted.' }) }],
        });

      await browser.runTask('https://example.com', 'Submit the form');
      expect(mockPage.click).toHaveBeenCalledWith('#submit-btn', expect.any(Object));
    });

    it('executes type action when Claude returns type', async () => {
      mockCreate
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: JSON.stringify({ action: 'type', selector: '#email', text: 'test@example.com', reason: 'Fill email' }) }],
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: JSON.stringify({ action: 'done', result: 'Email filled.' }) }],
        });

      await browser.runTask('https://example.com', 'Fill the email field');
      expect(mockPage.fill).toHaveBeenCalledWith('#email', 'test@example.com');
    });

    it('appends extracted content when extract_selector is provided', async () => {
      mockPage.$$eval.mockResolvedValueOnce('Basic $29\nPro $79');
      const result = await browser.runTask('https://example.com', 'Extract pricing', {
        extractSelector: '.pricing-card',
      });
      expect(result).toContain('Basic $29');
      expect(result).toContain('.pricing-card');
    });

    it('stops at max_steps and returns summary', async () => {
      // Always return a non-done action so we hit the limit
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({ action: 'wait', reason: 'Loading' }) }],
      });

      const result = await browser.runTask('https://example.com', 'Do something', { maxSteps: 2 });
      expect(result).toMatch(/max steps/i);
    });

    it('closes the browser even if an error is thrown', async () => {
      mockPage.goto.mockRejectedValueOnce(new Error('Navigation timeout'));
      await expect(
        browser.runTask('https://example.com', 'Should fail')
      ).rejects.toThrow('Navigation timeout');
      expect(mockBrowser.close).toHaveBeenCalled();
    });

    it('handles malformed JSON from Claude gracefully', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'I cannot determine the next action.' }],
      });
      const result = await browser.runTask('https://example.com', 'Some task');
      // Falls back to treating raw text as the done result
      expect(typeof result).toBe('string');
    });
  });

  describe('handler()', () => {
    it('returns result string for browser_task', async () => {
      const result = await browser.handler('browser_task', {
        url: 'https://example.com',
        task: 'Extract the headline',
      });
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('returns error string for unknown tool name', async () => {
      const result = await browser.handler('unknown_tool', {});
      expect(result).toMatch(/unknown tool/i);
    });
  });

  describe('init()', () => {
    it('registers POST /modules/browser/task on Express app', () => {
      const routes = [];
      const mockApp = { post: jest.fn((path) => routes.push(path)) };
      browser.init(mockApp);
      expect(routes).toContain('/modules/browser/task');
    });
  });
});
