import { createHash } from 'node:crypto'
import { harnessAppError } from '../../../shared/harness/types'
import { acpPermissionKey } from '../../../shared/permissionKeys'
import { permissionModeAllows, type PermissionMode } from '../../../shared/permissionMode'
import type { ActivityPatch } from '../../../shared/agentActivity'
import type { LlmModelOption } from '../../../shared/settings'
import type { AcpChatInput, AcpTurnUsage } from '../acp/session'
import type { ClassifiedOption, PermissionPrompter } from '../acp/permissions'
import { bearerHeader } from '../../run/mcp/attachment'
import { isNotFound, OpencodeApiError, type OpencodeClient } from './client'
import { actionKind, mousseServerName, permissionKind, sessionRules } from './rules'

/**
 * Turns on an OpenCode server (`server.ts`), one OpenCode session per thread.
 *
 * A thread's session is created with the rules of the turn's permission mode (`rules.ts`), resumed while the history
 * Mousse holds for the thread is what the session last answered (the same fingerprint the ACP runtime kept, so a
 * session saved over ACP resumes here), and given new rules whenever the mode changes. A turn sends one prompt and
 * follows the server's events for that session until the run ends. OpenCode's asks become Mousse approvals, answered
 * through the server once, never "always"; any failure to answer counts as a reject.
 */

/** A thread's OpenCode session, as Mousse keeps it. */
export interface SavedOpencodeSession {
  sessionId: string
  cwd: string
  /** The fingerprint of the thread's history the session last answered (`commitConversation`). */
  historyKey?: string
  instanceId?: string
  /** Hash of the session instructions the session was given; changed ones are sent again on resume. */
  instructionsHash?: string
}

export interface OpencodeSessionStore {
  saved(threadId: string): SavedOpencodeSession | undefined
  setSaved(threadId: string, saved: SavedOpencodeSession | undefined): void
  models(): LlmModelOption[]
  /** The models listed, and which of them are OpenCode's own free ones (`isOpencodeFreeModel`). */
  setModels(models: LlmModelOption[], free: string[]): void
}

/** The entry's server, as turns use it (`OpencodeServer`, with the managed copy's file check in front). */
export interface OpencodeServerHandle {
  running(): boolean
  hold(): () => void
  client(signal?: AbortSignal): Promise<OpencodeClient>
}

export interface OpencodeSessionsOptions {
  label: string
  defaultInstanceId: string
  server: OpencodeServerHandle
  store: OpencodeSessionStore
  /** How long a stop waits for OpenCode to confirm it ended the run (default 10 s). */
  interruptWaitMs?: number
}

/** One OpenCode model, as `GET /api/model` lists it (read leniently). */
interface ListedModel {
  providerID: string
  id: string
  name?: string
  enabled?: boolean
  variants?: Array<{ id?: unknown }>
  cost?: Array<Record<string, unknown>>
  limit?: { context?: unknown }
}

interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function hash(text: string, length = 64): string {
  return createHash('sha256').update(text).digest('hex').slice(0, length)
}

/** The models of `GET /api/model`, as Mousse lists them: `provider/model`, with OpenCode's variants as reasoning levels. */
export function modelsFromListing(data: unknown): LlmModelOption[] {
  if (!Array.isArray(data)) return []
  const models: LlmModelOption[] = []
  for (const raw of data) {
    if (!isRecord(raw)) continue
    const providerID = str(raw.providerID)
    const id = str(raw.id)
    if (!providerID || !id || raw.enabled === false) continue
    const efforts = Array.isArray(raw.variants)
      ? raw.variants.map((variant) => (isRecord(variant) ? str(variant.id) : undefined)).filter((variant): variant is string => Boolean(variant) && variant !== 'default')
      : []
    const context = isRecord(raw.limit) ? num(raw.limit.context) : 0
    models.push({
      id: `${providerID}/${id}`,
      label: str(raw.name) ?? id,
      resolvedId: id,
      ...(efforts.length ? { efforts } : {}),
      ...(context ? { contextWindow: context } : {})
    })
  }
  return models
}

/** The ids (`provider/model`) of OpenCode's own free models in a model listing. */
export function freeModelsOf(data: unknown): string[] {
  return (Array.isArray(data) ? data.filter(isRecord) : []).flatMap((raw) => {
    const providerID = str(raw.providerID)
    const id = str(raw.id)
    return providerID && id && isOpencodeFreeModel(raw as unknown as ListedModel, { providerID, id }) ? [`${providerID}/${id}`] : []
  })
}

