require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const router = express.Router();

let openaiClient = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  if (!process.env.OPENAI_API_KEY) {
    console.warn('[Voice] OPENAI_API_KEY missing — voice module disabled.');
    return router;
  }
  const { OpenAI } = require('openai');
  openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  console.log('[Voice] Module initialised — Whisper STT + ElevenLabs TTS ready.');
  return router;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Transcribe an audio buffer using OpenAI Whisper.
 * @param {Buffer} audioBuffer
 * @param {string} filename
 * @returns {Promise<string>} transcript text
 */
async function transcribeAudio(audioBuffer, filename = 'audio.mp3') {
  const { toFile } = require('openai');
  const file = await toFile(audioBuffer, filename, { type: 'audio/mpeg' });
  const transcription = await openaiClient.audio.transcriptions.create({
    file,
    model: 'whisper-1',
  });
  return transcription.text;
}

/**
 * Convert text to speech using the ElevenLabs API.
 * @param {string} text
 * @returns {Promise<Buffer>} MP3 audio buffer
 */
async function synthesizeSpeech(text) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'; // default: Adam
  const response = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      text,
      model_id: 'eleven_monolingual_v1',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    },
    {
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      responseType: 'arraybuffer',
    }
  );
  return Buffer.from(response.data);
}

/**
 * Get a text response from the Icarus agent.
 * Uses the same createMessage pattern as server.js but without tools
 * (voice should be quick and conversational).
 * @param {string} userText
 * @returns {Promise<string>} agent reply
 */
async function getAgentResponse(userText) {
  const {
    createMessage,
    SYSTEM_PROMPT_SERVER,
    validateMessages,
    loadMemory,
    saveMemory,
  } = require('../../config');

  let messages = loadMemory();
  messages.push({ role: 'user', content: userText });
  messages = validateMessages(messages);

  const response = await createMessage(messages, { systemPrompt: SYSTEM_PROMPT_SERVER });
  const reply =
    response.content.find((b) => b.type === 'text')?.text ||
    "I couldn't process that. Please try again.";

  messages.push({ role: 'assistant', content: reply });
  await saveMemory(messages);

  return reply;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /voice/incoming
 * Initial Twilio voice webhook — prompts caller to leave a message and records it.
 */
router.post('/incoming', (_req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Hello, this is Icarus. Please leave your message after the beep.</Say>
  <Record action="/voice/process" maxLength="30" playBeep="true" trim="trim-silence"/>
  <Say voice="alice">No recording received. Goodbye.</Say>
</Response>`;
  res.type('text/xml').send(twiml);
});

/**
 * POST /voice/process
 * Twilio posts here when recording completes (RecordingUrl in body).
 * Pipeline: download audio → Whisper → agent → ElevenLabs → <Play>
 */
router.post('/process', async (req, res) => {
  const { RecordingUrl, RecordingSid } = req.body;

  if (!RecordingUrl) {
    console.warn('[Voice] /process called without RecordingUrl');
    return res
      .type('text/xml')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">Sorry, no recording was received. Please try again.</Say></Response>`
      );
  }

  try {
    // Download recording from Twilio (add .mp3 extension for direct MP3 stream)
    const audioResponse = await axios.get(`${RecordingUrl}.mp3`, {
      responseType: 'arraybuffer',
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN,
      },
    });
    const audioBuffer = Buffer.from(audioResponse.data);

    // Transcribe with Whisper
    const transcript = await transcribeAudio(audioBuffer, `${RecordingSid || 'recording'}.mp3`);
    console.log(`[Voice] Transcribed: "${transcript}"`);

    // Get Icarus agent response
    const agentReply = await getAgentResponse(transcript);
    console.log(`[Voice] Agent reply: "${agentReply.substring(0, 100)}..."`);

    // Synthesise speech with ElevenLabs
    const speechBuffer = await synthesizeSpeech(agentReply);

    // Persist audio to public dir so Twilio can fetch it
    const publicDir = path.join(__dirname, '../../public');
    if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

    const audioFilename = `voice_${Date.now()}.mp3`;
    fs.writeFileSync(path.join(publicDir, audioFilename), speechBuffer);

    const audioUrl = `${req.protocol}://${req.get('host')}/${audioFilename}`;
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${audioUrl}</Play>
</Response>`;

    res.type('text/xml').send(twiml);
  } catch (error) {
    console.error('[Voice] Processing error:', error.message);
    res
      .type('text/xml')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">Sorry, Icarus encountered an error. Please try again.</Say></Response>`
      );
  }
});

function handler() {
  return router;
}

module.exports = { init, handler, transcribeAudio, synthesizeSpeech, getAgentResponse };
