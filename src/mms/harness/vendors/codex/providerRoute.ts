import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, TomlError } from 'smol-toml'
import type { CodexModelRoute } from '../../../../shared/harness/modelRoute'
import type { CliCommand } from '../../../run/mcp/attachment'

/**
 * A Codex entry that runs on the model provider its own config.toml selects, once the person agreed
 * to it in Mousse (`InstanceConfig.modelRoute`, docs/plans/codex-own-provider.md).
 *
 * - The choice is Mousse's: without `modelRoute` every turn runs on OpenAI's own provider, whatever a
 *   config layer selects (`CODEX_MODEL_PROVIDER`).
 * - The provider is Mousse's own table, defined with `-c` above every config layer
 *   (`customProviderArgs`), so no config file can change its address or credentials. Only `name`,
 *   `base_url` and `wire_api` are taken from the person's table; a table that needs more is refused.
 * - The key stays in config.toml. The daemon reads it on each launch, each token request and each
 *   check, and the token helper hands it to Codex (`auth.command`), so it is never in argv, the
 *   environment, Mousse's state or a message.
 */

/** The provider id Mousse defines for a custom route. It is not a secret: every field is set by `-c`. */
export const CUSTOM_MODEL_PROVIDER = 'mousse_api_key'
/** Codex kills the helper after this (`managedRuntime` uses the same). */
const TOKEN_COMMAND_TIMEOUT_MS = 80_000
/** Codex's own providers: selecting one is not a custom provider Mousse can offer. */
const BUILT_IN_PROVIDERS = new Set(['openai', 'ollama', 'lmstudio', 'oss', 'amazon-bedrock'])
/** Fields Mousse copies into its own table. */
const COPIED = new Set(['name', 'base_url', 'wire_api', 'experimental_bearer_token'])
/** Fields that only tune retries and timeouts: Codex's defaults apply instead. */
const TUNING = new Set(['request_max_retries', 'stream_max_retries', 'stream_idle_timeout_ms', 'requires_openai_auth', 'supports_websockets'])

/** One `[model_providers.<id>]` table, as far as Mousse reads it. */
export interface CodexProviderTable {
  id: string
  name: string
  baseUrl?: string
  wireApi?: string
  key?: string
  /** Fields Mousse would have to copy to run it as configured (`env_key`, `http_headers`, …). */
  unsupported: string[]
}

export type CodexConfigReading =
  | { kind: 'missing' }
  | { kind: 'unreadable'; message: string }
  | { kind: 'read'; selected?: string; tables: Map<string, CodexProviderTable> }

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * `<home>/config.toml`, read now. A parse error names its line only: smol-toml's own message quotes
 * the line, which may hold the key.
 */
export function readCodexConfig(home: string): CodexConfigReading {
  let source: string
  try {
    source = readFileSync(join(home, 'config.toml'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'unreadable', message: `Mousse can't read Codex's config.toml (${(error as NodeJS.ErrnoException).code ?? 'error'}).` }
  }
  let doc: Record<string, unknown>
  try {
    doc = parse(source) as Record<string, unknown>
  } catch (error) {
    const line = error instanceof TomlError ? ` (line ${error.line})` : ''
    return { kind: 'unreadable', message: `Codex's config.toml isn't valid TOML${line}.` }
  }
  const tables = new Map<string, CodexProviderTable>()
  const providers = doc.model_providers
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    for (const [id, raw] of Object.entries(providers as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const fields = raw as Record<string, unknown>
      const baseUrl = text(fields.base_url)
      const wireApi = text(fields.wire_api)
      const key = text(fields.experimental_bearer_token)
      tables.set(id, {
        id,
        name: text(fields.name) ?? id,
        ...(baseUrl ? { baseUrl } : {}),
        ...(wireApi ? { wireApi } : {}),
        ...(key ? { key } : {}),
        unsupported: Object.keys(fields).filter((field) => !COPIED.has(field) && !TUNING.has(field)).sort()
      })
    }
  }
  const selected = text(doc.model_provider)
  return { kind: 'read', ...(selected ? { selected } : {}), tables }
}

/** `•••• last4`: all the renderer ever sees of a key. */
export function maskKey(key: string): string {
  return `•••• ${key.slice(-4)}`
}

function hostOf(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.host : undefined
  } catch {
    return undefined
  }
}