/** Whether a listed OpenCode model is one of OpenCode's own free ones (its Zen provider, at no cost). */
export function isOpencodeFreeModel(model: ListedModel | undefined, ref: ModelRef): boolean {
  if (ref.providerID !== 'opencode') return false
  if (/(?:^|-)free(?:-|$)/.test(ref.id)) return true
  const costs = model?.cost ?? []
  return costs.length > 0 && costs.every((cost) => Object.values(cost).every((value) => typeof value !== 'number' || value === 0))
}

/**
 * `provider/model[:variant]` as a model reference. The part after the last `:` is a variant only when the model lists
 * it, so a model id with a colon of its own (`ollama/llama3:8b`) stays whole.
 */
export function parseModel(model: string, listed: readonly LlmModelOption[]): ModelRef | undefined {
  const slash = model.indexOf('/')
  if (slash <= 0) return undefined
  const colon = model.lastIndexOf(':')
  if (colon > slash) {
    const base = model.slice(0, colon)
    const variant = model.slice(colon + 1)
    const known = listed.find((entry) => entry.id === base)
    if (known?.efforts?.includes(variant)) return { providerID: base.slice(0, slash), id: base.slice(slash + 1), variant }
  }
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) }
}

/** A Mousse error for OpenCode's error (`Session.StructuredError`). */
export function opencodeTurnError(label: string, error: unknown): Error {
  const record = isRecord(error) ? error : {}
  const type = str(record.type) ?? 'unknown'
  const message = str(record.message) ?? `${label} failed.`
  if (type === 'provider.rate-limit' || type === 'provider.quota') return harnessAppError({ code: 'rate_limited', message })
  if (type === 'provider.auth') return harnessAppError({ code: 'signed_out', message: `${message} Sign in with \`opencode auth login\`.` })
  if (type === 'provider.no-route') return harnessAppError({ code: 'model_unavailable', message })
  if (type === 'provider.transport' || type === 'provider.internal' || type === 'provider.timeout') return harnessAppError({ code: 'service_unavailable', message })
  return new Error(`${label}: ${message}`)
}

/** What a tool call does, as the timeline shows it, from OpenCode's tool name and input. */
function toolActivity(name: string, input: Record<string, unknown> | undefined, cwd: string): ActivityPatch {
  const path = str(input?.path) ?? str(input?.filePath) ?? str(input?.file)
  switch (name) {
    case 'shell':
    case 'bash':
      return { kind: 'command', command: str(input?.command) ?? '', cwd: str(input?.cwd) ?? cwd }
    case 'edit':
    case 'write':
    case 'patch':
      return path ? { kind: 'file_change', changes: [{ path, change: name === 'write' ? 'add' : 'update', diffUnavailable: true }] } : { kind: 'generic', ...(input ? { input } : {}) }
    case 'grep':
      return { kind: 'search', scope: 'code', query: str(input?.pattern) ?? '', ...(path ? { path } : {}) }
    case 'glob':
      return { kind: 'search', scope: 'files', query: str(input?.pattern) ?? '', ...(path ? { path } : {}) }
    case 'websearch':
      return { kind: 'web_search', query: str(input?.query) ?? '' }
    default:
      return { kind: 'generic', ...(input ? { input } : {}) }
  }
}

function toolTitle(name: string, input: Record<string, unknown> | undefined): string {
  const detail = str(input?.command) ?? str(input?.path) ?? str(input?.filePath) ?? str(input?.pattern) ?? str(input?.url) ?? str(input?.query)
  return detail ? `${name} ${detail.length > 120 ? `${detail.slice(0, 117)}…` : detail}` : name
}

/** Most results a web search row keeps, as Claude's do. */
const MAX_SEARCH_RESULTS = 20
const RESULT_TITLE_CHARS = 300
const RESULT_URL_CHARS = 2_000

/**
 * The results OpenCode's own web search found, from its result text: one `## [title](url)` heading a result, the title
 * being the URL when the page has none (2.0.20 `tool/plugin/websearch.ts`). Undefined when it lists none (its "No search
 * results found" text included).
 */
