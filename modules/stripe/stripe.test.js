'use strict';

// ─── Mock stripe before requiring module ─────────────────────────────────────

const mockConstructEvent = jest.fn();
const mockMessagesCreate = jest.fn().mockResolvedValue({ sid: 'SM_test' });

jest.mock('stripe', () =>
  jest.fn().mockReturnValue({
    webhooks: {
      constructEvent: mockConstructEvent,
    },
  })
);

jest.mock('twilio', () =>
  jest.fn().mockReturnValue({
    messages: {
      create: mockMessagesCreate,
    },
  })
);

const { init, handler, generateReceipt, sendWhatsAppAlert } = require('./index');

describe('Stripe module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake1234';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
    process.env.TWILIO_ACCOUNT_SID = 'AC_test';
    process.env.TWILIO_AUTH_TOKEN = 'test-token';
    process.env.TWILIO_WHATSAPP_NUMBER = '+14155238886';
    process.env.MY_WHATSAPP_NUMBER = '+61400000000';
  });

  describe('init()', () => {
    it('returns an Express router', () => {
      const router = init();
      expect(router).toBeDefined();
      expect(typeof router).toBe('function');
    });

    it('warns if STRIPE_WEBHOOK_SECRET is missing', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      delete process.env.STRIPE_WEBHOOK_SECRET;
      init();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('STRIPE_WEBHOOK_SECRET'));
      consoleSpy.mockRestore();
    });
  });

  describe('handler()', () => {
    it('returns the Express router', () => {
      const r = handler();
      expect(r).toBeDefined();
    });
  });

  describe('generateReceipt()', () => {
    const fakeEvent = { id: 'evt_123', type: 'payment_intent.succeeded', created: 1700000000 };

    it('generates a receipt with correct shape', () => {
      const data = { amount: 99.99, currency: 'AUD' };
      const receipt = generateReceipt(fakeEvent, data);

      expect(receipt).toMatchObject({
        receiptId: 'ICARUS-evt_123',
        eventType: 'payment_intent.succeeded',
        timestamp: expect.any(String),
        data: { amount: 99.99, currency: 'AUD' },
      });
    });

    it('converts event.created timestamp to ISO string', () => {
      const receipt = generateReceipt(fakeEvent, {});
      expect(new Date(receipt.timestamp).getTime()).toBe(1700000000 * 1000);
    });
  });

  describe('sendWhatsAppAlert()', () => {
    it('sends a WhatsApp message via Twilio', async () => {
      await sendWhatsAppAlert('Test payment alert');
      expect(mockMessagesCreate).toHaveBeenCalledWith({
        body: 'Test payment alert',
        from: 'whatsapp:+14155238886',
        to: 'whatsapp:+61400000000',
      });
    });
  });

  describe('POST /webhook', () => {
    function getWebhookHandler() {
      const router = init();
      // The webhook route has multiple layers (express.raw + handler)
      const layer = router.stack.find((l) => l.route?.path === '/webhook');
      expect(layer).toBeDefined();
      // The actual async handler is the last stack item
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }

    function makeReq(body, sig = 'test-sig') {
      return {
        headers: { 'stripe-signature': sig },
        body,
        protocol: 'https',
        get: jest.fn().mockReturnValue('localhost'),
      };
    }

    function makeRes() {
      return {
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
        json: jest.fn(),
      };
    }

    it('returns 400 for invalid webhook signature', async () => {
      mockConstructEvent.mockImplementation(() => {
        throw new Error('No signatures found matching the expected signature for payload');
      });

      const webhookHandler = getWebhookHandler();
      const res = makeRes();
      await webhookHandler(makeReq(Buffer.from('{}'), 'bad-sig'), res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Webhook Error'));
    });

    it('processes payment_intent.succeeded and sends alert', async () => {
      const event = {
        id: 'evt_pi_001',
        type: 'payment_intent.succeeded',
        created: 1700000000,
        data: {
          object: {
            id: 'pi_001',
            amount: 4999,
            currency: 'aud',
            customer: 'cus_abc',
            description: 'Openclaw subscription',
          },
        },
      };
      mockConstructEvent.mockReturnValue(event);

      const webhookHandler = getWebhookHandler();
      const res = makeRes();
      await webhookHandler(makeReq(Buffer.from(JSON.stringify(event))), res, jest.fn());

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          received: true,
          processed: true,
          receipt: expect.objectContaining({
            eventType: 'payment_intent.succeeded',
            data: expect.objectContaining({ amount: 49.99, currency: 'AUD' }),
          }),
        })
      );
      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.stringContaining('Payment received') })
      );
    });

    it('processes invoice.paid and sends alert', async () => {
      const event = {
        id: 'evt_inv_001',
        type: 'invoice.paid',
        created: 1700000000,
        data: {
          object: {
            id: 'in_001',
            amount_paid: 9900,
            currency: 'aud',
            customer: 'cus_xyz',
            subscription: 'sub_abc',
            hosted_invoice_url: null,
          },
        },
      };
      mockConstructEvent.mockReturnValue(event);

      const webhookHandler = getWebhookHandler();
      const res = makeRes();
      await webhookHandler(makeReq(Buffer.from(JSON.stringify(event))), res, jest.fn());

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          receipt: expect.objectContaining({
            eventType: 'invoice.paid',
            data: expect.objectContaining({ amount: 99 }),
          }),
        })
      );
      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.stringContaining('Invoice paid') })
      );
    });

    it('processes customer.subscription.created and sends alert', async () => {
      const event = {
        id: 'evt_sub_001',
        type: 'customer.subscription.created',
        created: 1700000000,
        data: {
          object: {
            id: 'sub_001',
            customer: 'cus_abc',
            status: 'active',
            items: { data: [{ price: { id: 'price_monthly_99' } }] },
            current_period_end: 1702592000,
          },
        },
      };
      mockConstructEvent.mockReturnValue(event);

      const webhookHandler = getWebhookHandler();
      const res = makeRes();
      await webhookHandler(makeReq(Buffer.from(JSON.stringify(event))), res, jest.fn());

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          receipt: expect.objectContaining({
            eventType: 'customer.subscription.created',
            data: expect.objectContaining({
              subscriptionId: 'sub_001',
              plan: 'price_monthly_99',
            }),
          }),
        })
      );
      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.stringContaining('New subscription') })
      );
    });

    it('acknowledges unmonitored event types without processing', async () => {
      const event = {
        id: 'evt_other',
        type: 'charge.refunded',
        created: 1700000000,
        data: { object: {} },
      };
      mockConstructEvent.mockReturnValue(event);

      const webhookHandler = getWebhookHandler();
      const res = makeRes();
      await webhookHandler(makeReq(Buffer.from(JSON.stringify(event))), res, jest.fn());

      expect(res.json).toHaveBeenCalledWith({ received: true, processed: false });
      expect(mockMessagesCreate).not.toHaveBeenCalled();
    });

    it('still returns 200 if WhatsApp alert fails', async () => {
      const event = {
        id: 'evt_pi_002',
        type: 'payment_intent.succeeded',
        created: 1700000000,
        data: {
          object: { id: 'pi_002', amount: 1000, currency: 'aud', customer: null },
        },
      };
      mockConstructEvent.mockReturnValue(event);
      mockMessagesCreate.mockRejectedValueOnce(new Error('Twilio network error'));

      const webhookHandler = getWebhookHandler();
      const res = makeRes();
      await webhookHandler(makeReq(Buffer.from(JSON.stringify(event))), res, jest.fn());

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ received: true }));
    });
  });
});
