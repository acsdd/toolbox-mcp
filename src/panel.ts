/**
 * Localhost ops panel for toolbox-mcp: a small JSON API + single-page UI.
 * Binds to 127.0.0.1 only. MCP clients talk stdio; humans use the panel.
 */
import { createServer, type Server } from 'node:http'
import type { Services } from './services.js'

const PANEL_PORT = Number(process.env.TOOLBOX_MCP_PORT ?? 3851)

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>toolbox-mcp panel</title>
<style>
  :root { color-scheme: dark; --bg: #0d1117; --card: #161b22; --border: #30363d; --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, sans-serif; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .muted { color: var(--muted); font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-top: 16px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 14px; }
  .card h2 { font-size: 13px; margin: 0 0 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  pre { white-space: pre-wrap; word-break: break-word; margin: 0; font-size: 12px; max-height: 260px; overflow: auto; }
  button { margin-top: 10px; padding: 6px 12px; border: 1px solid var(--border); border-radius: 6px; background: #21262d; color: var(--text); cursor: pointer; }
  button:hover { border-color: var(--accent); }
</style>
</head>
<body>
  <h1>toolbox-mcp</h1>
  <div class="muted">Local ops panel · 127.0.0.1 only · shares widgets with Toolbox and the NAS app</div>
  <div class="grid">
    <div class="card"><h2>Crypto watch</h2><pre id="crypto">…</pre><button onclick="act('crypto_refresh', 'crypto')">Refresh prices</button></div>
    <div class="card"><h2>Gmail announcer</h2><pre id="gmail">…</pre><button onclick="act('gmail_check', 'gmail')">Check inbox</button></div>
    <div class="card"><h2>Resource monitor</h2><pre id="resource">…</pre><button onclick="act('system_stats', 'resource')">Refresh stats</button></div>
    <div class="card"><h2>Widget bundle</h2><pre id="bundle">…</pre><button onclick="loadBundle()">Export widgets</button></div>
  </div>
<script>
async function act(action, target) {
  const res = await fetch('/api/' + action, { method: 'POST' })
  document.getElementById(target).textContent = JSON.stringify(await res.json(), null, 2)
}
async function loadBundle() {
  const res = await fetch('/api/widgets_export')
  document.getElementById('bundle').textContent = await res.text()
}
async function boot() {
  const res = await fetch('/api/overview')
  const data = await res.json()
  document.getElementById('crypto').textContent = JSON.stringify(data.crypto, null, 2)
  document.getElementById('gmail').textContent = JSON.stringify(data.gmail, null, 2)
  document.getElementById('resource').textContent = JSON.stringify(data.resource, null, 2)
  loadBundle()
}
boot()
</script>
</body>
</html>`

function send(res: import('node:http').ServerResponse, status: number, body: string, type = 'application/json'): void {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' })
  res.end(body)
}

export function startPanel(services: Services): Promise<number> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    void (async () => {
      try {
        if (req.method === 'GET' && url.pathname === '/') {
          send(res, 200, PAGE, 'text/html')
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/overview') {
          send(res, 200, JSON.stringify({
            crypto: services.crypto,
            gmail: services.gmail,
            resource: await services.resourceStats()
          }))
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/crypto_refresh') {
          send(res, 200, JSON.stringify(await services.cryptoRefresh()))
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/gmail_check') {
          send(res, 200, JSON.stringify(await services.gmailCheck()))
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/system_stats') {
          send(res, 200, JSON.stringify(await services.resourceStats()))
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/widgets_export') {
          send(res, 200, await services.exportWidgets(), 'application/json')
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/widgets_import') {
          const raw = await new Promise<string>((resolve, reject) => {
            let body = ''
            req.on('data', (chunk) => (body += chunk))
            req.on('end', () => resolve(body))
            req.on('error', reject)
          })
          send(res, 200, JSON.stringify(await services.importWidgets(JSON.parse(raw))))
          return
        }
        send(res, 404, JSON.stringify({ error: 'Not found' }))
      } catch (cause) {
        send(res, 500, JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) }))
      }
    })()
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(PANEL_PORT, '127.0.0.1', () => resolve(PANEL_PORT))
  })
}
