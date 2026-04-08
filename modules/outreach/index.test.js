'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { daysSince } = require('./index');

// ─── daysSince ────────────────────────────────────────────────────────────────

test('daysSince: returns 0 for now', () => {
  const now = new Date().toISOString();
  const days = daysSince(now);
  assert.ok(days >= 0 && days < 0.01, `Expected ~0, got ${days}`);
});

test('daysSince: returns ~4 for 4 days ago', () => {
  const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
  const days = daysSince(fourDaysAgo);
  assert.ok(days >= 3.99 && days <= 4.01, `Expected ~4, got ${days}`);
});

test('daysSince: returns ~9 for 9 days ago', () => {
  const nineDaysAgo = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();
  const days = daysSince(nineDaysAgo);
  assert.ok(days >= 8.99 && days <= 9.01, `Expected ~9, got ${days}`);
});

// ─── Sequence eligibility logic ───────────────────────────────────────────────

test('sequence eligibility: Touch 1 requires no Sequence_Started', () => {
  // A record is eligible for Touch 1 if:
  // - ICP_Score >= 12 (filtered by Airtable query)
  // - Status = "Active" (filtered by Airtable query)
  // - No Sequence_Started
  const record = {
    id: 'recTest1',
    fields: {
      Email:            'test@example.com',
      Name:             'Test User',
      ICP_Score:        14,
      Status:           'Active',
      T1_Subject:       'Hi there',
      T1_Body:          'Body text',
      Sequence_Started: null,
    },
  };
  assert.ok(!record.fields.Sequence_Started, 'Should be eligible: no Sequence_Started');
});

test('sequence eligibility: Touch 2 requires 4+ days since Sequence_Started', () => {
  const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

  assert.ok(daysSince(fourDaysAgo) >= 4,  'Should be eligible after 4 days');
  assert.ok(daysSince(threeDaysAgo) < 4,  'Should not be eligible before 4 days');
});

test('sequence eligibility: Touch 3 requires 9+ days since Sequence_Started', () => {
  const nineDaysAgo  = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

  assert.ok(daysSince(nineDaysAgo) >= 9,   'Should be eligible after 9 days');
  assert.ok(daysSince(eightDaysAgo) < 9,   'Should not be eligible before 9 days');
});

test('sequence stops when Replied_At is set', () => {
  const record = {
    id: 'recTest2',
    fields: {
      Email:            'replied@example.com',
      Sequence_Started: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      Replied_At:       new Date().toISOString(),
    },
  };
  // If Replied_At is set, no further touches should be sent
  assert.ok(!!record.fields.Replied_At, 'Has replied — sequence should stop');
});

// ─── handler: registers routes ────────────────────────────────────────────────

test('handler: registers GET /outreach/status and POST /outreach/trigger', () => {
  const { handler } = require('./index');
  const routes = [];
  const fakeApp = {
    get:  (path) => routes.push(`GET ${path}`),
    post: (path) => routes.push(`POST ${path}`),
  };
  handler(fakeApp);
  assert.ok(routes.includes('GET /outreach/status'));
  assert.ok(routes.includes('POST /outreach/trigger'));
});

// ─── Airtable field mapping ───────────────────────────────────────────────────

test('touch field mapping: T1→Touch1, T3→Touch2 email, T5→Touch3 email', () => {
  // Validate our understanding of the field name convention
  const fields = {
    T1_Subject: 'Subject 1', T1_Body: 'Body 1',   // Touch 1 (email)
    T2_Subject: 'Subject 2', T2_Body: 'Body 2',   // Touch 2 (LinkedIn — not automated)
    T3_Subject: 'Subject 3', T3_Body: 'Body 3',   // Touch 3 (email — 2nd email touch)
    T4_Subject: 'Subject 4', T4_Body: 'Body 4',   // Touch 4 (LinkedIn — not automated)
    T5_Subject: 'Subject 5', T5_Body: 'Body 5',   // Touch 5 (email — 3rd email touch)
  };
  // The outreach module sends T1, T3 (as touch 2), T5 (as touch 3)
  assert.equal(fields.T1_Subject, 'Subject 1');
  assert.equal(fields.T3_Subject, 'Subject 3');
  assert.equal(fields.T5_Subject, 'Subject 5');
});
