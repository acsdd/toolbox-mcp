/**
 * A small ring buffer of MCP tool calls.
 *
 * The panel shows what the server is actually doing, so the server reports
 * every call here. The recorder is optional: the desktop app runs the panel
 * without an MCP server attached, and then there is simply nothing to show.
 */

export interface ToolCall {
  tool: string
  at: number
  ok: boolean
  ms: number
  error: string | null
}

export interface ActivitySnapshot {
  attached: boolean
  calls: ToolCall[]
  total: number
  failed: number
  recent: number
  perTool: { tool: string; calls: number; failed: number; lastAt: number | null }[]
}

export interface Activity {
  /** Whether an MCP server is feeding this recorder. */
  attached: boolean
  record: (tool: string, ok: boolean, ms: number, error?: string | null) => void
  snapshot: () => ActivitySnapshot
}

const MAX_CALLS = 60
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f]', 'g')

function sanitizeError(error: string | null): string | null {
  if (error == null) return null
  const text = String(error)
    .replace(CONTROL_CHARS, ' ')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .trim()
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

export function createActivity(attached: boolean): Activity {
  const calls: ToolCall[] = []
  const counters = new Map<string, { calls: number; failed: number; lastAt: number | null }>()

  function record(tool: string, ok: boolean, ms: number, error: string | null = null): void {
    const call: ToolCall = { tool, at: Date.now(), ok, ms, error: sanitizeError(error) }
    calls.push(call)
    if (calls.length > MAX_CALLS) calls.shift()
    const counter = counters.get(tool) ?? { calls: 0, failed: 0, lastAt: null }
    counter.calls += 1
    if (!ok) counter.failed += 1
    counter.lastAt = Date.now()
    counters.set(tool, counter)
  }

  function snapshot(): ActivitySnapshot {
    const entries = [...counters.entries()].map(([tool, counter]) => ({ tool, ...counter }))
    return {
      attached,
      calls: [...calls].reverse(),
      total: entries.reduce((sum, entry) => sum + entry.calls, 0),
      failed: entries.reduce((sum, entry) => sum + entry.failed, 0),
      recent: calls.length,
      perTool: entries.sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool))
    }
  }

  return { attached, record, snapshot }
}
