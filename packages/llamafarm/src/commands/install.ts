/**
 * `llamafarm install <repo>` — pull a GGUF into the local Ollama runtime.
 *
 * Ollama serves any HuggingFace GGUF directly, so the download is a single
 * `ollama pull hf.co/<owner>/<repo>:<quant>`. With `--offload N` a Modelfile
 * is written instead, pinning how many layers stay on the GPU.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import {
  buildModelfile,
  planOllamaInstall,
  probeOllamaCli,
  pullIntoOllama,
  runOllamaCommand,
  type CatalogModel
} from '@toolbox/widgets'
import { flagBool, flagNumber, flagString } from '../args.js'
import { formatBytes, label, sectionTitle } from '../render.js'
import { detect, type CommandContext } from '../context.js'
import { resolveModel } from './explain.js'

export interface InstallPlanSummary {
  reference: string
  modelName: string
  runtimeRamBytes: number
  steps: string[]
}

export async function installCommand(ctx: CommandContext): Promise<number> {
  const repoId = ctx.args.positionals[0]
  if (!repoId) {
    ctx.write('Usage: llamafarm install <owner/repo> [--quant Q4_K_M] [--offload N] [--dry-run]\n')
    return 2
  }
  const quant = flagString(ctx.args.flags, 'quant')
  const offload = flagNumber(ctx.args.flags, 'offload')
  const dryRun = flagBool(ctx.args.flags, 'dry-run') === true

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

  let plan: ReturnType<typeof planOllamaInstall>
  try {
    plan = planOllamaInstall(model, quant ?? model.quantLabel)
  } catch (cause) {
    ctx.write(`${cause instanceof Error ? cause.message : String(cause)}\n`)
    return 1
  }

  const machine = await detect(ctx)
  const summary: InstallPlanSummary = {
    reference: plan.reference,
    modelName: plan.modelName,
    runtimeRamBytes: model.runtimeRamBytes,
    steps: plan.steps
  }

  const palette = ctx.palette
  const execFileImpl = ctx.deps.execFile ?? (execFile as never)
  const probe = ctx.deps.probeOllama ? await ctx.deps.probeOllama(execFileImpl) : await probeOllamaCli(execFileImpl)

  if (!probe.installed) {
    if (ctx.json) {
      ctx.write(`${JSON.stringify({ model: model.id, ...summary, installed: false }, null, 2)}\n`)
      return 3
    }
    ctx.write(
      `${palette.yellow}Ollama is not available on this machine.${palette.reset}\n` +
        `${palette.dim}Install it from https://ollama.com/download, then run:${palette.reset}\n` +
        `${palette.accent}  ollama pull ${plan.reference}${palette.reset}\n`
    )
    return 3
  }

  const lines: string[] = [sectionTitle('INSTALL', palette), '']
  lines.push(`  ${label('Model', palette)}         ${model.label}`)
  lines.push(`  ${label('Reference', palette)}      ${plan.reference}`)
  lines.push(`  ${label('Runtime RAM', palette)}    ${formatBytes(model.runtimeRamBytes)}`)
  lines.push(`  ${label('Ollama', palette)}         ${probe.version ? `v${probe.version}` : 'installed'}`)
  if (offload !== undefined) {
    lines.push(`  ${label('GPU layers', palette)}     ${offload}`)
  }
  lines.push('')

  if (dryRun) {
    if (ctx.json) {
      ctx.write(`${JSON.stringify({ model: model.id, ...summary, dryRun: true }, null, 2)}\n`)
      return 0
    }
    lines.push(`${palette.dim}dry run — nothing was downloaded${palette.reset}`)
    ctx.write(`${lines.join('\n')}\n`)
    return 0
  }

  if (ctx.json) {
    ctx.write(`${JSON.stringify({ model: model.id, ...summary }, null, 2)}\n`)
  } else {
    ctx.write(`${lines.join('\n')}\n`)
  }

  const onOutput = (chunk: string): void => {
    if (!ctx.json) ctx.write(chunk)
  }

  if (offload === undefined) {
    const pull = ctx.deps.pull ?? pullIntoOllama
    const result = await pull(plan.reference, { onOutput })
    if (!result.ok) {
      ctx.write(`${palette.red}Download failed: ${result.error ?? 'unknown error'}${palette.reset}\n`)
      return 1
    }
    ctx.write(`${palette.green}Pulled ${plan.reference}${palette.reset}\n`)
  } else {
    const directory = mkdtempSync(join(tmpdir(), 'llamafarm-'))
    const modelfilePath = join(directory, 'Modelfile')
    writeFileSync(modelfilePath, buildModelfile(plan.reference, { numGpu: offload }), 'utf8')
    const runner = ctx.deps.runOllama ?? runOllamaCommand
    const result = await runner(['create', plan.modelName, '--file', modelfilePath], { onOutput })
    if (!result.ok) {
      ctx.write(
        `${palette.red}Import failed: ${result.error ?? 'unknown error'}${palette.reset}\n` +
          `${palette.dim}fallback: ollama pull ${plan.reference}${palette.reset}\n`
      )
      return 1
    }
    ctx.write(`${palette.green}Imported ${plan.reference} as ${plan.modelName}${palette.reset}\n`)
  }

  ctx.write(`${palette.accent}Run it with:${palette.reset} ollama run ${plan.reference}\n`)
  return 0
}
