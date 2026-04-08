'use strict';

// Playwright is an optional dependency — fail gracefully if not installed.
let chromium;
try {
  chromium = require('playwright').chromium;
} catch {
  chromium = null;
}

const Anthropic = require('@anthropic-ai/sdk');

const MAX_STEPS = 10;
const BROWSER_MODEL = 'claude-sonnet-4-6';
const NAV_TIMEOUT  = 30_000; // ms
const ACTION_TIMEOUT = 5_000; // ms

// ─── Tool definitions (Claude tool schema) ────────────────────────────────────

const tools = [
  {
    name: 'browser_task',
    description:
      'Run a headless Playwright browser to automate a task on a web page. ' +
      'Claude vision guides each step (navigate → screenshot → decide → act) until the task is complete. ' +
      'Can extract data, fill forms, click elements, and navigate multi-step flows. ' +
      'Requires playwright to be installed: npm install playwright && npx playwright install chromium.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to navigate to.',
        },
        task: {
          type: 'string',
          description:
            'The task to perform, e.g. "Extract all pricing tiers" or ' +
            '"Fill the contact form: name=John, email=john@example.com".',
        },
        extract_selector: {
          type: 'string',
          description: 'Optional CSS selector to extract text from after the task completes.',
        },
        max_steps: {
          type: 'number',
          description: `Maximum interaction steps before stopping. Default: ${MAX_STEPS}.`,
        },
      },
      required: ['url', 'task'],
    },
  },
];

// ─── Vision-guided action prompt ──────────────────────────────────────────────

function buildStepPrompt(task, step, maxSteps, priorActions) {
  return (
    `You are a browser automation agent. Task: "${task}"\n` +
    `Step ${step}/${maxSteps}. Prior actions: ${priorActions.length ? priorActions.join(' → ') : 'none'}.\n\n` +
    'Look at the screenshot and return ONLY a JSON object (no markdown, no commentary):\n' +
    '{\n' +
    '  "action": "click" | "type" | "scroll" | "select" | "wait" | "extract" | "done",\n' +
    '  "selector": "CSS selector (required for click/type/select/extract)",\n' +
    '  "text": "text to type or option value to select",\n' +
    '  "direction": "up" | "down" (for scroll only),\n' +
    '  "reason": "one-line explanation of why",\n' +
    '  "result": "what was found (required for extract and done)"\n' +
    '}\n\n' +
    'If the task is complete, use "done" and put the answer in "result".'
  );
}

// ─── Core task runner ─────────────────────────────────────────────────────────

async function runTask(url, task, { extractSelector, maxSteps = MAX_STEPS } = {}) {
  if (!chromium) {
    return (
      '[Browser] Playwright is not installed. ' +
      'Run: npm install playwright && npx playwright install chromium'
    );
  }

  const client = new Anthropic();
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    const priorActions = [];

    for (let step = 1; step <= maxSteps; step++) {
      // Capture viewport screenshot
      const screenshot = await page.screenshot({ type: 'png', fullPage: false });
      const base64 = screenshot.toString('base64');

      // Ask Claude vision what to do next
      const visionResp = await client.messages.create({
        model: BROWSER_MODEL,
        max_tokens: 512,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
              { type: 'text', text: buildStepPrompt(task, step, maxSteps, priorActions) },
            ],
          },
        ],
      });

      const rawText = visionResp.content.find((b) => b.type === 'text')?.text || '{}';

      // Extract JSON from response (Claude may add surrounding text)
      let instruction;
      try {
        const jsonMatch = rawText.match(/\{[\s\S]*?\}/);
        instruction = jsonMatch ? JSON.parse(jsonMatch[0]) : { action: 'done', result: rawText };
      } catch {
        instruction = { action: 'done', result: rawText };
      }

      const { action, selector, text, direction, reason, result } = instruction;
      priorActions.push(`${action}${selector ? `(${selector})` : ''}${reason ? ` — ${reason}` : ''}`);

      // ── Handle terminal state ─────────────────────────────────────────────
      if (action === 'done') {
        const finalResult = result || 'Task marked complete — no result provided.';
        if (extractSelector) {
          try {
            const extracted = await page.$$eval(
              extractSelector,
              (els) => els.map((e) => e.innerText.trim()).filter(Boolean).join('\n')
            );
            return `${finalResult}\n\nExtracted via \`${extractSelector}\`:\n${extracted}`;
          } catch {
            // Selector failed — return vision result only
          }
        }
        return finalResult;
      }

      // ── Execute action ────────────────────────────────────────────────────
      try {
        if (action === 'click' && selector) {
          await page.click(selector, { timeout: ACTION_TIMEOUT });

        } else if (action === 'type' && selector && text) {
          await page.fill(selector, text);

        } else if (action === 'select' && selector && text) {
          await page.selectOption(selector, text);

        } else if (action === 'scroll') {
          await page.keyboard.press(direction === 'up' ? 'PageUp' : 'PageDown');
          await page.waitForTimeout(500);

        } else if (action === 'extract' && selector) {
          const extracted = await page.$$eval(
            selector,
            (els) => els.map((e) => e.innerText.trim()).filter(Boolean).join('\n')
          ).catch(() => '');
          priorActions.push(`extracted: ${extracted.slice(0, 150)}`);

        } else if (action === 'wait') {
          await page.waitForTimeout(2000);
        }

        // Brief settle after each action
        await page.waitForTimeout(300);

      } catch (actionErr) {
        // Non-fatal — log and continue to next step
        priorActions.push(`[action failed: ${actionErr.message}]`);
      }
    }

    return `Task reached max steps (${maxSteps}). Actions taken: ${priorActions.join(' → ')}`;

  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─── Module interface ─────────────────────────────────────────────────────────

function init(app) {
  // POST /modules/browser/task — REST endpoint for direct use
  app.post('/modules/browser/task', async (req, res) => {
    const { url, task, extract_selector, max_steps } = req.body;
    if (!url || !task) {
      return res.status(400).json({ error: 'url and task are required.' });
    }
    try {
      const result = await runTask(url, task, {
        extractSelector: extract_selector,
        maxSteps: max_steps,
      });
      res.json({ result });
    } catch (err) {
      console.error('[Browser] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  console.log('[Icarus] Browser module initialised — POST /modules/browser/task');
  if (!chromium) {
    console.warn('[Icarus] Browser: Playwright not installed. Run: npm install playwright && npx playwright install chromium');
  }
}

async function handler(name, input) {
  if (name === 'browser_task') {
    return await runTask(input.url, input.task, {
      extractSelector: input.extract_selector,
      maxSteps: input.max_steps,
    });
  }
  return `[Browser] Unknown tool: ${name}`;
}

module.exports = { tools, init, handler, runTask };
