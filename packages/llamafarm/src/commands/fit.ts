/**
 * `llamafarm fit` — what runs on this machine.
 *
 * Two scenarios: 'total' (everything the hardware could hold) and 'now'
 * (what fits in the memory that is free right now, leaving 7% headroom so
 * the machine stays usable). Results are grouped per skill set — one block
 * per pipeline task — with the lightest model first inside each block.
 */
import { MODEL_TASKS, scoreModels, sortForDisplay, type FitScenario, type ScoredModel } from '@toolbox/widgets'
import { flagBool, flagNumber, flagString } from '../args.js'
import { formatBytes, label, sectionTitle, truncate, verdictMark } from '../render.js'
import { detect, loadCatalog, type CommandContext } from '../context.js'
import { parseTasks } from './catalog.js'

export function parseScenario(value: string | undefined): FitScenario {
  if (value === undefined || value === 'now') return 'now'
  if (value === 'total') return 'total'
  throw new Error(`Unknown scenario "${value}". Use "now" or "total".`)
}

/** Group scored models by skill set, keeping the display order inside groups. */
export function groupByTask(scored: ScoredModel[]): Array<{ task: string; label: string; icon: string; models: ScoredModel[] }> {
  const byTask = new Map<string, ScoredModel[]>()
  for (const model of scored) {
    const bucket = byTask.get(model.task) ?? []
    bucket.push(model)
    byTask.set(model.task, bucket)
  }
  return MODEL_TASKS.filter((info) => byTask.has(info.task)).map((info) => ({
    task: info.task,
    label: info.label,
    icon: info.icon,
    models: byTask.get(info.task) ?? []
  }))
}

export async function fitCommand(ctx: CommandContext): Promise<number> {
  const scenario = parseScenario(flagString(ctx.args.flags, 'scenario'))
  const tasks = parseTasks(flagString(ctx.args.flags, 'task'))
  const top = flagNumber(ctx.args.flags, 'top')
  const refresh = flagBool(ctx.args.flags, 'refresh') === true

  const [machine, { models, fromCache }] = await Promise.all([
    detect(ctx),
    loadCatalog(ctx, { ...(tasks ? { tasks } : {}), refresh })
  ])

  const scored = sortForDisplay(scoreModels({ models, machine, scenario }))
  const groups = groupByTask(scored)

  if (ctx.json) {
    ctx.write(
      `${JSON.stringify(
        {
          scenario,
          fromCache,
          machine: {
            cores: machine.cores,
            totalRamBytes: machine.totalRamBytes,
            availableRamBytes: machine.availableRamBytes,
            gpus: machine.gpus
          },
          groups: groups.map((group) => ({
            task: group.task,
            label: group.label,
            models: group.models.map((model) => ({
              id: model.id,
              label: model.label,
              verdict: model.verdict,
              fitsNow: model.fitsNow,
              fitsTotal: model.fitsTotal,
              reason: model.reason,
              runtimeRamBytes: model.runtimeRamBytes,
              quantLabel: model.quantLabel,
              license: model.license,
              hints: model.hints,
              grade: { score: model.grade.score, letter: model.grade.letter }
            }))
          }))
        },
        null,
        2
      )}\n`
    )
    return 0
  }

  const palette = ctx.palette
  const nowBudget = machine.availableRamBytes * 0.93
  const lines: string[] = []
  lines.push(
    sectionTitle(
      scenario === 'now' ? 'FITS RIGHT NOW' : 'FITS ON THIS MACHINE',
      palette
    )
  )
  lines.push('')
  lines.push(
    `  ${label('Budget', palette)}        ${formatBytes(scenario === 'now' ? nowBudget : machine.totalRamBytes)} ${
      scenario === 'now'
        ? palette.dim + '(93% of ' + formatBytes(machine.availableRamBytes) + ' free)' + palette.reset
        : palette.dim + '(total RAM)' + palette.reset
    }`
  )
  if (machine.gpus.length > 0) {
    lines.push(
      `  ${label('GPU', palette)}          ${machine.gpus.map((gpu) => `${gpu.name} · ${formatBytes(gpu.vramBytes)}`).join(', ')}`
    )
  }
  lines.push('')

  for (const group of groups) {
    const shown = top ? group.models.slice(0, top) : group.models
    lines.push(
      `${palette.accent}${palette.bold}${group.icon} ${group.label.toUpperCase()}${palette.reset} ${palette.dim}${group.models.length} models${palette.reset}`
    )
    for (const model of shown) {
      const params = model.paramsBillions ? `${model.paramsBillions}B` : '-'
      const grade = model.grade
      const gradeColor = grade.score >= 85 ? palette.green : grade.score >= 55 ? palette.yellow : palette.red
      lines.push(
        `  ${verdictMark(model.verdict, palette)} ${truncate(model.label, 38).padEnd(38)} ${formatBytes(model.runtimeRamBytes).padStart(10)}  ${palette.dim}${params.padStart(6)}  ${model.license ?? '-'}${palette.reset}  ${gradeColor}${grade.letter} ${grade.score}${palette.reset}`
      )
    }
    lines.push('')
  }

  lines.push(
    `${palette.dim}● runs now   ◐ free memory to run   ○ exceeds this machine   (${fromCache ? 'cached' : 'live'} catalog)${palette.reset}`
  )
  lines.push(
    `${palette.dim}right column: setup grade A+…F (0–100), weakest-link weighted${palette.reset}`
  )
  ctx.write(`${lines.join('\n')}\n`)
  return 0
}
