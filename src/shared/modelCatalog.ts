import { REASONING_LEVELS } from './modelVariants'

/**
 * Mousse's own model catalog (`src/mms/models/models.json`): the models that might exist, their
 * names and release dates, and the id each route accepts. The format is described in
 * `docs/providers/model-catalog.md`. This module only reads it; it never checks what an account can
 * run (the live check does that).
 */

/** The catalog format this reader knows. */
export const MODEL_CATALOG_FORMAT = 1

/**
 * Route keys this reader understands: an existing driver or provider id (`claude` is the Claude Code
 * driver, `anthropic` the Anthropic API provider). Other keys are ignored.
 */
export const MODEL_CATALOG_ROUTES = ['claude', 'anthropic', 'openai', 'codex'] as const
export type ModelCatalogRouteKey = (typeof MODEL_CATALOG_ROUTES)[number]

export interface ModelCatalogRoute {
  /** The exact model id this route accepts. */
  id: string
  /** The first Mousse version that handles this route for this model (inclusive). */
  minMousse?: string
}

/**
 * How capable a model is, for bots' hidden model choice (Bot Phase 1 §5.6): `frontier` the makers'
 * strongest, `standard` the everyday one, `small` the fast and cheap one.
 */
export const MODEL_CATALOG_TIERS = ['frontier', 'standard', 'small'] as const
export type ModelCatalogTier = (typeof MODEL_CATALOG_TIERS)[number]

export interface ModelCatalogEntry {
  /** The maker's own model id; never renamed or reused. */
  id: string
  /** The full name ("Claude Opus 5.5"). */
  name: string
  /** The short name beside a maker logo ("Opus 5.5"); defaults to `name`. */
  short: string
  maker: string
  family?: string
  /** Optional; a value this reader does not know is dropped. */
  tier?: ModelCatalogTier
  /** `YYYY-MM-DD`. */
  released: string
  older?: true
  /** Reasoning levels, for a route that reports none for this model. */
  efforts?: string[]
  routes: Partial<Record<ModelCatalogRouteKey, ModelCatalogRoute>>
}

export interface ModelCatalog {
  format: number
  revision: number
  models: ModelCatalogEntry[]
}

/** A file this reader cannot use at all: an unknown `format`, or not a catalog. */
export class ModelCatalogError extends Error {}

const ROUTE_KEYS: ReadonlySet<string> = new Set(MODEL_CATALOG_ROUTES)
const TIERS: ReadonlySet<string> = new Set(MODEL_CATALOG_TIERS)
const EFFORTS: ReadonlySet<string> = new Set(REASONING_LEVELS)
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const VERSION = /^\d+(?:\.\d+)*$/

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** A real calendar date in `YYYY-MM-DD`. */
export function validCatalogDate(value: string): boolean {
  const match = DATE.exec(value)
  if (!match) return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.toISOString().slice(0, 10) === value
}

function route(value: unknown): ModelCatalogRoute | undefined {
  const raw = record(value)
  const id = text(raw?.id)
  if (!raw || !id) return undefined
  if (raw.minMousse === undefined) return { id }
  // A limit this reader cannot read drops the route: it cannot tell whether this build handles it.
  const min = text(raw.minMousse)
  return min && VERSION.test(min) ? { id, minMousse: min } : undefined
}

