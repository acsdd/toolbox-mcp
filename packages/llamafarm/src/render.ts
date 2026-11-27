/**
 * Terminal rendering helpers in the vrm AIO house style: monospaced, dark,
 * one accent green for the good news and muted amber/red for the warnings.
 */

export interface Palette {
  accent: string
  bold: string
  dim: string
  green: string
  yellow: string
  red: string
  reset: string
}

const NO_COLOR: Palette = {
  accent: '',
  bold: '',
  dim: '',
  green: '',
  yellow: '',
  red: '',
  reset: ''
}

const COLOR: Palette = {
  accent: '\u001b[38;5;155m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  green: '\u001b[38;5;114m',
  yellow: '\u001b[38;5;179m',
  red: '\u001b[38;5;167m',
  reset: '\u001b[0m'
}

export function createPalette(enabled: boolean): Palette {
  return enabled ? COLOR : NO_COLOR
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** Human readable byte size, e.g. '6.25 GB'. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const decimals = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(decimals)} ${UNITS[unit]}`
}

/** Compact count, e.g. '1.2M'. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '-'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

/** Section title with an accent rule underneath. */
export function sectionTitle(title: string, palette: Palette): string {
  const rule = '─'.repeat(Math.max(title.length, 24))
  return `${palette.accent}${palette.bold}${title}${palette.reset}\n${palette.dim}${rule}${palette.reset}`
}

/** Shorten a label so columns stay aligned. */
export function truncate(text: string, width: number): string {
  if (text.length <= width) return text
  return `${text.slice(0, Math.max(1, width - 1))}…`
}

/** Remove the colour codes — handy when asserting on rendered output. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

/** Render a padded table; the last column is never padded. */
export function renderTable(headers: string[], rows: string[][], palette: Palette): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length))
  )
  const line = (cells: string[]): string =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
      .join('  ')
      .trimEnd()

  const head = `${palette.dim}${line(headers)}${palette.reset}`
  const body = rows.map((row) => line(row))
  return [head, ...body].join('\n')
}

/** Verdict marker: filled for green, half for yellow, hollow for red. */
export function verdictMark(verdict: 'green' | 'yellow' | 'red', palette: Palette): string {
  if (verdict === 'green') return `${palette.green}●${palette.reset}`
  if (verdict === 'yellow') return `${palette.yellow}◐${palette.reset}`
  return `${palette.red}○${palette.reset}`
}

/** Label a value for a key/value block. */
export function label(text: string, palette: Palette): string {
  return `${palette.dim}${text}${palette.reset}`
}
