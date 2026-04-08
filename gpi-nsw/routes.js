/**
 * GPI NSW Express routes — mount at /api/gpi
 * Usage in server.js:
 *   const gpiRoutes = require('./gpi-nsw/routes');
 *   app.use('/api/gpi', gpiRoutes);
 */

const express = require('express');
const router = express.Router();
const {
  generateQuote,
  manageFollowup,
  classifyEmail,
  trackPipeline,
  checkCompliance,
  chatDispatch,
} = require('./agents');

// ─── 1. Quoting Agent ─────────────────────────────────────────────────────────

router.post('/quote/generate', async (req, res) => {
  try {
    const result = await generateQuote(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 2. Follow-up Agent ───────────────────────────────────────────────────────

router.post('/followup', async (req, res) => {
  try {
    const result = await manageFollowup(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 3. Email Classifier ──────────────────────────────────────────────────────

router.post('/email/classify', async (req, res) => {
  try {
    const result = await classifyEmail(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 4. Pipeline Tracker ──────────────────────────────────────────────────────

router.post('/pipeline', async (req, res) => {
  try {
    const result = await trackPipeline(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 5. Compliance Monitor ────────────────────────────────────────────────────

router.post('/compliance', async (req, res) => {
  try {
    const result = await checkCompliance(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 6. Chat Dispatcher ───────────────────────────────────────────────────────

router.post('/chat', async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });
    const result = await chatDispatch(message, history || []);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────

router.get('/health', (req, res) => {
  res.json({ status: 'ok', agents: ['quoting', 'followup', 'email-classifier', 'pipeline', 'compliance'] });
});

module.exports = router;
