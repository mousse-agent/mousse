import { readFileSync } from 'node:fs'
import type { Api, Context, Model, MutableModels, Provider, ProviderStreams } from '@earendil-works/pi-ai'
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/compat'
import {
  LOCAL_PLANNING_WINDOW,
  LOCAL_RUNTIME_LABELS,
  localEffectiveWindow,
  type LocalCheckToolsResult,
  type LocalConnectInput,
  type LocalConnectResult,
  type LocalModelFacts,
  type LocalModelView,
  type LocalRuntimeKind,
  type LocalServerRow
} from '../../../shared/localServers'
import { atomicWriteJsonSync } from '../../data/AtomicFs'
import type { FileCredentialStore } from '../FileCredentialStore'
import { detectLocalServers, type DetectOptions } from './detect'
import { isLoopbackHost, pinnedFetch, type LocalFetch, type LocalPin } from './http'
import { identifyServer, readResidency, readServer, type LocalModelRead } from './servers'

/**
 * The profile's local connections (`pi:local-<slug>`): one record per server, kept beside `auth.json` so every
 * profile of this installation sees the same servers, as with keys. A server's own key is in the credential store
 * under the connection's id; a keyless server has none, and pi-ai gets {@link LOCAL_PLACEHOLDER_KEY} in memory only
 * (it refuses an empty key before sending), which the pinned `fetch` never sends.
 *
 * Each record registers one pi-ai provider on the OpenAI chat completions API, with Pi's own llama.cpp compatibility
 * settings and a `fetch` held to the record's origin (`pinnedFetch`). The same definition reaches the picker,
 * `runPiOneShot` (titles) and the Pi child (`PiCatalogProvider.pin`). Its model list is restored from the record at
 * start without a request, and read again only when asked (`refresh`): never by the background catalog refresh.
 */

/** What pi-ai is given as the key of a keyless server. Never stored, never sent. */
export const LOCAL_PLACEHOLDER_KEY = 'mousse-local-no-key'

export interface LocalConnectionRecord {
  /** `local-ollama`, `local-ollama-2`: unique, readable, never parsed. */
  id: string
  kind: LocalRuntimeKind
  label: string
  /** The server's address without `/v1` (`http://127.0.0.1:11434`, or with a reverse-proxy prefix). */
  root: string
  /** A key is saved in the credential store. */
  keyed: boolean
  /** The person agreed to plain http to this address (another machine). */
  cleartext?: true
  models: LocalModelRead[]
  /** The person's window per model (`Window unknown · Set`). */
  windows?: Record<string, number>
  /** Round-trip tool checks per model. */
  toolChecks?: Record<string, 'passed' | 'failed'>
  refreshedAt?: number
}

interface FileShape {
  version: 1
  connections: LocalConnectionRecord[]
  /** Ids of removed connections: never given out again, so a thread that chose one never reaches another server. */
  retired?: string[]
}

/** How long a refresh of one connection may take. */
const REFRESH_TIMEOUT_MS = 4_000
/** How long a connect's reads may take. */
const CONNECT_TIMEOUT_MS = 6_000
/** How long the tool check's two requests may take together. */
const TOOL_CHECK_TIMEOUT_MS = 60_000

const CHECK_TOOL = {
  name: 'mousse_tool_check',
  description: 'Records a short word. Call it exactly once when asked.',
  parameters: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'], additionalProperties: false }
}

