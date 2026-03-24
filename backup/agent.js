const readline = require('readline');
const { webSearch, readFile, writeFile } = require('./tools');
const { checkCalendar } = require('./calendar');
const { manageCrm } = require('./crm');
const { readEmails, sendEmail } = require('./gmail');
const { manageNotion } = require('./notion');
const { MAX_TOOL_ITERATIONS, validateEnv, validateMessages, loadMemory, saveMemory, createMessage } = require('./config');

validateEnv(['BRAVE_API_KEY']);

const tools = [
  {
    name: 'web_search',
    description: 'Search the web for real-time information, prospect research, competitor intel, SMB market trends, and news relevant to EGO and OpenClaw.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query to look up.' }
      },
      required: ['query']
    }
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file on the laptop.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The full path to the file to read.' }
      },
      required: ['file_path']
    }
  },
  {
    name: 'write_file',
    description: 'Write or update a file on the laptop.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The full path to the file to write.' },
        content:   { type: 'string', description: 'The content to write to the file.' }
      },
      required: ['file_path', 'content']
    }
  },
  {
    name: 'check_calendar',
    description: 'Manage Google Calendar: list upcoming events, check availability for scheduling, or create new events for prospect calls and client meetings.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_events', 'check_availability', 'create_event'],
          description: 'list_events: show events in a date range. check_availability: find free slots on a day. create_event: add a new calendar event.'
        },
        params: {
          type: 'object',
          description: 'Action parameters. list_events: { start_date, end_date?, max_results? }. check_availability: { date, duration_minutes? }. create_event: { title, start_time, end_time, description?, location? }.'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'manage_crm',
    description: 'Manage the HubSpot CRM pipeline: search contacts, create contacts, view deals, create deals, and log activity notes.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search_contacts', 'create_contact', 'get_deals', 'create_deal', 'log_note'],
          description: 'search_contacts: find contacts by name/email/company. create_contact: add a new contact. get_deals: list pipeline deals (optionally filter by stage). create_deal: add a new deal. log_note: log an activity note against a contact or deal.'
        },
        params: {
          type: 'object',
          description: 'Action parameters. search_contacts: { query }. create_contact: { firstname, lastname, email, company, phone }. get_deals: { stage? }. create_deal: { dealname, stage?, amount?, closedate?, contact_id? }. log_note: { body, contact_id?, deal_id? }.'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'read_emails',
    description: 'Read unread emails from the Icarus Gmail inbox.',
    input_schema: {
      type: 'object',
      properties: {
        max_results: { type: 'number', description: 'Number of emails to retrieve. Default 5.' }
      },
      required: []
    }
  },
  {
    name: 'send_email',
    description: 'Send an email from the Icarus Gmail account.',
    input_schema: {
      type: 'object',
      properties: {
        to:      { type: 'string', description: 'Recipient email address.' },
        subject: { type: 'string', description: 'Email subject.' },
        body:    { type: 'string', description: 'Email body.' }
      },
      required: ['to', 'subject', 'body']
    }
  },
  {
    name: 'manage_notion',
    description: 'Interact with Notion workspace. Log actions to operations log, create and update workflow tasks, log weekly performance metrics, create and search SOPs. Use this after every significant action to keep the Notion workspace updated.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['setup', 'log', 'create_task', 'update_task', 'log_performance', 'create_sop', 'search_sops', 'create_client_profile'],
          description: 'The Notion action to perform'
        },
        params: {
          type: 'object',
          description: 'Parameters for the action. For log: {action, outcome, status, category, nextStep, apiCostImpact}. For create_task: {task, status, priority, owner, dueDate, notes}. For update_task: {pageId, status, notes}. For log_performance: {week, tasksCompleted, tasksFailed, verificationsent, verificationsApproved, capabilityGapsIdentified, capabilityGapsResolved, apiCallsMade, prospectsResearched, dealsCreated, notes, overallScore}. For create_sop: {title, category, content, version}. For search_sops: {query}. For create_client_profile: {name, summary, businessType, size, website, contactInfo, painPoints, fitScore, fitReason, researchNotes}'
        }
      },
      required: ['action']
    }
  }
];

async function executeTool(toolName, toolInput) {
  console.log(`\n⚙️  Icarus executing: ${toolName}...`);
  switch (toolName) {
    case 'web_search':    return await webSearch(toolInput.query);
    case 'read_file':     return await readFile(toolInput.file_path);
    case 'write_file':    return await writeFile(toolInput.file_path, toolInput.content);
    case 'check_calendar': return await checkCalendar(toolInput.action, toolInput.params || {});
    case 'manage_crm':    return await manageCrm(toolInput.action, toolInput.params || {});
    case 'read_emails':   return await readEmails(toolInput.max_results || 5);
    case 'send_email':    return await sendEmail(toolInput.to, toolInput.subject, toolInput.body);
    case 'manage_notion': return await manageNotion(toolInput.action, toolInput.params || {});
    default:              return `Unknown tool: ${toolName}`;
  }
}

async function chat(messages, userInput) {
  messages.push({ role: 'user', content: userInput });

  // Validate before every API call — strips orphaned tool_use/tool_result blocks
  let clean = validateMessages(messages);
  messages.splice(0, messages.length, ...clean);

  let response = await createMessage(messages, { tools });
  let iterations = 0;

  while (response.stop_reason === 'tool_use') {
    if (++iterations > MAX_TOOL_ITERATIONS) {
      console.error('[Icarus] Max tool iterations reached — breaking loop.');
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults = await Promise.all(
      response.content
        .filter(b => b.type === 'tool_use')
        .map(async (block) => ({
          type: 'tool_result',
          tool_use_id: block.id,
          content: await executeTool(block.name, block.input),
        }))
    );

    messages.push({ role: 'user', content: toolResults });

    clean = validateMessages(messages);
    messages.splice(0, messages.length, ...clean);

    response = await createMessage(messages, { tools });
  }

  const reply = response.content.find(b => b.type === 'text')?.text || 'No response.';
  messages.push({ role: 'assistant', content: reply });
  await saveMemory(messages);
  return reply;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function main() {
  const messages = loadMemory();
  console.log('\n⚡ Icarus is online. Type your message or "exit" to quit.\n');

  const ask = () => {
    rl.question('You: ', async (input) => {
      if (input.toLowerCase() === 'exit') {
        console.log('\nIcarus: Shutting down. Memory saved.\n');
        rl.close();
        return;
      }

      if (!input.trim()) {
        ask();
        return;
      }

      try {
        const reply = await chat(messages, input);
        console.log(`\nIcarus: ${reply}\n`);
      } catch (err) {
        console.error(`\nIcarus: Error — ${err.message}\n`);
      }

      ask();
    });
  };

  ask();
}

main();
