require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const twilio = require('twilio');

const router = express.Router();

const NICK_PHONE  = '+61478764417';
const TWILIO_FROM = process.env.TWILIO_PHONE_NUMBER || '+17407363580';

let openaiClient = null;

const END_PHRASES = ['bye', 'goodbye', 'end call', 'stop', 'hang up', "that's all", 'thats all', 'that is all', 'see ya', 'cheers', 'done'];

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isEndOfConversation(text) {
  const lower = text.toLowerCase().trim();
  return END_PHRASES.some(
    (phrase) => lower === phrase || lower.startsWith(phrase + ' ') || lower.endsWith(' ' + phrase)
  );
}

// Use x-forwarded-proto so URLs work correctly behind Railway's proxy
function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.get('host')}`;
}

// Build TwiML that plays/says the response then loops back to record
function buildResponseTwiml(audioUrl, fallbackText, loop = true) {
  const listenBlock = loop
    ? `\n  <Record action="/api/voice/process" maxLength="45" playBeep="false" trim="trim-silence" timeout="3"/>\n  <Hangup/>`
    : `\n  <Hangup/>`;

  const speakBlock = audioUrl
    ? `  <Play>${audioUrl}</Play>`
    : `  <Say voice="Polly.Matthew">${escapeXml(fallbackText)}</Say>`;

  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${speakBlock}${listenBlock}\n</Response>`;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  if (!process.env.OPENAI_API_KEY) {
    console.warn('[Voice] OPENAI_API_KEY missing — Whisper STT unavailable.');
  } else {
    const { OpenAI } = require('openai');
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    console.log('[Voice] Whisper STT ready.');
  }
  if (!process.env.ELEVENLABS_API_KEY) {
    console.warn('[Voice] ELEVENLABS_API_KEY missing — will use Polly TTS fallback.');
  } else {
    console.log('[Voice] ElevenLabs TTS ready.');
  }
  return router;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function transcribeAudio(audioBuffer, filename = 'audio.mp3') {
  if (!openaiClient) throw new Error('OpenAI client not initialised — OPENAI_API_KEY missing');
  const { toFile } = require('openai');
  const file = await toFile(audioBuffer, filename, { type: 'audio/mpeg' });
  const transcription = await openaiClient.audio.transcriptions.create({
    file,
    model: 'whisper-1',
  });
  return transcription.text;
}

// Returns Buffer on success, null on failure (caller uses Polly fallback)
async function synthesizeSpeech(text) {
  if (!process.env.ELEVENLABS_API_KEY) return null;
  const voiceId = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB';
  try {
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
        timeout: 15000,
      }
    );
    return Buffer.from(response.data);
  } catch (err) {
    console.warn('[Voice] ElevenLabs failed, falling back to Polly:', err.message);
    return null;
  }
}

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
    "I didn't catch that. Say it again.";

  messages.push({ role: 'assistant', content: reply });
  await saveMemory(messages);

  return reply;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /incoming
 * Inbound calls — greet and start recording.
 */
router.post('/incoming', (_req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Matthew">Icarus online. What do you need?</Say>
  <Record action="/api/voice/process" maxLength="45" playBeep="false" trim="trim-silence" timeout="3"/>
  <Say voice="Polly.Matthew">No message received. Goodbye.</Say>
  <Hangup/>
</Response>`;
  res.type('text/xml').send(twiml);
});

/**
 * POST /process
 * Core conversation handler — transcribe → agent → speak → loop.
 */
router.post('/process', async (req, res) => {
  const { RecordingUrl, RecordingSid } = req.body;

  if (!RecordingUrl) {
    console.warn('[Voice] /process called without RecordingUrl');
    return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Matthew">I didn't catch that. Go ahead.</Say>
  <Record action="/api/voice/process" maxLength="45" playBeep="false" trim="trim-silence" timeout="3"/>
  <Hangup/>
</Response>`);
  }

  try {
    // Download and transcribe
    const audioResponse = await axios.get(`${RecordingUrl}.mp3`, {
      responseType: 'arraybuffer',
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN,
      },
      timeout: 10000,
    });
    const audioBuffer = Buffer.from(audioResponse.data);
    const transcript = await transcribeAudio(audioBuffer, `${RecordingSid || 'recording'}.mp3`);
    console.log(`[Voice] Transcribed: "${transcript}"`);

    // End of conversation?
    if (isEndOfConversation(transcript)) {
      console.log('[Voice] End of conversation detected.');
      return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Matthew">Got it. Later.</Say>
  <Hangup/>
</Response>`);
    }

    // Get agent response
    const agentReply = await getAgentResponse(transcript);
    console.log(`[Voice] Agent reply: "${agentReply.substring(0, 120)}"`);

    // Try ElevenLabs; fall back to Polly
    const speechBuffer = await synthesizeSpeech(agentReply);
    let audioUrl = null;

    if (speechBuffer) {
      const publicDir = path.join(__dirname, '../../public');
      if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
      const audioFilename = `voice_${Date.now()}.mp3`;
      fs.writeFileSync(path.join(publicDir, audioFilename), speechBuffer);
      audioUrl = `${getBaseUrl(req)}/${audioFilename}`;
      console.log(`[Voice] Audio URL: ${audioUrl}`);
    }

    // Respond and loop back to record
    res.type('text/xml').send(buildResponseTwiml(audioUrl, agentReply, true));
  } catch (error) {
    console.error('[Voice] Processing error:', error.message);
    // Loop back on error rather than hanging up
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Matthew">Something went wrong. Go ahead, try again.</Say>
  <Record action="/api/voice/process" maxLength="45" playBeep="false" trim="trim-silence" timeout="3"/>
  <Hangup/>
</Response>`);
  }
});

/**
 * POST /call
 * Initiates an outbound call to Nick's phone.
 */
router.post('/call', async (req, res) => {
  const topic = req.body?.topic || '';
  try {
    const client     = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const baseUrl    = getBaseUrl(req);
    const webhookUrl = `${baseUrl}/api/voice/webhook${topic ? `?topic=${encodeURIComponent(topic)}` : ''}`;
    const statusUrl  = `${baseUrl}/api/voice/status`;

    const call = await client.calls.create({
      url:                    webhookUrl,
      to:                     NICK_PHONE,
      from:                   TWILIO_FROM,
      statusCallback:         statusUrl,
      statusCallbackMethod:   'POST',
      machineDetection:       'Enable',
      asyncAmd:               true,
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
 */
router.post('/webhook', (req, res) => {
  const topic    = req.query.topic || '';
  const greeting = topic
    ? `Icarus online. You asked about ${escapeXml(topic)}. Go ahead.`
    : 'Icarus online. What do you need?';

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Matthew">${greeting}</Say>
  <Record action="/api/voice/process" maxLength="45" playBeep="false" trim="trim-silence" timeout="3"/>
  <Say voice="Polly.Matthew">No response. Goodbye.</Say>
  <Hangup/>
</Response>`;
  res.type('text/xml').send(twiml);
});

/**
 * POST /amd-status
 * Hang up immediately if Twilio detects voicemail.
 */
router.post('/amd-status', async (req, res) => {
  const { CallSid, AnsweredBy } = req.body;
  console.log(`[Voice] AMD result for ${CallSid}: ${AnsweredBy}`);

  if (AnsweredBy === 'machine_start' || AnsweredBy === 'fax') {
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
 * Call lifecycle logging.
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
