#!/usr/bin/env node
/**
 * toolbox-mcp: private local MCP server (stdio) exposing the shared Toolbox
 * widgets, plus a localhost ops panel on port 3851 (configurable).
 */
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { createServices } from './services.js'
import { startPanel } from './panel.js'
import { jsonSchemaToZodShape, proxiedToolAnnotations } from './remote.js'
import { appVersion } from './version.js'
import { TOOL_CATALOG } from './catalog.js'
import { createActivity } from './activity.js'

const server = new McpServer({ name: 'toolbox-mcp', version: appVersion() })

// Remote-server marketplace modules register their tools here at runtime.
const remoteRegistrations = new Map<string, RegisteredTool[]>()
const services = createServices({
  onRemoteTools: (moduleId, tools) => {
    remoteRegistrations.get(moduleId)?.forEach((tool) => tool.remove())
    remoteRegistrations.set(
      moduleId,
      tools.map((tool) =>
        server.tool(
          tool.name,
          tool.description,
          jsonSchemaToZodShape(tool.inputSchema),
          proxiedToolAnnotations(tool.annotations),
          async (args) => (await tool.call(args as Record<string, unknown>)) as CallToolResult
        )
      )
    )
  },
  onRemoteRemoved: (moduleId) => {
    remoteRegistrations.get(moduleId)?.forEach((tool) => tool.remove())
    remoteRegistrations.delete(moduleId)
  }
})
await services.init()

/**
 * Whether a tool payload describes a failure rather than data.
 *
 * Services report soft failures inside the payload (`ok: false`, or a
 * non-empty `error`), so the payload is wrapped with `isError` to keep a
 * client from reading an error message as if it were a result. Gateway
 * payloads carry an `availability` state instead — a stopped or missing
 * gateway is a state, not a tool failure — so those only count as a failure
 * when the observer itself broke.
 */
function isFailure(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.ok === false) return true
  const error = record.error
  if (typeof error !== 'string' || error === '') return false
  if (typeof record.availability === 'string') return record.availability === 'error'
  return true
}

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  isError: isFailure(value)
})

// --- tool handlers -----------------------------------------------------------
//
// The metadata lives in the shared catalog so the ops panel renders exactly
// what the server exposes; only the behaviour stays here.

type ToolArgs = Record<string, unknown>
type ToolHandler = (args: ToolArgs) => Promise<CallToolResult>