function webSearchResults(text: string): Array<{ title: string; url: string }> | undefined {
  const results: Array<{ title: string; url: string }> = []
  for (const line of text.split('\n')) {
    const heading = /^## \[(.*)\]\((\S+)\)\s*$/.exec(line)
    if (!heading || !/^https?:\/\//i.test(heading[2]!) || heading[2]!.length > RESULT_URL_CHARS) continue
    const title = heading[1]!.trim() || heading[2]!
    results.push({ title: title.length > RESULT_TITLE_CHARS ? `${title.slice(0, RESULT_TITLE_CHARS - 1)}…` : title, url: heading[2]! })
    if (results.length === MAX_SEARCH_RESULTS) break
  }
  return results.length > 0 ? results : undefined
}

/** The text of a tool result's content items (`Tool.Content`). */
function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const text = content.map((item) => (isRecord(item) && item.type === 'text' ? str(item.text) ?? '' : '')).join('\n').trim()
  return text || undefined
}

/** What the server reported of one turn's run. */
type Ending = { kind: 'succeeded' } | { kind: 'failed'; error: unknown } | { kind: 'interrupted' }

/** How long a model refresh waits for a server that just started to list its models. */
const MODEL_LIST_WAIT_MS = 5_000

/** How long a turn that must ask waits for a server that just started to list its plugins. */
const PLUGIN_LIST_WAIT_MS = 10_000

const ALLOW: ClassifiedOption ={ optionId: 'once', kind: 'allow_once', label: 'Allow once', scope: 'once' }
const REJECT: ClassifiedOption = { optionId: 'reject', kind: 'reject_once', label: 'Reject', scope: 'once' }

export class OpencodeSessions {
  /** Event handlers by OpenCode session id. */
  private readonly listeners = new Map<string, (event: Record<string, unknown>) => void>()
  /** The session of each thread's running turn. */
  private readonly running = new Map<string, string>()
  /** Threads whose stopped or failed turn left their session resumable (`commitInterrupted`). */
  private readonly interrupted = new Map<string, string>()
  /** Mousse's MCP server attached for a thread: its name and bearer, so it is replaced only when they change. */
  private readonly attached = new Map<string, string>()

  constructor(private readonly options: OpencodeSessionsOptions) {}

  /** Every event of the server: handed to the session it names. */
  dispatch(event: Record<string, unknown>): void {
    const data = isRecord(event.data) ? event.data : undefined
    const sessionID = str(data?.sessionID)
    if (sessionID) this.listeners.get(sessionID)?.(event)
  }

  /** The server ended: nothing it ran continues. */
  serverEnded(): void {
    this.attached.clear()
    for (const listener of [...this.listeners.values()]) listener({ type: 'server.ended', data: {} })
  }

  private historyKey(history: string): string {
    return hash(history)
  }

  /**
   * OpenCode's models, as Mousse lists them. A server that just started lists none for a moment (its providers load in
   * the background), so an empty list is asked again for up to `MODEL_LIST_WAIT_MS`.
   */
  async refreshModels(client: OpencodeClient, directory?: string): Promise<LlmModelOption[]> {
    const deadline = Date.now() + MODEL_LIST_WAIT_MS
    let raw = await client.data('GET', '/api/model', { ...(directory ? { directory } : {}) })
    let models = modelsFromListing(raw)
    while (!models.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      raw = await client.data('GET', '/api/model', { ...(directory ? { directory } : {}) })
      models = modelsFromListing(raw)
    }
    this.options.store.setModels(models, freeModelsOf(raw))
    return models
  }

  /** The model a turn on `model` runs: the selection, else OpenCode's default (a session never runs without one). */
  private async modelRef(client: OpencodeClient, model: string, directory: string): Promise<ModelRef> {
    let listed = this.options.store.models()
    if (!listed.length) listed = await this.refreshModels(client, directory).catch(() => [])
    const ref = model && model !== 'default' ? parseModel(model, listed) : undefined
    if (ref) return ref
    const fallback = await client.data('GET', '/api/model/default', { directory }).catch(() => undefined)
    if (isRecord(fallback) && str(fallback.providerID) && str(fallback.id)) return { providerID: str(fallback.providerID)!, id: str(fallback.id)! }
    throw harnessAppError({ code: 'model_unavailable', message: `${this.options.label} has no model to run. Sign in to a provider with \`opencode auth login\`.` })
  }