/** The address as Mousse keeps it, or why it cannot be used. */
export function normalizeLocalAddress(address: string): { root: string; host: string; secure: boolean } | undefined {
  const trimmed = address.trim()
  if (!trimmed) return undefined
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`)
  } catch {
    return undefined
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) return undefined
  // `localhost` may resolve to IPv6 first while the server listens on IPv4.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')
  return { root: `${url.origin}${path}`, host: url.hostname, secure: url.protocol === 'https:' }
}

function maxTokensFor(window: number): number {
  return Math.max(256, Math.min(Math.floor(window / 4), 8192))
}

export class LocalConnections {
  private records = new Map<string, LocalConnectionRecord>()
  private retired = new Set<string>()
  private loaded = false

  constructor(
    private readonly path: string,
    private readonly models: MutableModels,
    private readonly credentials: Pick<FileCredentialStore, 'get' | 'modify' | 'delete'>,
    private readonly fetchImpl?: LocalFetch
  ) {}

  /** Restores the saved connections and registers their providers, with no request. */
  load(): void {
    if (this.loaded) return
    this.loaded = true
    let parsed: Partial<FileShape> | undefined
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<FileShape>
    } catch {
      return
    }
    for (const id of Array.isArray(parsed?.retired) ? parsed.retired : []) if (typeof id === 'string') this.retired.add(id)
    for (const record of Array.isArray(parsed?.connections) ? parsed.connections : []) {
      if (!record || typeof record.id !== 'string' || !record.id.startsWith('local-') || typeof record.root !== 'string' || !normalizeLocalAddress(record.root)) continue
      this.records.set(record.id, { ...record, models: Array.isArray(record.models) ? record.models : [] })
      this.register(record.id)
    }
  }

  private save(): void {
    atomicWriteJsonSync(this.path, { version: 1, connections: [...this.records.values()], ...(this.retired.size ? { retired: [...this.retired] } : {}) } satisfies FileShape)
  }

  has(providerId: string): boolean {
    this.load()
    return this.records.has(providerId)
  }

  ids(): string[] {
    this.load()
    return [...this.records.keys()]
  }

  get(providerId: string): LocalConnectionRecord | undefined {
    this.load()
    return this.records.get(providerId)
  }

  /** The key pi-ai resolves for a connection: its saved key, else the in-memory placeholder. */
  apiKey(providerId: string): string | undefined {
    if (!this.get(providerId)) return undefined
    return this.savedKey(providerId) ?? LOCAL_PLACEHOLDER_KEY
  }

  /** The server's own key in the credential store (saved at connect, or later in the entry's editor). */
  private savedKey(providerId: string): string | undefined {
    const stored = this.credentials.get(providerId)
    return stored?.type === 'api_key' && stored.key ? stored.key : undefined
  }

  /** How the connection's requests are pinned, for the Pi child (`PiCatalogProvider.pin`). */
  pin(providerId: string): LocalPin | undefined {
    const record = this.get(providerId)
    return record ? this.pinOf(record) : undefined
  }

  private pinOf(record: LocalConnectionRecord): LocalPin {
    return {
      origin: new URL(record.root).origin,
      keyless: this.savedKey(record.id) === undefined,
      // Unsloth Studio runs its own Python, terminal and web tools unless a request turns them off.
      ...(record.kind === 'unsloth' ? { extraBody: { enable_tools: false } } : {})
    }
  }

  /** What Mousse knows of a model: the server's facts, then the person's window and the tool check. */
  facts(providerId: string, modelId: string): LocalModelFacts | undefined {
    const record = this.get(providerId)
    const model = record?.models.find((entry) => entry.id === modelId)
    if (!record || !model) return undefined
    const window = record.windows?.[modelId]
    const check = record.toolChecks?.[modelId]
    return { ...model.facts, ...(window ? { windowOverride: window } : {}), ...(check ? { tools: check } : {}) }
  }

  views(providerId: string): LocalModelView[] {
    const record = this.get(providerId)
    return (record?.models ?? []).map((model) => ({ id: model.id, label: model.label, ...this.facts(providerId, model.id)! }))
  }

  /** The servers answering on this computer now, and installed apps that are not (Add provider → Local models). */
  async detect(options: DetectOptions = {}): Promise<LocalServerRow[]> {
    this.load()
    const connected = (root: string): string | undefined => [...this.records.values()].find((record) => new URL(record.root).origin === new URL(root).origin)?.id
    return detectLocalServers({ ...options, ...(this.fetchImpl && !options.fetchImpl ? { fetchImpl: this.fetchImpl } : {}), connected })
  }

  /** Connects the server at `input.address`: recognises it, reads its models, saves it and registers its provider. */
  async connect(input: LocalConnectInput, signal?: AbortSignal): Promise<LocalConnectResult> {
    this.load()
    const address = normalizeLocalAddress(input.address)
    if (!address) return { ok: false, problem: 'invalid_address', message: 'Enter an http or https address, such as 127.0.0.1:11434.' }
    const existing = [...this.records.values()].find((record) => record.root === address.root)
    if (!address.secure && !isLoopbackHost(address.host) && !input.allowCleartext && !existing?.cleartext)
      return { ok: false, problem: 'cleartext_consent', message: `Messages to ${address.host} travel unencrypted over your network.` }
    const apiKey = input.apiKey?.trim() || undefined
    const read = { timeoutMs: CONNECT_TIMEOUT_MS, ...(signal ? { signal } : {}), ...(apiKey ? { apiKey } : {}), ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) }
    const identified = await identifyServer(address.root, read).catch(() => undefined)
    if (!identified) return { ok: false, problem: 'unreachable', message: `Nothing answers at ${address.root}. Start the server, then try again.` }
    if (!identified.ok) {
      return identified.problem === 'needs_key'
        ? { ok: false, problem: 'needs_key', message: 'This server needs its API key.', ...(identified.kind ? { kind: identified.kind } : {}) }
        : { ok: false, problem: 'not_a_model_server', message: `${address.root} is not a model server Mousse can use.` }
    }
    const listed = await readServer(address.root, identified.kind, read).catch(() => undefined)
    if (!listed) return { ok: false, problem: 'unreachable', message: `${address.root} stopped answering. Try again.`, kind: identified.kind }
    if (!listed.ok) {
      return listed.problem === 'needs_key'
        ? { ok: false, problem: 'needs_key', message: 'This server needs its API key.', kind: identified.kind }
        : { ok: false, problem: 'not_a_model_server', message: `${address.root} lists no models Mousse can use.`, kind: identified.kind }
    }
    // Read again after the awaits: a connect to the same address that finished meanwhile is this one's record. The id is
    // taken and the record saved with no await in between, so two connects at once never share an id.
    const current = [...this.records.values()].find((record) => record.root === address.root)
    const id = current?.id ?? this.freeId(identified.kind)
    const label = current?.label ?? this.freeLabel(LOCAL_RUNTIME_LABELS[identified.kind])
    const record: LocalConnectionRecord = {
      ...(current ?? {}),
      id,
      kind: identified.kind,
      label,
      root: address.root,
      keyed: Boolean(apiKey) || (current?.keyed ?? false),
      ...(input.allowCleartext || current?.cleartext ? { cleartext: true as const } : {}),
      models: listed.models,
      refreshedAt: Date.now()
    }
    this.records.set(id, record)
    this.save()
    if (apiKey) await this.credentials.modify(id, async () => ({ type: 'api_key', key: apiKey }))
    this.register(id)
    return { ok: true, providerId: id, label, kind: identified.kind, count: listed.models.length }
  }

  /** Reads the connection's models again (Providers page or picker opened, a turn dispatched). False when it did not answer. */
  async refresh(providerId: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<boolean> {
    const record = this.get(providerId)
    if (!record) return false
    const apiKey = this.savedKey(providerId)
    const listed = await readServer(record.root, record.kind, {
      timeoutMs: options.timeoutMs ?? REFRESH_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {})
    }).catch(() => undefined)
    // A read stopped part-way left some models' facts unread: the saved ones stay.
    if (!listed?.ok || options.signal?.aborted) return false
    const current = this.records.get(providerId)
    if (!current) return false
    this.records.set(providerId, { ...current, models: listed.models, refreshedAt: Date.now() })
    this.save()
    this.register(providerId)
    return true
  }

  /** Removes the connection, its key and its provider. */
  async remove(providerId: string): Promise<void> {
    if (!this.get(providerId)) return
    this.records.delete(providerId)
    this.retired.add(providerId)
    this.save()
    this.models.deleteProvider(providerId)
    await this.credentials.delete(providerId).catch(() => undefined)
  }

  /** The person's window for a model; null clears it. */
  setWindow(providerId: string, modelId: string, window: number | null): boolean {
    const record = this.get(providerId)
    if (!record || !record.models.some((model) => model.id === modelId)) return false
    const windows = { ...(record.windows ?? {}) }
    if (window === null) delete windows[modelId]
    else windows[modelId] = Math.max(1024, Math.min(Math.round(window), 10_000_000))
    this.records.set(providerId, { ...record, windows })
    this.save()
    this.register(providerId)
    return true
  }

  /** Whether the model is in memory now; undefined when the server cannot say or does not answer. */
  async resident(providerId: string, modelId: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<boolean | undefined> {
    const record = this.get(providerId)
    if (!record) return undefined
    const apiKey = this.savedKey(providerId)
    return readResidency(record.root, record.kind, modelId, {
      timeoutMs: options.timeoutMs ?? 600,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {})
    }).catch(() => undefined)
  }

  /**
   * The round-trip tool check on a model already in memory (it never loads one): a synthetic function the model must
   * call with the right argument, then a reply that reads its result. Nothing runs; the function does nothing.
   */
  async checkTools(providerId: string, modelId: string, signal?: AbortSignal): Promise<LocalCheckToolsResult> {
    const record = this.get(providerId)
    const model = this.models.getModel(providerId, modelId)
    if (!record || !model) return { ok: false, problem: 'unknown_model', message: 'This model is no longer listed. Refresh, then try again.' }
    const resident = await this.resident(providerId, modelId, signal ? { signal } : {})
    if (resident === false) return { ok: false, problem: 'cold', message: 'Load this model in its app first; the check never loads one.' }
    // A server that cannot say may load the model to answer, and the check never loads one.
    if (resident !== true) return { ok: false, problem: 'cold', message: `${record.label} does not say whether this model is loaded, so the check cannot run without risking a load.` }
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(TOOL_CHECK_TIMEOUT_MS)]) : AbortSignal.timeout(TOOL_CHECK_TIMEOUT_MS)
    let outcome: 'passed' | 'failed'
    try {
      outcome = await this.roundTrip(model, bounded)
    } catch {
      if (signal?.aborted) return { ok: false, problem: 'unreachable', message: 'The check was stopped.' }
      return { ok: false, problem: 'unreachable', message: `${record.label} did not answer the check.` }
    }
    const current = this.records.get(providerId)
    if (current) {
      this.records.set(providerId, { ...current, toolChecks: { ...(current.toolChecks ?? {}), [modelId]: outcome } })
      this.save()
    }
    return { ok: true, tools: outcome }
  }

  private async roundTrip(model: Model<Api>, signal: AbortSignal): Promise<'passed' | 'failed'> {
    const word = `ok${Math.floor(Math.random() * 9000 + 1000)}`
    const context: Context = {
      systemPrompt: 'You are checking that function calls work. Follow the instruction exactly.',
      messages: [{ role: 'user', content: `Call ${CHECK_TOOL.name} with word "${word}". Do not answer in text.`, timestamp: Date.now() }],
      tools: [CHECK_TOOL as never]
    }
    const first = await this.models.streamSimple(model, context, { signal, maxTokens: 256 }).result()
    const call = first.content.find((block) => block.type === 'toolCall')
    if (first.stopReason === 'error' || first.stopReason === 'aborted') throw new Error(first.errorMessage ?? 'request failed')
    if (!call || call.type !== 'toolCall' || call.name !== CHECK_TOOL.name || (call.arguments as { word?: unknown })?.word !== word) return 'failed'
    context.messages.push(first, {
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: 'text', text: `Recorded. Now reply with the single word: ${word}` }],
      isError: false,
      timestamp: Date.now()
    })
    const second = await this.models.streamSimple(model, context, { signal, maxTokens: 64 }).result()
    if (second.stopReason === 'error' || second.stopReason === 'aborted') throw new Error(second.errorMessage ?? 'request failed')
    const reply = second.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
    return reply.includes(word) ? 'passed' : 'failed'
  }

  /** The pi-ai definition of one listed model, as Pi's own llama.cpp provider sets it. */
  modelDefinition(record: LocalConnectionRecord, model: LocalModelRead): Model<'openai-completions'> {
    const facts = this.facts(record.id, model.id) ?? model.facts
    const window = localEffectiveWindow(facts) ?? LOCAL_PLANNING_WINDOW
    return {
      id: model.id,
      name: model.label,
      api: 'openai-completions',
      provider: record.id,
      baseUrl: `${record.root}/v1`,
      reasoning: false,
      input: facts.images ? ['text', 'image'] : ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: window,
      maxTokens: maxTokensFor(window),
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsUsageInStreaming: true,
        supportsStrictMode: false,
        maxTokensField: 'max_tokens'
      }
    }
  }

  /** The pi-ai provider of a record: its models, its key (or the placeholder), and the pinned transport. */
  provider(record: LocalConnectionRecord): Provider {
    const stock = openAICompletionsApi()
    // The pin is read at each request: a key saved later in the entry's editor is sent from then on.
    const fetch: LocalFetch = (input, init) => pinnedFetch(this.pinOf(this.records.get(record.id) ?? record), this.fetchImpl)(input, init)
    const pinned: ProviderStreams = {
      stream: ((model, context, options) => stock.stream(model, context, { ...(options ?? {}), fetch } as never)) as ProviderStreams['stream'],
      streamSimple: ((model, context, options) => stock.streamSimple(model, context, { ...(options ?? {}), fetch } as never)) as ProviderStreams['streamSimple']
    }
    const id = record.id
    return createProvider({
      id,
      name: record.label,
      baseUrl: `${record.root}/v1`,
      auth: { apiKey: { name: `${record.label} key`, resolve: async () => ({ auth: { apiKey: this.apiKey(id) ?? LOCAL_PLACEHOLDER_KEY }, source: 'Mousse' }) } },
      models: record.models.map((model) => this.modelDefinition(record, model)),
      api: { 'openai-completions': pinned }
    })
  }

  private register(providerId: string): void {
    const record = this.records.get(providerId)
    if (record) this.models.setProvider(this.provider(record))
  }

  private freeId(kind: LocalRuntimeKind): string {
    const base = `local-${kind === 'openai' ? 'server' : kind}`
    const taken = (id: string) => this.records.has(id) || this.retired.has(id)
    if (!taken(base)) return base
    for (let n = 2; ; n += 1) if (!taken(`${base}-${n}`)) return `${base}-${n}`
  }

  private freeLabel(base: string): string {
    const taken = new Set([...this.records.values()].map((record) => record.label.toLowerCase()))
    if (!taken.has(base.toLowerCase())) return base
    for (let n = 2; ; n += 1) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
  }
}