/** One model, or undefined when it is invalid (the rest of the file still counts). */
function model(value: unknown): ModelCatalogEntry | undefined {
  const raw = record(value)
  if (!raw) return undefined
  const id = text(raw.id)
  const name = text(raw.name)
  const maker = text(raw.maker)
  const released = text(raw.released)
  const rawRoutes = record(raw.routes)
  if (!id || !name || !maker || !released || !validCatalogDate(released) || !rawRoutes) return undefined
  const routes: ModelCatalogEntry['routes'] = {}
  for (const [key, entry] of Object.entries(rawRoutes)) {
    if (!ROUTE_KEYS.has(key)) continue
    const parsed = route(entry)
    if (parsed) routes[key as ModelCatalogRouteKey] = parsed
  }
  if (!Object.keys(routes).length) return undefined
  const family = text(raw.family)
  const tier = typeof raw.tier === 'string' && TIERS.has(raw.tier) ? (raw.tier as ModelCatalogTier) : undefined
  const efforts = Array.isArray(raw.efforts)
    ? [...new Set(raw.efforts.filter((level): level is string => typeof level === 'string' && EFFORTS.has(level)))]
    : undefined
  return {
    id,
    name,
    short: text(raw.short) ?? name,
    maker,
    ...(family ? { family } : {}),
    ...(tier ? { tier } : {}),
    released,
    ...(raw.older === true ? { older: true as const } : {}),
    ...(efforts?.length ? { efforts } : {}),
    routes
  }
}

/**
 * Reads a catalog. Unknown fields, route keys and effort levels are ignored; an invalid model is
 * dropped and the rest kept, and so is a model whose id or route id repeats one already read. The
 * whole file is rejected (`ModelCatalogError`) only when it is not a catalog or its `format` is unknown.
 */
export function parseModelCatalog(value: unknown): ModelCatalog {
  const raw = record(typeof value === 'string' ? parseJson(value) : value)
  if (!raw) throw new ModelCatalogError('The model catalog is not a JSON object.')
  if (raw.format !== MODEL_CATALOG_FORMAT) throw new ModelCatalogError(`The model catalog format ${JSON.stringify(raw.format)} is unknown.`)
  if (typeof raw.revision !== 'number' || !Number.isInteger(raw.revision) || raw.revision < 0 || !Array.isArray(raw.models))
    throw new ModelCatalogError('The model catalog has no revision or models.')
  const models: ModelCatalogEntry[] = []
  const ids = new Set<string>()
  const routeIds = new Map<string, Set<string>>()
  for (const entry of raw.models) {
    const parsed = model(entry)
    if (!parsed || ids.has(parsed.id)) continue
    const taken = Object.entries(parsed.routes).some(([key, value]) => routeIds.get(key)?.has(value.id))
    if (taken) continue
    ids.add(parsed.id)
    for (const [key, value] of Object.entries(parsed.routes)) {
      const seen = routeIds.get(key) ?? new Set<string>()
      seen.add(value.id)
      routeIds.set(key, seen)
    }
    models.push(parsed)
  }
  return { format: MODEL_CATALOG_FORMAT, revision: raw.revision, models }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new ModelCatalogError('The model catalog is not valid JSON.')
  }
}

/**
 * The catalog as this Mousse version may use it: a route whose `minMousse` is above `mousseVersion`
 * is removed, and a model left with no route goes with it. A missing version (`0.0.0`, a checkout or
 * a test) counts as newest. `compare` is `compareVersions` (`src/mms/harness/driver.ts`).
 */
export function gateModelCatalog(catalog: ModelCatalog, mousseVersion: string, compare: (a: string, b: string) => number): ModelCatalog {
  if (mousseVersion === '0.0.0') return catalog
  const models: ModelCatalogEntry[] = []
  for (const entry of catalog.models) {
    const routes = Object.fromEntries(
      Object.entries(entry.routes).filter(([, value]) => !value.minMousse || compare(mousseVersion, value.minMousse) >= 0)
    ) as ModelCatalogEntry['routes']
    if (Object.keys(routes).length) models.push({ ...entry, routes })
  }
  return { ...catalog, models }
}

/** The catalog's models that have `key`, newest `released` first (ties keep file order). */
export function catalogModelsOnRoute(catalog: ModelCatalog, key: ModelCatalogRouteKey): Array<ModelCatalogEntry & { route: ModelCatalogRoute }> {
  return catalog.models
    .flatMap((entry) => (entry.routes[key] ? [{ ...entry, route: entry.routes[key] }] : []))
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.released.localeCompare(a.entry.released) || a.index - b.index)
    .map(({ entry }) => entry)
}
