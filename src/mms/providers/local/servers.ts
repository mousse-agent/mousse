import type { LocalModelFacts, LocalRuntimeKind, LocalToolSupport } from '../../../shared/localServers'
import { localRequest, type LocalFetch, type LocalReply } from './http'

/**
 * What a local server is and what it serves. A server is recognised by what its endpoints answer, never by its port:
 * llama.cpp, LocalAI and MLX all default to 8080. llama.cpp (single model and router), Ollama, LM Studio and Unsloth
 * Studio have their native metadata read; vLLM, Jan, LocalAI, KoboldCpp and MLX are listed through `/v1/models`, with
 * what their models can do unknown until checked. Every read is a GET, or Ollama's read-only `/api/show`; nothing
 * here loads a model.
 */

export interface ReadOptions {
  timeoutMs: number
  signal?: AbortSignal
  apiKey?: string
  fetchImpl?: LocalFetch
  /** A JSON body: the request is a POST (Ollama's read-only `/api/show`). */
  body?: unknown
}

/** One model a server lists. */
export interface LocalModelRead {
  id: string
  label: string
  facts: LocalModelFacts
}

export type IdentifyOutcome =
  | { ok: true; kind: LocalRuntimeKind }
  | { ok: false; problem: 'needs_key' | 'not_a_model_server'; kind?: LocalRuntimeKind }

export type ReadOutcome =
  | { ok: true; models: LocalModelRead[] }
  | { ok: false; problem: 'needs_key' | 'not_a_model_server' }