/** A table Mousse can run on: its address, its host and its key. */
export interface RunnableTable {
  id: string
  name: string
  baseUrl: string
  host: string
  key: string
}

/** Why a table can't run, in words for the person; undefined when it can. */
function tableProblem(table: CodexProviderTable): string | undefined {
  if (!table.baseUrl) return `The provider ${table.id} in config.toml has no base_url.`
  if (!hostOf(table.baseUrl)) return `The base_url of ${table.id} in config.toml isn't an http or https address.`
  if (table.wireApi && table.wireApi !== 'responses') return `The provider ${table.id} uses wire_api "${table.wireApi}". Codex in Mousse runs only "responses".`
  if (table.unsupported.length) return `The provider ${table.id} sets ${table.unsupported.join(', ')} in config.toml, which Mousse doesn't pass on yet.`
  if (!table.key) return `The provider ${table.id} has no experimental_bearer_token in config.toml. Mousse runs only a key kept there.`
  return undefined
}

function runnable(table: CodexProviderTable): RunnableTable {
  return { id: table.id, name: table.name, baseUrl: table.baseUrl!, host: hostOf(table.baseUrl!)!, key: table.key! }
}

/** What config.toml offers: the provider it selects, ready to agree to, or why it can't be used. */
export type CodexRouteOffer =
  | { kind: 'none' }
  | { kind: 'offer'; table: string; name: string; baseUrl: string; host: string; keyMasked: string }
  | { kind: 'problem'; message: string }

export function routeOffer(reading: CodexConfigReading): CodexRouteOffer {
  if (reading.kind === 'missing') return { kind: 'none' }
  if (reading.kind === 'unreadable') return { kind: 'problem', message: reading.message }
  const selected = reading.selected
  if (!selected || BUILT_IN_PROVIDERS.has(selected)) return { kind: 'none' }
  const table = reading.tables.get(selected)
  if (!table) return { kind: 'problem', message: `config.toml selects the provider ${selected}, but has no [model_providers.${selected}] table.` }
  const problem = tableProblem(table)
  if (problem) return { kind: 'problem', message: problem }
  const run = runnable(table)
  return { kind: 'offer', table: run.id, name: run.name, baseUrl: run.baseUrl, host: run.host, keyMasked: maskKey(run.key) }
}

/**
 * The table the agreed route runs on, read now; or why it can't run. The base URL must still be the
 * one the person agreed to: a changed address is never sent the key without a new agreement.
 */
export function routeTable(route: CodexModelRoute, reading: CodexConfigReading): { ok: true; table: RunnableTable } | { ok: false; message: string } {
  if (reading.kind === 'missing') return { ok: false, message: "Codex's config.toml is gone." }
  if (reading.kind === 'unreadable') return { ok: false, message: reading.message }
  const table = reading.tables.get(route.table)
  if (!table) return { ok: false, message: `The provider ${route.table} is gone from config.toml.` }
  if (table.baseUrl !== route.baseUrl) return { ok: false, message: 'The base URL in config.toml changed. Agree to it again in Settings → Providers.' }
  if (!table.key) return { ok: false, message: 'The API key is gone from config.toml.' }
  const problem = tableProblem(table)
  if (problem) return { ok: false, message: problem }
  return { ok: true, table: runnable(table) }
}

/** The account a route runs as: its address and key, one-way. */
export function routeSubject(table: Pick<RunnableTable, 'baseUrl' | 'key'>): string {
  return `api_key:${createHash('sha256').update(`codex-route\u0000${table.baseUrl}\u0000${table.key}`).digest('hex').slice(0, 32)}`
}

