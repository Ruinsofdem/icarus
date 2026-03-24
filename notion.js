/**
 * Notion integration for Icarus
 * Manages: Operations Log, Workflow Tracker, SOP Library, Performance Dashboard
 */

const { Client } = require('@notionhq/client');

function getClient() {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error('NOTION_TOKEN not set in .env');
  return new Client({ auth: token });
}

// ─── Database Creation ──────────────────────────────────────────────────────

async function createWorkspace() {
  const notion = getClient();

  // Create parent page
  const rootPage = await notion.pages.create({
    parent: { type: 'page_id', page_id: await getRootPageId() },
    properties: {
      title: [{ type: 'text', text: { content: 'Icarus Command Centre' } }],
    },
  });

  const rootId = rootPage.id;

  // Create all databases
  const [opsLog, workflowDb, sopDb, perfDb] = await Promise.all([
    createOpsLogDb(notion, rootId),
    createWorkflowDb(notion, rootId),
    createSopDb(notion, rootId),
    createPerformanceDb(notion, rootId),
  ]);

  // Save IDs to config
  const fs = require('fs');
  const ids = {
    NOTION_ROOT_PAGE: rootId,
    NOTION_OPS_LOG_DB: opsLog.id,
    NOTION_WORKFLOW_DB: workflowDb.id,
    NOTION_SOP_DB: sopDb.id,
    NOTION_PERFORMANCE_DB: perfDb.id,
  };

  // Append to .env
  const envLines = Object.entries(ids)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  fs.appendFileSync('.env', '\n' + envLines + '\n');

  return `Notion workspace created successfully.\nRoot page ID: ${rootId}\nDatabases created: Operations Log, Workflow Tracker, SOP Library, Performance Dashboard\nIDs saved to .env`;
}

async function getRootPageId() {
  const notion = getClient();
  const response = await notion.search({ filter: { property: 'object', value: 'page' }, page_size: 1 });
  if (response.results.length === 0) throw new Error('No pages found in Notion workspace. Create a page first at notion.so');
  return response.results[0].id;
}

// Helper: create a child_database block inside a page, then update its schema.
// The Notion SDK ignores properties in databases.create(), so we use the
// page + child_database + databases.update() pattern instead.
async function createChildDb(notion, parentId, title, properties) {
  const page = await notion.pages.create({
    parent: { type: 'page_id', page_id: parentId },
    properties: { title: [{ type: 'text', text: { content: title } }] },
    children: [{
      object: 'block',
      type: 'child_database',
      child_database: { title },
    }],
  });

  const blocks = await notion.blocks.children.list({ block_id: page.id });
  const dbBlock = blocks.results.find(b => b.type === 'child_database');
  if (!dbBlock) throw new Error(`child_database block not found after creating "${title}"`);

  await notion.databases.update({ database_id: dbBlock.id, properties });
  return { id: dbBlock.id };
}

async function createOpsLogDb(notion, parentId) {
  return createChildDb(notion, parentId, '📋 Icarus Operations Log', {
    'Action':    { title: {} },
    'Outcome':   { rich_text: {} },
    'Date':      { date: {} },
    'Status': {
      select: { options: [
        { name: '🟢 Complete',          color: 'green' },
        { name: '🟡 Pending Approval',  color: 'yellow' },
        { name: '🔵 In Progress',       color: 'blue' },
        { name: '🔴 Failed',            color: 'red' },
      ]},
    },
    'Category': {
      select: { options: [
        { name: 'Research',          color: 'purple' },
        { name: 'CRM',               color: 'blue' },
        { name: 'System',            color: 'gray' },
        { name: 'Self-Improvement',  color: 'pink' },
      ]},
    },
    'Reason':    { rich_text: {} },
    'Next Step': { rich_text: {} },
  });
}

async function createWorkflowDb(notion, parentId) {
  return createChildDb(notion, parentId, '⚙️ Workflow Tracker', {
    'Task':  { title: {} },
    'Notes': { rich_text: {} },
    'Status': {
      select: { options: [
        { name: 'Blocked',      color: 'red' },
        { name: 'In Queue',     color: 'yellow' },
        { name: 'In Progress',  color: 'blue' },
        { name: 'Complete',     color: 'green' },
      ]},
    },
    'Priority': {
      select: { options: [
        { name: 'High',    color: 'red' },
        { name: 'Medium',  color: 'yellow' },
        { name: 'Low',     color: 'green' },
      ]},
    },
    'Owner': {
      select: { options: [
        { name: 'Icarus',    color: 'blue' },
        { name: 'Nicholas',  color: 'orange' },
        { name: 'Both',      color: 'purple' },
      ]},
    },
    'Due Date': { date: {} },
  });
}

