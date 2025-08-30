# WhatsApp ↔ HubSpot Notes Bridge (Baileys + HubSpot OAuth)

A Node.js app that listens to WhatsApp messages via **Baileys** and logs them as **HubSpot notes** against matching contacts (by phone). Includes an OAuth flow, token refresh, and a reset endpoint.

> ⚠️ **Security**: Never commit credentials. Replace any IDs/secrets in code with environment variables. Rotate anything you’ve already shared publicly.

---

## Features

- WhatsApp connect via QR (Baileys, multi-file auth)
- HubSpot OAuth 2.0 with **access + refresh** tokens
- Automatic **token refresh** on 401
- Contact lookup by **multiple phone formats** (91/ +91 / stripped)
- Rich note body with:
  - message type (text/image/video/document/etc.)
  - quoted message, mentions, files, durations, coordinates (when present)
  - **auto-extracted links**

---

## Prerequisites

- **Node.js 18+**
- A HubSpot app (Client ID/Secret + Redirect URL pointing to `http://localhost:3000/oauth-callback`)
- WhatsApp number you can pair via QR

---

## Quick Start

1. **Clone & enter** the project folder.
2. **Create `.env`** (see example below).
3. **Install deps**
   ```bash
   npm install @whiskeysockets/baileys express node-fetch open qrcode-terminal dotenv
   ```
4. **Run**
   ```bash
   node index.js
   ```
5. Open `http://localhost:3000` to start HubSpot OAuth.  
   After authorization, the app saves tokens and starts the WhatsApp listener.
6. Watch the terminal to **scan the WhatsApp QR**.

---

## Environment Variables

Create a `.env` file in the project root:

```env
CLIENT_ID=your-hubspot-client-id
CLIENT_SECRET=your-hubspot-client-secret
REDIRECT_URI=http://localhost:3000/oauth-callback
PORT=3000
TOKEN_FILE=./hubspot_token.json
```

Load with `dotenv` in your code:

```js
import 'dotenv/config'

const CLIENT_ID = process.env.CLIENT_ID
const CLIENT_SECRET = process.env.CLIENT_SECRET
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/oauth-callback'
const PORT = Number(process.env.PORT || 3000)
const TOKEN_FILE = process.env.TOKEN_FILE || './hubspot_token.json'
```

---

## OAuth & Scopes

This app requests:

- `crm.objects.contacts.read`
- `crm.objects.contacts.write`
- `crm.objects.custom.write`
- `crm.schemas.contacts.read`

Adjust scopes in the authorization URL if needed.

---

## Endpoints

- `GET /` — opens HubSpot authorization in your browser.
- `GET /oauth-callback` — handles the OAuth redirect, saves tokens, starts WhatsApp listener.
- `GET /reset` — deletes the saved token file and clears in-memory token. Re-run `/` to reconnect.

---

## Data & Folders

- `hubspot_token.json` — stores access + refresh tokens.
- `auth_info/` — Baileys multi-file WhatsApp session.
- **Do not** commit these files; add them to `.gitignore`.

Example `.gitignore`:

```
hubspot_token.json
auth_info/
.env
```

---

## How It Works

1. **WhatsApp Listener**
   - Connects via Baileys (multi-file auth)
   - Prints **QR** in terminal for pairing
   - Listens to `messages.upsert` (skips group chats by default)

2. **Message Processing**
   - `extractMessageContent()` normalizes many message types:
     text / extended text (with quoted & mentions) / image / video / audio / document / sticker / location / live location / contact / contacts array / buttons / list / template / reaction
   - Extracts links via regex
   - Preserves captions where applicable

3. **HubSpot**
   - `findContactByPhone()` searches with several formats (raw, stripped, +91 variants)
   - `createNote()` posts a Note with a rich body and timestamp, associated to the contact (association typeId `202`)

4. **Token Refresh**
   - Any HubSpot 401 triggers `refreshHubSpotToken()` and retries the request once.

---

## Scripts You May Want

Add to your `package.json`:

```json
{
  "scripts": {
    "start": "node index.js",
    "dev": "NODE_ENV=development node index.js",
    "reset": "curl -s http://localhost:3000/reset || true"
  }
}
```

---

## Troubleshooting

- **QR doesn’t show**: Ensure your terminal supports UTF-8; wait for the first `connection.update` with a `qr` value.
- **401 from HubSpot**: The app should auto-refresh. If not, hit `/reset` and re-authorize at `/`.
- **No contact found**: Check the phone number in HubSpot. Try adding it to **phone** or **mobilephone** fields exactly as your WhatsApp sends it.
- **node-fetch ESM**: Using Node 18+ with ESM `import`. If switching to CommonJS, use dynamic `import('node-fetch')` or Node 18+ built-in `fetch`.

---

## Security Checklist

- ✅ Store secrets in `.env`, never in code.
- ✅ Rotate any secrets already shared.
- ✅ Restrict HubSpot scopes to minimum required.
- ✅ Keep `hubspot_token.json` and `auth_info/` out of git.
- ✅ Consider running behind a reverse proxy and restricting access to `/oauth-callback`.

---
