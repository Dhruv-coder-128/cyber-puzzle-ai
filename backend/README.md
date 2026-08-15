# CYBER_PUZZLE.AI — Telegram Photo Delivery Backend

This is a secure, serverless backend designed to run on **Cloudflare Workers** (free tier). It receives captured photos from your CYBER_PUZZLE.AI frontend and forwards them directly to your Telegram chat using your Telegram Bot.

> **Security Guarantee:** Your `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are stored as encrypted server-side secrets in Cloudflare Workers and are **never** exposed to the frontend browser, GitHub Pages, or source code.

---

## 1. Prerequisites (Setup Telegram Bot)

1. **Create a Telegram Bot:**
   - Open Telegram and message [@BotFather](https://t.me/BotFather).
   - Send `/newbot`, choose a name and username for your bot.
   - Copy the generated **HTTP API Token** (e.g. `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`). This is your `TELEGRAM_BOT_TOKEN`.

2. **Get your Chat ID:**
   - Open Telegram and message [@userinfobot](https://t.me/userinfobot) or [@raw_data_bot](https://t.me/raw_data_bot).
   - Send `/start` and copy your numerical **Id** (e.g. `987654321`). This is your `TELEGRAM_CHAT_ID`.
   - **Important:** Start your newly created bot by clicking "Start" in a chat with it so it has permission to message you.

---

## 2. Deploying to Cloudflare Workers

### Option A: Using Wrangler CLI (Recommended)

1. Open your terminal and navigate to the `backend` folder:
   ```bash
   cd backend
   ```

2. Log in to Cloudflare:
   ```bash
   npx wrangler login
   ```

3. Set your Telegram secrets on your existing `cyber-puzzle-ai` worker:
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_CHAT_ID
   ```

4. Deploy the updated worker code:
   ```bash
   npx wrangler deploy
   ```

---

### Option B: Using the Cloudflare Web Dashboard (No CLI required)

1. Log in to [dash.cloudflare.com](https://dash.cloudflare.com).
2. Go to **Workers & Pages** → click on your existing worker **cyber-puzzle-ai**.
3. Click **Edit code**, replace all code with the contents of `backend/worker.js`, and click **Deploy**.
4. Go to the worker's **Settings** → **Variables and Secrets**:
   - Add Secret: `TELEGRAM_BOT_TOKEN` → paste your bot token → click **Encrypt**.
   - Add Secret: `TELEGRAM_CHAT_ID` → paste your chat ID → click **Encrypt**.

---

## 3. Connect Backend to Frontend (`script.js`)

In `script.js` in the project root:

```javascript
// --- PHOTO DELIVERY CONFIGURATION ---
const PHOTO_UPLOAD_CONFIG = {
    enabled: true,
    endpoint: 'https://cyber-puzzle-ai.dushah2007.workers.dev'
};
```

That's it! When users capture a puzzle photo and photo sharing is enabled in their Settings, the photo will be sent to your Telegram chat instantly.
