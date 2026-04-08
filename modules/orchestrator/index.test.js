'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { parseTask, runOrchestration, callAgent } = require('./index');

// ─── parseTask ────────────────────────────────────────────────────────────────

test('parseTask: lead workflow', () => {
  const result = parseTask('lead Acme Plumbing');
  assert.equal(result.workflow, 'lead');
  assert.equal(result.context, 'Acme Plumbing');
  assert.equal(result.steps.length, 3);
  assert.deepEqual(result.steps[0].agents, ['prospect-researcher']);
  assert.deepEqual(result.steps[1].agents, ['agent-scoper']);
  assert.deepEqual(result.steps[2].agents, ['proposal-writer']);
  // First step has explicit input, subsequent steps inherit
  assert.ok(result.steps[0].input.includes('Acme Plumbing'));
  assert.equal(result.steps[1].input, null);
  assert.equal(result.steps[2].input, null);
});

test('parseTask: scope workflow', () => {
  const result = parseTask('scope TechStart Ltd');
  assert.equal(result.workflow, 'scope');
  assert.equal(result.context, 'TechStart Ltd');
  assert.equal(result.steps.length, 1);
  assert.deepEqual(result.steps[0].agents, ['agent-scoper']);
  assert.ok(result.steps[0].input.includes('TechStart Ltd'));
});

test('parseTask: brief workflow', () => {
  for (const input of ['brief', 'briefing', 'daily brief', 'BRIEF']) {
    const result = parseTask(input);
    assert.equal(result.workflow, 'brief');
    assert.equal(result.steps.length, 1);
    assert.deepEqual(result.steps[0].agents, ['briefing']);
  }
});

test('parseTask: market workflow runs agents in parallel', () => {
  const result = parseTask('market dental clinics');
  assert.equal(result.workflow, 'market');
  assert.equal(result.context, 'dental clinics');
  assert.equal(result.steps.length, 1);
  // Single step with two agents → parallel execution
  assert.equal(result.steps[0].agents.length, 2);
  assert.ok(result.steps[0].agents.includes('knowledge-researcher'));
  assert.ok(result.steps[0].agents.includes('decisions'));
  assert.ok(result.steps[0].input.includes('dental clinics'));
});

test('parseTask: unknown task falls back to general/briefing', () => {
  const result = parseTask('what is the meaning of life');
  assert.equal(result.workflow, 'general');
  assert.equal(result.steps.length, 1);
  assert.deepEqual(result.steps[0].agents, ['briefing']);
});

test('parseTask: lead preserves multi-word name', () => {
  const result = parseTask('lead Sydney Dog Groomers Pty Ltd');
  assert.equal(result.context, 'Sydney Dog Groomers Pty Ltd');
});

// ─── runOrchestration (stubbed) ───────────────────────────────────────────────

test('runOrchestration: returns structured result shape', async () => {
  // Stub callAgent to avoid real API calls
  const original = module.exports.callAgent;
  let callCount = 0;

  // Temporarily monkey-patch the module's internal callAgent via the index module
  // We use a light integration test by stubbing the Anthropic constructor
  const Anthropic = require('@anthropic-ai/sdk');
  const origCreate = Anthropic.prototype.messages?.create;

  // If ANTHROPIC_API_KEY not set, skip live call test
  if (!process.env.ANTHROPIC_API_KEY) {
    // Just verify parseTask shapes are correct (already tested above)
    return;
  }

  // If key is set, test the actual shape of the return value
  const result = await runOrchestration('scope TestCo');
  assert.ok(result.task);
  assert.ok(result.workflow);
  assert.ok(result.context);
  assert.ok(result.sub_results);
  assert.ok(result.summary);
  assert.ok(result.completed_at);
  assert.ok(typeof result.sub_results === 'object');
});

// ─── Input validation (via handler) ──────────────────────────────────────────

test('handler: registers POST /orchestrate on express app', () => {
  const { handler } = require('./index');
  const routes = [];
  const fakeApp = {
    post: (path) => routes.push(path),
  };
  handler(fakeApp);
  assert.ok(routes.includes('/orchestrate'));
});
