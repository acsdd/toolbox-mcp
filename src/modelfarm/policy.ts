import { MODEL_TASKS, type ModelFormat, type ModelTask, type ScoreRuntime } from '@toolbox/widgets'
import type { CatalogScope, ModelFarmPreferences, ModelQueryInput, NormalizedModelQuery } from './contracts.js'

export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000
export const CATALOG_PER_TASK = 24
export const MODEL_CATALOG_CACHE_VERSION = 2 as const
export const ALL_MODEL_TASKS: readonly ModelTask[] = MODEL_TASKS.map((entry) => entry.task)
export const ALL_MODEL_FORMATS: readonly ModelFormat[] = ['gguf', 'safetensors']

export const MCP_CATALOG_POLICY = {
  formats: ['gguf'] as const,
  perTask: CATALOG_PER_TASK,
  visibility: 'reachable' as const,
  installFormats: ['gguf'] as const
}

export const LLAMAFARM_CATALOG_POLICY = {
  formats: ALL_MODEL_FORMATS,
  perTask: CATALOG_PER_TASK,
  visibility: 'all' as const,
  installFormats: ['gguf'] as const
}

export const DEFAULT_MODEL_FARM_PREFS: ModelFarmPreferences = {
  scenario: 'now',
  taskFilter: '',
  minParams: null,
  maxParams: null,
  showReds: false
}

const MIN_PARAM_OPTIONS = [1, 3, 7, 13, 33, 70]
const MAX_PARAM_OPTIONS = [3, 7, 13, 33, 70]
const TASK_FILTER_MAX_LENGTH = 120

function validBound(value: unknown, options: readonly number[]): value is number {
  return typeof value === 'number' && options.includes(value)
}

/** Existing MCP preference rules, kept pure so migration and runtime share them. */
export function sanitizeModelFarmPreferences(raw: unknown): ModelFarmPreferences {
  const doc = (raw ?? {}) as Record<string, unknown>
  const taskFilter = typeof doc.taskFilter === 'string' ? doc.taskFilter.trim() : ''
  return {
    scenario: doc.scenario === 'total' ? 'total' : 'now',
    taskFilter: taskFilter.length <= TASK_FILTER_MAX_LENGTH ? taskFilter : '',
    minParams: validBound(doc.minParams, MIN_PARAM_OPTIONS) ? doc.minParams : null,
    maxParams: validBound(doc.maxParams, MAX_PARAM_OPTIONS) ? doc.maxParams : null,
    showReds: doc.showReds === true
  }
}

/**
 * Fill absent/invalid MCP fields from Desktop without replacing any valid MCP
 * value, including an explicitly stored false, empty filter or null bound.
 */
export function mergeModelFarmPreferences(currentRaw: unknown, legacyRaw: unknown): ModelFarmPreferences {
  const current = (currentRaw ?? {}) as Record<string, unknown>
  const legacy = (legacyRaw ?? {}) as Record<string, unknown>
  const pick = <Key extends keyof ModelFarmPreferences>(
    key: Key,
    valid: (value: unknown) => value is ModelFarmPreferences[Key]
  ): ModelFarmPreferences[Key] => {
    if (Object.prototype.hasOwnProperty.call(current, key) && valid(current[key])) return current[key]
    if (valid(legacy[key])) return legacy[key]
    return DEFAULT_MODEL_FARM_PREFS[key]
  }
  return {
    scenario: pick('scenario', (value): value is 'now' | 'total' => value === 'now' || value === 'total'),
    taskFilter: pick('taskFilter', (value): value is string => typeof value === 'string' && value.trim().length <= TASK_FILTER_MAX_LENGTH),
    minParams: pick('minParams', (value): value is number | null => value === null || validBound(value, MIN_PARAM_OPTIONS)),
    maxParams: pick('maxParams', (value): value is number | null => value === null || validBound(value, MAX_PARAM_OPTIONS)),
    showReds: pick('showReds', (value): value is boolean => typeof value === 'boolean')
  }
}

