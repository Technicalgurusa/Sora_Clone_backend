# Sora-clone backend

A small Express server that safely proxies video-generation requests from the
mobile app to **Pika's model, hosted on fal.ai** (this is Pika's official
production API path in 2026 — you don't call `api.pika.art` directly).

## Why this exists

- Keeps your `FAL_KEY` off the phone entirely (never ship API keys inside a
  mobile app).
- Enforces a simple daily generation limit per device, so your free/low-cost
  tier isn't burned through instantly.
- Hides fal.ai's async queue mechanics (submit → poll → fetch result) behind
  two simple endpoints the app can call.

## Setup

1. **Get a fal.ai API key**
   Go to https://fal.ai, sign up, add a payment method (needed even for
   cheap/low-volume usage), and generate an API key from your dashboard.

2. **Install dependencies**
   ```bash
   cd backend
   npm install
   ```

3. **Configure environment variables**
   ```bash
   cp .env.example .env
   ```
   Then open `.env` and paste your key into `FAL_KEY`.

4. **Run the server**
   ```bash
   npm start
   ```
   You should see: `Sora-clone backend listening on http://localhost:4000`

5. **Test it**
   ```bash
   curl http://localhost:4000/api/health
   ```

## Endpoints

### `POST /api/generate`
```json
{ "prompt": "a golden retriever running on a beach at sunset", "deviceId": "abc123" }
```
Returns:
```json
{ "jobId": "job_...", "remaining": 4 }
```

### `GET /api/status/:jobId`
Poll this every ~3 seconds until `status` is `completed` or `failed`.
```json
{ "status": "processing" }
{ "status": "completed", "videoUrl": "https://..." }
```

## Going to production

This starter uses **in-memory storage** for jobs and usage limits — it will
reset every time the server restarts, and won't work if you run more than one
server instance. Before real users depend on it:

- Replace the `Map()` job/usage stores with a real database (Postgres,
  SQLite, etc.)
- Add authentication (so `deviceId` can't be spoofed to dodge limits)
- Copy each completed video into your own storage (S3, Cloudflare R2, etc.)
  instead of relying on fal.ai's result URL staying valid forever
- Add request logging and error alerting
- Consider a webhook instead of polling, once your volume grows
  (fal.ai supports this)

## Deploying

Any Node hosting works: Railway, Render, Fly.io, a small VPS, etc. Set the
same environment variables from `.env` in your host's dashboard — don't
commit `.env` to git.
