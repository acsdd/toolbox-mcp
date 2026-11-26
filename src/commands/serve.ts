/**
 * `llamafarm serve` — a small local JSON API so other tools (the ops panel,
 * a phone on the LAN, the NAS dashboard) can ask the same questions the CLI
 * answers. Binds to localhost unless another host is asked for.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer as createTlsServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { scoreModels, sortForDisplay, type FitScenario } from '@toolbox/widgets'
import { flagNumber, flagString } from '../args.js'
import { detect, loadCatalog, type CommandContext } from '../context.js'
import { parseScenario } from './fit.js'
import { parseTasks } from './catalog.js'

export interface ServeOptions {
  host?: string
  port?: number
  tlsCert?: string
  tlsKey?: string
  token?: string
}

export interface ServeHandle {
  port: number
  host: string
  token: string
  close: () => Promise<void>
}

function sendJson(response: { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }, status: number, payload: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(`${JSON.stringify(payload, null, 2)}\n`)
}

export async function startServer(ctx: CommandContext, options: ServeOptions = {}): Promise<ServeHandle> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 3854
  const token = options.token ?? randomBytes(32).toString('hex')
  if (options.token && options.token.length < 32) throw new Error('API token must be at least 32 characters.')
  const loopback = ['127.0.0.1','localhost','::1'].includes(host.toLowerCase())
  if (!loopback && (['0.0.0.0','::'].includes(host) || !options.token || token.length < 32 || !options.tlsCert || !options.tlsKey)) throw new Error('LAN access requires a specific host, TLS, and a token of at least 32 characters.')
  const scheme = options.tlsCert && options.tlsKey ? 'https' : 'http'
  let boundPort = port
  const allowedHosts = new Set(['localhost','127.0.0.1','[::1]', host.toLowerCase()])
  const calls = new Map<string,{start:number;count:number}>()
  let pendingDetection: ReturnType<typeof detect> | null = null
  const catalogs = new Map<string, ReturnType<typeof loadCatalog>>()
  const detectOnce = (): ReturnType<typeof detect> => {
    if (!pendingDetection) { const pending = detect(ctx); pendingDetection = pending; void pending.finally(() => { if (pendingDetection === pending) pendingDetection = null }).catch(() => {}) }
    return pendingDetection
  }
  const catalogOnce = (tasks: ReturnType<typeof parseTasks>): ReturnType<typeof loadCatalog> => {
    const key = tasks ? [...tasks].sort().join(',') : '*'
    let pending = catalogs.get(key)
    if (!pending) { pending = loadCatalog(ctx, tasks ? { tasks } : {}); catalogs.set(key, pending); const active = pending; void pending.finally(() => { if (catalogs.get(key) === active) catalogs.delete(key) }).catch(() => {}) }
    return pending
  }
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let target: URL
    try { target = new URL(scheme + '://' + request.headers.host) } catch { sendJson(response,403,{error:'Forbidden host'});return }
    const site=request.headers['sec-fetch-site'], origin=request.headers.origin
    if (!allowedHosts.has(target.hostname.toLowerCase()) || Number(target.port || (scheme === 'https' ? 443 : 80)) !== boundPort || (origin && origin !== target.origin) || (site && site !== 'same-origin' && site !== 'none')) { sendJson(response,403,{error:'Forbidden origin or host'});return }
    if (request.method !== 'GET') { sendJson(response,405,{error:'Method not allowed'});return }
    const supplied=request.headers.authorization?.replace(/^Bearer /,'') ?? ''
    const provided=Buffer.from(supplied),expected=Buffer.from(token)
    if (provided.length!==expected.length || !timingSafeEqual(provided,expected)) { sendJson(response,401,{error:'Access token required'});return }
    const remote=request.socket.remoteAddress || 'unknown', now=Date.now()
    const rate=calls.get(remote);if(!rate || now-rate.start>60_000)calls.set(remote,{start:now,count:1});else if(++rate.count>60){sendJson(response,429,{error:'Too many requests'});return}
    if(calls.size>1024)calls.clear()
    const url = new URL(request.url ?? '/', target.origin)
    const path = url.pathname

    try {
      if (path === '/healthz') {
        sendJson(response, 200, { ok: true })
        return
      }
      if (path === '/api/profile') {
        const machine = await detectOnce()
        sendJson(response, 200, machine)
        return
      }
      if (path === '/api/catalog') {
        const tasks = parseTasks(url.searchParams.get('task') ?? undefined)
        const { models, fromCache } = await catalogOnce(tasks)
        sendJson(response, 200, { fromCache, count: models.length, models })
        return
      }
      if (path === '/api/fit') {
        const scenario: FitScenario = parseScenario(url.searchParams.get('scenario') ?? undefined)
        const tasks = parseTasks(url.searchParams.get('task') ?? undefined)
        const [machine, { models }] = await Promise.all([detectOnce(), catalogOnce(tasks)])
        const scored = sortForDisplay(scoreModels({ models, machine, scenario }))
        sendJson(response, 200, { scenario, count: scored.length, models: scored })
        return
      }
      sendJson(response, 404, { error: 'Not found' })
    } catch (cause) {
      sendJson(response, 500, { error: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  let server: Server
  if (options.tlsCert && options.tlsKey) {
    server = createTlsServer(
      { cert: readFileSync(options.tlsCert), key: readFileSync(options.tlsKey) },
      (request, response) => {
        void handler(request, response)
      }
    )
  } else {
    server = createServer((request, response) => {
      void handler(request, response)
    })
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve())
  })

  const address = server.address()
  boundPort = typeof address === 'object' && address !== null ? address.port : port

  return {
    port: boundPort,
    host,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}

export async function serveCommand(ctx: CommandContext): Promise<number> {
  const host = flagString(ctx.args.flags, 'host') ?? '127.0.0.1'
  const port = flagNumber(ctx.args.flags, 'port') ?? 3854
  const tlsCert = flagString(ctx.args.flags, 'tls-cert')
  const tlsKey = flagString(ctx.args.flags, 'tls-key')
  const token = process.env.LLAMAFARM_API_TOKEN

  const handle = await startServer(ctx, {
    host,
    port,
    ...(tlsCert ? { tlsCert } : {}),
    ...(tlsKey ? { tlsKey } : {}),
    ...(token ? { token } : {})
  })
  const scheme = tlsCert && tlsKey ? 'https' : 'http'
  ctx.write(`LlamaFarm API on ${scheme}://${handle.host}:${handle.port}\n`)
  if (!token) ctx.write(`Local access token: ${handle.token}\n`)
  ctx.write(`  /api/profile  /api/catalog  /api/fit?scenario=now  /healthz\n`)
  return 0
}
