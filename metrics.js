// Lightweight self-hosted metrics: everything goes into a local SQLite file.
// No personal data is stored: visitors are a salted hash (salt rotates daily, so
// visitors can't be tracked across days), and receipt contents are never logged.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const RETENTION_DAYS = 180;
const BOT_RE = /bot|crawl|spider|slurp|preview|monitor|curl|wget|python|httpclient|headless/i;

export const ALLOWED_EVENTS = new Set([
  'receipt_uploaded', 'auto_crop_attempt', 'ocr_processed',
  'llm_cleanup', 'bill_split_completed', 'mode_switch',
]);

export function openMetrics(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'metrics.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS http (
      ts INTEGER NOT NULL, method TEXT, route TEXT, status INTEGER, ms REAL, visitor TEXT, country TEXT
    );
    CREATE INDEX IF NOT EXISTS http_ts ON http(ts);
    CREATE TABLE IF NOT EXISTS events (
      ts INTEGER NOT NULL, name TEXT NOT NULL, visitor TEXT, props TEXT
    );
    CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
    CREATE TABLE IF NOT EXISTS llm (
      ts INTEGER NOT NULL, ok INTEGER NOT NULL, status INTEGER, error TEXT, model TEXT,
      ocr_chars INTEGER, prompt_tokens INTEGER, output_tokens INTEGER,
      total_ms REAL, load_ms REAL, prompt_ms REAL, eval_ms REAL, tok_s REAL, rows INTEGER
    );
    CREATE INDEX IF NOT EXISTS llm_ts ON llm(ts);
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  `);

  // migrate older databases created before the country column existed
  if (!db.prepare('PRAGMA table_info(http)').all().some((c) => c.name === 'country')) db.exec('ALTER TABLE http ADD COLUMN country TEXT');

  const insHttp = db.prepare('INSERT INTO http (ts, method, route, status, ms, visitor, country) VALUES (?,?,?,?,?,?,?)');
  const insEvent = db.prepare('INSERT INTO events VALUES (?,?,?,?)');
  const insLlm = db.prepare('INSERT INTO llm VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const getMeta = db.prepare('SELECT v FROM meta WHERE k = ?');
  const setMeta = db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)');

  // Daily-rotating salt, persisted so restarts don't double-count visitors.
  function saltFor(day) {
    const k = 'salt:' + day;
    let row = getMeta.get(k);
    if (!row) { setMeta.run(k, randomBytes(16).toString('hex')); row = getMeta.get(k); }
    return row.v;
  }
  function visitorId(ip, ua) {
    const day = new Date().toISOString().slice(0, 10);
    return createHash('sha256').update(`${saltFor(day)}|${ip}|${ua}`).digest('hex').slice(0, 16);
  }

  function prune() {
    const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
    for (const t of ['http', 'events', 'llm']) db.prepare(`DELETE FROM ${t} WHERE ts < ?`).run(cutoff);
    db.prepare("DELETE FROM meta WHERE k LIKE 'salt:%' AND k < ?").run('salt:' + new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10));
  }
  prune();
  setInterval(prune, 6 * 3600_000).unref();

  const safe = (fn) => (...a) => { try { return fn(...a); } catch (e) { console.error('metrics write failed:', e.message); } };

  return {
    isBot: (ua) => !ua || BOT_RE.test(ua),
    visitorId,

    recordHttp: safe((r) => insHttp.run(Date.now(), r.method, r.route, r.status, r.ms, r.visitor ?? null, r.country ?? null)),

    recordEvent: safe((name, visitor, props) => {
      // Keep only small primitive props; drop anything that could carry user content.
      const clean = {};
      for (const [k, v] of Object.entries(props || {}).slice(0, 12)) {
        if (/^(page_|timestamp|event_label|event_category)/.test(k)) continue;
        if (typeof v === 'number' && Number.isFinite(v)) clean[k] = v;
        else if (typeof v === 'boolean') clean[k] = v;
        else if (typeof v === 'string' && v.length <= 40) clean[k] = v;
      }
      insEvent.run(Date.now(), name, visitor, JSON.stringify(clean));
    }),

    recordLlm: safe((r) => insLlm.run(
      Date.now(), r.ok ? 1 : 0, r.status ?? null, r.error ?? null, r.model ?? null,
      r.ocr_chars ?? null, r.prompt_tokens ?? null, r.output_tokens ?? null,
      r.total_ms ?? null, r.load_ms ?? null, r.prompt_ms ?? null, r.eval_ms ?? null,
      r.tok_s ?? null, r.rows ?? null,
    )),

    summary(rangeKey) {
      const RANGES = { '24h': [86400_000, 3600_000], '7d': [7 * 86400_000, 6 * 3600_000], '30d': [30 * 86400_000, 86400_000] };
      const [span, bucket] = RANGES[rangeKey] || RANGES['24h'];
      const now = Date.now();
      // Align bucket edges to the bucket size so labels are stable between refreshes.
      const end = Math.ceil(now / bucket) * bucket;
      const start = end - span;
      const n = Math.round(span / bucket);
      const idx = (ts) => Math.min(n - 1, Math.floor((ts - start) / bucket));
      const zeros = () => Array(n).fill(0);

      const http = db.prepare('SELECT ts, route, status, ms, visitor, country FROM http WHERE ts >= ?').all(start);
      const events = db.prepare('SELECT ts, name, visitor FROM events WHERE ts >= ?').all(start);
      const llm = db.prepare('SELECT * FROM llm WHERE ts >= ? ORDER BY ts').all(start);

      const series = { page_loads: zeros(), receipts: zeros(), llm_calls: zeros(), bills: zeros(), llm_errors: zeros() };
      const latBuckets = Array.from({ length: n }, () => []);
      const tpsBuckets = Array.from({ length: n }, () => []);
      const visitors = new Set();
      let apiErrors = 0, rateLimited = 0;
      const probes = zeros();
      const probePaths = {}, countries = {}, probeCountries = {};

      for (const h of http) {
        if (h.route === 'page') {
          series.page_loads[idx(h.ts)]++;
          if (h.visitor) visitors.add(h.visitor);
          if (h.country) countries[h.country] = (countries[h.country] || 0) + 1;
        } else if (h.route.startsWith('probe:')) {
          probes[idx(h.ts)]++;
          const pth = h.route.slice(6);
          probePaths[pth] = (probePaths[pth] || 0) + 1;
          if (h.country) probeCountries[h.country] = (probeCountries[h.country] || 0) + 1;
        }
        if (h.status >= 500) apiErrors++;
        if (h.status === 429 || h.status === 503) rateLimited++;
      }
      const top = (o, k = 8) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, k);
      const evCount = {};
      for (const e of events) {
        evCount[e.name] = (evCount[e.name] || 0) + 1;
        if (e.name === 'receipt_uploaded') series.receipts[idx(e.ts)]++;
        if (e.name === 'bill_split_completed') series.bills[idx(e.ts)]++;
        if (e.visitor) visitors.add(e.visitor);
      }
      for (const l of llm) {
        const i = idx(l.ts);
        series.llm_calls[i]++;
        if (!l.ok) series.llm_errors[i]++;
        else {
          if (l.total_ms != null) latBuckets[i].push(l.total_ms);
          if (l.tok_s != null) tpsBuckets[i].push(l.tok_s);
        }
      }

      const okLlm = llm.filter((l) => l.ok);
      const lat = okLlm.map((l) => l.total_ms).filter((v) => v != null);
      const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
      const sum = (a) => a.reduce((s, v) => s + (v || 0), 0);

      return {
        range: rangeKey, start, end, bucket_ms: bucket,
        buckets: Array.from({ length: n }, (_, i) => start + i * bucket),
        totals: {
          page_loads: series.page_loads.reduce((a, b) => a + b, 0),
          visitors: visitors.size,
          receipts: evCount.receipt_uploaded || 0,
          bills: evCount.bill_split_completed || 0,
          llm_calls: llm.length,
          llm_ok: okLlm.length,
          llm_p50_ms: pct(lat, 50),
          llm_p95_ms: pct(lat, 95),
          tok_s_avg: avg(okLlm.map((l) => l.tok_s).filter((v) => v != null)),
          prompt_tokens: sum(okLlm.map((l) => l.prompt_tokens)),
          output_tokens: sum(okLlm.map((l) => l.output_tokens)),
          cold_starts: okLlm.filter((l) => (l.load_ms || 0) > 1000).length,
          api_5xx: apiErrors,
          probes: probes.reduce((a, b) => a + b, 0),
          rate_limited: rateLimited,
        },
        security: {
          top_probe_paths: top(probePaths, 10),
          probe_countries: top(probeCountries),
          visitor_countries: top(countries),
        },
        funnel: [
          ['Page loads', series.page_loads.reduce((a, b) => a + b, 0)],
          ['Receipt uploaded', evCount.receipt_uploaded || 0],
          ['OCR finished', evCount.ocr_processed || 0],
          ['LLM cleanup', llm.length],
          ['Bill split copied', evCount.bill_split_completed || 0],
        ],
        series: {
          ...series,
          probes,
          llm_p50_ms: latBuckets.map((a) => pct(a, 50)),
          llm_p95_ms: latBuckets.map((a) => pct(a, 95)),
          tok_s: tpsBuckets.map((a) => avg(a)),
        },
        recent_llm: llm.slice(-25).reverse().map((l) => ({
          ts: l.ts, ok: !!l.ok, status: l.status, error: l.error, model: l.model, ocr_chars: l.ocr_chars,
          prompt_tokens: l.prompt_tokens, output_tokens: l.output_tokens, total_ms: l.total_ms,
          load_ms: l.load_ms, tok_s: l.tok_s, rows: l.rows,
        })),
      };
    },
  };
}

function pct(arr, p) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const i = (p / 100) * (a.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}
