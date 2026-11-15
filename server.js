/* global process */
// Self-hosted server: serves the built SPA from dist/ and proxies the LLM
// cleanup step to a local Ollama instance. The model is never exposed publicly;
// only the fixed-purpose /api/llm-cleanup endpoint is.
//
// A second listener (STATS_PORT) serves the observability dashboard. It is only
// reachable locally, or through Cloudflare with a valid Cloudflare Access login.
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { openMetrics, ALLOWED_EVENTS } from './metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const STATS_PORT = Number(process.env.STATS_PORT || 3001);
const HOST = process.env.HOST || '127.0.0.1'; // cloudflared connects locally; don't listen on the LAN
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const LLM_MODEL = process.env.LLM_MODEL || 'qwen3:8b';
const MAX_OCR_CHARS = 8000;
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 10);
const CF_ACCESS_TEAM_DOMAIN = process.env.CF_ACCESS_TEAM_DOMAIN || ''; // e.g. kerkking.cloudflareaccess.com
const CF_ACCESS_AUD = process.env.CF_ACCESS_AUD || '';

const SYSTEM_PROMPT =
  'You are a helpful assistant that extracts and cleans up bill items from OCR text. ' +
  'Return only the cleaned, itemized bill as a markdown table with the headers: name, quantity, price. ' +
  'Each row should correspond to one item. If quantity is missing, use 1. ' +
  'Price should be a number only, no currency symbol. Do not include subtotal, tax, service charge, or total rows.';

// Hardening headers for every response. The CSP is deliberately limited to directives
// that can't break the app (Tesseract/TF.js load workers and wasm from CDNs).
function securityHeaders(_req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=()',
    'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
    'Strict-Transport-Security': 'max-age=31536000',
  });
  next();
}

// Never leak stack traces or file paths: log server-side, return a generic message.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, _req, res, _next) {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  if (res.headersSent) return;
  res.status(status).json({ error: status < 500 ? 'Bad request' : 'Internal error' });
}

const metrics = openMetrics(process.env.METRICS_DIR || path.join(__dirname, 'data'));
const ns = (v) => (typeof v === 'number' ? v / 1e6 : null); // Ollama durations are nanoseconds

const clientIp = (req) => req.get('cf-connecting-ip') || req.ip;
const visitorOf = (req) => {
  const ua = req.get('user-agent') || '';
  return metrics.isBot(ua) ? null : metrics.visitorId(clientIp(req), ua);
};

// ---------------------------------------------------------------- public app
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback'); // only trust X-Forwarded-For from cloudflared on localhost
app.use(securityHeaders);

const country = (req) => req.get('cf-ipcountry') || null; // set by Cloudflare, null for local requests

// Record API calls (not static assets) with status + latency.
app.use('/api', (req, res, next) => {
  const t0 = performance.now();
  const route = req.originalUrl.split('?')[0].slice(0, 80); // capture now: req.path is rewritten by the time 'finish' fires
  if (route === '/api/event' || route === '/api/health') return next(); // too noisy / not interesting
  res.on('finish', () => {
    metrics.recordHttp({ method: req.method, route, status: res.statusCode, ms: performance.now() - t0, country: country(req) });
  });
  next();
});

// Global guard so the Mac can't be swamped by many IPs at once: at most
// LLM_CONCURRENCY generations in flight, a short queue, and a global per-minute cap.
const LLM_CONCURRENCY = Number(process.env.LLM_CONCURRENCY || 2);
const LLM_QUEUE_MAX = 6;
const LLM_GLOBAL_PER_MIN = Number(process.env.LLM_GLOBAL_PER_MIN || 60);
let llmActive = 0, llmMinuteCount = 0;
const llmQueue = [];
setInterval(() => { llmMinuteCount = 0; }, 60_000).unref();
function llmGate(req, res, next) {
  if (++llmMinuteCount > LLM_GLOBAL_PER_MIN || llmQueue.length >= LLM_QUEUE_MAX) {
    return res.status(503).json({ error: 'The server is busy right now, please try again shortly.' });
  }
  let released = false;
  const release = () => {
    if (released) return; released = true;
    llmActive--;
    const nextInLine = llmQueue.shift();
    if (nextInLine) nextInLine();
  };
  let started = false;
  const start = () => { started = true; llmActive++; next(); };
  // res 'close' fires when the response finishes OR the client disconnects.
  // (Not req 'close': that fires as soon as the body has been read.)
  res.on('close', () => {
    if (started) release();
    else { const i = llmQueue.indexOf(start); if (i >= 0) llmQueue.splice(i, 1); } // left while queued
  });
  if (llmActive < LLM_CONCURRENCY) start();
  else llmQueue.push(start);
}

