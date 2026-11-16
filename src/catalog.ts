/**
 * The MCP tool surface, in one place.
 *
 * The server registers these tools with the MCP SDK and the ops panel renders
 * the same list, so what an agent sees and what the panel shows can never
 * drift apart. Only the metadata lives here — the handlers stay with the
 * services that back them.
 */
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

export type ToolGroupId =
  | 'crypto'
  | 'gmail'
  | 'system'
  | 'llamafarm'
  | 'runtimes'
  | 'gateway'
  | 'marketplace'
  | 'remote'
  | 'widgets'

export interface ToolGroupMeta {
  id: ToolGroupId
  label: string
  icon: string
  hint: string
}

export const TOOL_GROUPS: ToolGroupMeta[] = [
  { id: 'crypto', label: 'Crypto watch', icon: '◈', hint: 'CoinGecko watchlist and price history' },
  { id: 'gmail', label: 'Gmail announcer', icon: '✉', hint: 'Read-only inbox checks over IMAP' },
  { id: 'system', label: 'Resource monitor', icon: '▤', hint: 'CPU, memory, disk and processes' },
  { id: 'llamafarm', label: 'Model Farm', icon: '⌁', hint: 'Local model catalog, fit scoring and Ollama installs' },
  { id: 'runtimes', label: 'Local runtimes', icon: '⌸', hint: 'Find, install and use Ollama, LM Studio, llama.cpp and friends' },
  { id: 'gateway', label: 'AstrLink gateway', icon: '⇄', hint: 'Read-only gateway observability' },
  { id: 'marketplace', label: 'Marketplace', icon: '▦', hint: 'Shared Toolbox modules from the public registry' },
  { id: 'remote', label: 'Remote servers', icon: '⇢', hint: 'Connected remote MCP servers' },
  { id: 'widgets', label: 'Widget bundles', icon: '⬓', hint: 'Portable widget setup, exported and imported' }
]

export interface ToolSpec {
  name: string
  group: ToolGroupId
  description: string
  shape: z.ZodRawShape
}