  /**
   * Why a turn that must ask cannot be held to it, before any session: a plugin's `permission.evaluate` hook sees every
   * decision last (`permission.ts` `evaluateInput`) and can allow what the rules ask about. OpenCode's own plugins
   * (`source.type` `builtin`) leave decisions alone. Full access asks about nothing, so it needs neither check.
   *
   * A server that just started lists no plugin at all until it has loaded them, its own and the user's together, so an
   * empty list is asked again for up to `PLUGIN_LIST_WAIT_MS`; one that stays empty refuses the turn.
   */
  async pluginsBlocking(client: OpencodeClient, cwd: string, signal?: AbortSignal): Promise<string | undefined> {
    const list = async () => {
      const plugins = await client.data('GET', '/api/plugin', { directory: cwd, ...(signal ? { signal } : {}) })
      return Array.isArray(plugins) ? plugins.filter(isRecord) : []
    }
    const deadline = Date.now() + PLUGIN_LIST_WAIT_MS
    let plugins = await list()
    while (!plugins.length && Date.now() < deadline) {
      signal?.throwIfAborted()
      await new Promise((resolve) => setTimeout(resolve, 100))
      plugins = await list()
    }
    if (!plugins.length) return `${this.options.label} did not say which plugins it loaded, so Mousse cannot tell whether it will ask first. Try again, or use Full access.`
    const external = plugins.filter((plugin) => {
      const source = isRecord(plugin.source) ? plugin.source : {}
      return source.type !== 'builtin'
    })
    if (!external.length) return undefined
    const names = external.map((plugin) => str(plugin.id) ?? str(plugin.name) ?? 'a plugin').slice(0, 3).join(', ')
    return `${this.options.label} loads plugins (${names}) that can answer its permission checks, so Mousse cannot make it ask first. Turn them off, or use Full access.`
  }

  /**
   * Why a turn that must ask cannot be held to it in the project of its session: rules the user saved with "always"
   * there are read after the session's (`permission.ts` `savedRules`, by the session's project), so they allow what
   * the session asks about. Without a project id every saved rule counts.
   */
  async savedBlocking(client: OpencodeClient, projectID: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
    const saved = await client.data('GET', '/api/permission/saved', { ...(projectID ? { query: { projectID } } : {}), ...(signal ? { signal } : {}) })
    const grants = (Array.isArray(saved) ? saved.filter(isRecord) : []).filter((grant) => !projectID || !str(grant.projectID) || grant.projectID === projectID)
    if (!grants.length) return undefined
    const names = [...new Set(grants.map((grant) => str(grant.action)).filter(Boolean))].slice(0, 4).join(', ')
    return `${this.options.label} has saved "always" permissions for this project (${names}), which it uses without asking. Remove them in OpenCode, or use Full access.`
  }

  /**
   * Attaches Mousse's MCP server for this thread, and the MCP relay beside it when the turn has it: servers of their
   * own per thread (`mousse_<thread>`, `mousse_<thread>_relay`), so each thread's calls carry its own bearer.
   */
  private async attachMcp(client: OpencodeClient, input: AcpChatInput): Promise<string | undefined> {
    if (!input.mcp) return undefined
    const name = mousseServerName(input.threadId)
    const servers: Array<[string, string]> = [[name, input.mcp.url]]
    if (input.mcp.relay) servers.push([`${name}_relay`, input.mcp.relay.url])
    for (const [server, url] of servers) {
      const key = `${input.cwd}|${url}|${input.mcp.token}`
      if (this.attached.get(server) === key) continue
      await client.request('PUT', `/api/experimental/mcp/${encodeURIComponent(server)}`, {
        directory: input.cwd,
        body: { config: { type: 'remote', url, headers: { Authorization: bearerHeader(input.mcp) }, oauth: false, codemode: false } }
      })
      this.attached.set(server, key)
    }
    return name
  }

