/**
 * Tiny argument parser: `llamafarm <command> [positional] [--flag value]`.
 * No dependencies — the CLI has to run anywhere Node does.
 */

export interface ParsedArgs {
  command: string
  positionals: string[]
  flags: Record<string, string | boolean>
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const body = arg.slice(2)
    const equals = body.indexOf('=')
    if (equals >= 0) {
      flags[body.slice(0, equals)] = body.slice(equals + 1)
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next
      index++
      continue
    }
    flags[body] = true
  }

  return { command: positionals.shift() ?? 'help', positionals, flags }
}

/** Read a flag as a string. */
export function flagString(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name]
  return typeof value === 'string' ? value : undefined
}

/** Read a flag as a number. */
export function flagNumber(flags: ParsedArgs['flags'], name: string): number | undefined {
  const value = flagString(flags, name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Read a flag as a boolean; `--no-color` style flags are false. */
export function flagBool(flags: ParsedArgs['flags'], name: string): boolean | undefined {
  const value = flags[name]
  if (value === undefined) return undefined
  if (typeof value === 'boolean') return value
  return value !== 'false' && value !== '0'
}

/** Read a comma separated flag as a list. */
export function flagList(flags: ParsedArgs['flags'], name: string): string[] | undefined {
  const value = flagString(flags, name)
  if (value === undefined) return undefined
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}