async function createSopDb(notion, parentId) {
  return createChildDb(notion, parentId, '📚 SOP Library', {
    'Title': { title: {} },
    'Category': {
      select: { options: [
        { name: 'Sales',              color: 'green' },
        { name: 'Operations',         color: 'blue' },
        { name: 'Client Delivery',    color: 'purple' },
        { name: 'Icarus Behaviour',   color: 'orange' },
        { name: 'Finance',            color: 'yellow' },
      ]},
    },
    'Version':      { rich_text: {} },
    'Status': {
      select: { options: [
        { name: 'Active',    color: 'green' },
        { name: 'Draft',     color: 'yellow' },
        { name: 'Archived',  color: 'gray' },
      ]},
    },
    'Last Updated': { date: {} },
  });
}

async function createPerformanceDb(notion, parentId) {
  return createChildDb(notion, parentId, '📊 Icarus Performance', {
    'Week':                  { title: {} },
    'Tasks Completed':       { number: {} },
    'Tasks Failed':          { number: {} },
    'Prospects Researched':  { number: {} },
    'Deals Created':         { number: {} },
    'Notes':                 { rich_text: {} },
    'Overall Score': {
      select: { options: [
        { name: 'Excellent',          color: 'green' },
        { name: 'Good',               color: 'yellow' },
        { name: 'Needs Improvement',  color: 'red' },
      ]},
    },
  });
}

// ─── Operations Log ─────────────────────────────────────────────────────────

async function logToNotion({ action, outcome, status, category, reason, nextStep }) {
  try {
    const notion = getClient();
    const dbId = process.env.NOTION_OPS_LOG_DB;
    if (!dbId) return 'NOTION_OPS_LOG_DB not set — run setup first';

    const properties = {};

    try { properties['Action']    = { title:     [{ text: { content: action    || 'Unnamed action' } }] }; } catch (e) { console.warn('[Icarus] Notion prop Action:', e.message); }
    try { properties['Outcome']   = { rich_text: [{ text: { content: outcome   || '' } }] }; }              catch (e) { console.warn('[Icarus] Notion prop Outcome:', e.message); }
    try { properties['Date']      = { date: { start: new Date().toISOString() } }; }                        catch (e) { console.warn('[Icarus] Notion prop Date:', e.message); }
    try { properties['Status']    = { select: { name: status   || '🟢 Complete' } }; }                     catch (e) { console.warn('[Icarus] Notion prop Status:', e.message); }
    try { properties['Category']  = { select: { name: category || 'System' } }; }                          catch (e) { console.warn('[Icarus] Notion prop Category:', e.message); }
    try { properties['Reason']    = { rich_text: [{ text: { content: reason   || '' } }] }; }              catch (e) { console.warn('[Icarus] Notion prop Reason:', e.message); }
    try { properties['Next Step'] = { rich_text: [{ text: { content: nextStep || '' } }] }; }              catch (e) { console.warn('[Icarus] Notion prop Next Step:', e.message); }

    await notion.pages.create({ parent: { database_id: dbId }, properties });
    return `Logged to Notion: "${action}"`;
  } catch (err) {
    return `Notion log error: ${err.message}`;
  }
}

// ─── Workflow Tracker ───────────────────────────────────────────────────────

async function createWorkflowTask({ task, status, notes }) {
  try {
    const notion = getClient();
    const dbId = process.env.NOTION_WORKFLOW_DB;
    if (!dbId) return 'NOTION_WORKFLOW_DB not set — run setup first';

    const properties = {};

    try {
      properties['Task'] = { title: [{ text: { content: task || 'Unnamed task' } }] };
    } catch (e) { console.warn('[Icarus] Notion: could not set Task:', e.message); }

    try {
      properties['Notes'] = { rich_text: [{ text: { content: notes || '' } }] };
    } catch (e) { console.warn('[Icarus] Notion: could not set Notes:', e.message); }

    try {
      properties['Status'] = { select: { name: status || 'In Queue' } };
    } catch (e) { console.warn('[Icarus] Notion: could not set Status:', e.message); }

    const page = await notion.pages.create({ parent: { database_id: dbId }, properties });
    return `Workflow task created: "${task}" (ID: ${page.id})`;
  } catch (err) {
    return `Notion workflow error: ${err.message}`;
  }
}