const handlers: Record<string, ToolHandler> = {
  // crypto-watch
  crypto_status: async () => json(services.crypto),
  crypto_refresh: async () => json(await services.cryptoRefresh()),
  crypto_set_watchlist: async (args) => json(await services.cryptoSetWatchlist(args.watchlist)),
  crypto_series: async (args) => json(await services.cryptoSeries(args.id, args.days)),

  // gmail-announcer
  gmail_status: async () => json(services.gmail),
  gmail_check: async () => json(await services.gmailCheck()),
  gmail_connect: async (args) => json(await services.gmailConnect(args)),
  gmail_disconnect: async () => json(await services.gmailDisconnect()),

  // resource-monitor
  system_stats: async () => json(await services.resourceStats()),
  system_processes: async () => json(await services.resourceProcesses()),

  // llamafarm: local model catalog
  llamafarm_status: async (args) => json(await services.llamafarmStatusReport(args.redetect === true)),
  llamafarm_catalog: async (args) => json(await services.llamafarmCatalog(args.refresh === true)),
  llamafarm_score: async (args) =>
    json(
      await services.llamafarmScore({
        scenario: args.scenario === 'total' ? 'total' : 'now',
        ...(typeof args.search === 'string' ? { search: args.search } : {}),
        minParams: typeof args.minParams === 'number' ? args.minParams : null,
        maxParams: typeof args.maxParams === 'number' ? args.maxParams : null,
        onlyReachable: args.onlyReachable === true
      })
    ),
  llamafarm_refresh: async () => json(await services.llamafarmRefresh()),
  llamafarm_grade: async (args) =>
    json(
      await services.llamafarmGrade({
        ...(typeof args.repo === 'string' ? { repo: args.repo } : {}),
        ...(args.scenario === 'total' || args.scenario === 'now' ? { scenario: args.scenario } : {})
      })
    ),
  llamafarm_install: async (args) =>
    json(
      await services.llamafarmInstall({
        repo: typeof args.repo === 'string' ? args.repo : '',
        ...(typeof args.quant === 'string' ? { quant: args.quant } : {}),
        ...(typeof args.offload === 'number' ? { offload: args.offload } : {}),
        ...(typeof args.runtime === 'string' ? { runtime: args.runtime } : {})
      })
    ),
  llamafarm_search: async (args) =>
    json(
      await services.llamafarmSearch({
        query: typeof args.query === 'string' ? args.query : '',
        ...(args.scenario === 'total' || args.scenario === 'now' ? { scenario: args.scenario } : {})
      })
    ),
  llamafarm_quants: async (args) =>
    json(await services.llamafarmQuants(typeof args.repo === 'string' ? args.repo : '')),
  llamafarm_remove: async (args) =>
    json(
      await services.llamafarmRemove({
        ...(typeof args.repo === 'string' ? { repo: args.repo } : {}),
        ...(typeof args.model === 'string' ? { model: args.model } : {}),
        ...(typeof args.runtime === 'string' ? { runtime: args.runtime } : {})
      })
    ),
  llamafarm_run_now: async () => json(await services.llamafarmRunNow()),
  llamafarm_progress: async () => json(await services.llamafarmProgress()),

  // local runtimes
  runtimes_detect: async (args) => json(await services.runtimesDetect(args.refresh === true)),
  runtimes_install: async (args) =>
    json(await services.runtimesInstall(typeof args.id === 'string' ? args.id : 'ollama')),
  runtimes_use: async (args) => json(await services.runtimesUse(typeof args.id === 'string' ? args.id : '')),
  runtimes_models: async (args) =>
    json(await services.runtimesModels(typeof args.id === 'string' ? args.id : undefined)),
  runtimes_download: async (args) =>
    json(
      await services.runtimesDownload({
        repo: typeof args.repo === 'string' ? args.repo : '',
        ...(typeof args.quant === 'string' ? { quant: args.quant } : {}),
        ...(typeof args.runtime === 'string' ? { runtime: args.runtime } : {})
      })
    ),

  // astrlink gateway: read-only observability
  gateway_status: async (args) => json(await services.gatewayStatus(args.refresh === true)),
  gateway_requests: async (args) =>
    json(
      await services.gatewayRequests({
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        ...(typeof args.status === 'string' ? { status: args.status } : {}),
        ...(typeof args.serviceId === 'string' ? { serviceId: args.serviceId } : {})
      })
    ),

  // marketplace
  marketplace_list: async (args) =>
    json(
      await services.marketplaceList(
        {
          ...(typeof args.query === 'string' ? { query: args.query } : {}),
          ...(typeof args.category === 'string' ? { category: args.category } : {})
        },
        args.refresh === true
      )
    ),
  marketplace_install: async (args) => json(await services.marketplaceInstall(args.id)),
  marketplace_uninstall: async (args) => json(await services.marketplaceUninstall(args.id)),
  remote_status: async () => json(services.remoteStatus()),

  // portable widgets
  widgets_export: async () => {
    const bundle = await services.exportWidgets()
    return { content: [{ type: 'text' as const, text: bundle }] }
  },
  widgets_import: async (args) => {
    const bundle = args.bundle
    const value = typeof bundle === 'string' ? JSON.parse(bundle) : bundle
    return json(await services.importWidgets(value))
  }
}

const activity = createActivity(true)

for (const spec of TOOL_CATALOG) {
  const handler = handlers[spec.name]
  if (!handler) throw new Error(`No handler for the ${spec.name} tool.`)
  server.tool(spec.name, spec.description, spec.shape, spec.annotations, async (args) => {
    const started = Date.now()
    try {
      const result = await handler((args ?? {}) as ToolArgs)
      activity.record(spec.name, result.isError !== true, Date.now() - started)
      return result
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      activity.record(spec.name, false, Date.now() - started, message)
      throw cause
    }
  })
}

await server.connect(new StdioServerTransport())

const panel = await startPanel(services, { activity })
console.error(`toolbox-mcp ready. Ops panel: http://127.0.0.1:${panel.port}/`)

const restored = await services.remoteRestore()
for (const entry of restored.connected) {
  console.error(`remote ${entry.id}: ${entry.tools} tools connected`)
}
for (const entry of restored.failed) {
  console.error(`remote ${entry.id}: reconnect failed — ${entry.error}`)
}
