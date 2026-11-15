/**
 * The single source of truth for the app version.
 *
 * package.json sits next to dist/ in a checkout and next to the app root in
 * the packaged portable build, so the same relative path resolves in both.
 * Reading it at runtime keeps the MCP handshake, the outgoing user agent and
 * the panel footer from drifting apart.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const FALLBACK_VERSION = '0.6.1'

let cached: string | null = null

export function appVersion(): string {
  if (cached) return cached
  try {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
    ) as { version?: unknown }
    cached = typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : FALLBACK_VERSION
  } catch {
    cached = FALLBACK_VERSION
  }
  return cached
}