async function updateWorkflowTask({ pageId, status, notes }) {
  try {
    const notion = getClient();
    const props = {};
    if (status) props['Status'] = { select: { name: status } };
    if (notes) props['Notes'] = { rich_text: [{ text: { content: notes } }] };

    await notion.pages.update({ page_id: pageId, properties: props });
    return `Workflow task updated (ID: ${pageId})`;
  } catch (err) {
    return `Notion update error: ${err.message}`;
  }
}

// ─── Performance Tracking ───────────────────────────────────────────────────

async function logPerformance({ week, tasksCompleted, tasksFailed, verificationssent, verificationsApproved, capabilityGapsIdentified, capabilityGapsResolved, apiCallsMade, prospectsResearched, dealsCreated, notes, overallScore }) {
  try {
    const notion = getClient();
    const dbId = process.env.NOTION_PERFORMANCE_DB;
    if (!dbId) return 'NOTION_PERFORMANCE_DB not set — run setup first';

    await notion.pages.create({
      parent: { database_id: dbId },
      properties: {
        'Week': { title: [{ text: { content: week || new Date().toISOString().split('T')[0] } }] },
        'Tasks Completed': { number: tasksCompleted || 0 },
        'Tasks Failed': { number: tasksFailed || 0 },
        'Verifications Sent': { number: verificationsent || 0 },
        'Verifications Approved': { number: verificationsApproved || 0 },
        'Capability Gaps Identified': { number: capabilityGapsIdentified || 0 },
        'Capability Gaps Resolved': { number: capabilityGapsResolved || 0 },
        'API Calls Made': { number: apiCallsMade || 0 },
        'Prospects Researched': { number: prospectsResearched || 0 },
        'Deals Created': { number: dealsCreated || 0 },
        'Notes': { rich_text: [{ text: { content: notes || '' } }] },
        'Overall Score': { select: { name: overallScore || '🟡 Good' } },
      },
    });
    return `Performance entry logged for week of ${week}`;
  } catch (err) {
    return `Notion performance error: ${err.message}`;
  }
}

// ─── SOP Management ─────────────────────────────────────────────────────────

async function createSop({ title, category, content, version }) {
  try {
    const notion = getClient();
    const dbId = process.env.NOTION_SOP_DB;
    if (!dbId) return 'NOTION_SOP_DB not set — run setup first';

    const page = await notion.pages.create({
      parent: { database_id: dbId },
      properties: {
        'Title': { title: [{ text: { content: title || 'Untitled SOP' } }] },
        'Category': { select: { name: category || 'Operations' } },
        'Last Updated': { date: { start: new Date().toISOString().split('T')[0] } },
        'Version': { rich_text: [{ text: { content: version || '1.0' } }] },
        'Status': { select: { name: 'Active' } },
      },
      children: [
        {
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{ type: 'text', text: { content: content || '' } }],
          },
        },
      ],
    });
    return `SOP created: "${title}" (ID: ${page.id})`;
  } catch (err) {
    return `Notion SOP error: ${err.message}`;
  }
}

async function searchSops(query) {
  try {
    const notion = getClient();
    const dbId = process.env.NOTION_SOP_DB;
    if (!dbId) return 'NOTION_SOP_DB not set — run setup first';

    const res = await notion.databases.query({
      database_id: dbId,
      filter: {
        property: 'Title',
        title: { contains: query },
      },
    });

    if (res.results.length === 0) return `No SOPs found matching "${query}"`;

    return res.results.map(p => {
      const title = p.properties['Title']?.title?.[0]?.text?.content || '(untitled)';
      const category = p.properties['Category']?.select?.name || '—';
      const version = p.properties['Version']?.rich_text?.[0]?.text?.content || '—';
      return `• ${title} | ${category} | v${version} | ID: ${p.id}`;
    }).join('\n');
  } catch (err) {
    return `Notion SOP search error: ${err.message}`;
  }
}

// ─── Client Profile Analysis ─────────────────────────────────────────────────

