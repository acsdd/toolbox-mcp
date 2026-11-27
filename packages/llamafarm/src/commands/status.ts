/**
 * `llamafarm status` — what this machine can run: CPU, RAM, GPU and the
 * local model runtimes.
 */
import { formatBytes, label, renderTable, sectionTitle } from '../render.js'
import { detect, type CommandContext } from '../context.js'
import { gradeMachine, type MachineGrade, type MachineProfile } from '@toolbox/widgets'

const NOW_THRESHOLD = 0.93

export interface StatusReport {
  platform: string
  node: string
  cores: number
  totalRamBytes: number
  availableRamBytes: number
  nowBudgetBytes: number
  gpus: Array<{ name: string; vramBytes: number }>
  ollama: {
    installed: boolean
    url: string
    error: string | null
    models: Array<{ name: string; sizeBytes: number }>
  }
  /** The PC rated 0-100 on the same axes the models are graded against. */
  grade: MachineGrade
}

export function buildReport(machine: MachineProfile, platform: string, node: string): StatusReport {
  return {
    platform,
    node,
    cores: machine.cores,
    totalRamBytes: machine.totalRamBytes,
    availableRamBytes: machine.availableRamBytes,
    nowBudgetBytes: Math.round(machine.availableRamBytes * NOW_THRESHOLD),
    gpus: machine.gpus.map((gpu) => ({ name: gpu.name, vramBytes: gpu.vramBytes })),
    ollama: {
      installed: machine.ollama.installed,
      url: machine.ollama.url,
      error: machine.ollama.error,
      models: machine.ollama.models.map((model) => ({ name: model.name, sizeBytes: model.sizeBytes }))
    },
    grade: gradeMachine(machine, 'now')
  }
}

export async function statusCommand(ctx: CommandContext): Promise<number> {
  const machine = await detect(ctx)
  const report = buildReport(machine, process.platform, process.version)

  if (ctx.json) {
    ctx.write(`${JSON.stringify(report, null, 2)}\n`)
    return 0
  }

  const palette = ctx.palette
  const lines: string[] = [sectionTitle('MACHINE', palette), '']
  lines.push(`  ${label('Platform', palette)}        ${report.platform} · Node ${report.node}`)
  lines.push(`  ${label('CPU cores', palette)}        ${report.cores}`)
  lines.push(`  ${label('RAM total', palette)}        ${formatBytes(report.totalRamBytes)}`)
  lines.push(`  ${label('RAM available', palette)}    ${formatBytes(report.availableRamBytes)}`)
  lines.push(
    `  ${label('Now budget', palette)}        ${formatBytes(report.nowBudgetBytes)} ${palette.dim}(93% of available)${palette.reset}`
  )
  if (report.gpus.length === 0) {
    lines.push(`  ${label('GPU', palette)}              ${palette.dim}none detected${palette.reset}`)
  } else {
    for (const gpu of report.gpus) {
      lines.push(`  ${label('GPU', palette)}              ${gpu.name} · ${formatBytes(gpu.vramBytes)} VRAM`)
    }
  }
  if (report.ollama.installed) {
    lines.push(`  ${label('Ollama', palette)}           ${palette.green}running${palette.reset} ${palette.dim}${report.ollama.url}${palette.reset}`)
    lines.push(`  ${label('Local models', palette)}     ${report.ollama.models.length}`)
    for (const model of report.ollama.models) {
      lines.push(`    ${palette.dim}·${palette.reset} ${model.name} ${palette.dim}${formatBytes(model.sizeBytes)}${palette.reset}`)
    }
  } else {
    lines.push(
      `  ${label('Ollama', palette)}           ${palette.yellow}not running${palette.reset} ${palette.dim}${report.ollama.url}${palette.reset}`
    )
  }

  const grade = report.grade
  lines.push('', sectionTitle('PC SCORECARD', palette), '')
  lines.push(
    `  ${label('Overall', palette)}        ${grade.score}/100 · ${grade.label} ${palette.dim}(right now)${palette.reset}`
  )
  const rows = grade.axes.map((axis) => [
    axis.label,
    axis.score === null ? '—' : String(axis.score),
    axis.detail
  ])
  const table = renderTable(['AXIS', 'SCORE', 'DETAIL'], rows, palette)
  lines.push(table.split('\n').map((line) => `  ${line}`).join('\n'))

  ctx.write(`${lines.join('\n')}\n`)
  return 0
}
