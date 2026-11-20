/**
 * Remote MCP server connections for marketplace remote-server modules.
 * toolbox-mcp connects as an MCP client over streamable HTTP, lists the
 * remote tools and proxies calls through namespaced local tools.
 * The connection factory is injectable so tests never touch the network.
 */
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'

export interface RemoteToolDef {
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: ToolAnnotations
}

/** Preserve remote hints, defaulting unknown behavior conservatively. */
export function proxiedToolAnnotations(annotations?: ToolAnnotations): ToolAnnotations {
  return {
    readOnlyHint: annotations?.readOnlyHint ?? false,
    destructiveHint: annotations?.destructiveHint ?? true,
    idempotentHint: annotations?.idempotentHint ?? false,
    openWorldHint: true
  }
}

export interface RemoteConnection {
  listTools(): Promise<RemoteToolDef[]>
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>
  close(): Promise<void>
}

export type RemoteConnect = (endpoint: string) => Promise<RemoteConnection>

export interface RemoteTimeouts {
  connectMs: number
  listMs: number
  callMs: number
  closeMs: number
}

export const DEFAULT_REMOTE_TIMEOUTS: RemoteTimeouts = {
  connectMs: 15_000,
  listMs: 15_000,
  callMs: 120_000,
  closeMs: 1_000
}

export class RemoteTimeoutError extends Error {
  constructor(readonly operation: string, readonly timeoutMs: number) {
    super(`Remote ${operation} timed out after ${timeoutMs}ms.`)
    this.name = 'RemoteTimeoutError'
  }
}

export function withRemoteTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RemoteTimeoutError(label, timeoutMs)), timeoutMs)
  })
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** A tool exposed locally on behalf of a remote server. */
export interface ProxiedTool {
  /** Namespaced local name, e.g. 'cve_now_list_feed'. */
  name: string
  description: string
  inputSchema: unknown
  annotations?: ToolAnnotations
  call: (args: Record<string, unknown>) => Promise<unknown>
}

export function proxiedToolName(moduleId: string, toolName: string): string {
  return `${moduleId.replace(/[^a-z0-9]/gi, '_')}_${toolName}`
}

/**
 * Endpoint policy for remote marketplace modules. Registry data is not trusted:
 * an endpoint must be public HTTPS. Loopback, private, link-local, CGNAT,
 * multicast, documentation and other reserved addresses are refused, and every
 * DNS answer for the host is checked so a public name cannot point back into
 * the local machine or a private network.
 */
export class RemoteEndpointError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RemoteEndpointError'
  }
}

export interface ResolvedAddress {
  address: string
  family: number
}

export type HostResolver = (host: string) => Promise<ResolvedAddress[]>

// Two lists, because BlockList matches an IPv4 check against IPv6 rules as its
// IPv4-mapped form — one shared list would block every IPv4 address.
const blockedV4 = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata lives here)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4] // reserved, includes 255.255.255.255
] as const) {
  blockedV4.addSubnet(network, prefix, 'ipv4')
}
const blockedV6 = new BlockList()
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64
  ['::ffff:0:0', 96], // IPv4-mapped; refuse rather than unwrap
  ['100::', 64], // discard-only
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8] // multicast
] as const) {
  blockedV6.addSubnet(network, prefix, 'ipv6')
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !blockedV4.check(address, 'ipv4')
  if (family === 6) return !blockedV6.check(address, 'ipv6')
  return false
}

const defaultResolve: HostResolver = async (host) => lookup(host, { all: true, verbatim: true })

export interface RemoteEndpointPolicy {
  resolve?: HostResolver
}

/**
 * Validate and return the parsed endpoint. Throws RemoteEndpointError when the
 * endpoint is not public HTTPS; callers surface the message to the user.
 */
export async function assertRemoteEndpointAllowed(endpoint: string, policy: RemoteEndpointPolicy = {}): Promise<URL> {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new RemoteEndpointError(`"${endpoint}" is not a valid URL.`)
  }
  if (url.protocol !== 'https:') throw new RemoteEndpointError('Remote endpoints must use https://.')
  if (url.username || url.password) throw new RemoteEndpointError('Remote endpoints must not carry credentials in the URL.')
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host) throw new RemoteEndpointError('Remote endpoints must name a host.')
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new RemoteEndpointError(`"${host}" is this machine; remote endpoints must be public.`)
  }
  if (host.endsWith('.local') || host.endsWith('.internal') || host === 'home.arpa' || host.endsWith('.home.arpa')) {
    throw new RemoteEndpointError(`"${host}" is a local network name; remote endpoints must be public.`)
  }
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new RemoteEndpointError(`"${host}" is a private or reserved address.`)
    return url
  }
  let addresses: ResolvedAddress[]
  try {
    addresses = await (policy.resolve ?? defaultResolve)(host)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new RemoteEndpointError(`Could not resolve "${host}": ${reason}`)
  }
  if (!addresses.length) throw new RemoteEndpointError(`"${host}" did not resolve to any address.`)
  const blocked = addresses.find((entry) => !isPublicAddress(entry.address))
  if (blocked) {
    throw new RemoteEndpointError(`"${host}" resolves to ${blocked.address}, a private or reserved address; remote endpoints must be public.`)
  }
  return url
}

/** Default factory: a real MCP client over streamable HTTP, public HTTPS only. */
export const connectRemote: RemoteConnect = async (endpoint) => {
  const url = await assertRemoteEndpointAllowed(endpoint)
  const client = new Client({ name: 'toolbox-mcp', version: '0.5.0' })
  await client.connect(new StreamableHTTPClientTransport(url))
  return {
    listTools: async () => {
      const tools: RemoteToolDef[] = []
      let cursor: string | undefined
      do {
        const page = await client.listTools(cursor ? { cursor } : {})
        for (const tool of page.tools) {
          tools.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations })
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
  const shape: Record<string, z.ZodType> = {}
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
          field = z.record(z.string(), z.unknown())
          break
        default:
          field = z.unknown()
      }
    }
    if (typeof def.description === 'string') field = field.describe(def.description)
    shape[key] = required.has(key) ? field : field.optional()
  }
  return shape as z.ZodRawShape
}
