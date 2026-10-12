import { createHash } from 'node:crypto'
import { accessSync, constants, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { AppError } from '../../../shared/errors'
import { CODEX_INSTANCE_ID } from '../../../shared/providerInstances'
import { parseThinkingSuffixFromModelId } from '../../../shared/modelVariants'
import type { CodexStatus, ConfiguredProvider, ProviderLoginOption, ProviderLoginResult } from '../../../shared/providerAuth'
import type { LlmModelOption, LlmProviderOption } from '../../../shared/settings'
import type { ChatImageAttachment } from '../../../shared/types'
import { atomicWriteJsonSync } from '../../data/AtomicFs'
import type { UserQuestionService } from '../../orchestrator/UserQuestionService'
import { codexMcpConfigOverrides } from '../../run/mcp/attachment'
import type { LoginSession } from '../LoginSession'
import {
  CodexAppServerClient,
  CodexRpcError,
  spawnCodexAppServer,
  type CodexConnection,
  type CodexLaunch,
  type CodexProcess
} from './CodexAppServerClient'
import {
  RPC_METHOD_NOT_FOUND,
  notificationParams,
  type AccountReadResponse,
  type CodexNotification,
  type CodexServerRequest,
  type CodexServerRequestMap,
  type CodexTurn,
  type ModelListResponse,
  type SandboxPolicy,
  type ThreadConfig,
  type ThreadItem,
  type TokenUsageBreakdown,
  type UserInput
} from './protocol'

export const CODEX_PROVIDER_ID = 'codex'
/** How long a live `account/read` result stands before it is checked again. */
export const CODEX_ACCOUNT_TTL_MS = 5 * 60_000
/** Model id that leaves the choice to the user's Codex config (`model` in `config.toml`). */
export const CODEX_DEFAULT_MODEL_ID = 'default'
/** Offered until `model/list` has run once (or when it fails). */
export const CODEX_FALLBACK_MODELS: LlmModelOption[] = [
  { id: CODEX_DEFAULT_MODEL_ID, label: 'Codex default (from your Codex config)' }
]
/**
 * Codex's built-in provider for OpenAI models, which uses the ChatGPT sign-in. Codex refuses to let
 * any config layer redefine it (`model_providers` cannot contain built-in ids), so pinning it per
 * thread keeps custom providers from user or workspace config, with their `env_key` or static
 * credentials, out of Mousse turns.
 */
export const CODEX_MODEL_PROVIDER = 'openai'
const CLIENT_VERSION = '0.1.1'
const INTERRUPT_TIMEOUT_MS = 5_000
/** A stopped turn must settle on the server before the thread takes a new one. */
const PREVIOUS_TURN_SETTLE_MS = 10_000
/** How long a stopped turn's routing is kept while the server settles it. */
const STOPPED_TURN_RELEASE_MS = 30_000
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

type SavedThread = {
  codexThreadId: string
  cwd: string
  /** Provider instance that owns the Codex thread; absent means the default `codex` instance. */
  instanceId?: string
  /** Fingerprint of the canonical history the thread holds; set only after the turn commits. */
  historyKey?: string
}
type Settings = {
  /** Absolute path chosen in Settings; PATH lookup otherwise. */
  binaryPath?: string
  models?: LlmModelOption[]
  /** Disconnected in Mousse; the terminal sign-in in `~/.codex` stays intact. */
  disconnected?: boolean
  threads?: Record<string, SavedThread>
}
type AccountProbe =
  | { kind: 'signed_in'; planType: string; email: string | null }
  | { kind: 'signed_out'; message: string }
  | { kind: 'error'; message: string }

export type { CodexStatus }

export type CodexServiceDependencies = {
  /** Starts the app-server process; tests and the replay kit substitute it. */
  launch?: (launch: CodexLaunch) => CodexProcess
  /** Overrides the PATH lookup (tests). */
  findBinary?: () => string | undefined
  /** Default per-request timeout (initialize, account/read, thread/start ...). */
  requestTimeoutMs?: number
}

export interface CodexToolEvent {
  phase: 'start' | 'complete'
  callId: string
  title: string
  toolName?: string
}

export interface CodexTurnUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  /** Reasoning tokens, a subset of `output`. */
  reasoning: number
  /** Prompt side of the last model call (the thread's context size) and the model's window. */
  context?: { input: number; cacheRead: number; cacheWrite: number; contextWindow?: number }
}

export type CodexChatInput = {
  threadId: string
  /** Provider instance running the turn; a saved Codex thread resumes only on the same instance. */
  instanceId?: string
  cwd: string
  model: string
  prompt: string
  appletInstructions?: string
  /** Canonical prior turns; injected as a preamble when no matching Codex thread is resumed. */
  history?: string
  images?: ChatImageAttachment[]
  signal?: AbortSignal
  mode?: 'plan' | 'default'
  /** The Mousse MCP server for this run (SPEC §15.2); null attaches none. */
  mcp?: { url: string; token: string } | null
  /** Codex developer instructions for a new or resumed thread (SPEC §15.3). */
  developerInstructions?: string
  onText: (text: string) => void
  onThinking?: (text: string) => void
  onTool?: (event: CodexToolEvent) => void
  onLineEdits?: (lines: number) => void
  /** The server retries a failed model call itself (`error` with `willRetry`). */
  onRetry?: (attempt: number) => void
  /** The Codex thread (and, once known, turn) serving this chat. */
  onSession?: (session: { codexThreadId: string; turnId?: string }) => void
  drainSteer?: () => string | undefined
  onSteer?: (text: string) => void
}

export interface CodexChatResult {
  text: string
  codexThreadId: string
  turnId: string
  /** The model Codex ran (resolves `default`). */
  model: string
  /**
   * `broken`: the saved Codex thread could not be resumed, so this turn ran on a fresh thread with
   * the history injected as a prompt. `reusable`: the thread can be resumed next turn.
   */
  threadDisposition: 'reusable' | 'broken'
  usage?: CodexTurnUsage
}