async function createClientProfile({ name, summary, businessType, size, website, contactInfo, painPoints, fitScore, fitReason, researchNotes }) {
  try {
    const notion = getClient();
    const rootPageId = process.env.NOTION_ROOT_PAGE;
    if (!rootPageId) return 'NOTION_ROOT_PAGE not set — run setup first';

    // Find or create the Client Profile Analysis folder page
    let folderPageId = process.env.NOTION_CLIENT_PROFILES_PAGE;

    if (!folderPageId) {
      const folderPage = await notion.pages.create({
        parent: { type: 'page_id', page_id: rootPageId },
        properties: {
          title: [{ type: 'text', text: { content: '🗂️ Client Profile Analysis' } }],
        },
      });
      folderPageId = folderPage.id;
      // Save to .env
      const fs = require('fs');
      fs.appendFileSync('.env', `\nNOTION_CLIENT_PROFILES_PAGE=${folderPageId}\n`);
    }

    // Create the client profile page with full report
    const page = await notion.pages.create({
      parent: { type: 'page_id', page_id: folderPageId },
      properties: {
        title: [{ type: 'text', text: { content: `${name} — Client Profile` } }],
      },
      children: [
        {
          object: 'block',
          type: 'heading_1',
          heading_1: { rich_text: [{ type: 'text', text: { content: `${name} — Prospect Analysis` } }] },
        },
        {
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [{ type: 'text', text: { content: `Generated by Icarus on ${new Date().toLocaleDateString('en-AU')}` } }] },
        },
        {
          object: 'block',
          type: 'divider',
          divider: {},
        },
        {
          object: 'block',
          type: 'heading_2',
          heading_2: { rich_text: [{ type: 'text', text: { content: '📋 Business Overview' } }] },
        },
        {
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [{ type: 'text', text: { content: `Business Type: ${businessType || '—'}` } }] },
        },
        {
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [{ type: 'text', text: { content: `Estimated Size: ${size || '—'}` } }] },
        },
        {
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [{ type: 'text', text: { content: `Website: ${website || '—'}` } }] },
        },
        {
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [{ type: 'text', text: { content: `Contact Info: ${contactInfo || '—'}` } }] },
        },
        {
          object: 'block',
          type: 'heading_2',
          heading_2: { rich_text: [{ type: 'text', text: { content: '🎯 Executive Summary' } }] },
        },
        {
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [{ type: 'text', text: { content: summary || '—' } }] },
        },
        {
          object: 'block',
          type: 'heading_2',
          heading_2: { rich_text: [{ type: 'text', text: { content: '⚠️ Pain Points & Automation Opportunities' } }] },
        },
        {
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [{ type: 'text', text: { content: painPoints || '—' } }] },
        },
        {
          object: 'block',
          type: 'heading_2',
          heading_2: { rich_text: [{ type: 'text', text: { content: '✅ Openclaw Fit Assessment' } }] },
        },
        {
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [{ type: 'text', text: { content: `Fit Score: ${fitScore || '—'}/10` } }] },
        },
        {
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [{ type: 'text', text: { content: `Reason: ${fitReason || '—'}` } }] },
        },
        {
          object: 'block',
          type: 'heading_2',
          heading_2: { rich_text: [{ type: 'text', text: { content: '🔍 Full Research Notes' } }] },
        },
        {
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [{ type: 'text', text: { content: researchNotes || '—' } }] },
        },
        {
          object: 'block',
          type: 'divider',
          divider: {},
        },
        {
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [{ type: 'text', text: { content: '⚡ Report generated by Icarus — Openclaw AI Operations Agent' } }] },
        },
      ],
    });

    return `Client profile created in Notion: "${name}" — ID: ${page.id}\nView at: https://notion.so/${page.id.replace(/-/g, '')}`;
  } catch (err) {
    return `Notion client profile error: ${err.message}`;
  }
}

// ─── Main entry point ────────────────────────────────────────────────────────

async function manageNotion(action, params = {}) {
  switch (action) {
    case 'setup':                  return await createWorkspace();
    case 'log':                    return await logToNotion(params);
    case 'create_task':            return await createWorkflowTask(params);
    case 'update_task':            return await updateWorkflowTask(params);
    case 'log_performance':        return await logPerformance(params);
    case 'create_sop':             return await createSop(params);
    case 'search_sops':            return await searchSops(params.query || '');
    case 'create_client_profile':  return await createClientProfile(params);
    default:
      return `Unknown Notion action: ${action}. Use setup, log, create_task, update_task, log_performance, create_sop, search_sops, create_client_profile.`;
  }
}

module.exports = { manageNotion };
