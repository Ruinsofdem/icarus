'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const Anthropic = require('@anthropic-ai/sdk');

const execAsync = promisify(exec);
const SCREENSHOT_PATH = '/tmp/icarus_vision.png';
const VISION_MODEL = 'claude-sonnet-4-6';

// ─── Tool definitions (Claude tool schema) ────────────────────────────────────

const tools = [
  {
    name: 'capture_screen',
    description:
      'Take a screenshot of the current display and analyse it with Claude vision. ' +
      'Returns a detailed textual answer to the prompt based on what is visible on screen. ' +
      'Requires screen-recording permission on macOS. On Linux, requires scrot or ImageMagick.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'What to look for or analyse in the screenshot. Be specific.',
        },
        model: {
          type: 'string',
          description: `Claude model to use for vision analysis. Default: ${VISION_MODEL}.`,
        },
      },
      required: ['prompt'],
    },
  },
];

// ─── Screenshot capture ───────────────────────────────────────────────────────

async function captureScreen() {
  const platform = process.platform;

  if (platform === 'darwin') {
    await execAsync(`screencapture -x "${SCREENSHOT_PATH}"`);
  } else if (platform === 'linux') {
    // Try scrot first, fall back to ImageMagick import
    try {
      await execAsync(`scrot "${SCREENSHOT_PATH}"`);
    } catch {
      await execAsync(`import -window root "${SCREENSHOT_PATH}"`);
    }
  } else {
    throw new Error(`Unsupported platform for screencapture: ${platform}. Supported: darwin, linux.`);
  }

  const data = fs.readFileSync(SCREENSHOT_PATH);
  if (!data || data.length < 100) throw new Error('Screenshot file appears empty or corrupt.');
  return data;
}

// ─── Vision analysis ──────────────────────────────────────────────────────────

async function analyseScreen(prompt, model) {
  const client = new Anthropic();
  const useModel = model || VISION_MODEL;

  let imageBuffer;
  try {
    imageBuffer = await captureScreen();
  } catch (err) {
    return `[Vision] Screenshot capture failed: ${err.message}`;
  }

  const base64Image = imageBuffer.toString('base64');

  const response = await client.messages.create({
    model: useModel,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: base64Image },
          },
          {
            type: 'text',
            text: prompt,
          },
        ],
      },
    ],
  });

  return response.content.find((b) => b.type === 'text')?.text || '[Vision] No analysis returned.';
}

// ─── Module interface ─────────────────────────────────────────────────────────

function init(app) {
  // POST /modules/vision/capture — REST endpoint for direct use
  app.post('/modules/vision/capture', async (req, res) => {
    const { prompt, model } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt (string) is required.' });
    }
    try {
      const result = await analyseScreen(prompt, model);
      res.json({ result });
    } catch (err) {
      console.error('[Vision] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  console.log('[Icarus] Vision module initialised — POST /modules/vision/capture');
}

async function handler(name, input) {
  if (name === 'capture_screen') {
    return await analyseScreen(input.prompt, input.model);
  }
  return `[Vision] Unknown tool: ${name}`;
}

module.exports = { tools, init, handler, analyseScreen, captureScreen };
