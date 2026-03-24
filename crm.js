/**
 * HubSpot CRM integration for Icarus (free tier, Private App token).
 */

const axios = require('axios');

const BASE_URL = 'https://api.hubapi.com';
const REQUEST_TIMEOUT = 15_000;

function hubspotClient() {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) {
    throw new Error('HUBSPOT_TOKEN not set. Create a HubSpot Private App and add the token to .env');
  }
  return axios.create({
    baseURL: BASE_URL,
    timeout: REQUEST_TIMEOUT,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
}

async function searchContacts(query) {
  try {
    const client = hubspotClient();
    const res = await client.post('/crm/v3/objects/contacts/search', {
      filterGroups: [
        { filters: [{ propertyName: 'email', operator: 'CONTAINS_TOKEN', value: query }] },
        { filters: [{ propertyName: 'firstname', operator: 'EQ', value: query }] },
        { filters: [{ propertyName: 'lastname', operator: 'EQ', value: query }] },
        { filters: [{ propertyName: 'company', operator: 'CONTAINS_TOKEN', value: query }] },
      ],
      properties: ['firstname', 'lastname', 'email', 'company', 'phone', 'lifecyclestage'],
      limit: 10,
    });

    const contacts = res.data.results || [];
    if (contacts.length === 0) return `No contacts found matching "${query}".`;

    return contacts.map(c => {
      const p = c.properties;
      const name    = `${p.firstname || ''} ${p.lastname || ''}`.trim() || '(no name)';
      const company = p.company     || '—';
      const email   = p.email       || '—';
      const phone   = p.phone       || '—';
      const stage   = p.lifecyclestage || '—';
      return `• ${name} | ${company}\n  Email: ${email} | Phone: ${phone} | Stage: ${stage}\n  ID: ${c.id}`;
    }).join('\n\n');
  } catch (err) {
    return `CRM search error: ${err.response?.data?.message || err.message}`;
  }
}

async function createContact(data) {
  try {
    const client = hubspotClient();
    const res = await client.post('/crm/v3/objects/contacts', {
      properties: {
        firstname: data.firstname || '',
        lastname:  data.lastname  || '',
        email:     data.email     || '',
        company:   data.company   || '',
        phone:     data.phone     || '',
      },
    });
    const p = res.data.properties;
    const name = `${p.firstname || ''} ${p.lastname || ''}`.trim();
    return `Contact created: ${name} (${p.email || '—'}) at ${p.company || '—'}. ID: ${res.data.id}`;
  } catch (err) {
    if (err.response?.status === 409) {
      return `Contact already exists with that email. Search for them first using search_contacts.`;
    }
    return `CRM create contact error: ${err.response?.data?.message || err.message}`;
  }
}

async function getDeals(stageFilter) {
  try {
    const client = hubspotClient();
    const body = {
      properties: ['dealname', 'dealstage', 'amount', 'closedate', 'hubspot_owner_id'],
      limit: 20,
      sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
    };

    if (stageFilter) {
      body.filterGroups = [{
        filters: [{ propertyName: 'dealstage', operator: 'EQ', value: stageFilter }],
      }];
    }

    const res = await client.post('/crm/v3/objects/deals/search', body);
    const deals = res.data.results || [];
    if (deals.length === 0) {
      return stageFilter ? `No deals found in stage "${stageFilter}".` : 'No deals found in the pipeline.';
    }

    return deals.map(d => {
      const p = d.properties;
      const amount = p.amount ? `$${Number(p.amount).toLocaleString()}` : '—';
      const close  = p.closedate ? p.closedate.split('T')[0] : '—';
      return `• ${p.dealname || '(unnamed)'}\n  Stage: ${p.dealstage || '—'} | Value: ${amount} | Close: ${close}\n  ID: ${d.id}`;
    }).join('\n\n');
  } catch (err) {
    return `CRM get deals error: ${err.response?.data?.message || err.message}`;
  }
}

async function createDeal(data) {
  try {
    const client = hubspotClient();
    const dealProps = {
      dealname:  data.dealname || 'New Deal',
      dealstage: data.stage    || 'appointmentscheduled',
      amount:    data.amount   ? String(data.amount) : undefined,
      closedate: data.closedate || undefined,
    };
    Object.keys(dealProps).forEach(k => dealProps[k] === undefined && delete dealProps[k]);

    const res = await client.post('/crm/v3/objects/deals', { properties: dealProps });
    const dealId = res.data.id;

    if (data.contact_id) {
      try {
        await client.put(`/crm/v3/objects/deals/${dealId}/associations/contacts/${data.contact_id}/deal_to_contact`);
      } catch { /* non-fatal */ }
    }

    return `Deal created: "${dealProps.dealname}" in stage "${dealProps.dealstage}"${data.amount ? ` worth $${Number(data.amount).toLocaleString()}` : ''}. ID: ${dealId}`;
  } catch (err) {
    return `CRM create deal error: ${err.response?.data?.message || err.message}`;
  }
}

async function logNote(data) {
  try {
    const client = hubspotClient();
    const res = await client.post('/crm/v3/objects/notes', {
      properties: {
        hs_note_body: data.body,
        hs_timestamp: new Date().toISOString(),
      },
    });

    const noteId = res.data.id;
    const associations = [];

    if (data.contact_id) {
      try {
        await client.put(`/crm/v3/objects/notes/${noteId}/associations/contacts/${data.contact_id}/note_to_contact`);
        associations.push('contact');
      } catch { /* non-fatal */ }
    }

    if (data.deal_id) {
      try {
        await client.put(`/crm/v3/objects/notes/${noteId}/associations/deals/${data.deal_id}/note_to_deal`);
        associations.push('deal');
      } catch { /* non-fatal */ }
    }

    const assocStr = associations.length ? ` (linked to ${associations.join(' + ')})` : '';
    return `Note logged${assocStr}: "${data.body.slice(0, 80)}${data.body.length > 80 ? '…' : ''}"`;
  } catch (err) {
    return `CRM log note error: ${err.response?.data?.message || err.message}`;
  }
}

async function manageCrm(action, params = {}) {
  switch (action) {
    case 'search_contacts': return await searchContacts(params.query || '');
    case 'create_contact':  return await createContact(params);
    case 'get_deals':       return await getDeals(params.stage || null);
    case 'create_deal':     return await createDeal(params);
    case 'log_note':        return await logNote(params);
    default:
      return `Unknown CRM action: ${action}. Use search_contacts, create_contact, get_deals, create_deal, or log_note.`;
  }
}

module.exports = { manageCrm };
