const { google } = require('googleapis');
const fs = require('fs');

const TOKEN_FILE = 'gmail_token.json';

function getAuthClient() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  if (fs.existsSync(TOKEN_FILE)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    auth.setCredentials(token);
  }

  return auth;
}

async function getAuthUrl() {
  console.log('Building auth URL with:', {
    clientId: process.env.GOOGLE_CLIENT_ID ? 'YES' : 'NO',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ? 'YES' : 'NO',
    redirectUri: process.env.GOOGLE_REDIRECT_URI
  });

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  return auth.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send'
    ]
  });
}

async function saveToken(code) {
  console.log('EXACT VALUES:',
    'ID:', process.env.GOOGLE_CLIENT_ID,
    'SECRET:', process.env.GOOGLE_CLIENT_SECRET ? 'exists' : 'missing',
    'URI:', process.env.GOOGLE_REDIRECT_URI
  );

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(`Missing credentials - ID: ${!!clientId}, Secret: ${!!clientSecret}, URI: ${!!redirectUri}`);
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const { tokens } = await auth.getToken(code);
  auth.setCredentials(tokens);
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens));
  return tokens;
}

async function readEmails(maxResults = 5) {
  const auth = getAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.messages.list({
    userId: 'me',
    maxResults,
    q: 'is:unread'
  });

  const messages = res.data.messages || [];
  if (messages.length === 0) return 'No unread emails.';

  const emails = [];
  for (const msg of messages) {
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date']
    });

    const headers = detail.data.payload.headers;
    const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
    const subject = headers.find(h => h.name === 'Subject')?.value || 'No subject';
    const date = headers.find(h => h.name === 'Date')?.value || 'Unknown date';

    emails.push(`From: ${from}\nSubject: ${subject}\nDate: ${date}`);
  }

  return emails.join('\n\n');
}

async function sendEmail(to, subject, body) {
  const auth = getAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const message = [
    `To: ${to}`,
    `Subject: ${subject}`,
    '',
    body
  ].join('\n');

  const encoded = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encoded }
  });

  return `Email sent to ${to} with subject: ${subject}`;
}

module.exports = { getAuthUrl, saveToken, readEmails, sendEmail };