/**
 * The environment of the app-server process. It reuses the terminal sign-in: `CODEX_HOME` is
 * never set (an inherited one is kept, as the terminal `codex` would use it), so `~/.codex` and
 * its ChatGPT tokens are shared. API keys and OpenAI routing variables are always removed so a
 * turn can never bill an API key instead of the subscription, and variables a parent Codex
 * session sets for its own sandbox do not leak in.
 */
export function codexEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source }
  for (const key of Object.keys(env)) {
    if (
      /^(OPENAI_|AZURE_OPENAI_|CODEX_SANDBOX)/.test(key) ||
      ['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_THREAD_ID', 'ELECTRON_RUN_AS_NODE'].includes(key)
    )
      delete env[key]
  }
  return env
}

/** `codex` on PATH (plus `~/.local/bin`, where the standalone installer puts it). */
export function findCodexBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex']
  for (const directory of [...(env.PATH ?? '').split(delimiter), join(homedir(), '.local', 'bin')]) {
    if (!directory) continue
    for (const name of names) {
      const candidate = resolve(directory, name)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        /* next */
      }
    }
  }
  return undefined
}

const historyKey = (history: string): string => createHash('sha256').update(history).digest('hex')

function classifyAccount(response: AccountReadResponse): AccountProbe {
  const account = response.account
  if (account?.type === 'chatgpt') return { kind: 'signed_in', planType: account.planType, email: account.email }
  if (account)
    return {
      kind: 'signed_out',
      message:
        'Codex in your terminal is signed in without a ChatGPT account. Mousse only uses a ChatGPT sign-in, so turns never bill an API key. Run `codex login` in a terminal, then recheck.'
    }
  return {
    kind: 'signed_out',
    message: 'Codex in your terminal is not signed in. Run `codex login` in a terminal, then recheck.'
  }
}

function toolEvent(item: ThreadItem, phase: 'start' | 'complete'): CodexToolEvent | undefined {
  switch (item.type) {
    case 'commandExecution': {
      const command = (item as { command?: string }).command ?? 'command'
      return { phase, callId: item.id, title: command.length > 200 ? `${command.slice(0, 200)}…` : command, toolName: 'shell' }
    }
    case 'fileChange': {
      const changes = (item as { changes?: Array<{ path: string }> }).changes ?? []
      const paths = changes.map((change) => change.path)
      return { phase, callId: item.id, title: paths.length ? `Edit ${paths.join(', ')}` : 'Edit files', toolName: 'apply_patch' }
    }
    case 'mcpToolCall': {
      const call = item as { server?: string; tool?: string }
      return { phase, callId: item.id, title: `${call.server}.${call.tool}`, toolName: `mcp__${call.server}__${call.tool}` }
    }
    case 'dynamicToolCall':
      return { phase, callId: item.id, title: (item as { tool?: string }).tool ?? 'tool', toolName: (item as { tool?: string }).tool }
    case 'webSearch':
      return { phase, callId: item.id, title: 'Web search', toolName: 'web_search' }
    case 'imageView':
      return { phase, callId: item.id, title: 'View image', toolName: 'view_image' }
    default:
      return undefined
  }
}

