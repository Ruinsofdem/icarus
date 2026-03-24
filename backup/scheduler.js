const cron = require('node-cron');
const twilio = require('twilio');
const { MAX_TOOL_ITERATIONS, validateEnv, loadMemory, saveMemory, createMessage } = require('./config');
const { checkCalendar } = require('./calendar');
const { manageCrm } = require('./crm');

validateEnv(['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_NUMBER', 'MY_WHATSAPP_NUMBER']);

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const briefingTools = [
  {
    name: 'check_calendar',
    description: 'Manage Google Calendar: list upcoming events, check availability for scheduling, or create new events.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_events', 'check_availability', 'create_event'],
          description: 'list_events: show events in a date range. check_availability: find free slots on a day. create_event: add a new calendar event.'
        },
        params: { type: 'object' }
      },
      required: ['action']
    }
  },
  {
    name: 'manage_crm',
    description: 'Manage the HubSpot CRM pipeline: search contacts, view deals, create deals, and log activity notes.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search_contacts', 'create_contact', 'get_deals', 'create_deal', 'log_note'],
          description: 'search_contacts, create_contact, get_deals, create_deal, log_note'
        },
        params: { type: 'object' }
      },
      required: ['action']
    }
  }
];

async function executeBriefingTool(name, input) {
  if (name === 'check_calendar') return await checkCalendar(input.action, input.params || {});
  if (name === 'manage_crm')     return await manageCrm(input.action, input.params || {});
  return `Unknown tool: ${name}`;
}

const WHATSAPP_LIMIT = 1500; // leave headroom below Twilio's 1600 hard limit

function splitMessage(text) {
  if (text.length <= WHATSAPP_LIMIT) return [text];

  const chunks = [];
  const sections = text.split(/\n\n+/);
  let current = '';

  for (const section of sections) {
    const addition = current ? `\n\n${section}` : section;
    if (current && (current.length + addition.length) > WHATSAPP_LIMIT) {
      chunks.push(current);
      current = section;
    } else {
      current += addition;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

async function sendBriefing(type) {
  const messages = loadMemory();

  const now = new Date().toLocaleString('en-AU', {
    timeZone: 'Australia/Sydney',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const prompt = type === 'morning'
    ? `Today is ${now} (AEST). Generate my morning briefing. Check today's calendar events and open CRM deals to ground your briefing in live data. Cover: Priorities for the day, Risks to watch, Opportunities to pursue, and one Bold move I should make today. Be sharp and specific to EGO and OpenClaw.`
    : `Today is ${now} (AEST). Generate my end of day briefing. Check this week's calendar and the CRM pipeline to ground your briefing in live data. Cover: What should have been accomplished today, what to carry forward tomorrow, any risks that emerged, and one priority to hit first thing tomorrow morning. Be sharp and specific to EGO and OpenClaw.`;

  messages.push({ role: 'user', content: prompt });

  try {
    let response = await createMessage(messages, { tools: briefingTools });
    let iterations = 0;

    while (response.stop_reason === 'tool_use') {
      if (++iterations > MAX_TOOL_ITERATIONS) {
        console.error('[Icarus] Max tool iterations reached in briefing — breaking loop.');
        break;
      }

      messages.push({ role: 'assistant', content: response.content });

      const toolResults = await Promise.all(
        response.content
          .filter(b => b.type === 'tool_use')
          .map(async (block) => ({
            type: 'tool_result',
            tool_use_id: block.id,
            content: await executeBriefingTool(block.name, block.input),
          }))
      );

      messages.push({ role: 'user', content: toolResults });
      response = await createMessage(messages, { tools: briefingTools });
    }

    const reply = response.content.find(b => b.type === 'text')?.text;
    if (!reply) throw new Error('No text content in briefing response.');

    messages.push({ role: 'assistant', content: reply });
    saveMemory(messages);

    const chunks = splitMessage(reply);
    for (const chunk of chunks) {
      await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: `whatsapp:${process.env.MY_WHATSAPP_NUMBER}`,
        body: chunk,
      });
    }

    console.log(`✅ ${type} briefing sent (${chunks.length} message${chunks.length > 1 ? 's' : ''}) at ${new Date().toLocaleString('en-AU')}`);

  } catch (error) {
    console.error(`[Icarus] Failed to send ${type} briefing: ${error.message}`);
  }
}

// 6:00 AM AEST
cron.schedule('0 20 * * *', () => sendBriefing('morning'), { timezone: 'Australia/Sydney' });

// 11:59 PM AEST
cron.schedule('59 13 * * *', () => sendBriefing('evening'), { timezone: 'Australia/Sydney' });

console.log('⏰ Icarus scheduler running — briefings at 6:00 AM and 11:59 PM AEST');
