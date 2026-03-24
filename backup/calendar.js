/**
 * Google Calendar integration for Icarus.
 *
 * Uses the same OAuth credentials and token file as gmail.js.
 * Calendar scope must be included in the OAuth token — re-authenticate
 * via GET /auth after deploying the updated gmail.js to gain access.
 *
 * Required env vars (already present from Gmail setup):
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
 */

const { google } = require('googleapis');
const fs = require('fs');

const TOKEN_FILE = 'gmail_token.json'; // shared OAuth token

function getAuthClient() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  if (fs.existsSync(TOKEN_FILE)) {
    auth.setCredentials(JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')));
  }
  return auth;
}

function getCalendarClient() {
  return google.calendar({ version: 'v3', auth: getAuthClient() });
}

/**
 * List events on the primary calendar within a date range.
 * @param {string} startDate  ISO date string, e.g. "2026-03-22"
 * @param {string} endDate    ISO date string, e.g. "2026-03-29"
 * @param {number} maxResults Maximum events to return (default 20)
 */
async function listEvents(startDate, endDate, maxResults = 20) {
  try {
    const cal = getCalendarClient();
    const res = await cal.events.list({
      calendarId: 'primary',
      timeMin: new Date(startDate).toISOString(),
      timeMax: new Date(endDate + 'T23:59:59').toISOString(),
      maxResults,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = res.data.items || [];
    if (events.length === 0) return `No events found between ${startDate} and ${endDate}.`;

    return events.map(e => {
      const start = e.start.dateTime || e.start.date;
      const end   = e.end.dateTime   || e.end.date;
      return `• ${start} → ${end}\n  ${e.summary || '(no title)'}${e.location ? `\n  📍 ${e.location}` : ''}`;
    }).join('\n\n');
  } catch (err) {
    if (err.code === 403 || err.code === 401) {
      return 'Calendar access not authorised. Re-authenticate via GET /auth to add Calendar scope.';
    }
    return `Calendar error: ${err.message}`;
  }
}

/**
 * Check free/busy windows on the primary calendar.
 * Returns a list of busy slots so Icarus can identify open availability.
 * @param {string} date      ISO date string, e.g. "2026-03-22"
 * @param {number} durationMinutes  Minimum gap needed (used for context only)
 */
async function checkAvailability(date, durationMinutes = 60) {
  try {
    const cal = getCalendarClient();
    const timeMin = new Date(`${date}T00:00:00`).toISOString();
    const timeMax = new Date(`${date}T23:59:59`).toISOString();

    const res = await cal.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        items: [{ id: 'primary' }],
      },
    });

    const busy = res.data.calendars?.primary?.busy || [];
    if (busy.length === 0) {
      return `${date} is fully open — no busy blocks found. A ${durationMinutes}-minute slot can be scheduled any time.`;
    }

    const blocks = busy.map(b => {
      const s = new Date(b.start).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
      const e = new Date(b.end).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
      return `  ${s} – ${e}`;
    }).join('\n');

    return `Busy on ${date}:\n${blocks}\n\nA ${durationMinutes}-minute slot should be scheduled outside these windows.`;
  } catch (err) {
    if (err.code === 403 || err.code === 401) {
      return 'Calendar access not authorised. Re-authenticate via GET /auth to add Calendar scope.';
    }
    return `Availability check error: ${err.message}`;
  }
}

/**
 * Create a calendar event on the primary calendar.
 * @param {string} title        Event title
 * @param {string} startTime    ISO datetime, e.g. "2026-03-25T10:00:00+11:00"
 * @param {string} endTime      ISO datetime, e.g. "2026-03-25T11:00:00+11:00"
 * @param {string} description  Optional event description / agenda
 * @param {string} location     Optional location or video call link
 */
async function createEvent(title, startTime, endTime, description = '', location = '') {
  try {
    const cal = getCalendarClient();
    const event = {
      summary: title,
      start:   { dateTime: startTime },
      end:     { dateTime: endTime },
    };
    if (description) event.description = description;
    if (location)    event.location = location;

    const res = await cal.events.insert({ calendarId: 'primary', requestBody: event });
    return `Event created: "${res.data.summary}" on ${res.data.start.dateTime}. Link: ${res.data.htmlLink}`;
  } catch (err) {
    if (err.code === 403 || err.code === 401) {
      return 'Calendar access not authorised. Re-authenticate via GET /auth to add Calendar scope.';
    }
    return `Event creation error: ${err.message}`;
  }
}

/**
 * Main entry point for the check_calendar tool.
 * @param {string} action   "list_events" | "check_availability" | "create_event"
 * @param {object} params   Action-specific parameters
 */
async function checkCalendar(action, params = {}) {
  switch (action) {
    case 'list_events':
      return await listEvents(
        params.start_date,
        params.end_date   || params.start_date,
        params.max_results || 20
      );
    case 'check_availability':
      return await checkAvailability(params.date, params.duration_minutes || 60);
    case 'create_event':
      return await createEvent(
        params.title,
        params.start_time,
        params.end_time,
        params.description || '',
        params.location    || ''
      );
    default:
      return `Unknown calendar action: ${action}. Use list_events, check_availability, or create_event.`;
  }
}

module.exports = { checkCalendar };