export const TOOL_CATALOG: ToolSpec[] = [
  // --- crypto-watch ---------------------------------------------------------
  {
    name: 'crypto_status',
    group: 'crypto',
    description: 'Current crypto watch state: watchlist, cached prices and last refresh.',
    shape: {}
  },
  {
    name: 'crypto_refresh',
    group: 'crypto',
    description: 'Refresh coin prices from CoinGecko for the configured watchlist.',
    shape: {}
  },
  {
    name: 'crypto_set_watchlist',
    group: 'crypto',
    description: 'Replace the crypto watchlist (1-8 CoinGecko coin ids).',
    shape: { watchlist: z.array(z.string()).min(1).describe('CoinGecko coin ids, e.g. ["bitcoin"]') }
  },
  {
    name: 'crypto_series',
    group: 'crypto',
    description: 'Price history for one coin (range 30, 90 or 180 days).',
    shape: {
      id: z.string().describe('CoinGecko coin id, e.g. bitcoin'),
      days: z.union([z.literal(30), z.literal(90), z.literal(180)]).describe('History window in days: 30, 90 or 180')
    }
  },

  // --- gmail-announcer ------------------------------------------------------
  {
    name: 'gmail_status',
    group: 'gmail',
    description: 'Gmail announcer state: connected account, unread count, recent messages.',
    shape: {}
  },
  {
    name: 'gmail_check',
    group: 'gmail',
    description: 'Run a read-only IMAP check of the Gmail inbox now.',
    shape: {}
  },
  {
    name: 'gmail_connect',
    group: 'gmail',
    description: 'Connect a Gmail account with a 16-character App Password (read-only IMAP).',
    shape: {
      email: z.string().describe('Gmail address'),
      password: z.string().describe('16-character App Password from myaccount.google.com/apppasswords')
    }
  },
  {
    name: 'gmail_disconnect',
    group: 'gmail',
    description: 'Remove the stored Gmail account and App Password from this machine.',
    shape: {}
  },

  // --- resource-monitor -----------------------------------------------------
  {
    name: 'system_stats',
    group: 'system',
    description: 'CPU, memory and disk usage of the machine running toolbox-mcp.',
    shape: {}
  },
  {
    name: 'system_processes',
    group: 'system',
    description: 'Top processes by memory (Windows only; empty elsewhere).',
    shape: {}
  },

  // --- llamafarm: local model catalog ---------------------------------------
  {
    name: 'llamafarm_status',
    group: 'llamafarm',
    description: 'Machine profile for running local models (RAM, cores, GPUs, Ollama) plus a 0-100 PC scorecard grade.',
    shape: { redetect: z.boolean().optional().describe('Force a fresh detection pass') }
  },
  {
    name: 'llamafarm_catalog',
    group: 'llamafarm',
    description: 'HuggingFace model catalog (top per task) with real file sizes; cached 6h. GGUF repos only — the ones Ollama can actually pull.',
    shape: { refresh: z.boolean().optional().describe('Ignore the cache and refetch') }
  },
  {
    name: 'llamafarm_score',
    group: 'llamafarm',
    description: 'Score catalog models green/yellow/red against this machine for a scenario.',
    shape: {
      scenario: z.enum(['now', 'total']).describe("'now' = resources free right now, 'total' = full machine"),
      search: z.string().optional().describe('Filter by repo id or name (substring)'),
      minParams: z.number().optional().describe('Minimum parameter count in billions'),
      maxParams: z.number().optional().describe('Maximum parameter count in billions'),
      onlyReachable: z.boolean().optional().describe('Suppress red models that have no offload path (wave 3 default)')
    }
  },
  {
    name: 'llamafarm_refresh',
    group: 'llamafarm',
    description: 'Re-detect the machine and force a full catalog refetch from HuggingFace.',
    shape: {}
  },
  {
    name: 'llamafarm_grade',
    group: 'llamafarm',
    description: 'Rate this PC 0-100, and grade one model against it (weakest-link weighted) when a repo is given.',
    shape: {
      repo: z.string().optional().describe('HuggingFace repo id to grade; omit to rate the PC alone'),
      scenario: z.enum(['now', 'total']).optional().describe("'now' = free resources (default), 'total' = full machine")
    }
  },
  {
    name: 'llamafarm_install',
    group: 'llamafarm',
    description: 'Install a catalog model into the active local runtime. Ollama pulls the GGUF from the Hub; other runtimes get the weights downloaded into their own models folder.',
    shape: {
      repo: z.string().describe('HuggingFace repo id, e.g. "bartowski/Llama-3.2-3B-Instruct-GGUF"'),
      quant: z.string().optional().describe('Quantization tag, e.g. "Q4_K_M" (defaults to the catalog entry)'),
      offload: z.number().optional().describe('Layers to keep on the GPU; writes a Modelfile instead of a plain pull'),
      runtime: z.string().optional().describe('Runtime id to install into; defaults to the active one')
    }
  },
  {
    name: 'llamafarm_search',
    group: 'llamafarm',
    description: 'Search HuggingFace live beyond the cached catalog and grade the hits against this machine. Blank query returns nothing without a network call.',
    shape: {
      query: z.string().describe('Search text, e.g. "qwen coder"'),
      scenario: z.enum(['now', 'total']).optional().describe("'now' = free resources (default), 'total' = full machine")
    }
  },
  {
    name: 'llamafarm_quants',
    group: 'llamafarm',
    description: 'List every GGUF quantization a repo offers, with real file sizes, smallest first — so you can pick a quant instead of the catalog default.',
    shape: { repo: z.string().describe('HuggingFace repo id, e.g. "bartowski/Llama-3.2-3B-Instruct-GGUF"') }
  },
  {
    name: 'llamafarm_remove',
    group: 'llamafarm',
    description: 'Remove a locally installed Ollama model by repo id or local name. Unknown names report not-found without touching the runtime.',
    shape: {
      repo: z.string().optional().describe('HuggingFace repo id of an installed model'),
      model: z.string().optional().describe('Local Ollama model name, e.g. "qwen2.5-coder-7b-instruct"')
    }
  },
  {
    name: 'llamafarm_run_now',
    group: 'llamafarm',
    description: 'Pick the best green (comfortable) model per task for this machine right now — a shortlist of what will actually run well.',
    shape: {}
  },
  {
    name: 'llamafarm_progress',
    group: 'llamafarm',
    description: 'Report tracked folder downloads: status, percent, bytes received/total and the resulting file, newest last.',
    shape: {}
  },

  // --- local runtimes --------------------------------------------------------
  {
    name: 'runtimes_detect',
    group: 'runtimes',
    description: 'Find the local model runtimes on this machine: Ollama, LM Studio, llama.cpp, Jan, GPT4All, KoboldCpp, LocalAI, vLLM, llamafile and text-generation-webui — each one that is installed, running and serving models.',
    shape: { refresh: z.boolean().optional().describe('Ignore the cache and probe again') }
  },
  {
    name: 'runtimes_install',
    group: 'runtimes',
    description: 'Install or update a local runtime from its official installer. Ollama is downloaded from ollama.com and installed silently, so the machine ends up with a fresh version.',
    shape: { id: z.string().optional().describe('Runtime id to install; defaults to "ollama"') }
  },
  {
    name: 'runtimes_use',
    group: 'runtimes',
    description: 'Choose which local runtime the Model Farm installs models into. Pass "none" to go back to the default (Ollama).',
    shape: { id: z.string().describe('Runtime id, e.g. "lmstudio" — or "none" to clear it') }
  },
  {
    name: 'runtimes_models',
    group: 'runtimes',
    description: 'List the models a local runtime is serving right now.',
    shape: { id: z.string().optional().describe('Runtime id; defaults to the active one') }
  },
  {
    name: 'runtimes_download',
    group: 'runtimes',
    description: 'Download a GGUF into a runtime\'s models folder without registering it with that runtime.',
    shape: {
      repo: z.string().describe('HuggingFace repo id, e.g. "bartowski/Llama-3.2-3B-Instruct-GGUF"'),
      quant: z.string().optional().describe('Quantization tag, e.g. "Q4_K_M"'),
      runtime: z.string().optional().describe('Runtime id; defaults to the active one')
    }
  },

  // --- astrlink gateway: read-only observability -----------------------------
  {
    name: 'gateway_status',
    group: 'gateway',
    description: 'Local AstrLink gateway health: providers and subscription state, routing posture, capture/privacy settings and the alerts that follow. Read-only metadata, cached 30s.',
    shape: { refresh: z.boolean().optional().describe('Ignore the cache and re-read the gateway') }
  },
  {
    name: 'gateway_requests',
    group: 'gateway',
    description: 'Recent AstrLink request records — model, provider, status, latency and token counts. Metadata only: no prompt or response bodies.',
    shape: {
      limit: z.number().optional().describe('1-200 records (default 25)'),
      status: z.string().optional().describe('Filter by status, e.g. "failed"'),
      serviceId: z.string().optional().describe('Filter by upstream service id from gateway_status')
    }
  },

  // --- marketplace ----------------------------------------------------------
  {
    name: 'marketplace_list',
    group: 'marketplace',
    description: 'Live marketplace listing of installable Toolbox modules (fetches the public registry, cached 5 min).',
    shape: {
      query: z.string().optional().describe('Live search across name, description, tags'),
      category: z.string().optional().describe('Exact category filter, e.g. "monitoring"'),
      refresh: z.boolean().optional().describe('Ignore the cache and refetch the registry')
    }
  },
  {
    name: 'marketplace_install',
    group: 'marketplace',
    description: 'Install a marketplace module by id. Widget bundles are applied through the portable bundle validator.',
    shape: { id: z.string().describe('Module id from marketplace_list') }
  },
  {
    name: 'marketplace_uninstall',
    group: 'marketplace',
    description: 'Uninstall a marketplace module (settings are kept; built-ins cannot be removed).',
    shape: { id: z.string().describe('Module id from marketplace_list') }
  },
  {
    name: 'remote_status',
    group: 'remote',
    description: 'Connected remote MCP servers and how many tools each provides.',
    shape: {}
  },

  // --- portable widgets -----------------------------------------------------
  {
    name: 'widgets_export',
    group: 'widgets',
    description: 'Export the widget setup as a portable Toolbox bundle (JSON).',
    shape: {}
  },
  {
    name: 'widgets_import',
    group: 'widgets',
    description: 'Import a portable Toolbox widget bundle (object or JSON text).',
    shape: { bundle: z.unknown().describe('Bundle object or JSON string from widgets_export') }
  }
]

export interface ToolParam {
  name: string
  type: string
  required: boolean
  description: string
}

export interface CatalogTool extends ToolParam {
  tool: string
}

/** One entry per tool, with the parameters an MCP client would send. */
export interface CatalogEntry {
  name: string
  group: ToolGroupId
  description: string
  params: ToolParam[]
}

/** The parameter list of a tool, derived from the very schema the server uses. */
export function toolParams(spec: ToolSpec): ToolParam[] {
  const schema = zodToJsonSchema(z.object(spec.shape)) as {
    properties?: Record<string, { type?: string; enum?: unknown[]; description?: string }>
    required?: string[]
  }
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties ?? {}).map(([name, property]) => ({
    name,
    type: property.enum ? 'enum' : (property.type ?? 'any'),
    required: required.has(name),
    description: property.description ?? ''
  }))
}

/** The whole catalog, ready for the panel. */
export function catalogEntries(): CatalogEntry[] {
  return TOOL_CATALOG.map((spec) => ({
    name: spec.name,
    group: spec.group,
    description: spec.description,
    params: toolParams(spec)
  }))
}
