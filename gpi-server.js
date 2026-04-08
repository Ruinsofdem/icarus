/**
 * GPI NSW — Standalone Agent Server
 * Serves the 5 GPI agents + chat UI
 * Requires only: ANTHROPIC_API_KEY
 *
 * Start: node gpi-server.js
 * Chat:  http://localhost:3001/gpi-chat.html
 * API:   http://localhost:3001/api/gpi/chat
 */

require('dotenv').config();
const path    = require('path');
const express = require('express');
const gpiRoutes = require('./gpi-nsw/routes');

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('[GPI] WARNING: ANTHROPIC_API_KEY is not set — GPI agents will not function.');
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── GPI agent routes ─────────────────────────────────────────────────────────
app.use('/api/gpi', gpiRoutes);

// ─── Root redirect ────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.redirect('/gpi-chat.html'));

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) =>
  res.json({ ok: true, agents: ['quoting', 'followup', 'email-classifier', 'pipeline', 'compliance', 'chat'] })
);

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.GPI_PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n  GPI NSW Agent Server`);
  console.log(`  ─────────────────────────────`);
  console.log(`  Chat UI  →  http://localhost:${PORT}/gpi-chat.html`);
  console.log(`  API      →  http://localhost:${PORT}/api/gpi`);
  console.log(`  Health   →  http://localhost:${PORT}/health\n`);
});