  /** One turn: the prompt on the thread's session, until OpenCode ends its run. Resolves the reply's text. */
  async chat(input: AcpChatInput): Promise<string> {
    const { label, store } = this.options
    input.signal?.throwIfAborted()
    if (input.continuation) return ''
    this.interrupted.delete(input.threadId)
    const release = this.options.server.hold()
    try {
      const client = await this.options.server.client(input.signal)
      const mode: PermissionMode = input.permissionMode ?? 'ask'
      // Both wait for a server that just started to finish loading, so they run side by side.
      const [blocked, model] = await Promise.all([
        mode !== 'full' ? this.pluginsBlocking(client, input.cwd, input.signal) : undefined,
        this.modelRef(client, input.model, input.cwd)
      ])
      if (blocked) throw harnessAppError({ code: 'permission_mode_unenforceable', message: blocked })
      const threadServer = await this.attachMcp(client, input)
      const rules = sessionRules(mode, threadServer, Boolean(input.mcp?.relay))
      const historyKey = this.historyKey(input.history ?? '')
      const instanceId = input.instanceId ?? this.options.defaultInstanceId
      const instructionsHash = input.orchestrationInstructions ? hash(input.orchestrationInstructions, 32) : undefined
      const stored = store.saved(input.threadId)
      let saved = stored && (stored.instanceId ?? this.options.defaultInstanceId) === instanceId && stored.cwd === input.cwd && stored.historyKey === historyKey ? stored : undefined
      // A bot's session given other instructions is not resumed: its instructions are its system text.
      if (saved && input.bot && instructionsHash && saved.instructionsHash !== instructionsHash) saved = undefined
      let sessionId: string | undefined
      let projectID: string | undefined
      if (saved) {
        try {
          await client.request('PATCH', `/api/session/${encodeURIComponent(saved.sessionId)}`, { body: { permissions: rules } })
          await client.request('POST', `/api/session/${encodeURIComponent(saved.sessionId)}/model`, { body: { model: modelBody(model) } })
          if (mode !== 'full') {
            const info = await client.data('GET', `/api/session/${encodeURIComponent(saved.sessionId)}`)
            projectID = isRecord(info) ? str(info.projectID) : undefined
          }
          sessionId = saved.sessionId
        } catch (error) {
          if (!isNotFound(error)) throw error
          saved = undefined
        }
      }
      const resumed = Boolean(sessionId)
      if (!sessionId) {
        const created = await client.data('POST', '/api/session', {
          body: { location: { directory: input.cwd }, model: modelBody(model), permissions: rules, title: 'Mousse' }
        })
        sessionId = isRecord(created) ? str(created.id) : undefined
        if (!sessionId) throw new Error(`${label} did not open a session.`)
        projectID = isRecord(created) ? str(created.projectID) : undefined
        store.setSaved(input.threadId, { sessionId, cwd: input.cwd, instanceId })
      }
      if (mode !== 'full') {
        // Checked before the prompt is sent: nothing has run in the session yet.
        const blocked = await this.savedBlocking(client, projectID, input.signal)
        if (blocked) {
          if (!resumed) {
            store.setSaved(input.threadId, undefined)
            await client.request('DELETE', `/api/session/${encodeURIComponent(sessionId)}`).catch(() => undefined)
          }
          throw harnessAppError({ code: 'permission_mode_unenforceable', message: blocked })
        }
      }
      input.onSession?.(sessionId)
      const history = !resumed && input.history
        ? `Previous conversation (context only; do not repeat earlier actions):\n${input.history}\n\nCurrent request:\n`
        : ''
      const orchestration = input.orchestrationInstructions && (!resumed || saved?.instructionsHash !== instructionsHash)
        ? `<mousse_orchestration_instructions>\n${input.orchestrationInstructions}\n</mousse_orchestration_instructions>\n\n`
        : ''
      if (instructionsHash) {
        const now = store.saved(input.threadId)
        if (now) store.setSaved(input.threadId, { ...now, instructionsHash })
      }
      const preamble = input.turnPreamble ? `${input.turnPreamble}\n\nCurrent request:\n` : ''
      const text = orchestration + history + preamble + (input.prompt || '(image attachment)')
      const files = (input.images ?? []).map((image, index) => ({ uri: `data:${image.mimeType};base64,${image.data}`, name: `image-${index + 1}` }))
      return await this.run(client, sessionId, input, mode, { text, ...(files.length ? { files } : {}) })
    } finally {
      release()
    }
  }

