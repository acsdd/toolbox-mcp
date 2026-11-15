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
  perTool: { tool: string; calls: number; failed: number; lastAt: number | null }[]
}

export interface Activity {
  /** Whether an MCP server is feeding this recorder. */
  attached: boolean
  record: (tool: string, ok: boolean, ms: number, error?: string | null) => void
  snapshot: () => ActivitySnapshot
}

const MAX_CALLS = 60

export function createActivity(attached: boolean): Activity {
  const calls: ToolCall[] = []
  const counters = new Map<string, { calls: number; failed: number; lastAt: number | null }>()

  function record(tool: string, ok: boolean, ms: number, error: string | null = null): void {
    const call: ToolCall = { tool, at: Date.now(), ok, ms, error }
    calls.push(call)
    if (calls.length > MAX_CALLS) calls.shift()
    const counter = counters.get(tool) ?? { calls: 0, failed: 0, lastAt: null }
    counter.calls += 1
    if (!ok) counter.failed += 1
    counter.lastAt = Date.now()
    counters.set(tool, counter)
  }

  function snapshot(): ActivitySnapshot {
    return {
      attached,
      calls: [...calls].reverse(),
      total: calls.length,
      failed: calls.filter((call) => !call.ok).length,
      perTool: [...counters.entries()]
        .map(([tool, counter]) => ({ tool, ...counter }))
        .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool))
    }
  }

  return { attached, record, snapshot }
}
