const axios = require('axios');

async function webSearch(query) {
  try {
    const response = await axios.get('https://api.search.brave.com/res/v1/web/search', {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': process.env.BRAVE_API_KEY,
      },
      params: {
        q: query,
        count: 5,
        text_decorations: false,
        search_lang: 'en',
        country: 'AU',
      }
    });

    const results = response.data.web?.results || [];

    if (results.length === 0) {
      return 'No results found for that query.';
    }

    return results.map((r, i) => 
      `[${i + 1}] ${r.title}\n${r.description}\nSource: ${r.url}`
    ).join('\n\n');

  } catch (error) {
    return `Search failed: ${error.message}`;
  }
}

async function readFile(filePath) {
  const fs = require('fs');
  try {
    if (!fs.existsSync(filePath)) {
      return `File not found: ${filePath}`;
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return `Failed to read file: ${error.message}`;
  }
}

async function writeFile(filePath, content) {
  const fs = require('fs');
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return `File written successfully: ${filePath}`;
  } catch (error) {
    return `Failed to write file: ${error.message}`;
  }
}

module.exports = { webSearch, readFile, writeFile };