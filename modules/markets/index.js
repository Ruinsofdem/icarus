require('dotenv').config();
const express = require('express');
const axios = require('axios');
const twilio = require('twilio');

const router = express.Router();

// ─── Ticker config ────────────────────────────────────────────────────────────

const TICKERS = [
  { symbol: 'C:XAGUSD', name: 'XAG/USD (Silver)', envKey: 'MARKET_XAG_THRESHOLD' },
  { symbol: 'X:BTCAUD', name: 'BTC/AUD',           envKey: 'MARKET_BTC_THRESHOLD' },
  { symbol: 'X:ETHAUD', name: 'ETH/AUD',           envKey: 'MARKET_ETH_THRESHOLD' },
];

const POLYGON_BASE = 'https://api.polygon.io';
const POLL_INTERVAL_MS = 60_000; // 60 seconds — stays within Polygon free tier (5 calls/min)

// ─── State ────────────────────────────────────────────────────────────────────
// Use a container object so exported _state reference stays valid after resets.

const state = {
  latestPrices: {},  // { [symbol]: { name, price, updatedAt } }
  alertsSent: {},    // dedup key → true (prevents repeat alerts per threshold tier)
  pollTimer: null,
  lastPollAt: null,
};

// ─── Polygon.io ───────────────────────────────────────────────────────────────

/**
 * Fetch previous-close price for a single Polygon ticker.
 * @param {string} ticker e.g. 'C:XAGUSD'
 * @returns {Promise<number|null>} closing price or null on error/no data
 */
async function fetchPrice(ticker) {
  const apiKey = process.env.POLYGON_API_KEY || process.env.MASSIVE_API_KEY;
  if (!apiKey) throw new Error('POLYGON_API_KEY (or MASSIVE_API_KEY) is not set');

  const url = `${POLYGON_BASE}/v2/aggs/ticker/${encodeURIComponent(ticker)}/prev?adjusted=true&apiKey=${apiKey}`;
  const response = await axios.get(url, { timeout: 10_000 });

  const results = response.data?.results;
  if (!results || results.length === 0) return null;
  return results[0].c; // closing price
}

// ─── WhatsApp alert ───────────────────────────────────────────────────────────

async function sendWhatsAppAlert(message) {
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return client.messages.create({
    body: message,
    from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
    to: `whatsapp:${process.env.MY_WHATSAPP_NUMBER}`,
  });
}

// ─── Poll cycle ───────────────────────────────────────────────────────────────

/**
 * Poll all configured tickers sequentially (to avoid burst rate limits).
 * Checks thresholds and sends WhatsApp alerts on breach.
 */
async function pollMarkets() {
  state.lastPollAt = new Date().toISOString();

  for (const { symbol, name, envKey } of TICKERS) {
    try {
      const price = await fetchPrice(symbol);
      if (price === null) {
        console.warn(`[Markets] No price data returned for ${symbol}`);
        continue;
      }

      state.latestPrices[symbol] = { name, price, updatedAt: new Date().toISOString() };

      const rawThreshold = process.env[envKey];
      const threshold = parseFloat(rawThreshold);
      if (!isNaN(threshold) && price >= threshold) {
        // Dedup key: one alert per whole-number multiple of threshold crossed
        const tier = Math.floor(price / threshold);
        const dedupKey = `${symbol}_tier_${tier}`;

        if (!state.alertsSent[dedupKey]) {
          state.alertsSent[dedupKey] = true;
          const msg =
            `🚨 Market Alert — ${name}\n` +
            `Price: ${price.toFixed(4)}\n` +
            `Threshold: ${threshold}\n` +
            `Updated: ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })}`;

          console.log(`[Markets] Threshold breach: ${msg}`);

          try {
            await sendWhatsAppAlert(msg);
          } catch (alertErr) {
            console.error(`[Markets] WhatsApp alert failed for ${symbol}:`, alertErr.message);
          }
        }
      }
    } catch (err) {
      console.error(`[Markets] Error fetching ${symbol}:`, err.message);
    }
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  // Run immediately then poll every 60 seconds
  pollMarkets().catch((err) => console.error('[Markets] Initial poll failed:', err.message));
  state.pollTimer = setInterval(() => {
    pollMarkets().catch((err) => console.error('[Markets] Poll error:', err.message));
  }, POLL_INTERVAL_MS);

  console.log('[Markets] Module initialised — polling every 60 s.');
  return router;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /markets/prices
 * Returns latest cached prices for all monitored tickers.
 */
router.get('/prices', (_req, res) => {
  res.json({
    prices: state.latestPrices,
    lastPollAt: state.lastPollAt,
    updatedAt: new Date().toISOString(),
  });
});

/**
 * GET /markets/status
 * Returns polling status, configured thresholds, and alert history.
 */
router.get('/status', (_req, res) => {
  const thresholds = {};
  for (const { symbol, name, envKey } of TICKERS) {
    thresholds[symbol] = {
      name,
      threshold: process.env[envKey] ? parseFloat(process.env[envKey]) : null,
      currentPrice: state.latestPrices[symbol]?.price ?? null,
      lastUpdated: state.latestPrices[symbol]?.updatedAt ?? null,
    };
  }
  res.json({
    polling: !!state.pollTimer,
    lastPollAt: state.lastPollAt,
    tickers: TICKERS.map((t) => t.symbol),
    thresholds,
    alertsSent: state.alertsSent,
  });
});

function handler() {
  return router;
}

module.exports = {
  init,
  handler,
  fetchPrice,
  pollMarkets,
  sendWhatsAppAlert,
  // Exposed for testing — same object reference, mutated in place
  _state: state,
  _resetState() {
    state.latestPrices = {};
    state.alertsSent = {};
    state.lastPollAt = null;
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  },
};
