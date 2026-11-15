# Self-hosting on macOS

```
Browser ──HTTPS──> Cloudflare edge ──tunnel──> cloudflared ──> server.js :3000 ──> Ollama :11434
                                                (all on the Mac, everything bound to 127.0.0.1)
```

OCR (Tesseract.js) and receipt autocrop (TF.js YOLO) run in the browser. Only the LLM cleanup
step hits the server, via `POST /api/llm-cleanup` (`{ ocrText }` → `{ content, tokens }`).
No ports are opened on your router.

## 1. Dependencies
```sh
brew install node ollama cloudflared
brew services start ollama
ollama pull qwen3:8b
```

## 2. App server
```sh
npm install && npm run build
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.billsplit.server.plist
```
Env vars (set in the plist): `PORT` (3000), `HOST` (127.0.0.1), `OLLAMA_URL`, `LLM_MODEL` (qwen3:8b),
`RATE_LIMIT_PER_MIN` (10/IP).

Deploy an update:
```sh
git pull && npm install && npm run build && launchctl kickstart -k gui/$(id -u)/com.billsplit.server
```
Logs: `~/Library/Logs/billsplit/server.log`

## 3. Cloudflare Tunnel (domain must use Cloudflare DNS)
```sh
cloudflared tunnel login                      # browser: pick your domain
cloudflared tunnel create billsplit
cloudflared tunnel route dns billsplit bill.example.com
```
`~/.cloudflared/config.yml`:
```yaml
tunnel: billsplit
credentials-file: /Users/<you>/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: bill.example.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```
Run it as a LaunchAgent (`~/Library/LaunchAgents/com.billsplit.tunnel.plist`, runs
`cloudflared tunnel --config ~/.cloudflared/config.yml run`, KeepAlive, logs to
`~/Library/Logs/billsplit/tunnel.log`). Alternatively `sudo cloudflared service install` runs it at boot
without login. HTTPS certificates are issued by Cloudflare automatically (can take ~15 min on a new zone).

Current deployment: `https://billsplit.kerkking.com`, tunnel `billsplit`.
`~/.cloudflared/*.json` is the tunnel credential; keep it secret.

## 4. Keep the Mac serving
- `sudo pmset -a sleep 0 disksleep 0 autorestart 1` (never sleep, power back on after outage)
- The app server and Ollama are LaunchAgents and start at **login**, so enable automatic login
  (System Settings → Users & Groups) if the Mac is headless.

## Swapping models
Any Ollama model works: `ollama pull <model>`, change `LLM_MODEL` in the plist, then kickstart.
On 32 GB, 8B to 14B instruct models run comfortably alongside everything else.

## Observability
`server.js` records metrics to `data/metrics.db` (SQLite, 180-day retention, git-ignored):
- `http`: page loads (real SPA routes only), API calls with status + latency, 404 probes, Cloudflare country
- `events`: anonymous funnel events beaconed from the browser (`src/analytics.js` → `POST /api/event`, allowlisted names, numeric props only)
- `llm`: every cleanup call with Ollama timings (load / prompt / eval), token counts, tokens/s, rows parsed, errors

Dashboard: `http://127.0.0.1:3001` on the Mac. To expose it at `stats.kerkking.com`:
1. Cloudflare Zero Trust → Access → Applications → Add → Self-hosted, domain `stats.kerkking.com`,
   policy "Allow" → Emails → your address. Copy the **Application Audience (AUD) tag**.
2. Add `CF_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com` and `CF_ACCESS_AUD=<tag>` to the server plist.
3. Add an ingress rule `stats.kerkking.com → http://127.0.0.1:3001` and `cloudflared tunnel route dns billsplit stats.kerkking.com`.
The server rejects any request that arrived via Cloudflare without a valid Access JWT, so the dashboard
is never public even if step 1 is misconfigured.

## Security model
- Nothing listens on the LAN or internet: app (3000), dashboard (3001), Ollama (11434) all bind 127.0.0.1;
  the only way in is the outbound Cloudflare Tunnel.
- Only the 5 real app routes serve HTML; everything else is a plain 404 (scanners probing `/.env`,
  `/wp-login.php`… find nothing, and are counted on the dashboard).
- Errors never return stack traces (`NODE_ENV=production` + JSON error handler).
- LLM endpoint: fixed server-side prompt, 8 KB input cap, 10 req/min per IP, max 2 concurrent generations
  with a 6-deep queue, 60/min globally. Excess gets 429/503 instead of piling up on the Mac.
- Headers: HSTS, nosniff, `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`, restrictive Permissions-Policy.
- Visitors are stored only as a daily-salted hash; receipt text is never logged.
- `~/.cloudflared/*.json` and `cert.pem` are credentials (mode 600/400). Don't commit or share them.
