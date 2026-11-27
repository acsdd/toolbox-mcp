/**
 * `llamafarm explain <repo>` — everything about one model: its real size,
 * whether it fits here, and the exact commands to run it.
 */
import {
  fetchModelById,
  planOllamaInstall,
  scoreModels,
  type CatalogModel
} from '@toolbox/widgets'
import { flagString } from '../args.js'
import { formatBytes, label, renderTable, sectionTitle, verdictMark } from '../render.js'
import { detect, type CommandContext } from '../context.js'

export async function resolveModel(ctx: CommandContext, repoId: string): Promise<CatalogModel | null> {
  const fetcher = ctx.deps.fetchModel ?? fetchModelById
  return fetcher(repoId, {})
}

export async function explainCommand(ctx: CommandContext): Promise<number> {
  const repoId = ctx.args.positionals[0]
  if (!repoId) {
    ctx.write('Usage: llamafarm explain <owner/repo> [--quant Q4_K_M]\n')
    return 2
  }
  const quant = flagString(ctx.args.flags, 'quant')

  let model: CatalogModel | null
  try {
    model = await resolveModel(ctx, repoId)
  } catch (cause) {
    ctx.write(`Could not read ${repoId}: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    return 1
  }
  if (!model) {
    ctx.write(`No GGUF or safetensors weights found for ${repoId}.\n`)
    return 1
  }

  const machine = await detect(ctx)
  const now = scoreModels({ models: [model], machine, scenario: 'now' })[0]
  const total = scoreModels({ models: [model], machine, scenario: 'total' })[0]

  let plan: ReturnType<typeof planOllamaInstall> | null = null
  let planError: string | null = null
  try {
    plan = planOllamaInstall(model, quant ?? model.quantLabel)
  } catch (cause) {
    planError = cause instanceof Error ? cause.message : String(cause)
  }

  if (ctx.json) {
    ctx.write(
      `${JSON.stringify(
        {
          model,
          now: { verdict: now?.verdict, reason: now?.reason, hints: now?.hints },
          total: { verdict: total?.verdict, reason: total?.reason },
          grade: now?.grade ?? null,
          plan
        },
        null,
        2
      )}\n`
    )
    return 0
  }

  const palette = ctx.palette
  const lines: string[] = [sectionTitle('MODEL', palette), '']
  lines.push(`  ${label('Name', palette)}           ${model.label}`)
  lines.push(`  ${label('Repo', palette)}           ${model.id}`)
  lines.push(`  ${label('Skill set', palette)}       ${model.task}`)
  lines.push(`  ${label('Parameters', palette)}      ${model.paramsBillions ? `${model.paramsBillions}B` : '-'}`)
  lines.push(`  ${label('Quant', palette)}           ${model.quantLabel ?? '-'}`)
  lines.push(`  ${label('Weights', palette)}         ${formatBytes(model.fileBytes ?? 0)}`)
  lines.push(`  ${label('Runtime RAM', palette)}     ${formatBytes(model.runtimeRamBytes)} ${palette.dim}(weights + 25% overhead)${palette.reset}`)
  lines.push(`  ${label('License', palette)}         ${model.license ?? '-'}`)
  lines.push(`  ${label('Downloads', palette)}       ${model.downloads}`)
  lines.push('')

  lines.push(sectionTitle('FIT', palette))
  lines.push('')
  lines.push(`  ${verdictMark(now?.verdict ?? 'red', palette)} ${label('now', palette)}            ${now?.reason ?? '-'}`)
  lines.push(`  ${verdictMark(total?.verdict ?? 'red', palette)} ${label('total', palette)}          ${total?.reason ?? '-'}`)
  for (const hint of now?.hints ?? []) {
    lines.push(`    ${palette.dim}→${palette.reset} ${hint}`)
  }
  lines.push('')

  const grade = now?.grade
  if (grade) {
    lines.push(sectionTitle('SCORECARD', palette))
    lines.push('')
    lines.push(
      `  ${label('Setup', palette)}          ${grade.score}/100 · ${grade.letter} · ${grade.label} ${palette.dim}(now)${palette.reset}`
    )
    const rows = grade.axes.map((axis) => [
      axis.label,
      axis.score === null ? '—' : String(axis.score),
      String(axis.model),
      axis.headroom === null ? '—' : `${axis.headroom > 0 ? '+' : ''}${axis.headroom}`,
      axis.fit === null ? '—' : String(axis.fit)
    ])
    const table = renderTable(['AXIS', 'PC', 'MODEL', 'HEADROOM', 'FIT'], rows, palette)
    lines.push(table.split('\n').map((line) => `  ${line}`).join('\n'))
    lines.push('')
    lines.push(`  ${grade.bottleneck.message}`)
    lines.push(`  ${palette.dim}${grade.bottleneck.advice}${palette.reset}`)
    lines.push('')
  }

  lines.push(sectionTitle('RUN', palette))
  lines.push('')
  if (plan) {
    lines.push(`  ${palette.accent}${plan.steps[0]}${palette.reset}`)
    lines.push(`  ${palette.accent}${plan.steps[1]}${palette.reset}`)
    lines.push(`  ${palette.dim}install it with: llamafarm install ${model.id}${palette.reset}`)
  } else {
    lines.push(`  ${palette.yellow}${planError ?? 'no run instructions available'}${palette.reset}`)
  }
  lines.push(`  ${palette.dim}${model.hfUrl}${palette.reset}`)

  ctx.write(`${lines.join('\n')}\n`)
  return 0
}