  /** Sends the prompt and follows the run to its end. */
  private run(client: OpencodeClient, sessionId: string, input: AcpChatInput, mode: PermissionMode, body: Record<string, unknown>): Promise<string> {
    const { label } = this.options
    const prompter: PermissionPrompter | undefined = input.prompter
    let text = ''
    let thinking = ''
    const blocks = new Map<string, string>()
    const thoughts = new Map<string, string>()
    const openTools = new Map<string, { name: string; input?: Record<string, unknown> }>()
    const usage: AcpTurnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, hasOutput: false }
    let reportedUsage = false
    let ending: ((value: Ending) => void) | undefined
    const ended = new Promise<Ending>((resolve) => { ending = resolve })

    /** The turn's text so far: every block in the order it began. */
    const update = (map: Map<string, string>, key: string, value: string, separate: boolean) => {
      const isNew = !map.has(key)
      map.set(key, value)
      const joined: string[] = []
      for (const part of map.values()) joined.push(part)
      if (separate && isNew && map.size > 1) {
        const before = [...map.values()].slice(0, -1).join('\n\n')
        input.onTextSeparator?.(before.length, '\n\n')
      }
      return joined.join('\n\n')
    }

    const answer = async (request: Record<string, unknown>) => {
      const requestId = str(request.id)
      if (!requestId) return
      const action = str(request.action) ?? 'other'
      const source = isRecord(request.source) ? request.source : {}
      const callId = str(source.id)
      const send = (decision: 'once' | 'reject') =>
        client.request('POST', `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`, {
          body: decision === 'reject' ? { decision, message: 'Declined in Mousse.' } : { decision }
        })
      /**
       * Tells OpenCode the decision. An allow it did not take is sent again as a reject; when OpenCode cannot be told
       * at all, its tool would wait for good, so the run is interrupted and the turn fails.
       */
      const reply = async (decision: 'once' | 'reject') => {
        try {
          await send(decision)
          return
        } catch (error) {
          if (decision === 'once') {
            try {
              await send('reject')
              return
            } catch {
              // Not told either way: below.
            }
          }
          if (input.signal?.aborted) return
          const reason = error instanceof Error ? error.message : String(error)
          ending?.({ kind: 'failed', error: { type: 'permission.reply', message: `could not answer its permission request (${reason})` } })
          void client.request('POST', `/api/session/${encodeURIComponent(sessionId)}/interrupt`).catch(() => undefined)
        }
      }
      try {
        if (input.signal?.aborted) return await reply('reject')
        if (prompter?.approvals === 'never') return await reply('reject')
        if (permissionModeAllows(mode, actionKind(action))) return await reply('once')
        if (!prompter) return await reply('reject')
        const resources = Array.isArray(request.resources) ? request.resources.filter((item): item is string => typeof item === 'string') : []
        const tool = callId ? openTools.get(callId) : undefined
        if (callId) input.onToolAwaiting?.(callId, true)
        const abort = new AbortController()
        const onAbort = () => abort.abort()
        input.signal?.addEventListener('abort', onAbort, { once: true })
        let picked: string | undefined
        try {
          picked = await prompter.choose({
            threadId: input.threadId,
            title: str(request.message) ?? `Allow ${label} to ${action}${resources.length && resources[0] !== '*' ? ` ${resources.slice(0, 3).join(', ')}` : ''}?`,
            options: [ALLOW, REJECT],
            approval: {
              action: actionKind(action),
              permissionKey: acpPermissionKey(permissionKind(action)),
              tool: { name: tool?.name ?? action, input: { action, resources, ...(tool?.input ? { input: tool.input } : {}) }, cwd: input.cwd }
            }
          }, { signal: abort.signal })
        } finally {
          input.signal?.removeEventListener('abort', onAbort)
          if (callId) input.onToolAwaiting?.(callId, false)
        }
        await reply(picked === ALLOW.optionId && !input.signal?.aborted ? 'once' : 'reject')
      } catch {
        // Anything that went wrong while asking is a reject.
        await reply('reject')
      }
    }