/** A TOML value from JSON: JSON strings, numbers and booleans are valid TOML. */
function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([key, entry]) => `${key}=${toml(entry)}`).join(',')}}`
  return JSON.stringify(value)
}

/**
 * The `-c` overrides that define Mousse's own provider for one launch. Every field that could carry
 * a credential or change where requests go is set here, empty when unused, so a config layer that
 * names this id adds nothing that matters; a thread whose layers name it is refused anyway
 * (`routeLayerProblem`).
 */
export function customProviderArgs(table: Pick<RunnableTable, 'name' | 'baseUrl'>, helper: Pick<CliCommand, 'command' | 'args'>): string[] {
  const provider = {
    name: table.name,
    base_url: table.baseUrl,
    wire_api: 'responses',
    requires_openai_auth: false,
    supports_websockets: false,
    http_headers: {},
    env_http_headers: {},
    query_params: {},
    auth: { command: helper.command, args: helper.args, timeout_ms: TOKEN_COMMAND_TIMEOUT_MS, refresh_interval_ms: 0 }
  }
  return [
    '-c', `model_provider=${toml(CUSTOM_MODEL_PROVIDER)}`,
    '-c', `model_providers.${CUSTOM_MODEL_PROVIDER}=${toml(provider)}`
  ]
}

interface ConfigLayer {
  name?: { type: string; file?: string; dotCodexFolder?: string }
  disabledReason: string | null
  config?: Record<string, unknown> | null
}

/**
 * Why a thread can't start on a custom route, from Codex's own config layers for its folder
 * (`config/read` with `includeLayers`); undefined when nothing but Mousse names its provider. A
 * project layer that selects a provider, or any file layer that adds to Mousse's table, is refused:
 * a chat's own commands can write such a file.
 */
export function routeLayerProblem(layers: readonly ConfigLayer[] | null | undefined): string | undefined {
  if (!layers) return "Mousse couldn't read Codex's config layers for this folder, so it can't check that nothing changes the model provider."
  for (const layer of layers) {
    if (layer.disabledReason) continue
    const type = layer.name?.type
    // `-c` overrides (Codex's `SessionFlags` layer): Mousse's own.
    if (type && /^session_?flags$/i.test(type)) continue
    const config = layer.config ?? {}
    const providers = config.model_providers
    const names = providers && typeof providers === 'object' && !Array.isArray(providers) && Object.prototype.hasOwnProperty.call(providers, CUSTOM_MODEL_PROVIDER)
    const where = type === 'project' ? "this project's .codex/config.toml" : "a Codex config file"
    if (names) return `${where[0]!.toUpperCase()}${where.slice(1)} defines the provider ${CUSTOM_MODEL_PROVIDER}, which Mousse sets itself. Remove it to run here.`
    if (type === 'project' && config.model_provider !== undefined)
      return "This project's .codex/config.toml chooses a model provider. Remove model_provider from it to run this entry's provider here."
  }
  return undefined
}

/** The outcome of the key check: one `GET <base_url>/models` with the key. */
export type KeyCheck = { kind: 'ok' } | { kind: 'refused' } | { kind: 'unreachable' }

export async function checkRouteKey(table: Pick<RunnableTable, 'baseUrl' | 'key'>, options: { fetch?: typeof fetch; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<KeyCheck> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 8_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  try {
    const response = await (options.fetch ?? fetch)(`${table.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { authorization: `Bearer ${table.key}` },
      redirect: 'error',
      signal
    })
    await response.body?.cancel().catch(() => undefined)
    // Any other answer (a provider without a model list included) leaves the key to the first turn.
    return response.status === 401 || response.status === 403 ? { kind: 'refused' } : { kind: 'ok' }
  } catch {
    options.signal?.throwIfAborted()
    return { kind: 'unreachable' }
  }
}
