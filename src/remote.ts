/**
 * Remote MCP server connections for marketplace remote-server modules.
 * toolbox-mcp connects as an MCP client over streamable HTTP, lists the
 * remote tools and proxies calls through namespaced local tools.
 * The connection factory is injectable so tests never touch the network.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'

export interface RemoteToolDef {
  name: string
  description?: string
  inputSchema?: unknown
}

export interface RemoteConnection {
  listTools(): Promise<RemoteToolDef[]>
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>
  close(): Promise<void>
}

export type RemoteConnect = (endpoint: string) => Promise<RemoteConnection>

/** A tool exposed locally on behalf of a remote server. */
export interface ProxiedTool {
  /** Namespaced local name, e.g. 'cve_now_list_feed'. */
  name: string
  description: string
  inputSchema: unknown
  call: (args: Record<string, unknown>) => Promise<unknown>
}

export function proxiedToolName(moduleId: string, toolName: string): string {
  return `${moduleId.replace(/[^a-z0-9]/gi, '_')}_${toolName}`
}

/** Default factory: a real MCP client over streamable HTTP. */
export const connectRemote: RemoteConnect = async (endpoint) => {
  const client = new Client({ name: 'toolbox-mcp', version: '0.5.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)))
  return {
    listTools: async () => {
      const tools: RemoteToolDef[] = []
      let cursor: string | undefined
      do {
        const page = await client.listTools(cursor ? { cursor } : {})
        for (const tool of page.tools) {
          tools.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })
        }
        cursor = page.nextCursor
      } while (cursor)
      return tools
    },
    callTool: (name, args) => client.callTool({ name, arguments: args }),
    close: () => client.close()
  }
}

/**
 * Best-effort JSON Schema -> zod shape conversion for proxy registration.
 * Covers the flat primitive schemas MCP tools overwhelmingly use; anything
 * exotic degrades to z.unknown() rather than breaking the tool.
 */
export function jsonSchemaToZodShape(schema: unknown): z.ZodRawShape {
  const doc = schema as { properties?: Record<string, unknown>; required?: unknown } | null
  if (!doc?.properties || typeof doc.properties !== 'object') return {}
  const required = new Set(Array.isArray(doc.required) ? doc.required : [])
  const shape: z.ZodRawShape = {}
  for (const [key, raw] of Object.entries(doc.properties)) {
    const def = raw as { type?: unknown; description?: unknown; enum?: unknown }
    let field: z.ZodTypeAny
    if (Array.isArray(def.enum) && def.enum.length > 0 && def.enum.every((v) => typeof v === 'string')) {
      field = z.enum(def.enum as [string, ...string[]])
    } else {
      switch (def.type) {
        case 'string':
          field = z.string()
          break
        case 'number':
        case 'integer':
          field = z.number()
          break
        case 'boolean':
          field = z.boolean()
          break
        case 'array':
          field = z.array(z.unknown())
          break
        case 'object':
          field = z.record(z.unknown())
          break
        default:
          field = z.unknown()
      }
    }
    if (typeof def.description === 'string') field = field.describe(def.description)
    shape[key] = required.has(key) ? field : field.optional()
  }
  return shape
}