// Minimal in-memory per-IP rate limiter (single process, good enough for a home server).
function makeLimiter(perMin) {
  const hits = new Map();
  setInterval(() => hits.clear(), 60_000).unref();
  return (req, res, next) => {
    const ip = clientIp(req);
    const n = (hits.get(ip) || 0) + 1;
    hits.set(ip, n);
    if (n > perMin) return res.status(429).json({ error: 'Too many requests, try again in a minute.' });
    next();
  };
}

app.post('/api/llm-cleanup', makeLimiter(RATE_LIMIT_PER_MIN), express.json({ limit: '64kb' }), llmGate, async (req, res) => {
  const ocrText = typeof req.body?.ocrText === 'string' ? req.body.ocrText.trim() : '';
  if (!ocrText) return res.status(400).json({ error: 'ocrText is required.' });
  if (ocrText.length > MAX_OCR_CHARS) return res.status(413).json({ error: 'OCR text too long.' });

  const t0 = performance.now();
  const rec = { model: LLM_MODEL, ocr_chars: ocrText.length };
  try {
    const r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: LLM_MODEL,
        stream: false,
        think: false, // reasoning models: skip the <think> phase, we only want the table
        keep_alive: '30m',
        options: { temperature: 0.2, num_ctx: 8192 },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: ocrText },
        ],
      }),
    });
    const data = await r.json();
    rec.total_ms = performance.now() - t0;
    if (!r.ok || data.error) {
      console.error('Ollama error:', data.error || r.status);
      metrics.recordLlm({ ...rec, ok: false, status: 502, error: String(data.error || r.status).slice(0, 200) });
      return res.status(502).json({ error: 'Local model error: ' + (data.error || r.status) });
    }
    const content = data.message?.content ?? '';
    const evalMs = ns(data.eval_duration);
    metrics.recordLlm({
      ...rec, ok: true, status: 200,
      prompt_tokens: data.prompt_eval_count, output_tokens: data.eval_count,
      load_ms: ns(data.load_duration), prompt_ms: ns(data.prompt_eval_duration), eval_ms: evalMs,
      tok_s: data.eval_count && evalMs ? data.eval_count / (evalMs / 1000) : null,
      // markdown table rows minus header + separator
      rows: Math.max(0, content.split('\n').filter((l) => l.trim().startsWith('|')).length - 2),
    });
    res.json({ content, tokens: data.eval_count ?? null });
  } catch (err) {
    console.error('LLM request failed:', err);
    metrics.recordLlm({ ...rec, ok: false, status: 502, total_ms: performance.now() - t0, error: String(err.name === 'TimeoutError' ? 'timeout' : err.message).slice(0, 200) });
    res.status(502).json({ error: 'Could not reach the local model.' });
  }
});