function normalizeTasks(input: ModelQueryInput['tasks']): ModelTask[] {
  const values = input == null ? [] : Array.isArray(input) ? input : [input]
  const requested = new Set<ModelTask>()
  for (const value of values) {
    if (typeof value !== 'string' || !ALL_MODEL_TASKS.includes(value as ModelTask)) {
      throw new Error(`Unknown task "${String(value)}". Known: ${ALL_MODEL_TASKS.join(', ')}.`)
    }
    requested.add(value as ModelTask)
  }
  return ALL_MODEL_TASKS.filter((task) => requested.has(task))
}

function normalizeFormats(input: ModelQueryInput['formats'], defaults: readonly ModelFormat[]): ModelFormat[] {
  const source = input == null ? defaults : Array.isArray(input) ? input : [input]
  if (source.length === 0) throw new Error('At least one model format is required.')
  const requested = new Set<ModelFormat>()
  for (const value of source) {
    if (typeof value !== 'string' || !ALL_MODEL_FORMATS.includes(value as ModelFormat)) {
      throw new Error(`Unknown format "${String(value)}". Known: ${ALL_MODEL_FORMATS.join(', ')}.`)
    }
    requested.add(value as ModelFormat)
  }
  return ALL_MODEL_FORMATS.filter((format) => requested.has(format))
}

function normalizeBound(value: number | null | undefined, name: string): number | null {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite, non-negative number or null.`)
  }
  return value
}

export function runtimeForId(id: string): ScoreRuntime {
  switch (id) {
    case 'ollama': return { id, api: 'ollama' }
    case 'koboldcpp': return { id, api: 'kobold' }
    case 'lmstudio':
    case 'jan':
    case 'gpt4all':
    case 'llamafile':
    case 'vllm':
      return { id, api: 'openai' }
    default: return { id: id.trim() || 'ollama', api: 'openai' }
  }
}

export function normalizeModelQuery(input: ModelQueryInput = {}): NormalizedModelQuery {
  const tasks = normalizeTasks(input.task)
  for (const task of normalizeTasks(input.tasks)) {
    if (!tasks.includes(task)) tasks.push(task)
  }
  tasks.sort((a, b) => ALL_MODEL_TASKS.indexOf(a) - ALL_MODEL_TASKS.indexOf(b))

  const scenario = input.scenario ?? input.defaultScenario ?? 'now'
  if (scenario !== 'now' && scenario !== 'total') {
    throw new Error(`Unknown scenario "${String(scenario)}". Use "now" or "total".`)
  }
  const runtime = typeof input.runtime === 'string'
    ? runtimeForId(input.runtime)
    : input.runtime ?? input.defaultRuntime ?? { id: 'ollama', api: 'ollama' }
  if (!runtime.id || !['ollama', 'openai', 'kobold'].includes(runtime.api)) {
    throw new Error('A valid model runtime is required.')
  }
  const top = input.top == null || input.top === 0 ? null : input.top
  if (top !== null && (typeof top !== 'number' || !Number.isFinite(top) || top < 0 || !Number.isInteger(top))) {
    throw new Error('top must be a finite, non-negative integer or null.')
  }
  const hideUnreachable = input.onlyReachable === true || input.showReds === false
  return {
    search: input.search?.trim().toLowerCase() ?? '',
    tasks,
    formats: normalizeFormats(input.formats, input.defaultFormats ?? LLAMAFARM_CATALOG_POLICY.formats),
    minParams: normalizeBound(input.minParams, 'minParams'),
    maxParams: normalizeBound(input.maxParams, 'maxParams'),
    scenario,
    runtime: { ...runtime },
    hideUnreachable,
    top
  }
}

export function normalizeScopeTasks(tasks?: readonly ModelTask[]): ModelTask[] {
  const requested = new Set(tasks ?? [])
  for (const task of requested) {
    if (!ALL_MODEL_TASKS.includes(task)) throw new Error(`Unknown task "${task}".`)
  }
  return ALL_MODEL_TASKS.filter((task) => requested.has(task))
}

export function cacheScopeKey(scope: CatalogScope): string {
  const tasks = normalizeScopeTasks(scope.tasks)
  const coverage = tasks.length === 0 ? '*' : tasks.join(',')
  return JSON.stringify([coverage, [...scope.formats].sort(), scope.runtime, scope.perTask])
}

export function isGgufInstallable(model: { formats: readonly ModelFormat[] }): boolean {
  return model.formats.includes('gguf')
}