    const closeTool = (callId: string, status: 'completed' | 'failed' | 'unfinished', result?: string) => {
      const tool = openTools.get(callId)
      if (!tool) return
      openTools.delete(callId)
      const activity = toolActivity(tool.name, tool.input, input.cwd)
      // The result text is a command's, search's or other call's output, as other runtimes' rows keep it (the transcript
      // bounds it; a computer use call's is held to its allowlist by the turn's tool mapper). A web search that succeeded
      // keeps the results it lists; a file change, or a failed search, keeps its result as the row's summary.
      const results = activity.kind === 'web_search' && status === 'completed' && result ? webSearchResults(result) : undefined
      const kept = !result
        ? {}
        : activity.kind === 'command' || activity.kind === 'search' || activity.kind === 'generic'
          ? { output: result }
          : results
            ? { results }
            : { summary: result.slice(0, 2_000) }
      input.onTool?.({
        phase: 'complete',
        callId,
        title: toolTitle(tool.name, tool.input),
        toolName: tool.name,
        status,
        activity: { ...activity, ...kept }
      })
    }

    const onEvent = (event: Record<string, unknown>) => {
      const type = str(event.type) ?? ''
      const data = isRecord(event.data) ? event.data : {}
      const block = `${str(data.assistantMessageID) ?? ''}:${typeof data.ordinal === 'number' ? data.ordinal : 0}`
      switch (type) {
        case 'session.text.delta': {
          const next = (blocks.get(block) ?? '') + (str(data.delta) ?? '')
          text = update(blocks, block, next, true)
          input.onText(text)
          return
        }
        case 'session.text.ended': {
          if (typeof data.text !== 'string') return
          text = update(blocks, block, data.text, true)
          input.onText(text)
          return
        }
        case 'session.reasoning.delta': {
          thinking = update(thoughts, block, (thoughts.get(block) ?? '') + (str(data.delta) ?? ''), false)
          input.onThinking?.(thinking)
          return
        }
        case 'session.reasoning.ended': {
          if (typeof data.text !== 'string') return
          thinking = update(thoughts, block, data.text, false)
          input.onThinking?.(thinking)
          return
        }
        case 'session.tool.input.started': {
          const callId = str(data.id)
          const name = str(data.name) ?? 'tool'
          if (!callId || openTools.has(callId)) return
          openTools.set(callId, { name })
          input.onTool?.({ phase: 'start', callId, title: name, toolName: name, activity: toolActivity(name, undefined, input.cwd) })
          return
        }
        case 'session.tool.called': {
          const callId = str(data.id)
          if (!callId) return
          const toolInput = isRecord(data.input) ? data.input : undefined
          const known = openTools.get(callId)
          const name = known?.name ?? str(data.name) ?? 'tool'
          openTools.set(callId, { name, ...(toolInput ? { input: toolInput } : {}) })
          input.onTool?.({ phase: known ? 'update' : 'start', callId, title: toolTitle(name, toolInput), toolName: name, activity: toolActivity(name, toolInput, input.cwd) })
          return
        }
        case 'session.tool.success': {
          const callId = str(data.id)
          if (callId) closeTool(callId, 'completed', contentText(data.content))
          return
        }
        case 'session.tool.failed': {
          const callId = str(data.id)
          const error = isRecord(data.error) ? str(data.error.message) : undefined
          if (callId) closeTool(callId, 'failed', error ?? contentText(data.content))
          return
        }
        case 'session.step.started':
          input.onProviderTurn?.()
          return
        case 'session.step.ended':
        case 'session.step.failed': {
          const tokens = isRecord(data.tokens) ? data.tokens : undefined
          if (!tokens) return
          const cache = isRecord(tokens.cache) ? tokens.cache : {}
          reportedUsage = true
          usage.input += num(tokens.input)
          usage.output += num(tokens.output)
          usage.reasoning = (usage.reasoning ?? 0) + num(tokens.reasoning)
          usage.cacheRead += num(cache.read)
          usage.cacheWrite += num(cache.write)
          usage.totalTokens = usage.input + usage.output + (usage.reasoning ?? 0) + usage.cacheRead + usage.cacheWrite
          if (num(tokens.output) > 0) usage.hasOutput = true
          return
        }
        case 'permission.asked':
          void answer(data)
          return
        case 'form.created': {
          // A question nobody in Mousse answers (the `question` tool is not offered; a form from elsewhere is declined).
          const form = isRecord(data.form) ? data.form : data
          const formId = str(form.id)
          if (formId) void client.request('DELETE', `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}`).catch(() => undefined)
          return
        }
        case 'session.execution.succeeded':
          ending?.({ kind: 'succeeded' })
          return
        case 'session.execution.failed':
          ending?.({ kind: 'failed', error: data.error })
          return
        case 'session.execution.interrupted':
          ending?.({ kind: 'interrupted' })
          return
        case 'server.ended':
          ending?.({ kind: 'failed', error: { type: 'provider.transport', message: `${label}'s server ended.` } })
      }
    }

