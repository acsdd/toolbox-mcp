/**
 * `llamafarm catalog` — the live HuggingFace catalog with real file sizes.
 */
import { MODEL_TASKS, type ModelTask } from '@toolbox/widgets'
import { flagList, flagNumber, flagString, flagBool } from '../args.js'
import { formatBytes, formatCount, label, renderTable, sectionTitle } from '../render.js'
import { loadCatalog, type CommandContext } from '../context.js'

export function parseTasks(value: string | undefined): ModelTask[] | undefined {
  if (!value) return undefined
  const known = MODEL_TASKS.map((entry) => entry.task)
  const tasks = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  const invalid = tasks.filter((task) => !known.includes(task as ModelTask))
  if (invalid.length > 0) {
    throw new Error(`Unknown task "${invalid[0]}". Known: ${known.join(', ')}.`)
  }
  return tasks as ModelTask[]
}

export async function catalogCommand(ctx: CommandContext): Promise<number> {
  const tasks = parseTasks(flagString(ctx.args.flags, 'task'))
  const perTask = flagNumber(ctx.args.flags, 'per-task')
  const refresh = flagBool(ctx.args.flags, 'refresh') === true
  const formats = flagList(ctx.args.flags, 'formats')

  const { models, fromCache } = await loadCatalog(ctx, {
    ...(tasks ? { tasks } : {}),
    ...(perTask ? { perTask } : {}),
    refresh
  })

  if (ctx.json) {
    ctx.write(`${JSON.stringify({ fromCache, count: models.length, models }, null, 2)}\n`)
    return 0
  }

  const palette = ctx.palette
  const rows = models.map((model) => [
    model.label,
    formatBytes(model.runtimeRamBytes),
    model.paramsBillions ? `${model.paramsBillions}B` : '-',
    model.quantLabel ?? '-',
    model.formats.join('/'),
    model.license ?? '-',
    formatCount(model.downloads)
  ])

  const lines = [sectionTitle('CATALOG', palette), '']
  lines.push(
    `${label(`${models.length} models`, palette)} ${palette.dim}${fromCache ? '(cached)' : '(live from huggingface.co)'}${palette.reset}`
  )
  lines.push('')
  lines.push(renderTable(['MODEL', 'RUNTIME', 'PARAMS', 'QUANT', 'FORMAT', 'LICENSE', 'DL'], rows, palette))
  ctx.write(`${lines.join('\n')}\n`)
  return 0
}
