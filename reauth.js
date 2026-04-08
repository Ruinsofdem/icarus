require('dotenv').config();
const { google } = require('googleapis');
const http = require('http');
const { URL } = require('url');

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = 'http://localhost:3000/auth/callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

async function exchangeCode(code) {
  const { tokens } = await oauth2Client.getToken(code);
  console.log('\n=== SUCCESS ===');
  console.log('\nRefresh token (paste into Railway as GMAIL_REFRESH_TOKEN):\n');
  console.log(tokens.refresh_token || '(no refresh_token — revoke access at myaccount.google.com/permissions and re-run)');
  console.log('\nFull token object:\n');
  console.log(JSON.stringify(tokens, null, 2));
}

// Manual mode: node reauth.js "http://localhost:3000/auth/callback?code=..."
const manualUrl = process.argv[2];
if (manualUrl) {
  const parsed = new URL(manualUrl);
  const code = parsed.searchParams.get('code');
  if (!code) {
    console.error('No code found in the URL you provided.');
    process.exit(1);
  }
  console.log('Exchanging code manually...');
  exchangeCode(code).catch(err => console.error('Failed:', err.message));
  return;
}

// Auto mode: spin up local server
const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: SCOPES,
});

console.log('\n=== Icarus Google Reauth ===');
console.log('\n1. Open this URL in your browser:\n');
console.log(authUrl);
console.log('\n2. Complete the Google login and grant permissions.');
console.log('3. If you land on a broken page, copy the full URL from the address bar');
console.log('   and run: node reauth.js "<paste full URL here>"\n');
console.log('Waiting for automatic callback on http://localhost:3000/auth/callback ...\n');

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://localhost:3000');
  if (parsed.pathname !== '/auth/callback') {
    res.end('Not found');
    return;
  }

  const code = parsed.searchParams.get('code');
  if (!code) {
    const error = parsed.searchParams.get('error') || 'unknown';
    console.log(`\nNo code in callback. Error: ${error}`);
    console.log('Full query string:', parsed.search);
    res.end(`Auth failed: ${error}. Copy the full URL from your browser and run: node reauth.js "<url>"`);
    server.close();
    return;
  }

  res.end('<h2>Auth complete. You can close this tab.</h2>');
  server.close();

  try {
    await exchangeCode(code);
  } catch (err) {
    console.error('\nFailed to exchange code:', err.message);
  }
});

server.listen(3000, () => {});
