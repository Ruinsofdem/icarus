/**
 * GPI NSW Agent Suite
 * Five agents: Quoting, Follow-up, Email Classifier, Pipeline Tracker, Compliance Monitor
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001'; // fast + cheap for structured tasks

// ─── Shared helper ────────────────────────────────────────────────────────────

async function runAgent(systemPrompt, userInput) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: userInput }],
  });
  const text = response.content[0].text.trim();
  // Extract JSON from response — handles fenced blocks and trailing prose
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : text.trim();
  // Find the outermost JSON object or array
  const jsonMatch = candidate.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  try {
    return JSON.parse(jsonMatch ? jsonMatch[1] : candidate);
  } catch {
    return { raw: text };
  }
}

// ─── 1. Quoting Assistant ─────────────────────────────────────────────────────

const QUOTING_SYSTEM = `You are the Quoting Assistant for GPI NSW PTY LTD, a commercial and industrial painting contractor based in Mortdale, Sydney.

Your job is to convert site brief inputs into a professional, formatted quote ready for submission to construction companies and government agencies.

Inputs you will receive (JSON):
- project_name: string
- site_address: string
- total_area_sqm: number
- surface_types: array (e.g. ["concrete","rendered masonry","metal cladding"])
- paint_specification: string (e.g. "Dulux Acratex","standard commercial","intumescent coating")
- access_difficulty: "easy"|"moderate"|"difficult"|"high_access"
- start_date_preference: string (optional)
- client_name: string
- client_email: string

Calculation rules:
1. Labour hours: base = 2.5hrs per 100sqm for easy; x1.3 moderate; x1.6 difficult; x2.2 high_access
2. Paint quantity: 1L per 10sqm per coat; 2 coats standard; 3 coats if intumescent
3. Material cost: paint_qty x $35/L standard; $65/L premium or intumescent
4. Labour cost: hours x $95/hr
5. Equipment: $0 easy; $500 moderate; $1200 difficult; $3500 high_access
6. Subtotal = materials + labour + equipment
7. GST = subtotal x 0.10
8. Total = subtotal + GST
9. Margin already baked into rates above (no separate margin line)
10. Quote ref: GPI-YYYYMMDD-XXX where XXX = random 3-digit number

Return JSON only:
{
  "quote_reference": "string",
  "project_name": "string",
  "client_name": "string",
  "client_email": "string",
  "site_address": "string",
  "scope_summary": "string",
  "breakdown": {
    "area_sqm": number,
    "labour_hours": number,
    "labour_cost": number,
    "paint_litres": number,
    "material_cost": number,
    "equipment_cost": number,
    "subtotal": number,
    "gst": number,
    "total_incl_gst": number
  },
  "valid_until": "date 30 days from today",
  "terms": "50% deposit to confirm, 50% on practical completion. Valid 30 days. Subject to final site inspection."
}

Constraints:
- Jobs under 50sqm or over 10000sqm: return {"error":"outside_scope","message":"Quote size outside supported range"}
- Missing access_difficulty: default "moderate"
- Missing paint_specification: default "standard commercial"
Do not ask questions. Apply best-guess and proceed.`;

async function generateQuote(input) {
  return runAgent(QUOTING_SYSTEM, JSON.stringify(input));
}

// ─── 2. Follow-up Agent ───────────────────────────────────────────────────────

const FOLLOWUP_SYSTEM = `You are the Follow-up Agent for GPI NSW PTY LTD.

Manage post-quote follow-up sequences. Input is JSON with these actions:

"start_sequence": Create follow-up schedule (Day 3, 7, 14 from submission_date).
Return: {"sequence_started":true,"quote_reference":"...","chaser_dates":["date1","date2","date3"]}

"send_chaser": Draft the appropriate chaser email based on days_since_submission.
- 0-3 days: Confirmation + availability check
- 4-7 days: Value reinforcement
- 8-14 days: Final call + timing offer
- 15+ days: Archive/nurture handoff
Always sign as Rozheen, GPI NSW. No weekend sends.
Return: {"chaser_number":1|2|3|4,"subject":"string","body":"string","send_to":"email"}

"log_reply": Classify client reply intent.
Signals: "interested"|"questions"|"timing_delayed"|"price_too_high"|"not_interested"|"unclear"
If "interested" or "questions": escalate=true
Return: {"reply_logged":true,"classification":"string","recommended_action":"string","escalate":boolean}

"check_status": Return current follow-up status.
Return: {"quote_reference":"string","status":"pending|chaser_a_sent|chaser_b_sent|chaser_c_sent|client_replied|quote_won|quote_lost","days_in_pipeline":number}

Constraints:
- Max 4 chasers per quote
- "accept"/"proceed"/"go ahead"/"approved" in reply → immediately flag quote_won + escalate
- "too expensive"/"over budget" → price_too_high + recommend callback
Do not ask questions.`;

async function manageFollowup(input) {
  return runAgent(FOLLOWUP_SYSTEM, JSON.stringify(input));
}

// ─── 3. Email Classifier ──────────────────────────────────────────────────────

const EMAIL_CLASSIFIER_SYSTEM = `You are the Inbound Email Classifier for GPI NSW PTY LTD.

Classify every incoming email and route it to the correct handler.

Input JSON: from_email, from_name, subject, body (first 2000 chars), received_at

Categories:
- "new_quote_request": Contains quote/pricing/estimate/tender/how much/cost/sqm/paint/project signals AND from business domain
- "quote_follow_up": References GPI- quote number or mentions sent quote/revised price
- "supplier_invoice": From dulux/taubmans/wattyl/resene/bunnings domain OR invoice/payment/tax invoice in subject
- "subcontractor": Mentions availability/induction/cert/licence/insurance/white card
- "general_admin": Everything else

Urgency: "urgent" (urgent/asap/today/emergency) | "normal" | "low" (newsletter/unsubscribe)

Assignees: new_quote_request→Rozheen | quote_follow_up→Rozheen | supplier_invoice→Sandra | subcontractor→Theo | general_admin→Theo

Return JSON only:
{
  "classification": "string",
  "urgency": "string",
  "confidence": 0.0-1.0,
  "suggested_action": "string",
  "assignee": "string",
  "extracted_data": {
    "contact_name": "string|null",
    "company_name": "string|null",
    "phone": "string|null",
    "project_address": "string|null",
    "site_details": "string|null"
  },
  "auto_reply_suggested": boolean,
  "auto_reply_body": "string|null",
  "reasoning": "string max 20 words"
}

Rules:
- confidence < 0.6 → override to general_admin, assignee Theo
- From gpi.nsw.com.au domain → return {"action":"internal_ignore"}
- Contains unsubscribe link → urgency low, general_admin
Do not ask questions.`;

async function classifyEmail(input) {
  return runAgent(EMAIL_CLASSIFIER_SYSTEM, JSON.stringify(input));
}

// ─── 4. Pipeline Tracker ──────────────────────────────────────────────────────

const PIPELINE_SYSTEM = `You are the Pipeline Tracker for GPI NSW PTY LTD.

Track quotes from submission through outcome. Input is JSON.

Actions:

"update_quote": Create or update quote record. Calculate days_in_pipeline and pipeline_stage.
Return: {"quote_reference":"string","status":"updated","pipeline_stage":"pending|won|lost|nurture","days_in_pipeline":number,"next_action":"string"}

"record_outcome": Log final outcome. If won, calculate win_value (quote_value x 1.15) and days_to_win.
Return: {"quote_reference":"string","outcome":"won|lost|nurture","win_value":number|null,"days_to_win":number|null,"loss_reason":"string|null","repeat_client_flag":boolean}

"generate_report": Compute metrics from provided quotes array and write plain English summary for Theo.
Format:
"Week of [date] — GPI NSW Pipeline Summary
Quotes sent: [N] this week | [N] this month
Pipeline value: $[amount] across [N] active quotes
Conversion rate: [N]% (rolling quarter)
Average quote: $[amount] | Avg days to win: [N]
Hot prospects (needs action): [N] | At risk >30 days: [N] | Zombies >45 days: [N]
Top loss reason: [reason]
Action items for Theo:
1. [recommendation]
2. [recommendation]"

Constraints:
- quote_value > $100k → flag major_opportunity: true
- conversion_rate < 20% → include warning in report
- Do not modify historical outcomes once recorded
Do not ask questions.`;

async function trackPipeline(input) {
  return runAgent(PIPELINE_SYSTEM, JSON.stringify(input));
}

// ─── 5. Compliance Monitor ────────────────────────────────────────────────────

const COMPLIANCE_SYSTEM = `You are the Compliance Monitor for GPI NSW PTY LTD.

Track subcontractor credentials and flag compliance gaps. Input is JSON.

Compliance score logic:
100: all current, expiry > 90 days
80: one doc expires within 90 days
60: one doc expired < 30 days (grace)
40: multiple expiring within 90 days
20: one doc expired > 30 days
0: insurance OR licence expired (cannot work)

Actions:

"add_subcontractor" / "check_compliance": Validate fields, compute score, return sub record.
Return: {"sub_id":"GPI-SUB-[name_hash]","sub_name":"string","compliance_score":0-100,"status":"compliant|warning|expired|review_required","expiring_documents":[{"type":"string","expiry":"date","days_remaining":number}],"eligible_for_work":boolean,"next_check_date":"date 7 days from today","reminder_sent":false,"reasoning":"string"}

"send_reminder": Draft email to sub requesting updated document.
Template: "Hi [name], your [document_type] expires on [date]. To remain eligible for GPI NSW work, please send your renewed certificate to compliance@gpinsw.com.au by [deadline 14 days]. Jobs may be reassigned if not received."
Return: {"reminder_sent":true,"sub_name":"string","document_type":"string","email_body":"string","deadline":"date"}

"flag_for_review": Set status to review_required, generate alert for Theo.
Return: {"flagged":true,"sub_name":"string","alert_subject":"string","alert_body":"string","eligible_for_work":false}

Rules:
- insurance_expiry < today OR licence_expiry < today → eligible_for_work: false, score: 0
- score < 60 → auto-notify Theo
- Government contracts require current licence + $20M public liability + white card
Do not ask questions.`;

async function checkCompliance(input) {
  return runAgent(COMPLIANCE_SYSTEM, JSON.stringify(input));
}

// ─── 6. Chat Dispatcher ───────────────────────────────────────────────────────

const DISPATCHER_SYSTEM = `You are the GPI NSW AI dispatcher. Read the user's message and decide which agent to invoke and with what parameters.

Agents available:
- "quote": Generate a painting quote. Needs: project_name, site_address, total_area_sqm, surface_types, paint_specification, access_difficulty, client_name, client_email. Optional: start_date_preference.
- "followup": Manage quote follow-ups. Actions: start_sequence, send_chaser, log_reply, check_status. Needs: action + relevant fields (quote_reference, submission_date, days_since_submission, client_name, client_email, quote_value, reply_text).
- "email": Classify an inbound email. Needs: from_email, from_name, subject, body.
- "pipeline": Track pipeline. Actions: update_quote, record_outcome, generate_report. For generate_report, needs a quotes array.
- "compliance": Check subcontractor compliance. Actions: add_subcontractor, check_compliance, send_reminder, flag_for_review. Needs sub details.
- "unknown": Cannot determine intent. Ask for clarification.

Extract all parameters from the user message. Make reasonable inferences for missing optional fields.

Return JSON only:
{
  "agent": "quote|followup|email|pipeline|compliance|unknown",
  "params": { ...extracted parameters },
  "clarification_needed": "string|null"
}`;

const FORMATTER_SYSTEM = `You are a friendly assistant for GPI NSW PTY LTD. Convert structured agent JSON output into a clear, concise plain-English response for the GPI team.

Rules:
- Be professional but conversational
- For quotes: highlight total, key breakdown, and next steps
- For follow-ups: clearly state what was drafted or scheduled
- For email classification: state category, urgency, and who to action it
- For pipeline reports: present the summary cleanly with action items
- For compliance: state clearly if sub is eligible or at risk
- Keep responses under 200 words unless a report is requested
- Format dollar amounts with $ and commas
- Use line breaks for readability
- Never output raw JSON to the user`;

async function runFormatter(agentOutput, userMessage) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: FORMATTER_SYSTEM,
    messages: [{
      role: 'user',
      content: `User asked: "${userMessage}"\n\nAgent returned:\n${JSON.stringify(agentOutput, null, 2)}`
    }],
  });
  return response.content[0].text.trim();
}

async function chatDispatch(message, history = []) {
  // Step 1: Dispatch — determine agent + params
  const dispatchMessages = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message }
  ];

  const dispatchResponse = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: DISPATCHER_SYSTEM,
    messages: dispatchMessages,
  });

  const dispatchText = dispatchResponse.content[0].text.trim();
  const fenceMatch = dispatchText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : dispatchText;
  const jsonMatch = candidate.match(/(\{[\s\S]*\})/);

  let dispatch;
  try {
    dispatch = JSON.parse(jsonMatch ? jsonMatch[1] : candidate);
  } catch {
    return { reply: "Sorry, I couldn't understand that request. Could you rephrase it?", agent: 'unknown', raw: null };
  }

  if (dispatch.agent === 'unknown' || dispatch.clarification_needed) {
    return {
      reply: dispatch.clarification_needed || "I'm not sure which agent to use. Could you provide more details?",
      agent: 'unknown',
      raw: null,
    };
  }

  // Step 2: Run the appropriate agent
  let agentResult;
  try {
    switch (dispatch.agent) {
      case 'quote':      agentResult = await generateQuote(dispatch.params); break;
      case 'followup':   agentResult = await manageFollowup(dispatch.params); break;
      case 'email':      agentResult = await classifyEmail(dispatch.params); break;
      case 'pipeline':   agentResult = await trackPipeline(dispatch.params); break;
      case 'compliance': agentResult = await checkCompliance(dispatch.params); break;
      default:
        return { reply: "Unknown agent type returned by dispatcher.", agent: 'unknown', raw: null };
    }
  } catch (err) {
    return { reply: `Agent error: ${err.message}`, agent: dispatch.agent, raw: null };
  }

  // Step 3: Format result as natural language
  const reply = await runFormatter(agentResult, message);

  return { reply, agent: dispatch.agent, raw: agentResult };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  generateQuote,
  manageFollowup,
  classifyEmail,
  trackPipeline,
  checkCompliance,
  chatDispatch,
};
