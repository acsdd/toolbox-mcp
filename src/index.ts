#!/usr/bin/env node
/**
 * toolbox-mcp: private local MCP server (stdio) exposing the shared Toolbox
 * widgets, plus a localhost ops panel on port 3851 (configurable).
 */
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { createServices } from './services.js'
import { startPanel } from './panel.js'
import { jsonSchemaToZodShape } from './remote.js'

const server = new McpServer({ name: 'toolbox-mcp', version: '0.4.0' })

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

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
})

// --- crypto-watch -----------------------------------------------------------

server.tool(
  'crypto_status',
  'Current crypto watch state: watchlist, cached prices and last refresh.',
  {},
  async () => json(services.crypto)
)

server.tool(
  'crypto_refresh',
  'Refresh coin prices from CoinGecko for the configured watchlist.',
  {},
  async () => json(await services.cryptoRefresh())
)

server.tool(
  'crypto_set_watchlist',
  'Replace the crypto watchlist (1-8 CoinGecko coin ids).',
  { watchlist: z.array(z.string()).min(1).describe('CoinGecko coin ids, e.g. ["bitcoin"]') },
  async ({ watchlist }) => json(await services.cryptoSetWatchlist(watchlist))
)

server.tool(
  'crypto_series',
  'Price history for one coin (range 30, 90 or 180 days).',
  {
    id: z.string().describe('CoinGecko coin id, e.g. bitcoin'),
    days: z.number().describe('30, 90 or 180')
  },
  async ({ id, days }) => json(await services.cryptoSeries(id, days))
)

// --- gmail-announcer --------------------------------------------------------

server.tool(
  'gmail_status',
  'Gmail announcer state: connected account, unread count, recent messages.',
  {},
  async () => json(services.gmail)
)

server.tool(
  'gmail_check',
  'Run a read-only IMAP check of the Gmail inbox now.',
  {},
  async () => json(await services.gmailCheck())
)

server.tool(
  'gmail_connect',
  'Connect a Gmail account with a 16-character App Password (read-only IMAP).',
  {
    email: z.string().describe('Gmail address'),
    password: z.string().describe('16-character App Password from myaccount.google.com/apppasswords')
  },
  async (input) => json(await services.gmailConnect(input))
)

server.tool(
  'gmail_disconnect',
  'Remove the stored Gmail account and App Password from this machine.',
  {},
  async () => json(await services.gmailDisconnect())
)

// --- resource-monitor -------------------------------------------------------

server.tool(
  'system_stats',
  'CPU, memory and disk usage of the machine running toolbox-mcp.',
  {},
  async () => json(await services.resourceStats())
)

server.tool(
  'system_processes',
  'Top processes by memory (Windows only; empty elsewhere).',
  {},
  async () => json(await services.resourceProcesses())
)

// --- llamafarm: local model catalog -----------------------------------------

server.tool(
  'llamafarm_status',
  'Machine profile for running local models: RAM, cores, GPUs, Ollama install.',
  { redetect: z.boolean().optional().describe('Force a fresh detection pass') },
  async ({ redetect }) => json(await services.llamafarmStatus(redetect ?? false))
)

server.tool(
  'llamafarm_catalog',
  'HuggingFace model catalog (top per task) with real file sizes; cached 6h. Wave 1 requests only formats the machine can run.',
  { refresh: z.boolean().optional().describe('Ignore the cache and refetch') },
  async ({ refresh }) => json(await services.llamafarmCatalog(refresh ?? false))
)

server.tool(
  'llamafarm_score',
  'Score catalog models green/yellow/red against this machine for a scenario.',
  {
    scenario: z.enum(['now', 'total']).describe("'now' = resources free right now, 'total' = full machine"),
    search: z.string().optional().describe('Filter by repo id or name (substring)'),
    minParams: z.number().optional().describe('Minimum parameter count in billions'),
    maxParams: z.number().optional().describe('Maximum parameter count in billions'),
    onlyReachable: z
      .boolean()
      .optional()
      .describe('Suppress red models that have no offload path (wave 3 default)')
  },
  async (input) => json(await services.llamafarmScore(input))
)

server.tool(
  'llamafarm_refresh',
  'Re-detect the machine and force a full catalog refetch from HuggingFace.',
  {},
  async () => json(await services.llamafarmRefresh())
)

// --- marketplace -------------------------------------------------------------

server.tool(
  'marketplace_list',
  'Live marketplace listing of installable Toolbox modules (fetches the public registry, cached 5 min).',
  {
    query: z.string().optional().describe('Live search across name, description, tags'),
    category: z.string().optional().describe('Exact category filter, e.g. "monitoring"'),
    refresh: z.boolean().optional().describe('Ignore the cache and refetch the registry')
  },
  async ({ query, category, refresh }) => json(await services.marketplaceList({ query, category }, refresh ?? false))
)

server.tool(
  'marketplace_install',
  'Install a marketplace module by id. Widget bundles are applied through the portable bundle validator.',
  { id: z.string().describe('Module id from marketplace_list') },
  async ({ id }) => json(await services.marketplaceInstall(id))
)

server.tool(
  'marketplace_uninstall',
  'Uninstall a marketplace module (settings are kept; built-ins cannot be removed).',
  { id: z.string().describe('Module id from marketplace_list') },
  async ({ id }) => json(await services.marketplaceUninstall(id))
)

server.tool(
  'remote_status',
  'Connected remote MCP servers and how many tools each provides.',
  {},
  async () => json(services.remoteStatus())
)

// --- portable widgets -------------------------------------------------------

server.tool(
  'widgets_export',
  'Export the widget setup as a portable Toolbox bundle (JSON).',
  {},
  async () => {
    const bundle = await services.exportWidgets()
    return { content: [{ type: 'text' as const, text: bundle }] }
  }
)

server.tool(
  'widgets_import',
  'Import a portable Toolbox widget bundle (object or JSON text).',
  { bundle: z.unknown().describe('Bundle object or JSON string from widgets_export') },
  async ({ bundle }) => {
    const value = typeof bundle === 'string' ? JSON.parse(bundle) : bundle
    return json(await services.importWidgets(value))
  }
)

await server.connect(new StdioServerTransport())

const panel = await startPanel(services)
console.error(`toolbox-mcp ready. Ops panel: http://127.0.0.1:${panel.port}/`)

const restored = await services.remoteRestore()
for (const entry of restored.connected) {
  console.error(`remote ${entry.id}: ${entry.tools} tools connected`)
}
for (const entry of restored.failed) {
  console.error(`remote ${entry.id}: reconnect failed — ${entry.error}`)
}
