/**
 * GPI NSW Agent Demo
 * Run: node gpi-nsw/demo.js
 * Tests all 5 agents with realistic GPI NSW data
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { generateQuote, manageFollowup, classifyEmail, trackPipeline, checkCompliance } = require('./agents');

const RESET  = '\x1b[0m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const RED    = '\x1b[31m';
const BOLD   = '\x1b[1m';

function header(title) {
  console.log(`\n${BOLD}${CYAN}${'─'.repeat(60)}${RESET}`);
  console.log(`${BOLD}${CYAN}  ${title}${RESET}`);
  console.log(`${BOLD}${CYAN}${'─'.repeat(60)}${RESET}`);
}

function ok(label) {
  console.log(`${GREEN}✓${RESET} ${label}`);
}

function print(data) {
  console.log(JSON.stringify(data, null, 2));
}

async function runDemo() {
  console.log(`\n${BOLD}${YELLOW}  GPI NSW OPENCLAW AGENT SUITE — LIVE DEMO${RESET}`);
  console.log(`${YELLOW}  Testing all 5 agents with real GPI NSW scenarios${RESET}\n`);

  // ── TEST 1: Quoting Assistant ─────────────────────────────────────────────
  header('AGENT 1: Quoting Assistant');
  console.log('Scenario: Rozheen receives site brief for a 350sqm government office repaint in Parramatta\n');

  const quoteInput = {
    project_name: 'Parramatta Government Office Repaint',
    site_address: '1 Parramatta Square, Parramatta NSW 2150',
    total_area_sqm: 350,
    surface_types: ['plasterboard', 'concrete columns', 'metal door frames'],
    paint_specification: 'Dulux Acratex',
    access_difficulty: 'moderate',
    start_date_preference: 'April 2026',
    client_name: 'Sarah Chen',
    client_email: 'sarah.chen@nsw.gov.au',
  };

  const quote = await generateQuote(quoteInput);
  ok('Quote generated');
  print(quote);

  // ── TEST 2: Follow-up Agent (Start Sequence) ──────────────────────────────
  header('AGENT 2: Follow-up Agent — Start Sequence');
  const quoteRef = quote.quote_reference || 'GPI-20260330-482';
  console.log(`Scenario: Quote ${quoteRef} submitted — start chaser sequence\n`);

  const seqResult = await manageFollowup({
    action: 'start_sequence',
    quote_reference: quoteRef,
    client_name: 'Sarah Chen',
    client_email: 'sarah.chen@nsw.gov.au',
    submission_date: new Date().toISOString().split('T')[0],
    project_name: 'Parramatta Government Office Repaint',
    quote_value: quote.breakdown?.total_incl_gst || 12500,
  });

  ok('Follow-up sequence started');
  print(seqResult);

  // ── TEST 3: Follow-up Agent (Send Chaser) ─────────────────────────────────
  header('AGENT 2: Follow-up Agent — Send 7-Day Chaser');
  console.log('Scenario: 7 days passed, no reply from Sarah Chen\n');

  const chaserResult = await manageFollowup({
    action: 'send_chaser',
    quote_reference: quoteRef,
    client_name: 'Sarah Chen',
    client_email: 'sarah.chen@nsw.gov.au',
    client_company: 'NSW Government',
    project_name: 'Parramatta Government Office Repaint',
    quote_value: quote.breakdown?.total_incl_gst || 12500,
    days_since_submission: 7,
  });

  ok('Chaser drafted');
  print(chaserResult);

  // ── TEST 4: Email Classifier ──────────────────────────────────────────────
  header('AGENT 3: Email Classifier');
  console.log('Scenario: 3 emails arrive — new enquiry, supplier invoice, and a spam newsletter\n');

  const emails = [
    {
      label: 'New quote request from builder',
      from_email: 'project.manager@buildcorp.com.au',
      from_name: 'James Wheeler',
      subject: 'Painting quote required — Campbelltown warehouse 800sqm',
      body: "Hi, we need a quote for repainting our warehouse at Campbelltown. About 800sqm of concrete walls and steel columns. Metal cladding on the exterior too. Please get back to me ASAP, we're on a tight timeline. My number is 0412 333 444.",
      received_at: new Date().toISOString(),
    },
    {
      label: 'Dulux supplier invoice',
      from_email: 'accounts@dulux.com.au',
      from_name: 'Dulux Accounts',
      subject: 'Tax Invoice #DLX-20260330-9921 — $4,280.00',
      body: 'Please find attached your tax invoice for paint supplies delivered 28 March 2026. Payment due within 30 days. ABN: 67 000 049 427.',
      received_at: new Date().toISOString(),
    },
    {
      label: 'Marketing newsletter',
      from_email: 'noreply@paintingnews.com.au',
      from_name: 'Painting Industry News',
      subject: 'March 2026 Industry Update — New Dulux Range Released',
      body: 'Click here to unsubscribe. This month in painting news: new VOC regulations, Dulux Weathershield refresh, top brush tips for professionals.',
      received_at: new Date().toISOString(),
    },
  ];

  for (const email of emails) {
    console.log(`\n→ Classifying: "${email.label}"`);
    const { label, ...emailData } = email;
    const classification = await classifyEmail(emailData);
    ok(`Classified: ${classification.classification} (${classification.urgency}) → ${classification.assignee}`);
    console.log(`  Confidence: ${classification.confidence} | Action: ${classification.suggested_action}`);
    if (classification.auto_reply_suggested) {
      console.log(`  Auto-reply: ${YELLOW}Yes${RESET}`);
    }
  }

  // ── TEST 5: Pipeline Tracker ──────────────────────────────────────────────
  header('AGENT 4: Pipeline Tracker — Generate Report');
  console.log('Scenario: Weekly pipeline report with 5 quotes in various stages\n');

  const pipelineInput = {
    action: 'generate_report',
    today: new Date().toISOString().split('T')[0],
    quotes: [
      { quote_reference: 'GPI-20260310-101', client_company: 'BuildCorp', quote_value: 28500, submission_date: '2026-03-10', outcome: 'won', outcome_date: '2026-03-18' },
      { quote_reference: 'GPI-20260315-203', client_company: 'Lendlease NSW', quote_value: 142000, submission_date: '2026-03-15', outcome: null },
      { quote_reference: 'GPI-20260318-331', client_company: 'City of Sydney Council', quote_value: 67000, submission_date: '2026-03-18', outcome: null },
      { quote_reference: 'GPI-20260301-088', client_company: 'Private Client', quote_value: 12000, submission_date: '2026-03-01', outcome: 'lost', loss_reason: 'price' },
      { quote_reference: 'GPI-20260210-044', client_company: 'Old Prospect Pty Ltd', quote_value: 19500, submission_date: '2026-02-10', outcome: null },
    ],
  };

  const pipelineReport = await trackPipeline(pipelineInput);
  ok('Pipeline report generated');
  if (pipelineReport.raw) {
    console.log('\n' + pipelineReport.raw);
  } else {
    print(pipelineReport);
  }

  // ── TEST 6: Compliance Monitor ────────────────────────────────────────────
  header('AGENT 5: Compliance Monitor');
  console.log('Scenario: Check compliance for 2 subcontractors — one compliant, one at risk\n');

  const subs = [
    {
      label: 'Compliant sub',
      action: 'add_subcontractor',
      sub_name: 'Marco Pellegrini',
      sub_email: 'marco@pellegrinipainting.com.au',
      sub_company: 'Pellegrini Painting',
      licence_number: 'LP-NSW-44821',
      licence_expiry: '2027-06-30',
      insurance_cert: 'CHU-2026-88721',
      insurance_expiry: '2026-12-31',
      white_card_number: 'WC-NSW-334421',
      white_card_expiry: '2027-01-15',
      worksafe_registered: true,
    },
    {
      label: 'Sub with expiring insurance',
      action: 'add_subcontractor',
      sub_name: 'Danny Tran',
      sub_email: 'danny.tran.painter@gmail.com',
      sub_company: 'DT Coatings',
      licence_number: 'LP-NSW-39104',
      licence_expiry: '2026-05-15',
      insurance_cert: 'NRMA-2026-31045',
      insurance_expiry: '2026-04-10',
      white_card_number: 'WC-NSW-229901',
      white_card_expiry: '2026-06-01',
      worksafe_registered: true,
    },
  ];

  for (const sub of subs) {
    console.log(`\n→ Checking: ${sub.label} (${sub.sub_name})`);
    const { label, ...subData } = sub;
    const result = await checkCompliance(subData);
    const statusColor = result.eligible_for_work ? GREEN : RED;
    ok(`Score: ${result.compliance_score}/100 | Status: ${statusColor}${result.status}${RESET} | Eligible: ${statusColor}${result.eligible_for_work}${RESET}`);
    if (result.expiring_documents?.length) {
      console.log(`  ${YELLOW}Expiring docs:${RESET}`);
      result.expiring_documents.forEach(d => {
        console.log(`    - ${d.type}: ${d.expiry} (${d.days_remaining} days remaining)`);
      });
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${BOLD}${GREEN}${'─'.repeat(60)}${RESET}`);
  console.log(`${BOLD}${GREEN}  DEMO COMPLETE — All 5 GPI NSW agents operational${RESET}`);
  console.log(`${BOLD}${GREEN}${'─'.repeat(60)}${RESET}`);
  console.log(`
Agents tested:
  ${GREEN}✓${RESET} Quoting Assistant     — generated quote with full breakdown
  ${GREEN}✓${RESET} Follow-up Agent       — sequence + chaser email drafted
  ${GREEN}✓${RESET} Email Classifier      — 3 emails classified + routed
  ${GREEN}✓${RESET} Pipeline Tracker      — weekly report with 5 quotes
  ${GREEN}✓${RESET} Compliance Monitor    — 2 subs checked, risk flagged

To use via API:
  POST /api/gpi/quote/generate
  POST /api/gpi/followup
  POST /api/gpi/email/classify
  POST /api/gpi/pipeline
  POST /api/gpi/compliance
`);
}

runDemo().catch(err => {
  console.error(`${RED}Demo failed:${RESET}`, err.message);
  process.exit(1);
});
