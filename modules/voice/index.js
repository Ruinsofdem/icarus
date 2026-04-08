require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const twilio = require('twilio');

const router = express.Router();

const NICK_PHONE   = '+61478764417';
const TWILIO_FROM  = process.env.TWILIO_PHONE_NUMBER || '+17407363580';

let openaiClient = null;

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

/**
 * POST /call
 * Initiates an outbound Twilio call to Nick's phone (+61478764417).
 * Optional body: { topic: string }
 */
router.post('/call', async (req, res) => {
  const topic = req.body?.topic || '';
  try {
    const client     = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const baseUrl    = `${req.protocol}://${req.get('host')}`;
    const webhookUrl = `${baseUrl}/api/voice/webhook${topic ? `?topic=${encodeURIComponent(topic)}` : ''}`;
    const statusUrl  = `${baseUrl}/api/voice/status`;

    const call = await client.calls.create({
      url:                  webhookUrl,
      to:                   NICK_PHONE,
      from:                 TWILIO_FROM,
      statusCallback:       statusUrl,
      statusCallbackMethod: 'POST',
      machineDetection:     'Enable',
      asyncAmd:             true,
      asyncAmdStatusCallback: `${baseUrl}/api/voice/amd-status`,
    });

    console.log(`[Voice] Outbound call initiated: ${call.sid} → ${NICK_PHONE}`);
    res.json({ ok: true, callSid: call.sid });
  } catch (err) {
    console.error('[Voice] Call initiation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /webhook
 * Twilio hits this when the outbound call is answered.
 * Returns TwiML with a spoken greeting, then records the caller's reply.
 */
router.post('/webhook', (req, res) => {
  const topic    = req.query.topic || '';
  const greeting = topic
    ? `Icarus online. You requested a briefing on ${topic}. Go ahead.`
    : 'Icarus online. What do you need?';

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Matthew">${escapeXml(greeting)}</Say>
  <Record action="/api/voice/process" maxLength="30" playBeep="true" trim="trim-silence"/>
  <Say voice="Polly.Matthew">No message received. Goodbye.</Say>
</Response>`;
  res.type('text/xml').send(twiml);
});

/**
 * POST /amd-status
 * Twilio Answering Machine Detection callback.
 * If voicemail is detected, hang up immediately.
 */
router.post('/amd-status', async (req, res) => {
  const { CallSid, AnsweredBy } = req.body;
  console.log(`[Voice] AMD result for ${CallSid}: ${AnsweredBy}`);

  if (AnsweredBy === 'machine_start' || AnsweredBy === 'fax') {
    // Voicemail detected — hang up
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    try {
      await client.calls(CallSid).update({ status: 'completed' });
      console.log(`[Voice] Hung up ${CallSid} (voicemail detected)`);
    } catch (err) {
      console.error('[Voice] Failed to hang up:', err.message);
    }
  }
  res.sendStatus(204);
});

/**
 * POST /status
 * Twilio status callback — logs call lifecycle events.
 */
router.post('/status', (req, res) => {
  const { CallSid, CallStatus } = req.body;
  console.log(`[Voice] Call ${CallSid} status: ${CallStatus}`);
  res.sendStatus(204);
});

function handler() {
  return router;
}

module.exports = { init, handler, transcribeAudio, synthesizeSpeech, getAgentResponse };
