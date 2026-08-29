/**
 * Sora-clone backend
 * ----------------------------------------------------------------------
 * A thin, secure proxy between the mobile app and Pika's video-generation
 * model, which is hosted on fal.ai (Pika does not expose api.pika.art
 * directly for production use — fal.ai is the official integration path).
 *
 * Why a backend at all, instead of calling fal.ai straight from the app?
 *  1. Your FAL_KEY must never ship inside a mobile app binary — anyone
 *     could extract it and drain your credits.
 *  2. We want a simple per-device daily limit so a free tier isn't burned
 *     through by one user.
 *  3. fal.ai's queue is async: you submit a job, poll for status, then
 *     fetch the result. The app just talks to two simple endpoints below
 *     and this server handles the fal.ai details.
 *
 * Endpoints exposed to the mobile app:
 *   POST /api/generate        { prompt, deviceId }  -> { jobId }
 *   GET  /api/status/:jobId?deviceId=...             -> { status, videoUrl? }
 * ----------------------------------------------------------------------
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const FAL_KEY = process.env.FAL_KEY;
const FAL_MODEL_ID = process.env.FAL_MODEL_ID || 'fal-ai/pika/v2.2/text-to-video';
const PORT = process.env.PORT || 4000;
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT_PER_USER || '5', 10);

if (!FAL_KEY) {
  console.warn(
    '\n⚠️  FAL_KEY is not set. Copy .env.example to .env and add your fal.ai API key.\n' +
    '   Get one at https://fal.ai after signing up.\n'
  );
}

const FAL_QUEUE_BASE = 'https://queue.fal.run';

// In-memory job map: our jobId -> { falRequestId, status, videoUrl, createdAt }
// For a real production app, replace this with a database (Postgres, SQLite, etc.)
const jobs = new Map();

// In-memory per-device daily usage counter. Replace with a real DB in production.
const usage = new Map(); // deviceId -> { count, date }

function checkAndIncrementUsage(deviceId) {
  const today = new Date().toISOString().slice(0, 10);
  const record = usage.get(deviceId);
  if (!record || record.date !== today) {
    usage.set(deviceId, { count: 1, date: today });
    return { allowed: true, remaining: DAILY_LIMIT - 1 };
  }
  if (record.count >= DAILY_LIMIT) {
    return { allowed: false, remaining: 0 };
  }
  record.count += 1;
  return { allowed: true, remaining: DAILY_LIMIT - record.count };
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, model: FAL_MODEL_ID });
});

// Kick off a new generation job
app.post('/api/generate', async (req, res) => {
  try {
    const { prompt, deviceId, aspectRatio, duration } = req.body || {};

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
      return res.status(400).json({ error: 'Please provide a descriptive prompt (at least a few words).' });
    }
    if (!deviceId) {
      return res.status(400).json({ error: 'Missing deviceId.' });
    }
    if (!FAL_KEY) {
      return res.status(500).json({ error: 'Server is not configured with a FAL_KEY yet.' });
    }

    const { allowed, remaining } = checkAndIncrementUsage(deviceId);
    if (!allowed) {
      return res.status(429).json({
        error: `Daily generation limit (${DAILY_LIMIT}) reached. Try again tomorrow.`,
      });
    }

    // Submit the job to fal.ai's async queue for the Pika model.
    const submitRes = await fetch(`${FAL_QUEUE_BASE}/${FAL_MODEL_ID}`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${FAL_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: prompt.trim(),
        aspect_ratio: aspectRatio || '9:16', // default to vertical for a mobile-first app
        duration: duration || 5,
      }),
    });

    if (!submitRes.ok) {
      const errText = await submitRes.text();
      console.error('fal.ai submit error:', submitRes.status, errText);
      return res.status(502).json({ error: 'Video generation service rejected the request.', detail: errText });
    }

    const submitData = await submitRes.json();
    // fal.ai queue responses include request_id and status_url / response_url
    const falRequestId = submitData.request_id;

    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    jobs.set(jobId, {
      falRequestId,
      status: 'queued',
      videoUrl: null,
      deviceId,
      prompt: prompt.trim(),
      createdAt: Date.now(),
    });

    res.json({ jobId, remaining });
  } catch (err) {
    console.error('Error in /api/generate:', err);
    res.status(500).json({ error: 'Unexpected server error while starting generation.' });
  }
});

// Poll a job's status. The mobile app calls this every few seconds.
app.get('/api/status/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = jobs.get(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Unknown job id.' });
    }

    if (job.status === 'completed' || job.status === 'failed') {
      return res.json({ status: job.status, videoUrl: job.videoUrl });
    }

    const statusRes = await fetch(
      `${FAL_QUEUE_BASE}/${FAL_MODEL_ID}/requests/${job.falRequestId}/status`,
      { headers: { 'Authorization': `Key ${FAL_KEY}` } }
    );
    const statusData = await statusRes.json();

    if (statusData.status === 'COMPLETED') {
      // Fetch the actual result payload (contains the video URL)
      const resultRes = await fetch(
        `${FAL_QUEUE_BASE}/${FAL_MODEL_ID}/requests/${job.falRequestId}`,
        { headers: { 'Authorization': `Key ${FAL_KEY}` } }
      );
      const resultData = await resultRes.json();
      const videoUrl = resultData?.video?.url || resultData?.video_url || null;

      job.status = 'completed';
      job.videoUrl = videoUrl;
      jobs.set(jobId, job);
      return res.json({ status: 'completed', videoUrl });
    }

    if (statusData.status === 'ERROR' || statusData.status === 'FAILED') {
      job.status = 'failed';
      jobs.set(jobId, job);
      return res.json({ status: 'failed' });
    }

    // Still IN_QUEUE or IN_PROGRESS
    job.status = 'processing';
    jobs.set(jobId, job);
    return res.json({ status: 'processing' });
  } catch (err) {
    console.error('Error in /api/status:', err);
    res.status(500).json({ error: 'Unexpected server error while checking status.' });
  }
});

app.listen(PORT, () => {
  console.log(`Sora-clone backend listening on http://localhost:${PORT}`);
});