    this.listeners.set(sessionId, onEvent)
    this.running.set(input.threadId, sessionId)
    let stopping = false
    const stop = () => {
      if (stopping) return
      stopping = true
      void client.request('POST', `/api/session/${encodeURIComponent(sessionId)}/interrupt`).catch(() => undefined)
      // OpenCode confirms with `session.execution.interrupted`; past the wait the turn ends anyway.
      const timer = setTimeout(() => ending?.({ kind: 'interrupted' }), this.options.interruptWaitMs ?? 10_000)
      timer.unref?.()
    }
    input.signal?.addEventListener('abort', stop, { once: true })

    return (async () => {
      try {
        await client.request('POST', `/api/session/${encodeURIComponent(sessionId)}/prompt`, { body, ...(input.signal ? { signal: input.signal } : {}) })
          .catch((error: unknown) => {
            if (input.signal?.aborted) return
            throw error
          })
        input.onProviderTurn?.()
        if (input.signal?.aborted) stop()
        const end = await ended
        for (const callId of [...openTools.keys()]) closeTool(callId, 'unfinished')
        if (reportedUsage) input.onUsage?.(usage)
        if (end.kind === 'failed' && !input.signal?.aborted) {
          // The run failed: the session holds the request, so the next turn resumes it.
          this.interrupted.set(input.threadId, sessionId)
          throw opencodeTurnError(label, end.error)
        }
        if (end.kind === 'interrupted' || input.signal?.aborted) this.interrupted.set(input.threadId, sessionId)
        return text
      } finally {
        input.signal?.removeEventListener('abort', stop)
        this.listeners.delete(sessionId)
        if (this.running.get(input.threadId) === sessionId) this.running.delete(input.threadId)
      }
    })()
  }

  /** Record the canonical history that the owning turn durably committed. */
  commitConversation(threadId: string, history: string): void {
    const saved = this.options.store.saved(threadId)
    if (!saved) return
    this.options.store.setSaved(threadId, { ...saved, historyKey: this.historyKey(history) })
  }

  /** A turn that did not finish left its session resumable with the history it left. */
  commitInterrupted(threadId: string, history: string): void {
    const sessionId = this.interrupted.get(threadId)
    this.interrupted.delete(threadId)
    const saved = this.options.store.saved(threadId)
    if (!sessionId || !saved || saved.sessionId !== sessionId) return
    this.options.store.setSaved(threadId, { ...saved, historyKey: this.historyKey(history) })
  }

  /** Drops the thread's session; its next turn starts a new one with the history in the prompt. */
  forgetConversation(threadId: string): void {
    this.interrupted.delete(threadId)
    if (this.options.store.saved(threadId)) this.options.store.setSaved(threadId, undefined)
  }

  /** Stops the run of the session `sessionId`, when one runs. */
  async interrupt(sessionId: string | undefined): Promise<'interrupted' | 'not_active'> {
    if (!sessionId || !this.listeners.has(sessionId) || !this.options.server.running()) return 'not_active'
    const client = await this.options.server.client()
    const reply = await client.request('POST', `/api/session/${encodeURIComponent(sessionId)}/interrupt`).catch(() => undefined)
    return isRecord(reply) && reply.interrupted === false ? 'not_active' : 'interrupted'
  }

  /** Whether a turn runs now. */
  busy(): boolean {
    return this.running.size > 0
  }

  /** Mousse's MCP server of a thread is no longer needed (its conversation was dropped). */
  async detachMcp(threadId: string): Promise<void> {
    const name = mousseServerName(threadId)
    const servers = [name, `${name}_relay`].filter((server) => this.attached.delete(server))
    if (!servers.length || !this.options.server.running()) return
    const client = await this.options.server.client()
    for (const server of servers)
      await client.request('DELETE', `/api/experimental/mcp/${encodeURIComponent(server)}`).catch((error: unknown) => {
        if (!(error instanceof OpencodeApiError)) throw error
      })
  }
}

function modelBody(ref: ModelRef): Record<string, string> {
  return { providerID: ref.providerID, id: ref.id, ...(ref.variant ? { variant: ref.variant } : {}) }
}
