require('dotenv').config();
const express = require('express');
const twilio = require('twilio');

const router = express.Router();

let stripeClient = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.warn('[Stripe] STRIPE_SECRET_KEY missing — Stripe module disabled.');
    return router;
  }
  // eslint-disable-next-line global-require
  stripeClient = require('stripe')(process.env.STRIPE_SECRET_KEY);

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn(
      '[Stripe] WARNING: STRIPE_WEBHOOK_SECRET is not set — webhook signature verification will fail. ' +
      'Set it in .env using the signing secret from your Stripe dashboard (whsec_...).'
    );
  }

  console.log('[Stripe] Module initialised — monitoring payment events.');
  return router;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generate a structured JSON receipt from a Stripe event.
 * @param {object} event  Stripe event object
 * @param {object} data   Extracted payment/subscription data
 * @returns {object} receipt
 */
function generateReceipt(event, data) {
  return {
    receiptId: `ICARUS-${event.id}`,
    eventType: event.type,
    timestamp: new Date(event.created * 1000).toISOString(),
    data,
  };
}

async function sendWhatsAppAlert(message) {
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return client.messages.create({
    body: message,
    from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
    to: `whatsapp:${process.env.MY_WHATSAPP_NUMBER}`,
  });
}

// ─── Webhook route ────────────────────────────────────────────────────────────

/**
 * POST /stripe/webhook
 *
 * IMPORTANT: This route must be mounted in server.js BEFORE express.json() middleware
 * so that express.raw() can capture the raw body needed for signature verification.
 *
 * In server.js:
 *   app.use('/stripe', stripeModule.init());   // ← BEFORE
 *   app.use(express.json());                    // ← AFTER
 */
router.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      event = stripeClient.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error('[Stripe] Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    let receipt = null;
    let alertMsg = null;

    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        receipt = generateReceipt(event, {
          paymentIntentId: pi.id,
          amount: pi.amount / 100,
          currency: pi.currency.toUpperCase(),
          customer: pi.customer || 'anonymous',
          description: pi.description || null,
        });
        alertMsg =
          `💰 Payment received!\n` +
          `Amount: ${receipt.data.currency} ${receipt.data.amount.toFixed(2)}\n` +
          `ID: ${pi.id}`;
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object;
        receipt = generateReceipt(event, {
          invoiceId: invoice.id,
          amount: invoice.amount_paid / 100,
          currency: invoice.currency.toUpperCase(),
          customer: invoice.customer,
          subscriptionId: invoice.subscription || null,
          invoiceUrl: invoice.hosted_invoice_url || null,
        });
        alertMsg =
          `🧾 Invoice paid!\n` +
          `Amount: ${receipt.data.currency} ${receipt.data.amount.toFixed(2)}\n` +
          `Invoice: ${invoice.id}`;
        break;
      }

      case 'customer.subscription.created': {
        const sub = event.data.object;
        receipt = generateReceipt(event, {
          subscriptionId: sub.id,
          customer: sub.customer,
          status: sub.status,
          plan: sub.items?.data?.[0]?.price?.id || 'unknown',
          currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
        });
        alertMsg =
          `🎉 New subscription!\n` +
          `Customer: ${sub.customer}\n` +
          `Plan: ${receipt.data.plan}\n` +
          `ID: ${sub.id}`;
        break;
      }

      default:
        // Acknowledge non-monitored events without further processing
        return res.json({ received: true, processed: false });
    }

    console.log(`[Stripe] ${event.type}:`, JSON.stringify(receipt, null, 2));

    try {
      await sendWhatsAppAlert(alertMsg);
    } catch (err) {
      // Alert failure should not cause webhook to fail — log and continue
      console.error('[Stripe] WhatsApp alert failed:', err.message);
    }

    res.json({ received: true, processed: true, receipt });
  }
);

function handler() {
  return router;
}

module.exports = { init, handler, generateReceipt, sendWhatsAppAlert };
