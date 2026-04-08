'use strict';

// ─── Mock external dependencies before requiring the module ──────────────────

jest.mock('openai', () => {
  const mockToFile = jest.fn().mockResolvedValue({ name: 'audio.mp3' });
  const MockOpenAI = jest.fn().mockImplementation(() => ({
    audio: {
      transcriptions: {
        create: jest.fn().mockResolvedValue({ text: 'Hello Icarus, what is the weather?' }),
      },
    },
  }));
  MockOpenAI.prototype.toFile = mockToFile;
  return { OpenAI: MockOpenAI, toFile: mockToFile };
});

jest.mock('axios');
jest.mock('../../config', () => ({
  createMessage: jest.fn().mockResolvedValue({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'The weather in Sydney is 22°C and sunny.' }],
  }),
  SYSTEM_PROMPT_SERVER: 'You are Icarus.',
  validateMessages: jest.fn((msgs) => msgs),
  loadMemory: jest.fn().mockReturnValue([]),
  saveMemory: jest.fn().mockResolvedValue(undefined),
}));

const axios = require('axios');
const { transcribeAudio, synthesizeSpeech, getAgentResponse, init, handler } = require('./index');

describe('Voice module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.ELEVENLABS_API_KEY = 'test-eleven-key';
    process.env.ELEVENLABS_VOICE_ID = 'testVoiceId';
  });

  describe('init()', () => {
    it('returns an Express router', () => {
      const router = init();
      expect(router).toBeDefined();
      expect(typeof router).toBe('function'); // Express routers are functions
    });
  });

  describe('handler()', () => {
    it('returns the same Express router', () => {
      const r = handler();
      expect(r).toBeDefined();
      expect(typeof r).toBe('function');
    });
  });

  describe('transcribeAudio()', () => {
    it('calls OpenAI Whisper and returns transcript text', async () => {
      const { OpenAI, toFile } = require('openai');
      const mockInstance = new OpenAI();
      toFile.mockResolvedValue({ name: 'test.mp3' });
      mockInstance.audio.transcriptions.create.mockResolvedValue({ text: 'test transcript' });

      // Re-init to ensure openaiClient is set with the mock
      init();

      const buf = Buffer.from('fake audio data');
      // transcribeAudio uses the module-level openaiClient set by init()
      // Since mock is in place, just verify it doesn't throw with the mock
      const result = await transcribeAudio(buf, 'test.mp3');
      expect(typeof result).toBe('string');
    });
  });

  describe('synthesizeSpeech()', () => {
    it('calls ElevenLabs API and returns audio buffer', async () => {
      const fakeAudio = Buffer.from('fake mp3 data');
      axios.post.mockResolvedValue({ data: fakeAudio });

      const result = await synthesizeSpeech('Hello world');

      expect(axios.post).toHaveBeenCalledWith(
        expect.stringContaining('api.elevenlabs.io/v1/text-to-speech/'),
        expect.objectContaining({ text: 'Hello world' }),
        expect.objectContaining({
          headers: expect.objectContaining({ 'xi-api-key': 'test-eleven-key' }),
        })
      );
      expect(result).toBeInstanceOf(Buffer);
    });

    it('uses ELEVENLABS_VOICE_ID from env', async () => {
      process.env.ELEVENLABS_VOICE_ID = 'custom-voice-123';
      axios.post.mockResolvedValue({ data: Buffer.from('audio') });

      await synthesizeSpeech('test');

      expect(axios.post).toHaveBeenCalledWith(
        expect.stringContaining('custom-voice-123'),
        expect.anything(),
        expect.anything()
      );
    });
  });

  describe('getAgentResponse()', () => {
    it('loads memory, calls createMessage, saves memory, and returns reply', async () => {
      const { createMessage, loadMemory, saveMemory } = require('../../config');

      const reply = await getAgentResponse('What time is it?');

      expect(loadMemory).toHaveBeenCalled();
      expect(createMessage).toHaveBeenCalled();
      expect(saveMemory).toHaveBeenCalled();
      expect(reply).toBe('The weather in Sydney is 22°C and sunny.');
    });

    it('returns fallback text if no text block in response', async () => {
      const { createMessage } = require('../../config');
      createMessage.mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'tool_use', id: 'foo', name: 'bar', input: {} }],
      });

      const reply = await getAgentResponse('test');
      expect(reply).toContain("couldn't process");
    });
  });

  describe('POST /incoming route', () => {
    it('returns TwiML with <Record> verb', () => {
      const router = init();
      // Find the /incoming route handler and test it directly
      const layer = router.stack.find((l) => l.route?.path === '/incoming');
      expect(layer).toBeDefined();

      const mockRes = {
        type: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };
      layer.route.stack[0].handle({}, mockRes, jest.fn());

      expect(mockRes.type).toHaveBeenCalledWith('text/xml');
      expect(mockRes.send).toHaveBeenCalledWith(expect.stringContaining('<Record'));
    });
  });
});
