import {
  matchInstalledModel,
  MODEL_TASKS,
  scoreModels,
  sortForDisplay,
  type CatalogModel,
  type MachineProfile,
  type ModelTask,
  type ScoredModel
} from '@toolbox/widgets'
import type {
  FarmScoredModel,
  ModelGroup,
  ModelInventory,
  ModelQueryInput,
  ModelQueryResult,
  NormalizedModelQuery,
  QuerySnapshot
} from './contracts.js'
import { normalizeModelQuery } from './policy.js'

export { normalizeModelQuery } from './policy.js'

/** Filter the supplied catalog exactly once; scoring and display policy are separate. */
export function filterCatalogModels(
  models: readonly CatalogModel[],
  input: ModelQueryInput | NormalizedModelQuery = {}
): CatalogModel[] {
  const query = 'hideUnreachable' in input ? input : normalizeModelQuery(input)
  const tasks = new Set(query.tasks)
  const formats = new Set(query.formats)
  const search = query.search
  return models.filter((model) => {
    if (search && !model.id.toLowerCase().includes(search) && !model.label.toLowerCase().includes(search)) return false
    if (tasks.size > 0 && !tasks.has(model.task)) return false
    if (!model.formats.some((format) => formats.has(format))) return false
    if (query.minParams != null && (model.paramsBillions ?? 0) < query.minParams) return false
    if (query.maxParams != null && (model.paramsBillions ?? Infinity) > query.maxParams) return false
    return true
  })
}

/** MCP reachability: only red models without hints are hidden. */
export function isModelVisible(
  model: Pick<ScoredModel, 'verdict' | 'hints'>,
  input: ModelQueryInput | NormalizedModelQuery = {}
): boolean {
  const hide = 'hideUnreachable' in input ? input.hideUnreachable : normalizeModelQuery(input).hideUnreachable
  return !hide || model.verdict !== 'red' || model.hints.length > 0
}

function markInstalled(
  models: readonly ScoredModel[],
  inventory: ModelInventory | undefined,
  runtime: string
): FarmScoredModel[] {
  if (inventory?.runtime && inventory.runtime !== runtime) {
    throw new Error(`Inventory runtime "${inventory.runtime}" does not match query runtime "${runtime}".`)
  }
  const names = [...(inventory?.names ?? [])]
  return models.map((model) => {
    const installed = matchInstalledModel(model, names)
    return { ...model, installed, installedRuntime: installed ? runtime : null }
  })
}

/** Canonical grouping/sorting/top stage, also used by compatibility wrappers. */
export function groupScoredModels(
  models: readonly FarmScoredModel[],
  top: number | null = null
): ModelGroup[] {
  const byTask = new Map<ModelTask, FarmScoredModel[]>()
  for (const model of models) {
    const bucket = byTask.get(model.task) ?? []
    bucket.push(model)
    byTask.set(model.task, bucket)
  }
  return MODEL_TASKS.filter((info) => byTask.has(info.task)).map((info) => {
    const sorted = sortForDisplay(byTask.get(info.task) ?? []) as FarmScoredModel[]
    return {
      task: info.task,
      label: info.label,
      icon: info.icon,
      models: top == null ? sorted : sorted.slice(0, top)
    }
  })
}

/** Score once, apply visibility/provenance, then group, sort and truncate. */
export function scoreAndGroupModels(input: {
  models: readonly CatalogModel[]
  machine: MachineProfile
  query?: ModelQueryInput | NormalizedModelQuery
  inventory?: ModelInventory
  runtime?: QuerySnapshot['runtime']
  score?: QuerySnapshot['score']
}): ModelQueryResult {
  const query = 'hideUnreachable' in (input.query ?? {})
    ? input.query as NormalizedModelQuery
    : normalizeModelQuery(input.query)
  if (input.runtime && !input.query) query.runtime = { ...input.runtime }
  const scored = (input.score ?? scoreModels)({
    models: [...input.models],
    machine: input.machine,
    scenario: query.scenario,
    runtime: query.runtime
  })
  const visible = scored.filter((model) => isModelVisible(model, query))
  const marked = markInstalled(visible, input.inventory, query.runtime.id)
  return {
    query,
    models: marked,
    groups: groupScoredModels(marked, query.top),
    total: marked.length
  }
}

/** Pure canonical consumer: identical snapshots produce identical MCP/widget results. */
export function queryModels(input: QuerySnapshot): ModelQueryResult {
  const filtered = filterCatalogModels(input.models, input.query)
  return scoreAndGroupModels({
    models: filtered,
    machine: input.machine,
    query: input.query,
    inventory: input.inventory,
    runtime: input.runtime,
    score: input.score
  })
}
