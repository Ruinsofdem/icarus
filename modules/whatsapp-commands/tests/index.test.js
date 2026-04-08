'use strict';

/**
 * WhatsApp commands module tests
 * Run: node modules/whatsapp-commands/tests/index.test.js
 */

const assert = require('assert');

// ─── Stub axios so no real HTTP calls go out ──────────────────────────────────

const Module = require('module');
const _load  = Module._load.bind(Module);

// Stub responses keyed by URL pattern
const axiosStub = {
  get: async (url) => {
    if (url.includes('airtable.com')) return { data: { records: [
      { fields: { Status: 'Prospect' } },
      { fields: { Status: 'Prospect' } },
      { fields: { Status: 'Qualified' } },
    ] } };
    if (url.includes('stripe.com')) return { data: { data: [] } };
    return { data: {} };
  },
  post: async (url, body) => {
    if (url.includes('module/not/there')) throw Object.assign(new Error('Not found'), { response: { status: 404 } });
    if (url.includes('/briefing/trigger')) return { data: { result: 'Briefing scheduled.' } };
    if (url.includes('/orchestrator/task')) return { data: { result: 'Lead task created.' } };
    if (url.includes('/anomaly/scan')) return { data: { message: 'Scan started.' } };
    if (url.includes('/brain-sync/trigger')) return { data: { result: 'Sync done.' } };
    if (url.includes('/markets/price')) return { data: { result: 'BTC/AUD: $90,000' } };
    if (url.includes('/decisions/analyse')) return { data: { result: 'Hold recommended.' } };
    return { data: { result: 'OK' } };
  },
};

Module._load = function(req, parent, isMain) {
  if (req === 'axios') return axiosStub;
  return _load(req, parent, isMain);
};

const cmds = require('../index.js');

// ─── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    failed++;
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\nwhatsapp-commands');

  // Exports
  await test('exports init function', async () => {
    assert.strictEqual(typeof cmds.init, 'function');
  });
  await test('exports handler function', async () => {
    assert.strictEqual(typeof cmds.handler, 'function');
  });

  // handler — fall-through for non-commands
  await test('handler returns null for plain text', async () => {
    const r = await cmds.handler('hello there');
    assert.strictEqual(r, null);
  });
  await test('handler returns null for empty string', async () => {
    const r = await cmds.handler('');
    assert.strictEqual(r, null);
  });
  await test('handler returns null for null input', async () => {
    const r = await cmds.handler(null);
    assert.strictEqual(r, null);
  });

  // handler — unknown command
  await test('handler returns error message for unknown command', async () => {
    const r = await cmds.handler('/foobar');
    assert.ok(r && r.includes('Unknown command'), `Expected "Unknown command" but got: ${r}`);
  });

  // /help
  await test('/help lists all commands', async () => {
    const r = await cmds.handler('/help');
    assert.ok(r.includes('/brief'), 'Expected /brief');
    assert.ok(r.includes('/status'), 'Expected /status');
    assert.ok(r.includes('/pitch'), 'Expected /pitch');
    assert.ok(r.includes('/trade'), 'Expected /trade');
    assert.ok(r.includes('/scan'), 'Expected /scan');
    assert.ok(r.includes('/brain'), 'Expected /brain');
  });

  // /help — case insensitive
  await test('/HELP works case-insensitively', async () => {
    const r = await cmds.handler('/HELP');
    assert.ok(r && r.includes('/brief'));
  });

  // /brief
  await test('/brief triggers briefing module', async () => {
    const r = await cmds.handler('/brief');
    assert.ok(r && r.includes('Briefing triggered'), `Got: ${r}`);
  });

  // /status
  await test('/status returns pipeline summary with counts', async () => {
    process.env.AIRTABLE_API_KEY  = 'test';
    process.env.STRIPE_SECRET_KEY = 'test';
    const r = await cmds.handler('/status');
    assert.ok(r && r.includes('Icarus Status'), `Got: ${r}`);
    assert.ok(r.includes('Prospect'), 'Expected stage name in status');
    delete process.env.AIRTABLE_API_KEY;
    delete process.env.STRIPE_SECRET_KEY;
  });

  await test('/status shows missing keys gracefully', async () => {
    delete process.env.AIRTABLE_API_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    const r = await cmds.handler('/status');
    assert.ok(r && r.includes('Icarus Status'), `Got: ${r}`);
    assert.ok(r.includes('unavailable'), 'Expected "unavailable" message');
  });

  // /pitch
  await test('/pitch requires a name argument', async () => {
    const r = await cmds.handler('/pitch');
    assert.ok(r && r.includes('Usage:'), `Got: ${r}`);
  });
  await test('/pitch [name] triggers orchestrator', async () => {
    const r = await cmds.handler('/pitch Acme Corp');
    assert.ok(r && r.includes('Acme Corp'), `Got: ${r}`);
  });

  // /trade
  await test('/trade requires an asset argument', async () => {
    const r = await cmds.handler('/trade');
    assert.ok(r && r.includes('Usage:'), `Got: ${r}`);
  });
  await test('/trade [asset] triggers markets + decisions', async () => {
    const r = await cmds.handler('/trade BTC');
    assert.ok(r && r.includes('BTC'), `Got: ${r}`);
  });

  // /scan
  await test('/scan triggers anomaly module', async () => {
    const r = await cmds.handler('/scan');
    assert.ok(r && r.includes('scan'), r);
  });

  // /brain
  await test('/brain triggers brain-sync module', async () => {
    const r = await cmds.handler('/brain');
    assert.ok(r && r.toLowerCase().includes('brain'), `Got: ${r}`);
  });

  // getPipelineSummary
  await test('getPipelineSummary groups records by Status', async () => {
    process.env.AIRTABLE_API_KEY = 'test';
    const result = await cmds.getPipelineSummary();
    assert.ok(result, 'Expected result');
    assert.strictEqual(result.total, 3);
    assert.strictEqual(result.counts.Prospect, 2);
    assert.strictEqual(result.counts.Qualified, 1);
    delete process.env.AIRTABLE_API_KEY;
  });

  await test('getPipelineSummary returns null without API key', async () => {
    delete process.env.AIRTABLE_API_KEY;
    const result = await cmds.getPipelineSummary();
    assert.strictEqual(result, null);
  });

  // getStripeMrr
  await test('getStripeMrr returns null without STRIPE_SECRET_KEY', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const result = await cmds.getStripeMrr();
    assert.strictEqual(result, null);
  });

  await test('getStripeMrr returns mrr and count with key set', async () => {
    process.env.STRIPE_SECRET_KEY = 'test';
    const result = await cmds.getStripeMrr();
    assert.ok(result, 'Expected result');
    assert.ok(typeof result.mrr === 'number', 'Expected numeric mrr');
    assert.ok(typeof result.count === 'number', 'Expected numeric count');
    delete process.env.STRIPE_SECRET_KEY;
  });

  // Trailing message
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