/** The most models one server's list keeps, and the most `/api/show` reads one refresh makes. */
const MAX_MODELS = 200
const MAX_SHOW_READS = 40

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function positive(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

function locked(reply: LocalReply): boolean {
  return reply.status === 401 || reply.status === 403
}

/** The OpenAI `/v1/models` rows: ids in order, without repeats. */
function openAiRows(json: unknown): Array<Record<string, unknown> & { id: string }> {
  const seen = new Set<string>()
  const rows: Array<Record<string, unknown> & { id: string }> = []
  for (const entry of list(record(json)?.data)) {
    const row = record(entry)
    const id = text(row?.id)
    if (!row || !id || seen.has(id)) continue
    seen.add(id)
    rows.push({ ...row, id })
    if (rows.length >= MAX_MODELS) break
  }
  return rows
}

const get = (root: string, path: string, options: ReadOptions) => localRequest(root, path, options)

/**
 * What answers at `root` (the server's address, with any reverse-proxy prefix and without `/v1`). Native endpoints
 * first, the most specific first; then a plain OpenAI model list. A 401 or 403 on every probe is `needs_key`.
 */
export async function identifyServer(root: string, options: ReadOptions): Promise<IdentifyOutcome> {
  let lockedSeen = false
  const json = async (path: string): Promise<unknown> => {
    const reply = await get(root, path, options).catch(() => undefined)
    if (!reply) return undefined
    if (locked(reply)) lockedSeen = true
    return reply.status >= 200 && reply.status < 300 ? reply.json : undefined
  }
  // Unsloth Studio names itself; its inference API always needs a key.
  const health = record(await json('/api/health'))
  if (health && /unsloth/i.test(text(health.service) ?? '')) {
    const models = await get(root, '/v1/models', options).catch(() => undefined)
    if (models && locked(models)) return { ok: false, problem: 'needs_key', kind: 'unsloth' }
    return { ok: true, kind: 'unsloth' }
  }
  if (text(record(await json('/api/version'))?.version)) return { ok: true, kind: 'ollama' }
  const lmStudio = record(await json('/api/v1/models'))
  if (lmStudio && Array.isArray(lmStudio.models)) return { ok: true, kind: 'lmstudio' }
  const kobold = record(await json('/api/extra/version'))
  if (kobold && /kobold/i.test(text(kobold.result) ?? '')) return { ok: true, kind: 'koboldcpp' }
  if (record(await json('/.well-known/localai.json'))) return { ok: true, kind: 'localai' }
  const modelsReply = await get(root, '/v1/models', options).catch(() => undefined)
  if (!modelsReply) return { ok: false, problem: 'not_a_model_server' }
  if (locked(modelsReply)) return { ok: false, problem: 'needs_key' }
  const rows = modelsReply.status >= 200 && modelsReply.status < 300 ? openAiRows(modelsReply.json) : undefined
  if (!rows || !Array.isArray(record(modelsReply.json)?.data)) return lockedSeen ? { ok: false, problem: 'needs_key' } : { ok: false, problem: 'not_a_model_server' }
  const owners = new Set(rows.map((row) => text(row.owned_by)?.toLowerCase()))
  if (owners.has('llamacpp')) return { ok: true, kind: 'llamacpp' }
  if (owners.has('vllm')) return { ok: true, kind: 'vllm' }
  if (rows.some((row) => positive(row.max_model_len) !== undefined) && text(record(await json('/version'))?.version)) return { ok: true, kind: 'vllm' }
  // Jan's models name their engine; MLX's server answers `/health` and lists Hugging Face repositories.
  if (rows.some((row) => /^(?:llamacpp|llama-cpp|cortex)/i.test(text(row.engine) ?? ''))) return { ok: true, kind: 'jan' }
  if (record(await json('/health')) && rows.every((row) => row.owned_by === undefined)) return { ok: true, kind: 'mlx' }
  return { ok: true, kind: 'openai' }
}

/** The models `kind` serves at `root`, with what each can do as the server says. */
export async function readServer(root: string, kind: LocalRuntimeKind, options: ReadOptions): Promise<ReadOutcome> {
  switch (kind) {
    case 'ollama':
      return readOllama(root, options)
    case 'lmstudio':
      return readLmStudio(root, options)
    case 'llamacpp':
      return readLlamaCpp(root, options)
    case 'unsloth':
      return readGeneric(root, options, (row) => ({
        tools: 'unknown',
        images: false,
        ...(positive(row.context_length) ? { loadedWindow: positive(row.context_length)! } : {}),
        ...(typeof row.loaded === 'boolean' ? { loaded: row.loaded } : {})
      }), (row) => text(row.display_name))
    case 'vllm':
      // One model per process, served at `max_model_len`, always in memory.
      return readGeneric(root, options, (row) => ({ tools: 'unknown', images: false, loaded: true, ...(positive(row.max_model_len) ? { loadedWindow: positive(row.max_model_len)! } : {}) }))
    case 'koboldcpp': {
      const window = positive(record((await get(root, '/api/extra/true_max_context_length', options).catch(() => undefined))?.json)?.value)
      return readGeneric(root, options, () => ({ tools: 'unknown', images: false, loaded: true, ...(window ? { loadedWindow: window } : {}) }))
    }
    default:
      return readGeneric(root, options, () => ({ tools: 'unknown', images: false }))
  }
}

async function readGeneric(
  root: string,
  options: ReadOptions,
  facts: (row: Record<string, unknown>) => LocalModelFacts,
  label: (row: Record<string, unknown>) => string | undefined = () => undefined
): Promise<ReadOutcome> {
  const reply = await get(root, '/v1/models', options)
  if (locked(reply)) return { ok: false, problem: 'needs_key' }
  if (reply.status < 200 || reply.status >= 300 || !Array.isArray(record(reply.json)?.data)) return { ok: false, problem: 'not_a_model_server' }
  return { ok: true, models: openAiRows(reply.json).map((row) => ({ id: row.id, label: label(row) ?? row.id, facts: facts(row) })) }
}

/**
 * Ollama: `/api/tags` lists what is on disk, `/api/ps` what is in memory and the window it runs at (the OpenAI
 * endpoint cannot change it), `/api/show` each model's capabilities and whether it is a cloud model.
 */
async function readOllama(root: string, options: ReadOptions): Promise<ReadOutcome> {
  const tags = await get(root, '/api/tags', options)
  if (locked(tags)) return { ok: false, problem: 'needs_key' }
  const rows = list(record(tags.json)?.models).map(record).filter((row): row is Record<string, unknown> => Boolean(row && text(row.name ?? row.model)))
  if (tags.status < 200 || tags.status >= 300) return { ok: false, problem: 'not_a_model_server' }
  const ps = await get(root, '/api/ps', options).catch(() => undefined)
  const running = new Map<string, number | undefined>()
  for (const entry of list(record(ps?.json)?.models)) {
    const row = record(entry)
    const id = text(row?.name ?? row?.model)
    if (id) running.set(id, positive(row?.context_length))
  }
  const models: LocalModelRead[] = []
  let shows = 0
  for (const row of rows.slice(0, MAX_MODELS)) {
    const id = text(row.name ?? row.model)!
    const show = shows++ < MAX_SHOW_READS ? record((await get(root, '/api/show', { ...options, body: { model: id } }).catch(() => undefined))?.json) : undefined
    const capabilities = list(show?.capabilities).filter((entry): entry is string => typeof entry === 'string')
    const cloud = Boolean(text(row.remote_model) || text(row.remote_host) || text(show?.remote_model) || text(show?.remote_host))
    // Embedding-only models cannot chat.
    if (capabilities.length && !capabilities.includes('completion')) continue
    const tools: LocalToolSupport = !show ? 'unknown' : capabilities.includes('tools') ? 'reported' : 'none'
    const window = running.get(id)
    models.push({
      id,
      label: id,
      facts: {
        tools,
        images: capabilities.includes('vision'),
        ...(cloud ? { cloud: true as const } : {}),
        ...(ps ? { loaded: running.has(id) } : {}),
        ...(window ? { loadedWindow: window } : {})
      }
    })
  }
  return { ok: true, models }
}

/**
 * LM Studio's native list: every downloaded model, its loaded instances with the window each runs at, and its
 * vision and tool-use flags.
 */
async function readLmStudio(root: string, options: ReadOptions): Promise<ReadOutcome> {
  const reply = await get(root, '/api/v1/models', options)
  if (locked(reply)) return { ok: false, problem: 'needs_key' }
  const rows = list(record(reply.json)?.models).map(record)
  if (reply.status < 200 || reply.status >= 300) return { ok: false, problem: 'not_a_model_server' }
  const models: LocalModelRead[] = []
  for (const row of rows) {
    const id = text(row?.key)
    if (!row || !id || (text(row.type) && row.type !== 'llm')) continue
    const instances = list(row.loaded_instances).map(record).filter(Boolean) as Array<Record<string, unknown>>
    const window = instances.map((instance) => positive(record(instance.config)?.context_length)).find((value) => value !== undefined)
    const capabilities = record(row.capabilities)
    const toolFlag = capabilities?.trained_for_tool_use
    models.push({
      id,
      label: text(row.display_name) ?? id,
      facts: {
        tools: toolFlag === true ? 'reported' : toolFlag === false ? 'none' : 'unknown',
        images: capabilities?.vision === true,
        loaded: instances.length > 0,
        ...(window ? { loadedWindow: window } : {})
      }
    })
    if (models.length >= MAX_MODELS) break
  }
  return { ok: true, models }
}

/**
 * llama.cpp: a router (`status` on each model) reports residency and, for a loaded model, its window; `/props` is
 * read only for a model already in memory (a GET can load a cold one). A single-model server is always loaded.
 */
async function readLlamaCpp(root: string, options: ReadOptions): Promise<ReadOutcome> {
  const reply = await get(root, '/v1/models', options)
  if (locked(reply)) return { ok: false, problem: 'needs_key' }
  if (reply.status < 200 || reply.status >= 300) return { ok: false, problem: 'not_a_model_server' }
  const rows = openAiRows(reply.json)
  const router = rows.some((row) => record(row.status) !== undefined)
  const models: LocalModelRead[] = []
  for (const row of rows) {
    const state = text(record(row.status)?.value)
    const loaded = router ? state === 'loaded' : true
    const meta = record(row.meta)
    const props = loaded ? record((await get(root, router ? `/props?model=${encodeURIComponent(row.id)}` : '/props', options).catch(() => undefined))?.json) : undefined
    const window = positive(record(props?.default_generation_settings)?.n_ctx) ?? (router ? positive(meta?.n_ctx) : undefined)
    const caps = record(props?.chat_template_caps)
    const toolFlag = caps?.supports_tool_calls ?? caps?.supports_tools
    const inputs = list(record(row.architecture)?.input_modalities)
    const vision = record(props?.modalities)?.vision === true || inputs.includes('image')
    models.push({
      id: row.id,
      label: row.id,
      facts: {
        tools: toolFlag === true ? 'reported' : toolFlag === false ? 'none' : 'unknown',
        images: vision,
        loaded,
        ...(window ? { loadedWindow: window } : {})
      }
    })
  }
  return { ok: true, models }
}

/** Whether `modelId` is in memory now, asking only what reports residency; undefined when the server cannot say. */
export async function readResidency(root: string, kind: LocalRuntimeKind, modelId: string, options: ReadOptions): Promise<boolean | undefined> {
  if (kind === 'vllm' || kind === 'koboldcpp') return true
  if (kind === 'ollama') {
    const ps = await get(root, '/api/ps', options)
    if (ps.status < 200 || ps.status >= 300) return undefined
    return list(record(ps.json)?.models).some((entry) => text(record(entry)?.name ?? record(entry)?.model) === modelId)
  }
  if (kind === 'lmstudio') {
    const reply = await get(root, '/api/v1/models', options)
    const row = list(record(reply.json)?.models).map(record).find((entry) => text(entry?.key) === modelId)
    return row ? list(row.loaded_instances).length > 0 : undefined
  }
  if (kind === 'llamacpp' || kind === 'unsloth') {
    const reply = await get(root, '/v1/models', options)
    const row = openAiRows(reply.json).find((entry) => entry.id === modelId)
    if (!row) return undefined
    if (kind === 'unsloth') return typeof row.loaded === 'boolean' ? row.loaded : undefined
    const state = text(record(row.status)?.value)
    return record(row.status) ? state === 'loaded' : true
  }
  return undefined
}