// Anonymous product events from the browser (navigator.sendBeacon sends text/plain).
app.post('/api/event', makeLimiter(120), express.text({ type: '*/*', limit: '4kb' }), (req, res) => {
  try {
    const { name, props } = JSON.parse(req.body || '{}');
    if (ALLOWED_EVENTS.has(name)) {
      const visitor = visitorOf(req);
      if (visitor) metrics.recordEvent(name, visitor, props);
    }
  } catch { /* ignore malformed */ }
  res.status(204).end();
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

const dist = path.join(__dirname, 'dist');
app.use(express.static(dist, { index: false, maxAge: '1h', dotfiles: 'deny' }));

// Only the app's real routes (see <Routes> in src/App.jsx) serve the SPA. Everything
// else is a 404, so scanners probing /.env, /wp-login.php etc. get nothing and are
// counted as probes rather than page loads.
const SPA_ROUTES = new Set(['/', '/ocr', '/ocr-autocrop', '/manual', '/cropper-test']);
app.get('/{*splat}', (req, res) => {
  const p = req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path;
  if (!SPA_ROUTES.has(p)) {
    metrics.recordHttp({ method: req.method, route: 'probe:' + req.path.slice(0, 80), status: 404, ms: 0, country: country(req) });
    return res.status(404).type('text').send('Not found');
  }
  const visitor = visitorOf(req);
  if (visitor) metrics.recordHttp({ method: 'GET', route: 'page', status: 200, ms: 0, visitor, country: country(req) });
  res.set('Cache-Control', 'no-cache').sendFile(path.join(dist, 'index.html'));
});
app.use((req, res) => {
  metrics.recordHttp({ method: req.method, route: 'probe:' + req.path.slice(0, 80), status: 404, ms: 0, country: country(req) });
  res.status(404).type('text').send('Not found');
});
app.use(errorHandler);

app.listen(PORT, HOST, () => console.log(`billsplit listening on http://${HOST}:${PORT} (model: ${LLM_MODEL})`));

// ---------------------------------------------------------- stats dashboard
const stats = express();
stats.disable('x-powered-by');
stats.use(securityHeaders);
stats.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const jwks = CF_ACCESS_TEAM_DOMAIN
  ? createRemoteJWKSet(new URL(`https://${CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`))
  : null;

// Requests that came through Cloudflare always carry cf-ray (Cloudflare overwrites it,
// it can't be spoofed from outside). Those must present a valid Access JWT.
// Requests without it can only be local, since we bind to 127.0.0.1.
stats.use(async (req, res, next) => {
  if (!req.get('cf-ray')) return next();
  if (!jwks || !CF_ACCESS_AUD) return res.status(403).send('Cloudflare Access is not configured for this dashboard.');
  const token = req.get('cf-access-jwt-assertion');
  if (!token) return res.status(403).send('Forbidden');
  try {
    await jwtVerify(token, jwks, { audience: CF_ACCESS_AUD, issuer: `https://${CF_ACCESS_TEAM_DOMAIN}` });
    next();
  } catch {
    res.status(403).send('Forbidden');
  }
});

const started = Date.now();
stats.get('/api/summary', (req, res) => res.json(metrics.summary(String(req.query.range || '24h'))));
stats.get('/api/live', async (_req, res) => {
  let ollama = { up: false, models: [] };
  try {
    const [ps, ver] = await Promise.all([
      fetch(`${OLLAMA_URL}/api/ps`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()),
      fetch(`${OLLAMA_URL}/api/version`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()),
    ]);
    ollama = {
      up: true, version: ver.version,
      models: (ps.models || []).map((m) => ({
        name: m.name, params: m.details?.parameter_size, quant: m.details?.quantization_level,
        vram_bytes: m.size_vram, ctx: m.context_length, expires_at: m.expires_at,
      })),
    };
  } catch { /* down */ }
  res.json({
    now: Date.now(),
    configured_model: LLM_MODEL,
    server_uptime_s: Math.round((Date.now() - started) / 1000),
    host: { mem_total: os.totalmem(), mem_free: os.freemem(), load: os.loadavg(), uptime_s: os.uptime() },
    ollama,
  });
});
stats.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'stats', 'dashboard.html')));
stats.use((_req, res) => res.status(404).type('text').send('Not found'));
stats.use(errorHandler);

stats.listen(STATS_PORT, HOST, () => console.log(`stats dashboard on http://${HOST}:${STATS_PORT}`));
