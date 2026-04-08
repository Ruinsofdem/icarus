'use strict';

/**
 * Brain Sync Module
 *
 * Runs every 30 minutes. Pulls live data from Airtable, HubSpot, Stripe,
 * Gmail, and Google Calendar, then writes a summary JSON to CORE-Vault.
 *
 * Output: ~/Desktop/CORE-Vault/brain-stats.json
 *
 * Required env vars:
 *   AIRTABLE_API_KEY, HUBSPOT_TOKEN, STRIPE_SECRET_KEY,
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 *   (or gmail_token.json)
 */

const cron    = require('node-cron');
const { google } = require('googleapis');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');

const VAULT_DIR        = path.join(os.homedir(), 'Desktop', 'CORE-Vault');
const STATS_FILE       = path.join(VAULT_DIR, 'brain-stats.json');
const ICARUS_MODULES   = path.join(__dirname, '..');   // modules/ parent

const AIRTABLE_BASE    = 'app6B6clOJP8i0J4Q';
const AIRTABLE_TABLE   = 'tblhqZra5YY2XCqyU';
const AIRTABLE_URL     = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`;
const HUBSPOT_BASE_URL = 'https://api.hubapi.com';
const STRIPE_BASE_URL  = 'https://api.stripe.com/v1';
const ICARUS_TARGET    = 15; // module build target

// Cache current stats so GET /brain/stats can respond instantly
let cachedStats = null;

// ─── Gmail auth (reuses pattern from gmail.js) ────────────────────────────────

const TOKEN_FILE = path.join(process.cwd(), 'gmail_token.json');

function getGmailAuth() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  if (process.env.GMAIL_REFRESH_TOKEN) {
    auth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  } else if (fs.existsSync(TOKEN_FILE)) {
    auth.setCredentials(JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')));
  }
  return auth;
}

// ─── Data fetchers ────────────────────────────────────────────────────────────

async function fetchAirtableStats() {
  try {
    // Total prospects
    const allRes = await fetch(`${AIRTABLE_URL}?pageSize=100&fields[]=ICP_Score&fields[]=Status`, {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    if (!allRes.ok) return { airtable_prospects: 0, sequences_ready: 0 };

    const data  = await allRes.json();
    const recs  = data.records || [];
    const total = recs.length;
    const ready = recs.filter(r =>
      (r.fields.ICP_Score || 0) >= 12 && r.fields.Status === 'Active'
    ).length;

    return { airtable_prospects: total, sequences_ready: ready };
  } catch {
    return { airtable_prospects: 0, sequences_ready: 0 };
  }
}

async function fetchHubSpotStats() {
  try {
    const token   = process.env.HUBSPOT_TOKEN;
    if (!token) return { hubspot_contacts: 0, hubspot_deals: 0, hubspot_companies: 0 };

    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const [contactsRes, dealsRes, companiesRes] = await Promise.all([
      fetch(`${HUBSPOT_BASE_URL}/crm/v3/objects/contacts?limit=1&properties=email`, { headers }),
      fetch(`${HUBSPOT_BASE_URL}/crm/v3/objects/deals?limit=1&properties=dealname`, { headers }),
      fetch(`${HUBSPOT_BASE_URL}/crm/v3/objects/companies?limit=1&properties=name`, { headers }),
    ]);

    const [contacts, deals, companies] = await Promise.all([
      contactsRes.ok ? contactsRes.json() : { total: 0 },
      dealsRes.ok    ? dealsRes.json()    : { total: 0 },
      companiesRes.ok ? companiesRes.json() : { total: 0 },
    ]);

    return {
      hubspot_contacts:  contacts.total  || 0,
      hubspot_deals:     deals.total     || 0,
      hubspot_companies: companies.total || 0,
    };
  } catch {
    return { hubspot_contacts: 0, hubspot_deals: 0, hubspot_companies: 0 };
  }
}

async function fetchStripeStats() {
  try {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) return { stripe_mrr: 0, stripe_customers: 0 };

    const auth    = 'Basic ' + Buffer.from(`${key}:`).toString('base64');
    const headers = { Authorization: auth };

    const [subsRes, custsRes] = await Promise.all([
      fetch(`${STRIPE_BASE_URL}/subscriptions?status=active&limit=100&expand[]=data.plan`, { headers }),
      fetch(`${STRIPE_BASE_URL}/customers?limit=1`, { headers }),
    ]);

    const [subs, custs] = await Promise.all([
      subsRes.ok  ? subsRes.json()  : { data: [] },
      custsRes.ok ? custsRes.json() : { total_count: 0 },
    ]);

    // MRR: sum of monthly-normalised amounts for active subscriptions
    const mrr = (subs.data || []).reduce((acc, sub) => {
      const item  = sub.items?.data?.[0];
      const price = item?.price || item?.plan;
      if (!price) return acc;
      const amount   = (price.unit_amount || 0) / 100;
      const interval = price.recurring?.interval || price.interval || 'month';
      const count    = price.recurring?.interval_count || price.interval_count || 1;
      // Normalise to monthly
      if (interval === 'year')  return acc + amount / (12 * count);
      if (interval === 'week')  return acc + amount * (52 / 12) / count;
      if (interval === 'day')   return acc + amount * (365 / 12) / count;
      return acc + amount / count;
    }, 0);

    return {
      stripe_mrr:       Math.round(mrr * 100) / 100,
      stripe_customers: custs.total_count || 0,
    };
  } catch {
    return { stripe_mrr: 0, stripe_customers: 0 };
  }
}

async function fetchGmailSentCount() {
  try {
    const auth  = getGmailAuth();
    const gmail = google.gmail({ version: 'v1', auth });
    const res   = await gmail.users.messages.list({
      userId:     'me',
      q:          'in:sent',
      maxResults: 1,
    });
    // Gmail API returns an estimated result count in the label info
    const labelRes = await gmail.users.labels.get({ userId: 'me', id: 'SENT' });
    return labelRes.data.messagesTotal || 0;
  } catch {
    return 0;
  }
}

async function fetchCalendarEventCount() {
  try {
    const auth = getGmailAuth();
    const cal  = google.calendar({ version: 'v3', auth });
    const now  = new Date();
    const end  = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // next 30 days

    const res = await cal.events.list({
      calendarId:   'primary',
      timeMin:      now.toISOString(),
      timeMax:      end.toISOString(),
      maxResults:   100,
      singleEvents: true,
    });
    return (res.data.items || []).length;
  } catch {
    return 0;
  }
}

function countVaultNotes() {
  try {
    if (!fs.existsSync(VAULT_DIR)) return 0;
    const files = fs.readdirSync(VAULT_DIR);
    return files.filter(f => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

function countIcarusModules() {
  try {
    if (!fs.existsSync(ICARUS_MODULES)) return 0;
    return fs.readdirSync(ICARUS_MODULES)
      .filter(f => fs.statSync(path.join(ICARUS_MODULES, f)).isDirectory())
      .length;
  } catch {
    return 0;
  }
}

// ─── Sync orchestration ───────────────────────────────────────────────────────

async function runSync() {
  console.log('[Brain Sync] Running sync...');

  const [
    airtable,
    hubspot,
    stripe,
    gmailSent,
    gcalEvents,
  ] = await Promise.all([
    fetchAirtableStats(),
    fetchHubSpotStats(),
    fetchStripeStats(),
    fetchGmailSentCount(),
    fetchCalendarEventCount(),
  ]);

  const vaultNotes     = countVaultNotes();
  const icarusModules  = countIcarusModules();

  const stats = {
    last_synced:       new Date().toISOString(),
    airtable_prospects: airtable.airtable_prospects,
    hubspot_contacts:   hubspot.hubspot_contacts,
    hubspot_deals:      hubspot.hubspot_deals,
    hubspot_companies:  hubspot.hubspot_companies,
    stripe_mrr:         stripe.stripe_mrr,
    stripe_customers:   stripe.stripe_customers,
    gmail_sent:         gmailSent,
    gcal_events:        gcalEvents,
    vault_notes:        vaultNotes,
    prospects_total:    airtable.airtable_prospects,
    sequences_ready:    airtable.sequences_ready,
    icarus_modules:     icarusModules,
    icarus_target:      ICARUS_TARGET,
  };

  // Write to vault
  try {
    fs.mkdirSync(VAULT_DIR, { recursive: true });
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
    console.log(`[Brain Sync] Stats written to ${STATS_FILE}`);
  } catch (err) {
    console.error('[Brain Sync] Failed to write stats file:', err.message);
  }

  cachedStats = stats;
  return stats;
}

// ─── Express handler ──────────────────────────────────────────────────────────

function handler(app) {
  app.get('/brain/stats', (_req, res) => {
    // Return cached or read from file
    if (cachedStats) {
      return res.json(cachedStats);
    }
    if (fs.existsSync(STATS_FILE)) {
      try {
        const stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
        cachedStats = stats;
        return res.json(stats);
      } catch {
        return res.status(500).json({ error: 'Stats file is corrupt.' });
      }
    }
    res.status(404).json({ error: 'No stats yet — trigger a sync first.' });
  });

  app.post('/brain/sync', async (req, res) => {
    try {
      const stats = await runSync();
      res.json(stats);
    } catch (err) {
      console.error('[Brain Sync] Forced sync error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}

// ─── init ─────────────────────────────────────────────────────────────────────

function init() {
  // Every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    try {
      await runSync();
    } catch (err) {
      console.error('[Brain Sync] Cron error:', err.message);
    }
  });

  // Run an initial sync shortly after startup
  setTimeout(() => runSync().catch(err => console.error('[Brain Sync] Startup sync failed:', err.message)), 5000);

  console.log('[Brain Sync] Module ready — syncing every 30 minutes.');
}

module.exports = {
  init,
  handler,
  runSync,
  // Exported for testing
  _fetchAirtableStats:   fetchAirtableStats,
  _fetchHubSpotStats:    fetchHubSpotStats,
  _fetchStripeStats:     fetchStripeStats,
  _countVaultNotes:      countVaultNotes,
  _countIcarusModules:   countIcarusModules,
};
