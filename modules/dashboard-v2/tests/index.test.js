'use strict';

/**
 * Dashboard v2 module tests
 * Run: node modules/dashboard-v2/tests/index.test.js
 */

const assert = require('assert');

// ─── Minimal stubs so we can require the module without live credentials ─────

// Stub axios so no real HTTP calls go out
const Module = require('module');
const _orig  = Module._resolveFilename.bind(Module);

// Simple stub registry
const stubs = {};
function stub(name, val) { stubs[name] = val; }

stub('axios', {
  get:  async () => ({ data: { records: [], results: [] } }),
  post: async () => ({ data: { results: [] } }),
});

// Stub calendar so it doesn't need google credentials
stub('../../calendar', {
  listEvents: async () => '10:00 AM - Standup\n11:00 AM - Client call',
});

const _load = Module._load.bind(Module);
Module._load = function(req, parent, isMain) {
  if (stubs[req]) return stubs[req];
  // Intercept relative calendar require from dashboard-v2
  if (req.endsWith('calendar') || req === '../../calendar') return stubs['../../calendar'];
  return _load(req, parent, isMain);
};

// Now require the module under test
const dashV2 = require('../index.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      r.then(() => {
        console.log(`  ✓ ${name}`);
        passed++;
      }).catch(err => {
        console.error(`  ✗ ${name}\n    ${err.message}`);
        failed++;
      });
    } else {
      console.log(`  ✓ ${name}`);
      passed++;
    }
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    failed++;
  }
}

async function asyncTest(name, fn) {
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
  console.log('\ndashboard-v2');

  // Exports
  test('exports init function', () => assert.strictEqual(typeof dashV2.init, 'function'));
  test('exports handler function', () => assert.strictEqual(typeof dashV2.handler, 'function'));
  test('exports refreshAll function', () => assert.strictEqual(typeof dashV2.refreshAll, 'function'));
  test('exports getCache function', () => assert.strictEqual(typeof dashV2.getCache, 'function'));

  // Cache starts null
  test('cache starts empty', () => {
    const c = dashV2.getCache();
    assert.strictEqual(c.lastUpdate, null);
  });

  // fetchPipeline returns error when no API key
  await asyncTest('fetchPipeline returns error without AIRTABLE_API_KEY', async () => {
    const orig = process.env.AIRTABLE_API_KEY;
    delete process.env.AIRTABLE_API_KEY;
    const result = await dashV2.fetchPipeline();
    assert.ok(result.error, 'Expected error field');
    assert.ok(result.error.includes('AIRTABLE_API_KEY'));
    if (orig) process.env.AIRTABLE_API_KEY = orig;
  });

  // fetchHubspot returns error when no token
  await asyncTest('fetchHubspot returns error without HUBSPOT_TOKEN', async () => {
    const orig = process.env.HUBSPOT_TOKEN;
    delete process.env.HUBSPOT_TOKEN;
    const result = await dashV2.fetchHubspot();
    assert.ok(result.error, 'Expected error field');
    assert.ok(result.error.includes('HUBSPOT_TOKEN'));
    if (orig) process.env.HUBSPOT_TOKEN = orig;
  });

  // fetchStripe returns error when no key
  await asyncTest('fetchStripe returns error without STRIPE_SECRET_KEY', async () => {
    const orig = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    const result = await dashV2.fetchStripe();
    assert.ok(result.error, 'Expected error field');
    assert.ok(result.error.includes('STRIPE_SECRET_KEY'));
    if (orig) process.env.STRIPE_SECRET_KEY = orig;
  });

  // fetchMarkets returns error when no key
  await asyncTest('fetchMarkets returns error without MASSIVE_API_KEY', async () => {
    const orig = process.env.MASSIVE_API_KEY;
    delete process.env.MASSIVE_API_KEY;
    const result = await dashV2.fetchMarkets();
    assert.ok(result.error, 'Expected error field');
    if (orig) process.env.MASSIVE_API_KEY = orig;
  });

  // refreshAll populates cache
  await asyncTest('refreshAll populates cache with lastUpdate', async () => {
    process.env.AIRTABLE_API_KEY = 'test_key';
    process.env.HUBSPOT_TOKEN    = 'test_token';
    process.env.STRIPE_SECRET_KEY = 'test_stripe';
    process.env.MASSIVE_API_KEY  = 'test_massive';
    const result = await dashV2.refreshAll();
    assert.ok(result.lastUpdate, 'Expected lastUpdate timestamp');
    assert.ok(result.pipeline !== undefined, 'Expected pipeline');
    assert.ok(result.hubspot  !== undefined, 'Expected hubspot');
    assert.ok(result.stripe   !== undefined, 'Expected stripe');
    assert.ok(result.markets  !== undefined, 'Expected markets');
    assert.ok(result.calendar !== undefined, 'Expected calendar');
    delete process.env.AIRTABLE_API_KEY;
    delete process.env.HUBSPOT_TOKEN;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.MASSIVE_API_KEY;
  });

  // handler returns HTML
  await asyncTest('handler returns HTML with dashboard content', async () => {
    let body = null;
    const fakeReq = {};
    const fakeRes = {
      type: () => fakeRes,
      send: (b) => { body = b; return fakeRes; },
    };
    dashV2.handler(fakeReq, fakeRes);
    assert.ok(body && typeof body === 'string', 'Expected HTML string');
    assert.ok(body.includes('ICARUS'), 'Expected ICARUS in HTML');
    assert.ok(body.includes('socket.io'), 'Expected socket.io script tag');
    assert.ok(body.includes('#0a0a0a'), 'Expected dark bg colour');
    assert.ok(body.includes('#d4a017'), 'Expected gold accent colour');
    assert.ok(body.includes('#00ff41'), 'Expected green accent colour');
    assert.ok(body.includes('JetBrains Mono'), 'Expected JetBrains Mono font');
  });

  // Summary
  await new Promise(r => setTimeout(r, 100));
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
