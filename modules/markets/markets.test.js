'use strict';

jest.mock('axios');
jest.mock('twilio', () =>
  jest.fn().mockReturnValue({
    messages: {
      create: jest.fn().mockResolvedValue({ sid: 'SM_test' }),
    },
  })
);

const axios = require('axios');
const twilio = require('twilio');
const markets = require('./index');

describe('Markets module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    markets._resetState();
    process.env.MASSIVE_API_KEY = 'test-polygon-key';
    process.env.TWILIO_ACCOUNT_SID = 'AC_test';
    process.env.TWILIO_AUTH_TOKEN = 'test-token';
    process.env.TWILIO_WHATSAPP_NUMBER = '+14155238886';
    process.env.MY_WHATSAPP_NUMBER = '+61400000000';
    process.env.MARKET_XAG_THRESHOLD = '30';
    process.env.MARKET_BTC_THRESHOLD = '100000';
    process.env.MARKET_ETH_THRESHOLD = '5000';
  });

  afterEach(() => {
    markets._resetState();
  });

  describe('init()', () => {
    it('returns an Express router', () => {
      axios.get.mockResolvedValue({ data: { results: [{ c: 28.5 }] } });
      const router = markets.init();
      expect(router).toBeDefined();
      expect(typeof router).toBe('function');
      markets._resetState(); // stop polling interval
    });
  });

  describe('handler()', () => {
    it('returns the Express router', () => {
      const r = markets.handler();
      expect(r).toBeDefined();
    });
  });

  describe('fetchPrice()', () => {
    it('returns closing price from Polygon API', async () => {
      axios.get.mockResolvedValue({
        data: { results: [{ c: 29.47 }] },
      });

      const price = await markets.fetchPrice('C:XAGUSD');

      expect(price).toBe(29.47);
      expect(axios.get).toHaveBeenCalledWith(
        expect.stringContaining('C%3AXAGUSD'),
        expect.objectContaining({ timeout: expect.any(Number) })
      );
      expect(axios.get).toHaveBeenCalledWith(
        expect.stringContaining('test-polygon-key'),
        expect.anything()
      );
    });

    it('returns null when no results returned', async () => {
      axios.get.mockResolvedValue({ data: { results: [] } });
      const price = await markets.fetchPrice('C:XAGUSD');
      expect(price).toBeNull();
    });

    it('returns null when results field is missing', async () => {
      axios.get.mockResolvedValue({ data: {} });
      const price = await markets.fetchPrice('X:BTCAUD');
      expect(price).toBeNull();
    });

    it('throws if MASSIVE_API_KEY is not set', async () => {
      delete process.env.MASSIVE_API_KEY;
      await expect(markets.fetchPrice('C:XAGUSD')).rejects.toThrow('MASSIVE_API_KEY');
    });
  });

  describe('sendWhatsAppAlert()', () => {
    it('sends WhatsApp message via Twilio', async () => {
      await markets.sendWhatsAppAlert('Test alert message');

      const mockClient = twilio.mock.results[0].value;
      expect(mockClient.messages.create).toHaveBeenCalledWith({
        body: 'Test alert message',
        from: 'whatsapp:+14155238886',
        to: 'whatsapp:+61400000000',
      });
    });
  });

  describe('pollMarkets()', () => {
    it('updates latestPrices for each ticker', async () => {
      axios.get
        .mockResolvedValueOnce({ data: { results: [{ c: 29.5 }] } })  // XAG
        .mockResolvedValueOnce({ data: { results: [{ c: 95000 }] } }) // BTC
        .mockResolvedValueOnce({ data: { results: [{ c: 4800 }] } }); // ETH

      await markets.pollMarkets();

      const state = markets._state;
      expect(state.latestPrices['C:XAGUSD']?.price).toBe(29.5);
      expect(state.latestPrices['X:BTCAUD']?.price).toBe(95000);
      expect(state.latestPrices['X:ETHAUD']?.price).toBe(4800);
    });

    it('sends WhatsApp alert when price exceeds threshold', async () => {
      axios.get
        .mockResolvedValueOnce({ data: { results: [{ c: 32.0 }] } })  // XAG above 30 threshold
        .mockResolvedValueOnce({ data: { results: [{ c: 90000 }] } }) // BTC below 100000
        .mockResolvedValueOnce({ data: { results: [{ c: 4000 }] } }); // ETH below 5000

      await markets.pollMarkets();

      const mockClient = twilio.mock.results[0].value;
      expect(mockClient.messages.create).toHaveBeenCalledTimes(1);
      expect(mockClient.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('XAG/USD'),
        })
      );
    });

    it('does not send duplicate alerts for the same threshold tier', async () => {
      axios.get.mockResolvedValue({ data: { results: [{ c: 32.0 }] } });

      await markets.pollMarkets();
      await markets.pollMarkets(); // second poll — same tier, same dedup key

      const mockClient = twilio.mock.results[0].value;
      // Alert should only fire once despite two polls
      const xagAlertCalls = mockClient.messages.create.mock.calls.filter(([args]) =>
        args.body.includes('XAG/USD')
      );
      expect(xagAlertCalls.length).toBe(1);
    });

    it('continues polling other tickers if one fails', async () => {
      axios.get
        .mockRejectedValueOnce(new Error('Network error'))             // XAG fails
        .mockResolvedValueOnce({ data: { results: [{ c: 90000 }] } }) // BTC ok
        .mockResolvedValueOnce({ data: { results: [{ c: 4000 }] } }); // ETH ok

      await expect(markets.pollMarkets()).resolves.not.toThrow();

      const state = markets._state;
      expect(state.latestPrices['X:BTCAUD']?.price).toBe(90000);
    });
  });

  describe('GET /prices route', () => {
    it('returns current prices as JSON', () => {
      const router = markets.handler();
      const pricesLayer = router.stack.find((l) => l.route?.path === '/prices');
      expect(pricesLayer).toBeDefined();

      const mockRes = {
        json: jest.fn(),
      };
      pricesLayer.route.stack[0].handle({}, mockRes, jest.fn());

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          prices: expect.any(Object),
          updatedAt: expect.any(String),
        })
      );
    });
  });

  describe('GET /status route', () => {
    it('returns polling status and thresholds', () => {
      const router = markets.handler();
      const statusLayer = router.stack.find((l) => l.route?.path === '/status');
      expect(statusLayer).toBeDefined();

      const mockRes = { json: jest.fn() };
      statusLayer.route.stack[0].handle({}, mockRes, jest.fn());

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          polling: expect.any(Boolean),
          tickers: expect.any(Array),
          thresholds: expect.any(Object),
        })
      );
    });
  });
});
