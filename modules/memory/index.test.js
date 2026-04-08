// Set env vars before any require
process.env.PINECONE_API_KEY = 'test-pinecone-key';
process.env.OPENAI_API_KEY = 'test-openai-key';

jest.mock('@pinecone-database/pinecone');
jest.mock('openai');

const { Pinecone } = require('@pinecone-database/pinecone');
const OpenAI = require('openai');
const express = require('express');

// ─── Mock implementations ─────────────────────────────────────────────────────
const mockUpsert = jest.fn().mockResolvedValue({});
const mockQueryFn = jest.fn().mockResolvedValue({
  matches: [
    { metadata: { text: 'User: hello\nAssistant: hi', ts: Date.now() } },
    { metadata: { text: 'User: world\nAssistant: earth', ts: Date.now() } },
  ],
});
const mockPineconeIndex = { upsert: mockUpsert, query: mockQueryFn };
const mockIndexFactory = jest.fn().mockReturnValue(mockPineconeIndex);
Pinecone.mockImplementation(() => ({ index: mockIndexFactory }));

const mockEmbedCreate = jest.fn().mockResolvedValue({
  data: [{ embedding: new Array(1536).fill(0.1) }],
});
OpenAI.mockImplementation(() => ({ embeddings: { create: mockEmbedCreate } }));

// Require module ONCE after mocks are set up
const memory = require('./index');

// ─── Tests ────────────────────────────────────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks();
  Pinecone.mockImplementation(() => ({ index: mockIndexFactory }));
  OpenAI.mockImplementation(() => ({ embeddings: { create: mockEmbedCreate } }));
  mockIndexFactory.mockReturnValue(mockPineconeIndex);
  mockEmbedCreate.mockResolvedValue({ data: [{ embedding: new Array(1536).fill(0.1) }] });
  mockQueryFn.mockResolvedValue({
    matches: [
      { metadata: { text: 'User: hello\nAssistant: hi', ts: Date.now() } },
      { metadata: { text: 'User: world\nAssistant: earth', ts: Date.now() } },
    ],
  });
  memory.init();
});

describe('memory module', () => {
  test('init() registers Pinecone index and OpenAI client', () => {
    expect(Pinecone).toHaveBeenCalledWith({ apiKey: 'test-pinecone-key' });
    expect(OpenAI).toHaveBeenCalledWith({ apiKey: 'test-openai-key' });
    expect(mockIndexFactory).toHaveBeenCalledWith('icarus-memory');
  });

  test('embed() calls OpenAI embeddings.create with correct model', async () => {
    const vec = await memory.embed('test text');
    expect(mockEmbedCreate).toHaveBeenCalledWith({
      model: 'text-embedding-3-small',
      input: 'test text',
    });
    expect(vec).toHaveLength(1536);
  });

  test('upsertTurn() upserts to Pinecone with correct metadata', async () => {
    await memory.upsertTurn('hello', 'hi there');
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          values: expect.any(Array),
          metadata: expect.objectContaining({
            text: 'User: hello\nAssistant: hi there',
          }),
        }),
      ])
    );
  });

  test('queryMemory() returns formatted string of top matches', async () => {
    const result = await memory.queryMemory('what is AI?');
    expect(mockQueryFn).toHaveBeenCalledWith(
      expect.objectContaining({ topK: 5, includeMetadata: true })
    );
    expect(result).toContain('User: hello');
    expect(result).toContain('User: world');
  });

  test('queryMemory() returns empty string when no matches', async () => {
    mockQueryFn.mockResolvedValueOnce({ matches: [] });
    const result = await memory.queryMemory('obscure query');
    expect(result).toBe('');
  });

  test('wrapHandler() injects RELEVANT MEMORY into systemPrompt', async () => {
    const mockAgent = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'agent reply' }],
    });
    const wrapped = memory.wrapHandler(mockAgent);
    await wrapped([{ role: 'user', content: 'what is AI?' }], { systemPrompt: 'BASE' });
    expect(mockAgent).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        systemPrompt: expect.stringContaining('RELEVANT MEMORY'),
      })
    );
  });

  test('wrapHandler() calls upsertTurn in background after response', async () => {
    const mockAgent = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'agent reply' }],
    });
    const wrapped = memory.wrapHandler(mockAgent);
    await wrapped([{ role: 'user', content: 'test query' }], {});
    await new Promise(resolve => setImmediate(resolve));
    expect(mockUpsert).toHaveBeenCalled();
  });

  test('/memory/status route is registered on router', () => {
    const router = express.Router();
    memory.handler(router);
    expect(router.stack.length).toBeGreaterThan(0);
  });
});
