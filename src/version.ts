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

/**
 * Only reachable when package.json cannot be read at all (a broken package).
 * It deliberately carries no release number, so a broken build never claims
 * to be a version it is not.
 */
const FALLBACK_VERSION = '0.0.0-unknown'

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