/** Lines a completed patch added or removed. */
function editedLines(item: ThreadItem): number {
  const changes = (item as { changes?: Array<{ kind?: { type?: string }; diff?: string }> }).changes ?? []
  let lines = 0
  for (const change of changes) {
    const diff = change.diff ?? ''
    if (change.kind?.type === 'add' || change.kind?.type === 'delete') lines += diff ? diff.split('\n').filter(Boolean).length : 0
    else
      for (const line of diff.split('\n'))
        if ((line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'))) lines += 1
  }
  return lines
}

function usageDelta(start: TokenUsageBreakdown, end: TokenUsageBreakdown): TokenUsageBreakdown {
  const keys: Array<keyof TokenUsageBreakdown> = [
    'totalTokens',
    'inputTokens',
    'cachedInputTokens',
    'cacheWriteInputTokens',
    'outputTokens',
    'reasoningOutputTokens'
  ]
  return Object.fromEntries(keys.map((key) => [key, Math.max(0, (end[key] ?? 0) - (start[key] ?? 0))])) as unknown as TokenUsageBreakdown
}

/** Codex reports input including cached tokens; Mousse counts uncached input separately. */
function promptSide(usage: TokenUsageBreakdown): { input: number; cacheRead: number; cacheWrite: number } {
  const cacheRead = usage.cachedInputTokens ?? 0
  const cacheWrite = usage.cacheWriteInputTokens ?? 0
  return { input: Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite), cacheRead, cacheWrite }
}

/** One Mousse chat on one Codex thread: the turns it starts and what they stream. */
class TurnRun {
  turnId: string | undefined
  /** The current Codex turn settled (any status). */
  private settle?: { resolve: (turn: CodexTurn) => void; reject: (error: unknown) => void }
  private readonly order: string[] = []
  private readonly parts = new Map<string, string>()
  private thinking = ''
  private lastReasoningItem: string | undefined
  private readonly items = new Map<string, ThreadItem>()
  private readonly openTools = new Map<string, CodexToolEvent>()
  private usageStart: TokenUsageBreakdown | undefined
  private usageEnd: { total: TokenUsageBreakdown; last: TokenUsageBreakdown; window: number | null } | undefined
  private retries = 0
  lastError: string | undefined
  interruptRequested = false
  /** A `turn/start` is on its way; its turn id is not known yet. */
  startInFlight = false
  /** The chat returned; late events only settle the turn and reach nobody. */
  private muted = false
  private readonly completedTurns = new Set<string>()
  private idleWaiters: Array<() => void> = []
  /** Resolves once the run is released: settled on the server, or the process died. */
  readonly finished: Promise<void>
  private finish!: () => void

  constructor(
    readonly codexThreadId: string,
    readonly mousseThreadId: string,
    readonly mode: 'plan' | 'default',
    readonly signal: AbortSignal,
    private readonly input: CodexChatInput
  ) {
    this.finished = new Promise((done) => (this.finish = done))
  }

  get text(): string {
    return this.order.map((id) => this.parts.get(id) ?? '').filter(Boolean).join('\n\n')
  }

  /** Waits for the next `turn/completed` of this thread. */
  nextCompletion(): Promise<CodexTurn> {
    return new Promise((resolveTurn, reject) => (this.settle = { resolve: resolveTurn, reject }))
  }

  mute(): void {
    this.muted = true
  }

  fail(error: unknown): void {
    this.settle?.reject(error)
    this.settle = undefined
    this.startInFlight = false
    this.wakeIdle(true)
    this.finish()
  }

  settled(): void {
    this.finish()
  }

  /** No Codex turn of this run is starting or running on the server. */
  isIdle(): boolean {
    return !this.startInFlight && (!this.turnId || this.completedTurns.has(this.turnId))
  }

  whenIdle(): Promise<void> {
    return this.isIdle() ? Promise.resolve() : new Promise((done) => this.idleWaiters.push(done))
  }

  wakeIdle(force = false): void {
    if (!force && !this.isIdle()) return
    for (const waiter of this.idleWaiters.splice(0)) waiter()
  }

  item(id: string): ThreadItem | undefined {
    return this.items.get(id)
  }

  usage(): CodexTurnUsage | undefined {
    if (!this.usageEnd) return undefined
    const turn = this.usageStart ? usageDelta(this.usageStart, this.usageEnd.total) : this.usageEnd.total
    const side = promptSide(turn)
    const context = promptSide(this.usageEnd.last)
    return {
      ...side,
      output: turn.outputTokens ?? 0,
      reasoning: turn.reasoningOutputTokens ?? 0,
      totalTokens: turn.totalTokens ?? 0,
      context: { ...context, ...(this.usageEnd.window ? { contextWindow: this.usageEnd.window } : {}) }
    }
  }

  closeTools(): void {
    for (const event of this.openTools.values()) this.input.onTool?.({ ...event, phase: 'complete' })
    this.openTools.clear()
  }

  handle(notification: CodexNotification): void {
    const started = notificationParams(notification, 'turn/started')
    if (started) {
      this.turnId ??= started.turn.id
      return
    }
    const completed = notificationParams(notification, 'turn/completed')
    if (completed) {
      this.completedTurns.add(completed.turn.id)
      if (!this.turnId || completed.turn.id === this.turnId) {
        this.settle?.resolve(completed.turn)
        this.settle = undefined
      }
      this.wakeIdle()
      return
    }
    if (this.muted) return
    const delta = notificationParams(notification, 'item/agentMessage/delta')
    if (delta) {
      if (!this.parts.has(delta.itemId)) this.order.push(delta.itemId)
      this.parts.set(delta.itemId, (this.parts.get(delta.itemId) ?? '') + delta.delta)
      this.input.onText(this.text)
      return
    }
    // Reasoning summaries only: raw reasoning text, when a model streams it too, would repeat them.
    const reasoning = notificationParams(notification, 'item/reasoning/summaryTextDelta')
    if (reasoning) {
      if (this.lastReasoningItem !== reasoning.itemId && this.thinking) this.thinking += '\n\n'
      this.lastReasoningItem = reasoning.itemId
      this.thinking += reasoning.delta
      this.input.onThinking?.(this.thinking)
      return
    }
    const itemStarted = notificationParams(notification, 'item/started')
    if (itemStarted) {
      const { item } = itemStarted
      this.items.set(item.id, item)
      if (item.type === 'agentMessage' && !this.parts.has(item.id)) {
        this.order.push(item.id)
        this.parts.set(item.id, (item as { text?: string }).text ?? '')
      }
      const event = toolEvent(item, 'start')
      if (event) {
        this.openTools.set(item.id, event)
        this.input.onTool?.(event)
      }
      return
    }
    const itemCompleted = notificationParams(notification, 'item/completed')
    if (itemCompleted) {
      const { item } = itemCompleted
      this.items.set(item.id, item)
      if (item.type === 'agentMessage') {
        const text = (item as { text?: string }).text ?? ''
        if (!this.parts.has(item.id)) this.order.push(item.id)
        if (this.parts.get(item.id) !== text) {
          this.parts.set(item.id, text)
          this.input.onText(this.text)
        }
      }
      const open = this.openTools.get(item.id)
      if (open) {
        this.openTools.delete(item.id)
        this.input.onTool?.({ ...open, ...toolEvent(item, 'complete'), phase: 'complete' })
      }
      if (item.type === 'fileChange' && (item as { status?: string }).status === 'completed') {
        const lines = editedLines(item)
        if (lines) this.input.onLineEdits?.(lines)
      }
      return
    }
    const usage = notificationParams(notification, 'thread/tokenUsage/updated')
    if (usage) {
      const { total, last, modelContextWindow } = usage.tokenUsage
      // Baseline: the thread total before this chat's first model call.
      this.usageStart ??= usageDelta(last, total)
      this.usageEnd = { total, last, window: modelContextWindow }
      return
    }
    const error = notificationParams(notification, 'error')
    if (error) {
      if (error.willRetry) this.input.onRetry?.(++this.retries)
      else this.lastError = error.error.message
    }
  }
}

/**
 * Codex as a Mousse provider through `codex app-server`, reusing the terminal sign-in
 * (`~/.codex`). One app-server process per profile, started on first use and again after it
 * exits. Each Mousse thread maps to a Codex thread, resumed while the canonical history it holds
 * matches; command, patch and user-input requests go to Mousse's question service. Disconnect
 * only clears Mousse's state: `account/logout` is never sent, so the terminal sign-in survives.
 */
export class CodexProviderService {
  private readonly dir: string
  private readonly settingsPath: string
  private settings: Settings = {}
  private settingsError?: string
  private stopped = false
  /** `verified`: this process answered `account/read` with a ChatGPT account. */
  private app?: { conn: CodexConnection; ready: Promise<CodexConnection>; verified: boolean }
  private probeResult?: { at: number; result: AccountProbe }
  private probing?: Promise<void>
  private modelDiscoveryStarted = false
  /** Bumped by disconnect; a turn from an older scope does not save its thread. */
  private scope = 0
  /** Running chats by Codex thread id. */
  private readonly turns = new Map<string, TurnRun>()
  /** Codex threads loaded in the current process, with the MCP token they were opened with. */
  private readonly loaded = new Map<string, { mcpToken: string | null; cwd: string }>()
  private readonly activeThreads = new Set<string>()
  private readonly controllers = new Set<AbortController>()
  private readonly readyToCommit = new Set<string>()

  constructor(
    private readonly profileHome: string,
    private readonly questions: UserQuestionService,
    private readonly dependencies: CodexServiceDependencies = {}
  ) {
    this.dir = join(profileHome, 'providers', CODEX_PROVIDER_ID)
    this.settingsPath = join(this.dir, 'settings.json')
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.settingsPath, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      this.settings = parsed as Settings
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT')
        this.settingsError = `Mousse could not read this profile's Codex settings (${this.settingsPath}). Fix or remove the file, then recheck.`
    }
  }

  private save(): void {
    if (this.settingsError) return
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(this.settingsPath, this.settings)
  }

  private binary(): string | undefined {
    const selected = this.settings.binaryPath
    if (!selected) return (this.dependencies.findBinary ?? findCodexBinary)()
    try {
      if (!isAbsolute(selected)) return undefined
      accessSync(selected, constants.X_OK)
      return selected
    } catch {
      return undefined
    }
  }

  standaloneWorkspace(threadId: string): string {
    const directory = join(this.dir, 'workspaces', historyKey(threadId))
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    return directory
  }

  // -------------------------------------------------------------------------------------------
  // Sign-in state

  /**
   * Synchronous view for routing and listings, from the last live `account/read` (see
   * `status()`); a stale result is refreshed in the background.
   */
  configured(): boolean {
    if (this.stopped || this.settingsError || this.settings.disconnected || !this.binary()) return false
    if (this.probeResult && this.checkDue()) void this.status()
    return this.probeResult?.result.kind === 'signed_in'
  }

  configuredProvider(): ConfiguredProvider | undefined {
    return this.configured()
      ? { id: CODEX_PROVIDER_ID, label: 'Codex', authType: 'oauth', source: 'Codex CLI · ChatGPT sign-in' }
      : undefined
  }

  loginOption(): ProviderLoginOption {
    return {
      id: CODEX_PROVIDER_ID,
      label: 'Codex',
      authType: 'oauth',
      configured: this.configured(),
      guidedLogin: true,
      description: 'Codex CLI · your ChatGPT sign-in'
    }
  }

  llmProvider(): LlmProviderOption | undefined {
    if (!this.configured()) return undefined
    return {
      id: CODEX_PROVIDER_ID,
      label: 'Codex',
      models: this.settings.models?.length ? this.settings.models : CODEX_FALLBACK_MODELS
    }
  }

  private checkDue(): boolean {
    if (this.stopped || this.settingsError || this.settings.disconnected) return false
    return !this.probeResult || Date.now() - this.probeResult.at >= CODEX_ACCOUNT_TTL_MS
  }

  private async probe(): Promise<AccountProbe> {
    try {
      const conn = await this.connection()
      return await this.readAccount(conn)
    } catch (error) {
      return {
        kind: 'error',
        message: `Codex did not report its sign-in (${error instanceof Error ? error.message : String(error)}). Update the Codex CLI and recheck.`
      }
    }
  }

  /** `account/read` on `conn`; a ChatGPT answer marks that process as verified. */
  private async readAccount(conn: CodexConnection, signal?: AbortSignal): Promise<AccountProbe> {
    const result = classifyAccount(await conn.request('account/read', { refreshToken: false }, { timeoutMs: 15_000, signal }))
    if (this.app?.conn === conn) this.app.verified = result.kind === 'signed_in'
    return result
  }

  /**
   * The app-server process, once it has itself reported a ChatGPT account. A process that has not
   * (a replacement after a crash, or one whose account changed) is checked before any thread or
   * turn reaches it.
   */
  private async verifiedConnection(signal: AbortSignal): Promise<CodexConnection> {
    const conn = await this.connection()
    signal.throwIfAborted()
    if (this.app?.conn === conn && this.app.verified) return conn
    const result = await this.readAccount(conn, signal)
    this.probeResult = { at: Date.now(), result }
    if (result.kind !== 'signed_in')
      throw new AppError({ code: 'codex_not_connected', message: this.signInMessage(), errorInfo: { category: 'unavailable', retryable: false } })
    return conn
  }

  /**
   * Checks the terminal sign-in with a live `account/read` when the cached result is missing,
   * older than five minutes, or `force` (Recheck) is set.
   */
  async status(options: { force?: boolean } = {}): Promise<CodexStatus> {
    if (options.force) {
      await this.probing
      this.probeResult = undefined
    }
    if (this.binary() && this.checkDue()) {
      this.probing ??= (async () => {
        const result = await this.probe()
        if (this.stopped) return
        this.probeResult = { at: Date.now(), result }
        if (result.kind === 'signed_in' && !this.settings.models?.length && !this.modelDiscoveryStarted) {
          this.modelDiscoveryStarted = true
          void this.refreshModels().catch(() => {
            /* the fallback model stays available */
          })
        }
      })().finally(() => {
        this.probing = undefined
      })
      await this.probing
    }
    return this.snapshot()
  }

  private snapshot(): CodexStatus {
    if (this.settingsError) return { state: 'error', message: this.settingsError }
    if (!this.binary())
      return { state: 'missing_binary', message: 'Codex CLI not found. Install the Codex CLI, then recheck.' }
    if (this.settings.disconnected)
      return { state: 'disconnected', message: 'Disconnected in Mousse. The Codex sign-in in your terminal is unchanged.' }
    const probe = this.probeResult
    if (!probe) return { state: 'error', message: 'Mousse has not checked the Codex sign-in yet.' }
    const checkedAt = new Date(probe.at).toISOString()
    if (probe.result.kind === 'signed_in') return { state: 'connected', checkedAt, planType: probe.result.planType }
    return { state: probe.result.kind, message: probe.result.message, checkedAt }
  }

  /**
   * Connects Codex for this profile. Codex is signed in from the terminal (`codex login`); Mousse
   * never runs a login or logout itself, it only checks and offers a Recheck.
   */
  async login(session: LoginSession, _cwd: string): Promise<ProviderLoginResult> {
    const checkpoint = (): void => {
      session.abort.signal.throwIfAborted()
      if (this.stopped) throw new Error('Codex provider is stopped')
    }
    try {
      checkpoint()
      if (this.settingsError) throw new Error(this.settingsError)
      const interaction = session.createAuthCallbacks()
      if (!this.binary()) {
        const binary = await interaction.prompt({
          type: 'text',
          message: 'Install the Codex CLI, then enter its absolute executable path',
          placeholder: '/home/me/.local/bin/codex'
        })
        checkpoint()
        if (!isAbsolute(binary)) throw new Error('Codex binary path must be absolute')
        this.settings.binaryPath = binary
        if (!this.binary()) throw new Error('Codex executable is unavailable')
      }
      delete this.settings.disconnected
      this.save()
      for (;;) {
        const status = await this.status({ force: true })
        checkpoint()
        if (status.state === 'connected') break
        const answer = await interaction.prompt({
          type: 'select',
          message: `${status.message ?? 'Codex is not signed in.'} Mousse shares that sign-in and its ChatGPT usage limits.`,
          options: [
            { id: 'check', label: 'Check sign-in' },
            { id: 'cancel', label: 'Cancel' }
          ]
        })
        checkpoint()
        if (answer !== 'check') throw new Error('Codex sign-in cancelled')
      }
      try {
        await this.refreshModels()
      } catch {
        interaction.notify({ type: 'progress', message: 'Signed in. Model discovery is unavailable; your Codex default model is available.' })
      }
      checkpoint()
      return { success: true, sessionId: session.sessionId }
    } catch (error) {
      return { success: false, sessionId: session.sessionId, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Lists the account's models (`model/list`, every page) and stores them for the picker. */
  async refreshModels(): Promise<LlmModelOption[]> {
    const conn = await this.connection()
    const models: LlmModelOption[] = []
    let cursor: string | null = null
    for (let page = 0; page < 10; page += 1) {
      const response: ModelListResponse = await conn.request('model/list', cursor ? { cursor } : {})
      for (const model of response.data) {
        if (model.hidden) continue
        const efforts = model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort).filter((effort) => EFFORTS.has(effort))
        models.push({ id: model.id, label: model.displayName || model.id, ...(efforts.length ? { efforts } : {}) })
      }
      cursor = response.nextCursor
      if (!cursor) break
    }
    if (!models.length) throw new Error('Codex returned no models')
    this.settings.models = models
    this.save()
    return models
  }

  /** Disconnects this profile in Mousse only; the terminal sign-in is never logged out. */
  async logout(): Promise<void> {
    this.scope += 1
    this.settings.disconnected = true
    this.settings.threads = {}
    this.probeResult = undefined
    this.save()
    this.abortInFlight()
    this.app?.conn.close()
  }

  stop(): void {
    this.stopped = true
    this.abortInFlight()
    this.app?.conn.close()
  }

  private abortInFlight(): void {
    for (const controller of this.controllers) controller.abort(new Error('Codex was disconnected'))
    for (const threadId of this.activeThreads) this.questions.dismissAllForThread(threadId)
    this.readyToCommit.clear()
  }

  // -------------------------------------------------------------------------------------------
  // App-server process

  private connection(): Promise<CodexConnection> {
    if (this.stopped) return Promise.reject(new Error('Codex provider is stopped'))
    if (this.app && !this.app.conn.signal.aborted) return this.app.ready
    const binary = this.binary()
    if (!binary) return Promise.reject(new Error('Codex CLI not found. Install the Codex CLI first.'))
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const process = (this.dependencies.launch ?? spawnCodexAppServer)({ binary, args: [], env: codexEnvironment(), cwd: this.dir })
    const conn = new CodexAppServerClient(process, { defaultTimeoutMs: this.dependencies.requestTimeoutMs })
    conn.onNotification((notification) => this.route(notification))
    conn.setServerRequestHandler((request) => this.serve(request))
    conn.signal.addEventListener('abort', () => this.lost(conn, conn.signal.reason), { once: true })
    const ready = conn
      .request('initialize', {
        clientInfo: { name: 'mousse', title: 'Mousse', version: CLIENT_VERSION },
        capabilities: { experimentalApi: false, requestAttestation: false }
      })
      .then(() => {
        conn.notify('initialized')
        return conn
      })
    ready.catch(() => conn.close())
    this.app = { conn, ready, verified: false }
    return ready
  }

  /** The process is gone: every chat on it fails; the next use starts a new one. */
  private lost(conn: CodexConnection, reason: unknown): void {
    if (this.app?.conn !== conn) return
    this.app = undefined
    this.loaded.clear()
    // The next process must prove its own sign-in before it gets a turn.
    this.probeResult = undefined
    for (const [threadId, run] of [...this.turns]) {
      this.turns.delete(threadId)
      run.fail(reason)
    }
  }

  private route(notification: CodexNotification): void {
    const account = notificationParams(notification, 'account/updated')
    if (account) {
      // A terminal `codex login --api-key` or logout reaches the shared process; re-check.
      if (account.authMode !== 'chatgpt') {
        this.probeResult = undefined
        if (this.app) this.app.verified = false
      }
      return
    }
    const threadId = (notification.params as { threadId?: unknown } | undefined)?.threadId
    if (typeof threadId === 'string') this.turns.get(threadId)?.handle(notification)
  }

  private async serve(request: CodexServerRequest): Promise<unknown> {
    const params = (request.params ?? {}) as { threadId?: string; itemId?: string }
    const run = params.threadId ? this.turns.get(params.threadId) : undefined
    type Result<M extends keyof CodexServerRequestMap> = CodexServerRequestMap[M]['result']
    switch (request.method) {
      case 'item/commandExecution/requestApproval': {
        const approval = request.params as CodexServerRequestMap['item/commandExecution/requestApproval']['params']
        if (!run || run.signal.aborted) return { decision: 'cancel' } satisfies Result<'item/commandExecution/requestApproval'>
        if (run.mode === 'plan') return { decision: 'decline' } satisfies Result<'item/commandExecution/requestApproval'>
        const command = approval.command ?? (run.item(approval.itemId) as { command?: string } | undefined)?.command ?? 'a command'
        const decision = await this.approve(
          run,
          `Allow Codex to run this command?\n${command}${approval.cwd ? `\nin ${approval.cwd}` : ''}${approval.reason ? `\n${approval.reason}` : ''}`
        )
        return { decision } satisfies Result<'item/commandExecution/requestApproval'>
      }
      case 'item/fileChange/requestApproval': {
        const approval = request.params as CodexServerRequestMap['item/fileChange/requestApproval']['params']
        if (!run || run.signal.aborted) return { decision: 'cancel' } satisfies Result<'item/fileChange/requestApproval'>
        if (run.mode === 'plan') return { decision: 'decline' } satisfies Result<'item/fileChange/requestApproval'>
        const changes = (run.item(approval.itemId) as { changes?: Array<{ path: string }> } | undefined)?.changes ?? []
        const decision = await this.approve(
          run,
          `Allow Codex to edit ${changes.length ? changes.map((change) => change.path).join(', ') : 'files'}?${approval.reason ? `\n${approval.reason}` : ''}`
        )
        return { decision } satisfies Result<'item/fileChange/requestApproval'>
      }
      case 'item/tool/requestUserInput': {
        const input = request.params as CodexServerRequestMap['item/tool/requestUserInput']['params']
        if (!run || run.signal.aborted) throw new Error('No Mousse turn is waiting for this answer')
        const answers = await this.questions.requestAnswers(
          input.questions.map((question) => ({
            id: question.id,
            prompt: question.header ? `${question.header}\n${question.question}` : question.question,
            options: (question.options ?? []).map((option) => ({ id: option.label, label: option.label }))
          })),
          run.mousseThreadId,
          { signal: run.signal }
        )
        return {
          answers: Object.fromEntries(
            input.questions.map((question) => {
              const value = answers[question.id]
              return [question.id, { answers: Array.isArray(value) ? value : value ? [value] : [] }]
            })
          )
        } satisfies Result<'item/tool/requestUserInput'>
      }
      case 'item/permissions/requestApproval':
        // Extra sandbox permissions are never granted from Mousse.
        return { permissions: {}, scope: 'turn' } satisfies Result<'item/permissions/requestApproval'>
      case 'mcpServer/elicitation/request':
        return { action: 'decline', content: null, _meta: null } satisfies Result<'mcpServer/elicitation/request'>
      default:
        throw new CodexRpcError(request.method, RPC_METHOD_NOT_FOUND, `Mousse does not handle ${request.method}`)
    }
  }

  private async approve(run: TurnRun, prompt: string): Promise<'accept' | 'acceptForSession' | 'decline' | 'cancel'> {
    try {
      const answer = await this.questions.requestAnswers(
        [
          {
            id: 'permission',
            prompt,
            options: [
              { id: 'allow', label: 'Allow once' },
              { id: 'allow_session', label: 'Allow for this session' },
              { id: 'reject', label: 'Reject' }
            ]
          }
        ],
        run.mousseThreadId,
        { signal: run.signal }
      )
      if (run.signal.aborted) return 'cancel'
      return answer.permission === 'allow' ? 'accept' : answer.permission === 'allow_session' ? 'acceptForSession' : 'decline'
    } catch {
      return run.signal.aborted ? 'cancel' : 'decline'
    }
  }

  // -------------------------------------------------------------------------------------------
  // Turns

  /** Records the canonical history the thread's Codex thread now holds (after a committed turn). */
  commitConversation(threadId: string, history: string): void {
    if (!this.readyToCommit.delete(threadId)) return
    const saved = this.settings.threads?.[threadId]
    if (saved) {
      saved.historyKey = historyKey(history)
      this.save()
    }
  }

  /** Interrupts the running turn on `codexThreadId`, if any. */
  async interrupt(codexThreadId: string | undefined): Promise<'interrupted' | 'not_active'> {
    const run = codexThreadId ? this.turns.get(codexThreadId) : undefined
    if (!run) return 'not_active'
    this.requestInterrupt(run)
    return 'interrupted'
  }

  /** Adds `text` to the running turn on `codexThreadId` (`turn/steer`). */
  async steer(codexThreadId: string | undefined, text: string): Promise<'delivered' | 'not_active'> {
    const run = codexThreadId ? this.turns.get(codexThreadId) : undefined
    const conn = this.app?.conn
    if (!run?.turnId || !conn || run.signal.aborted) return 'not_active'
    try {
      await conn.request('turn/steer', { threadId: run.codexThreadId, expectedTurnId: run.turnId, input: [textInput(text)] })
      return 'delivered'
    } catch {
      return 'not_active'
    }
  }

  private requestInterrupt(run: TurnRun): void {
    if (run.interruptRequested) return
    run.interruptRequested = true
    if (run.turnId) this.sendInterrupt(run)
  }

  private sendInterrupt(run: TurnRun): void {
    const conn = this.app?.conn
    if (!conn || !run.turnId) return
    void conn
      .request('turn/interrupt', { threadId: run.codexThreadId, turnId: run.turnId }, { timeoutMs: INTERRUPT_TIMEOUT_MS })
      .catch(() => {
        /* the turn ended meanwhile, or the process is gone */
      })
  }

  /**
   * Opens the thread's Codex thread for this turn: the loaded one, a resumed saved one, or a new
   * one. A failed resume starts a new thread and reports `broken`.
   */
  private async openThread(
    conn: CodexConnection,
    input: CodexChatInput,
    signal: AbortSignal
  ): Promise<{ codexThreadId: string; model: string | undefined; continued: boolean; disposition: 'reusable' | 'broken' }> {
    const cwd = resolve(input.cwd)
    const saved = this.settings.threads?.[input.threadId]
    const mcpToken = input.mcp?.token ?? null
    const overrides = codexMcpConfigOverrides(input.mcp) as ThreadConfig
    const { baseId } = parseThinkingSuffixFromModelId(input.model)
    const params = {
      cwd,
      approvalPolicy: 'on-request' as const,
      sandbox: input.mode === 'plan' ? ('read-only' as const) : ('workspace-write' as const),
      ...(baseId !== CODEX_DEFAULT_MODEL_ID ? { model: baseId } : {}),
      // Pinned twice: the request field and the config layer above user and workspace config.
      modelProvider: CODEX_MODEL_PROVIDER,
      config: { ...overrides, model_provider: CODEX_MODEL_PROVIDER },
      ...(input.developerInstructions ? { developerInstructions: input.developerInstructions } : {})
    }
    // A Codex thread belongs to the instance that started it; another instance starts fresh.
    const resumable = saved && (saved.instanceId ?? CODEX_INSTANCE_ID) === (input.instanceId ?? CODEX_INSTANCE_ID) &&
      saved.cwd === cwd && saved.historyKey === historyKey(input.history ?? '')
    if (resumable) {
      const previous = this.turns.get(saved.codexThreadId)
      if (previous) {
        // A stopped turn of this thread is still settling on the server.
        await Promise.race([previous.finished, new Promise((done) => setTimeout(done, PREVIOUS_TURN_SETTLE_MS).unref?.())])
        signal.throwIfAborted()
        if (this.turns.has(saved.codexThreadId)) throw new Error('The previous Codex turn on this thread is still running')
      }
      const loaded = this.loaded.get(saved.codexThreadId)
      if (loaded && loaded.mcpToken === mcpToken && loaded.cwd === cwd)
        return { codexThreadId: saved.codexThreadId, model: undefined, continued: true, disposition: 'reusable' }
      try {
        const resumed = chatgptProvider(await conn.request('thread/resume', { threadId: saved.codexThreadId, excludeTurns: true, ...params }, { signal }))
        this.loaded.set(resumed.thread.id, { mcpToken, cwd })
        return { codexThreadId: resumed.thread.id, model: resumed.model, continued: true, disposition: 'reusable' }
      } catch (error) {
        signal.throwIfAborted()
        conn.signal.throwIfAborted()
        if (!(error instanceof CodexRpcError)) throw error
        const fresh = chatgptProvider(await conn.request('thread/start', params, { signal }))
        this.loaded.set(fresh.thread.id, { mcpToken, cwd })
        return { codexThreadId: fresh.thread.id, model: fresh.model, continued: false, disposition: 'broken' }
      }
    }
    const fresh = chatgptProvider(await conn.request('thread/start', params, { signal }))
    this.loaded.set(fresh.thread.id, { mcpToken, cwd })
    return { codexThreadId: fresh.thread.id, model: fresh.model, continued: false, disposition: 'reusable' }
  }

  async chat(input: CodexChatInput): Promise<CodexChatResult> {
    input.signal?.throwIfAborted()
    if (this.activeThreads.has(input.threadId)) throw new Error('A Codex turn is already running for this thread')
    this.activeThreads.add(input.threadId)
    const controller = new AbortController()
    this.controllers.add(controller)
    const forward = (): void => controller.abort(input.signal?.reason)
    input.signal?.addEventListener('abort', forward, { once: true })
    const signal = controller.signal
    const scope = this.scope
    let run: TurnRun | undefined
    let steerTimer: ReturnType<typeof setInterval> | undefined
    const onAbort = (): void => {
      this.questions.dismissAllForThread(input.threadId)
      if (run) this.requestInterrupt(run)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    this.readyToCommit.delete(input.threadId)
    try {
      if (this.checkDue()) await this.status()
      signal.throwIfAborted()
      if (!this.configured())
        throw new AppError({
          code: 'codex_not_connected',
          message: this.signInMessage(),
          errorInfo: { category: 'unavailable', retryable: false }
        })
      const images = (input.images ?? []).map((image): UserInput => {
        if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(image.mimeType) || Buffer.byteLength(image.data, 'base64') > 10 * 1024 * 1024)
          throw new Error(`Codex cannot send image ${image.name}; use JPEG, PNG, GIF or WebP under 10 MiB`)
        return { type: 'image', url: `data:${image.mimeType};base64,${image.data}` }
      })
      const conn = await this.verifiedConnection(signal)
      const thread = await this.openThread(conn, input, signal)
      const codexThreadId = thread.codexThreadId
      // The thread is not resumable until the turn commits its history.
      this.settings.threads = { ...this.settings.threads, [input.threadId]: { codexThreadId, cwd: resolve(input.cwd), instanceId: input.instanceId ?? CODEX_INSTANCE_ID } }
      this.save()
      input.onSession?.({ codexThreadId })
      const current = new TurnRun(codexThreadId, input.threadId, input.mode ?? 'default', signal, input)
      run = current
      this.turns.set(codexThreadId, current)
      const { baseId, effort } = parseThinkingSuffixFromModelId(input.model)
      const turnParams = {
        cwd: resolve(input.cwd),
        approvalPolicy: 'on-request' as const,
        sandboxPolicy: (input.mode === 'plan'
          ? { type: 'readOnly', networkAccess: false }
          : { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }) satisfies SandboxPolicy,
        ...(baseId !== CODEX_DEFAULT_MODEL_ID ? { model: baseId } : {}),
        ...(effort && EFFORTS.has(effort) ? { effort } : {})
      }

      // Steers join the running turn (`turn/steer`); one that arrives after the turn ended
      // starts the next turn instead.
      const undelivered: string[] = []
      let steering: Promise<void> = Promise.resolve()
      let turnOpen = false
      const deliver = (text: string): void => {
        steering = steering.then(async () => {
          if (!turnOpen || !current.turnId || signal.aborted) {
            undelivered.push(text)
            return
          }
          try {
            await conn.request('turn/steer', { threadId: codexThreadId, expectedTurnId: current.turnId, input: [textInput(text)] })
          } catch (error) {
            if (!(error instanceof CodexRpcError)) throw error
            undelivered.push(text)
          }
        })
        steering.catch(() => controller.abort(new Error('Codex steer delivery failed')))
      }
      const collectSteer = (): void => {
        if (signal.aborted) return
        const steer = input.drainSteer?.()?.trim()
        if (!steer) return
        input.onSteer?.(steer)
        deliver(steer)
      }
      if (input.drainSteer) {
        steerTimer = setInterval(() => {
          try {
            collectSteer()
          } catch (error) {
            controller.abort(error)
          }
        }, 100)
        steerTimer.unref?.()
      }
      const aborted = new Promise<never>((_resolve, reject) => {
        const fail = (): void => reject(signal.reason ?? new Error('Codex turn cancelled'))
        if (signal.aborted) fail()
        else signal.addEventListener('abort', fail, { once: true })
      })
      aborted.catch(() => undefined)

      const preamble =
        (input.appletInstructions ? input.appletInstructions + '\n\nCurrent request:\n' : '') +
        (!thread.continued && input.history
          ? `Previous conversation (context only; do not repeat earlier actions):\n${input.history}\n\nCurrent request:\n`
          : '')
      let nextInput: UserInput[] = [textInput(preamble + (input.prompt || '(image attachment)')), ...images]
      let lastTurn: CodexTurn | undefined
      for (;;) {
        current.turnId = undefined
        const completion = current.nextCompletion()
        completion.catch(() => undefined)
        current.startInFlight = true
        // Recorded even when Stop wins the race below, so the interrupt still reaches the turn.
        const starting = conn.request('turn/start', { threadId: codexThreadId, input: nextInput, ...turnParams }).then(
          (started) => {
            current.turnId ??= started.turn.id
            current.startInFlight = false
            current.wakeIdle()
            if (current.interruptRequested) this.sendInterrupt(current)
            return started
          },
          (error: unknown) => {
            current.startInFlight = false
            current.wakeIdle()
            throw error
          }
        )
        starting.catch(() => undefined)
        await Promise.race([starting, aborted])
        turnOpen = true
        input.onSession?.({ codexThreadId, turnId: current.turnId })
        // Steers drained before the turn existed go in now.
        for (const steer of undelivered.splice(0)) deliver(steer)
        lastTurn = await Promise.race([completion, aborted])
        turnOpen = false
        await steering
        collectSteer()
        await steering
        if (lastTurn.status === 'failed')
          throw new Error(lastTurn.error?.message ?? current.lastError ?? 'Codex turn failed')
        if (lastTurn.status === 'interrupted') {
          signal.throwIfAborted()
          throw new Error('Codex interrupted the turn')
        }
        if (!undelivered.length) break
        nextInput = [textInput(undelivered.splice(0).join('\n'))]
      }
      this.turns.delete(codexThreadId)
      current.settled()
      current.closeTools()
      if (scope === this.scope) {
        this.settings.threads = { ...this.settings.threads, [input.threadId]: { codexThreadId, cwd: resolve(input.cwd), instanceId: input.instanceId ?? CODEX_INSTANCE_ID } }
        this.save()
        this.readyToCommit.add(input.threadId)
      }
      return {
        text: current.text,
        codexThreadId,
        turnId: lastTurn.id,
        model: thread.model ?? baseId,
        threadDisposition: thread.disposition,
        usage: current.usage()
      }
    } catch (error) {
      run?.closeTools()
      if (signal.aborted && input.signal?.aborted) throw input.signal.reason ?? error
      throw error
    } finally {
      if (steerTimer) clearInterval(steerTimer)
      signal.removeEventListener('abort', onAbort)
      input.signal?.removeEventListener('abort', forward)
      this.controllers.delete(controller)
      this.activeThreads.delete(input.threadId)
      // A stopped turn stays registered (for routing) until the server settles it or the process dies.
      run?.mute()
      if (run && this.turns.get(run.codexThreadId) === run) {
        const pending = run
        const release = (): void => {
          if (this.turns.get(pending.codexThreadId) === pending) this.turns.delete(pending.codexThreadId)
          pending.settled()
        }
        if (pending.isIdle() || !this.app) release()
        else
          void Promise.race([pending.whenIdle(), new Promise((done) => setTimeout(done, STOPPED_TURN_RELEASE_MS).unref?.())]).then(
            release
          )
      }
    }
  }

  private signInMessage(): string {
    if (this.settings.disconnected) return 'Codex is disconnected. Reconnect it in Settings → Providers.'
    if (!this.binary()) return 'Codex CLI not found. Install the Codex CLI, then recheck in Settings → Providers.'
    const probe = this.probeResult?.result
    return probe && probe.kind !== 'signed_in'
      ? probe.message
      : 'Codex in your terminal is not signed in. Run `codex login` in a terminal, then try again.'
  }
}

/** Refuses a thread whose effective provider is not the ChatGPT-backed built-in one. */
function chatgptProvider<T extends { modelProvider?: string }>(response: T): T {
  if (response.modelProvider !== CODEX_MODEL_PROVIDER)
    throw new AppError({
      code: 'codex_provider_not_chatgpt',
      message: `Codex chose the model provider "${response.modelProvider ?? 'unknown'}" for this thread. Mousse only runs Codex on your ChatGPT sign-in.`,
      errorInfo: { category: 'unavailable', retryable: false }
    })
  return response
}

function textInput(text: string): UserInput {
  return { type: 'text', text, text_elements: [] }
}

/** Builds the profile's Codex service (registration seam; see `run/adapters/codex/index.ts`). */
export function createCodexProviderService(
  profileHome: string,
  questions: UserQuestionService,
  deps: CodexServiceDependencies = {}
): CodexProviderService {
  return new CodexProviderService(profileHome, questions, deps)
}
