# Notion Recruiter — Setup

## Project structure

```
notion-recruiter/
├── server.js
├── package.json
└── public/
    └── index.html
```

## Quick start

```bash
mkdir notion-recruiter && cd notion-recruiter

# Create package.json
npm init -y

# Add "type": "module" to package.json (for ES module imports)
# Install dependencies
npm install express multer node-fetch

# Create the public folder
mkdir public
```

Then copy:
- `server.js` → project root
- `index.html` → `public/index.html`

## Run

```bash
node server.js
```

Open **http://localhost:3000** in your browser.

## What you'll need

1. **Notion Internal Integration Token** — Create one at https://www.notion.so/my-integrations. Make sure to share the database page with the integration.
2. **Database ID** — From your Notion URL: `notion.so/{database_id}?v=...`
3. **AI API Key** — One of:
   - **Anthropic**: `sk-ant-...` from console.anthropic.com
   - **OpenAI**: `sk-...` from platform.openai.com
   - **Google**: `AIza...` from aistudio.google.com

## How it works

- **Express server** proxies all Notion API calls (avoids CORS, keeps your token out of the browser)
- **CV extraction** uploads the file to the server, which forwards it to your chosen AI provider
- **Page creation** builds the Notion properties object and creates the page via the Notion API

## Notes on OpenAI + PDFs

OpenAI's vision API works best with images. If you're using GPT-4o and uploading PDFs, consider converting to PNG first, or use Anthropic/Gemini which handle PDFs natively.

## Customizing fields

Edit the `properties` object in the `/api/create-candidate` route in `server.js` to match your exact Notion database column names and types (select, rich_text, number, date, etc.).
