import { createHash } from 'node:crypto'
import { accessSync, constants, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { AppError, redactSecrets } from '../../../shared/errors'
import { CODEX_INSTANCE_ID } from '../../../shared/providerInstances'
import { parseThinkingSuffixFromModelId } from '../../../shared/modelVariants'
import type {
  CliProviderConfig,
  CliProviderConfigPatch,
  CodexStatus,
  ConfiguredProvider,
  ProviderLoginOption,
  ProviderLoginResult
} from '../../../shared/providerAuth'
import type { LlmModelOption, LlmProviderOption } from '../../../shared/settings'
import type { ChatImageAttachment } from '../../../shared/types'
import { mousseVersion } from '../../appVersion'
import { atomicWriteJsonSync } from '../../data/AtomicFs'
import type { UserQuestionService } from '../../orchestrator/UserQuestionService'
import { codexMcpConfigOverrides } from '../../run/mcp/attachment'
import type { LoginSession } from '../LoginSession'
import {
  applyCliConfigPatch,
  cliLaunch,
  requireExecutable,
  sharedCliVersions,
  storedCliArgs,
  storedCliEnv,
  withUserEnv,
  type CliLaunch,
  type CliVersionCache
} from '../cliConfig'
import { resolveWindowsShim } from '../resolveWindowsShim'
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
import { codexTurnPolicy } from './childPolicy'
import { NativeHelpers, type StrayThread } from './nativeHelpers'
import { readCodexUserSetup, type CodexUserSetup } from './userSetup'
import type { ChildTurnPolicy } from '../../run/adapters/ProviderAdapter'

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
const INTERRUPT_TIMEOUT_MS = 5_000
/** A stopped turn must settle on the server before the thread takes a new one. */
const PREVIOUS_TURN_SETTLE_MS = 10_000
/** How long a stopped turn's routing is kept while the server settles it. */
const STOPPED_TURN_RELEASE_MS = 30_000
/** The app-server process is closed once it has been unused this long after a turn... */
export const CODEX_IDLE_CLOSE_MS = 60_000
/** ...or after a sign-in check or model listing that started it. */
export const CODEX_CHECK_CLOSE_MS = 5_000
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
  /** Extra arguments after `codex app-server`. */
  args?: string[]
  /** Extra environment variables, applied over `codexEnvironment()`. */
  env?: Record<string, string>
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
  /** Overrides both idle-close delays (tests). */
  idleCloseMs?: number
  /** `codex --version` lookups (tests). */
  versions?: CliVersionCache
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
  /** Set for a delegated child's turns (first and resumed); see `codexTurnPolicy`. */
  child?: ChildTurnPolicy
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
  /** Liveness while the turn only waits for the native helpers it started. */
  onHeartbeat?: () => void
}

export interface CodexChatResult {
  text: string
  codexThreadId: string
  turnId: string
  /** The model Codex ran (resolves `default`). */
  model: string
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

/**
 * `codex` on PATH (plus `~/.local/bin`, where the standalone installer puts it). On Windows an npm
 * `codex.cmd` shim counts only when it resolves to the program it runs (see `resolveWindowsShim`).
 */
export function findCodexBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex']
  for (const directory of [...(env.PATH ?? '').split(delimiter), join(homedir(), '.local', 'bin')]) {
    if (!directory) continue
    for (const name of names) {
      const candidate = resolve(directory, name)
      try {
        accessSync(candidate, constants.X_OK)
      } catch {
        continue
      }
      if (resolveWindowsShim(candidate, { env })) return candidate
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
  private readonly questionsDone = new AbortController()
  /** Ends this run's pending questions: the turn stopped, ended, or lost its process. */
  readonly questionSignal: AbortSignal
  private readonly completedTurns = new Set<string>()
  private idleWaiters: Array<() => void> = []
  /** Resolves once the run is released: settled on the server, or the process died. */
  readonly finished: Promise<void>
  /** Codex's own subagents this turn started; they outlive the parent's turn unless Mousse waits for them. */
  readonly helpers: NativeHelpers
  private finish!: () => void

  constructor(
    readonly codexThreadId: string,
    readonly mousseThreadId: string,
    readonly mode: 'plan' | 'default',
    readonly signal: AbortSignal,
    private readonly input: CodexChatInput,
    stray?: (threadId: string) => StrayThread | undefined
  ) {
    this.helpers = new NativeHelpers(stray)
    this.finished = new Promise((done) => (this.finish = done))
    this.questionSignal = AbortSignal.any([signal, this.questionsDone.signal])
  }

  cancelQuestions(): void {
    this.questionsDone.abort(new Error('The Codex turn ended'))
  }

  /** A read-only (`shared`) delegated child: every command and file change is declined, never asked. */
  get readOnlyChild(): boolean {
    return this.input.child?.readOnly === true
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
    this.helpers.close(error)
    this.cancelQuestions()
    this.settle?.reject(error)
    this.settle = undefined
    this.startInFlight = false
    this.wakeIdle(true)
    this.finish()
  }

  settled(): void {
    this.finish()
  }

  /** The current Codex turn has already settled on the server. */
  turnCompleted(): boolean {
    return this.turnId !== undefined && this.completedTurns.has(this.turnId)
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
      this.helpers.noteItem(item as never)
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
      this.helpers.noteItem(item as never)
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
 * (`~/.codex`). One app-server process per profile, started on first use and closed when idle
 * (about 70 MB that would otherwise stay resident for the whole session). Each Mousse thread maps to a Codex thread, resumed while the canonical history it holds
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
  private app?: { conn: CodexConnection; ready: Promise<CodexConnection>; verified: boolean; generation: number }
  /** Bumped when the launch settings change; a process from an older generation is replaced once idle. */
  private launchGeneration = 0
  private probeResult?: { at: number; result: AccountProbe }
  private probing?: Promise<void>
  private modelDiscoveryStarted = false
  /** Model listings in flight; they keep the process open. */
  private listing = 0
  private idleClose?: { timer: ReturnType<typeof setTimeout>; at: number }
  /** Bumped by disconnect; a turn from an older scope does not save its thread. */
  private scope = 0
  /** Running chats by Codex thread id. */
  private readonly turns = new Map<string, TurnRun>()
  /**
   * Codex threads loaded in the current process, with the MCP token and cwd they were opened with.
   * Only cold opens (start, resume of an unloaded thread, fork) record an entry: Codex applies
   * config overrides when it loads a thread and ignores them on an already-loaded one.
   */
  private readonly strays = new Map<string, StrayThread>()
  /** Helpers of finished chats that were told to stop before their turn id was known. */
  private readonly orphans = new Set<NativeHelpers>()
  private readonly loaded = new Map<string, { mcpToken: string | null; cwd: string; childKey: string }>()
  private readonly activeThreads = new Set<string>()
  private readonly controllers = new Set<AbortController>()
  private readonly readyToCommit = new Set<string>()
  /** Mousse MCP tokens handed to Codex; never echoed into errors or status messages. */
  private readonly secrets = new Set<string>()

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

  /** How to start Codex: the chosen or detected executable, with an npm shim resolved. */
  private launchTarget(): CliLaunch | undefined {
    return cliLaunch(this.settings.binaryPath || (this.dependencies.findBinary ?? findCodexBinary)())
  }

  /** The program that runs (reported as `resolvedBinaryPath`). */
  private binary(): string | undefined {
    return this.launchTarget()?.path
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
        message: this.redact(`Codex did not report its sign-in (${error instanceof Error ? error.message : String(error)}). Update the Codex CLI and recheck.`)
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
        this.closeWhenIdle(CODEX_CHECK_CLOSE_MS)
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
      return { success: false, sessionId: session.sessionId, error: this.redact(error instanceof Error ? error.message : String(error)) }
    }
  }

  /** Lists the account's models (`model/list`, every page) and stores them for the picker. */
  async refreshModels(): Promise<LlmModelOption[]> {
    this.listing += 1
    try {
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
    } finally {
      this.listing -= 1
      this.closeWhenIdle(CODEX_CHECK_CLOSE_MS)
    }
  }

  /**
   * The user's effective Codex setup for `cwd` (its enabled MCP servers), read without changing it;
   * see `readCodexUserSetup`. A read-only child runs only where the user has no MCP server, because
   * Mousse cannot deny a Codex MCP tool call. A null field could not be read.
   */
  async userSetup(cwd: string | null): Promise<CodexUserSetup> {
    this.listing += 1
    try {
      return await readCodexUserSetup(await this.connection(), cwd ? resolve(cwd) : null)
    } catch {
      return { mcpServers: null }
    } finally {
      this.listing -= 1
      this.closeWhenIdle(CODEX_CHECK_CLOSE_MS)
    }
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

  /** The executable path, launch args and environment set in Settings → Providers. */
  async cliConfig(): Promise<CliProviderConfig> {
    const launch = this.launchTarget()
    return {
      instanceId: CODEX_INSTANCE_ID,
      ...(this.settings.binaryPath ? { binaryPath: this.settings.binaryPath } : {}),
      ...(launch ? { resolvedBinaryPath: launch.path } : {}),
      version: await (this.dependencies.versions ?? sharedCliVersions).version(launch, this.environment()),
      args: storedCliArgs(this.settings),
      env: storedCliEnv(this.settings)
    }
  }

  /**
   * Saves the launch settings. The app-server process is long-lived, so one started with the old
   * settings is replaced: at once when idle, otherwise when its running turns and checks finish.
   * A changed executable re-checks the sign-in.
   */
  async setCliConfig(patch: CliProviderConfigPatch): Promise<CliProviderConfig> {
    if (this.stopped) throw new Error('Codex provider is stopped')
    if (this.settingsError) throw new Error(this.settingsError)
    const before = this.binary()
    applyCliConfigPatch(this.settings, patch, (path) => requireExecutable(path, 'Codex'))
    this.save()
    this.launchGeneration += 1
    if (this.app) {
      if (this.busy()) this.closeWhenIdle(CODEX_CHECK_CLOSE_MS)
      else this.closeProcess()
    }
    if (this.binary() !== before) await this.status({ force: true })
    return this.cliConfig()
  }

  stop(): void {
    this.stopped = true
    if (this.idleClose) clearTimeout(this.idleClose.timer)
    this.idleClose = undefined
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
    const target = this.launchTarget()
    if (!target) return Promise.reject(new Error('Codex CLI not found. Install the Codex CLI first.'))
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const process = (this.dependencies.launch ?? spawnCodexAppServer)({
      binary: target.command,
      ...(target.args.length ? { entryArgs: target.args } : {}),
      args: storedCliArgs(this.settings),
      env: this.environment(),
      cwd: this.dir
    })
    const conn = new CodexAppServerClient(process, { defaultTimeoutMs: this.dependencies.requestTimeoutMs, secrets: () => this.secrets })
    conn.onNotification((notification) => this.route(notification))
    conn.setServerRequestHandler((request) => this.serve(request))
    conn.signal.addEventListener('abort', () => this.lost(conn, conn.signal.reason), { once: true })
    const ready = conn
      .request('initialize', {
        clientInfo: { name: 'mousse', title: 'Mousse', version: mousseVersion() },
        capabilities: { experimentalApi: false, requestAttestation: false }
      })
      .then(() => {
        conn.notify('initialized')
        return conn
      })
    ready.catch(() => conn.close())
    this.app = { conn, ready, verified: false, generation: this.launchGeneration }
    return ready
  }

  private environment(): NodeJS.ProcessEnv {
    return withUserEnv(codexEnvironment(), storedCliEnv(this.settings))
  }

  /** Something is using the process: a check, a model listing, or a turn. */
  private busy(): boolean {
    return Boolean(this.probing || this.listing || this.activeThreads.size || this.turns.size)
  }

  /** Detaches and closes the process; `lost` then treats the exit as expected. */
  private closeProcess(): void {
    const app = this.app
    if (!app) return
    if (this.idleClose) clearTimeout(this.idleClose.timer)
    this.idleClose = undefined
    this.app = undefined
    this.loaded.clear()
    this.orphans.clear()
    app.conn.close()
  }

  /**
   * Closes the process `delay` ms from now unless something is using it then; an earlier close
   * already scheduled is pushed back, never brought forward. A process started with older launch
   * settings is the exception: it closes as soon as nothing uses it. The cached sign-in check
   * survives, so Codex stays listed; the next process proves its own sign-in before it gets a turn.
   */
  private closeWhenIdle(delay: number, retry = false): void {
    if (!this.app || this.stopped) return
    const stale = this.app.generation !== this.launchGeneration
    const at = Date.now() + (stale && !retry ? 0 : (this.dependencies.idleCloseMs ?? delay))
    if (this.idleClose && this.idleClose.at >= at && !stale) return
    if (this.idleClose) clearTimeout(this.idleClose.timer)
    const timer = setTimeout(() => {
      this.idleClose = undefined
      const app = this.app
      if (!app) return
      if (this.busy()) {
        this.closeWhenIdle(CODEX_CHECK_CLOSE_MS, true)
        return
      }
      // Detached first, so `lost` treats the exit as expected and keeps the sign-in result.
      this.closeProcess()
    }, at - Date.now())
    timer.unref?.()
    this.idleClose = { timer, at }
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
    if (typeof threadId !== 'string') return
    const run = this.turns.get(threadId)
    if (run) return run.handle(notification)
    // A native helper's own thread: its turn belongs to the run that started it.
    const owner = [...this.turns.values()].find((candidate) => candidate.helpers.has(threadId))
    if (owner) return owner.helpers.handle(notification)
    const orphan = [...this.orphans].find((helpers) => helpers.has(threadId))
    if (orphan) {
      orphan.handle(notification)
      if (!orphan.awaitingTurn()) this.orphans.delete(orphan)
      return
    }
    this.noteStray(notification, threadId)
  }

  private async serve(request: CodexServerRequest): Promise<unknown> {
    const params = (request.params ?? {}) as { threadId?: string; itemId?: string }
    const run = params.threadId ? this.turns.get(params.threadId) : undefined
    type Result<M extends keyof CodexServerRequestMap> = CodexServerRequestMap[M]['result']
    switch (request.method) {
      case 'item/commandExecution/requestApproval': {
        const approval = request.params as CodexServerRequestMap['item/commandExecution/requestApproval']['params']
        if (!run || run.questionSignal.aborted) return { decision: 'cancel' } satisfies Result<'item/commandExecution/requestApproval'>
        if (run.mode === 'plan' || run.readOnlyChild) return { decision: 'decline' } satisfies Result<'item/commandExecution/requestApproval'>
        const command = approval.command ?? (run.item(approval.itemId) as { command?: string } | undefined)?.command ?? 'a command'
        const decision = await this.approve(
          run,
          `Allow Codex to run this command?\n${command}${approval.cwd ? `\nin ${approval.cwd}` : ''}${approval.reason ? `\n${approval.reason}` : ''}`
        )
        return { decision } satisfies Result<'item/commandExecution/requestApproval'>
      }
      case 'item/fileChange/requestApproval': {
        const approval = request.params as CodexServerRequestMap['item/fileChange/requestApproval']['params']
        if (!run || run.questionSignal.aborted) return { decision: 'cancel' } satisfies Result<'item/fileChange/requestApproval'>
        if (run.mode === 'plan' || run.readOnlyChild) return { decision: 'decline' } satisfies Result<'item/fileChange/requestApproval'>
        const changes = (run.item(approval.itemId) as { changes?: Array<{ path: string }> } | undefined)?.changes ?? []
        const decision = await this.approve(
          run,
          `Allow Codex to edit ${changes.length ? changes.map((change) => change.path).join(', ') : 'files'}?${approval.reason ? `\n${approval.reason}` : ''}`
        )
        return { decision } satisfies Result<'item/fileChange/requestApproval'>
      }
      case 'item/tool/requestUserInput': {
        const input = request.params as CodexServerRequestMap['item/tool/requestUserInput']['params']
        if (!run || run.questionSignal.aborted) throw new Error('No Mousse turn is waiting for this answer')
        const answers = await this.questions.requestAnswers(
          input.questions.map((question) => ({
            id: question.id,
            prompt: question.header ? `${question.header}\n${question.question}` : question.question,
            options: (question.options ?? []).map((option) => ({ id: option.label, label: option.label }))
          })),
          run.mousseThreadId,
          { signal: run.questionSignal }
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
        { signal: run.questionSignal }
      )
      if (run.questionSignal.aborted) return 'cancel'
      return answer.permission === 'allow' ? 'accept' : answer.permission === 'allow_session' ? 'acceptForSession' : 'decline'
    } catch {
      return run.questionSignal.aborted ? 'cancel' : 'decline'
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

  /** Remembers the turn of a thread no run owns yet: a helper's first events can beat the item that names it. */
  private noteStray(notification: CodexNotification, threadId: string): void {
    const turn = (notification.params as { turn?: { id?: string } } | undefined)?.turn
    if (notification.method !== 'turn/started' && notification.method !== 'turn/completed') return
    const stray = this.strays.get(threadId) ?? { completed: false }
    if (notification.method === 'turn/started' && turn?.id) Object.assign(stray, { turnId: turn.id, completed: false })
    else if (notification.method === 'turn/completed') stray.completed = true
    this.strays.delete(threadId)
    this.strays.set(threadId, stray)
    if (this.strays.size > 64) this.strays.delete(this.strays.keys().next().value as string)
  }

  private requestInterrupt(run: TurnRun): void {
    if (run.interruptRequested) return
    run.interruptRequested = true
    if (run.turnId) this.sendInterrupt(run)
    this.stopHelpers(run)
  }

  /**
   * Interrupts the native helpers of `run`, those running now and any that start later. The parent's
   * interrupt does not reach them; each helper thread is interrupted on its own.
   */
  private stopHelpers(run: TurnRun): void {
    const conn = this.app?.conn
    if (!conn) return
    run.helpers.stopAll((threadId, turnId) => {
      void conn.request('turn/interrupt', { threadId, turnId }, { timeoutMs: INTERRUPT_TIMEOUT_MS }).catch(() => {
        /* the helper ended meanwhile, or the process is gone */
      })
    })
    // A helper whose turn has not started yet is interrupted when it does, even after this chat ended.
    if (run.helpers.awaitingTurn()) this.orphans.add(run.helpers)
  }

  private sendInterrupt(run: TurnRun): void {
    const conn = this.app?.conn
    if (!conn || !run.turnId || run.turnCompleted()) return
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
  ): Promise<{ codexThreadId: string; model: string | undefined; continued: boolean }> {
    const cwd = resolve(input.cwd)
    const saved = this.settings.threads?.[input.threadId]
    const mcpToken = input.mcp?.token ?? null
    const overrides = codexMcpConfigOverrides(input.mcp) as ThreadConfig
    const { baseId } = parseThinkingSuffixFromModelId(input.model)
    const policy = codexTurnPolicy(input.mode ?? 'default', input.child)
    const childKey = input.child ? (input.child.readOnly ? 'read-only' : 'child') : ''
    const params = {
      cwd,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
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
      if (loaded && loaded.mcpToken === mcpToken && loaded.cwd === cwd && loaded.childKey === childKey)
        return { codexThreadId: saved.codexThreadId, model: undefined, continued: true }
      if (loaded) {
        // The attachment, cwd or child policy changed while the thread is loaded. A resume would
        // keep the old config, so fork it: Codex loads the history into a new thread with the new
        // config, and the old thread is released.
        const forked = chatgptProvider(await conn.request('thread/fork', { threadId: saved.codexThreadId, excludeTurns: true, ...params }, { signal }))
        this.loaded.delete(saved.codexThreadId)
        this.loaded.set(forked.thread.id, { mcpToken, cwd, childKey })
        await conn.request('thread/unsubscribe', { threadId: saved.codexThreadId }, { signal, timeoutMs: 5_000 }).catch(() => undefined)
        signal.throwIfAborted()
        return { codexThreadId: forked.thread.id, model: forked.model, continued: true }
      }
      try {
        const resumed = chatgptProvider(await conn.request('thread/resume', { threadId: saved.codexThreadId, excludeTurns: true, ...params }, { signal }))
        this.loaded.set(resumed.thread.id, { mcpToken, cwd, childKey })
        return { codexThreadId: resumed.thread.id, model: resumed.model, continued: true }
      } catch (error) {
        signal.throwIfAborted()
        conn.signal.throwIfAborted()
        if (!(error instanceof CodexRpcError)) throw error
        const fresh = chatgptProvider(await conn.request('thread/start', params, { signal }))
        this.loaded.set(fresh.thread.id, { mcpToken, cwd, childKey })
        return { codexThreadId: fresh.thread.id, model: fresh.model, continued: false }
      }
    }
    const fresh = chatgptProvider(await conn.request('thread/start', params, { signal }))
    this.loaded.set(fresh.thread.id, { mcpToken, cwd, childKey })
    return { codexThreadId: fresh.thread.id, model: fresh.model, continued: false }
  }

  async chat(input: CodexChatInput): Promise<CodexChatResult> {
    if (input.mcp?.token) this.secrets.add(input.mcp.token)
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
      signal.throwIfAborted()
      const codexThreadId = thread.codexThreadId
      // The thread is not resumable until the turn commits its history.
      this.settings.threads = { ...this.settings.threads, [input.threadId]: { codexThreadId, cwd: resolve(input.cwd), instanceId: input.instanceId ?? CODEX_INSTANCE_ID } }
      this.save()
      input.onSession?.({ codexThreadId })
      const current = new TurnRun(codexThreadId, input.threadId, input.mode ?? 'default', signal, input, (id) => this.strays.get(id))
      run = current
      this.turns.set(codexThreadId, current)
      const { baseId, effort } = parseThinkingSuffixFromModelId(input.model)
      const policy = codexTurnPolicy(input.mode ?? 'default', input.child)
      const turnParams = {
        cwd: resolve(input.cwd),
        approvalPolicy: policy.approvalPolicy,
        sandboxPolicy: policy.sandboxPolicy,
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
            await conn.request('turn/steer', { threadId: codexThreadId, expectedTurnId: current.turnId, input: [textInput(text)] }, { signal })
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
        // Stop may have landed before this run existed (its handler then had nothing to
        // interrupt); a turn started now could never be stopped.
        signal.throwIfAborted()
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
        // Stop must not wait for a steer the server has not answered yet.
        await Promise.race([steering, aborted])
        collectSteer()
        await Promise.race([steering, aborted])
        if (lastTurn.status === 'failed')
          throw new Error(this.redact(lastTurn.error?.message ?? current.lastError ?? 'Codex turn failed'))
        if (lastTurn.status === 'interrupted') {
          signal.throwIfAborted()
          throw new Error('Codex interrupted the turn')
        }
        if (!undelivered.length) break
        nextInput = [textInput(undelivered.splice(0).join('\n'))]
      }
      // Codex completes the parent's turn while the helpers it started keep running, so this chat (the
      // child's run) stays open until they settle; Stop interrupts them and ends the wait.
      if (current.helpers.running().length) {
        const beat = setInterval(() => input.onHeartbeat?.(), 5_000)
        beat.unref?.()
        try {
          await Promise.race([current.helpers.whenSettled(), aborted])
        } finally {
          clearInterval(beat)
        }
        // Stop interrupts the helpers, and their end can be reported before the abort is seen.
        signal.throwIfAborted()
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
        usage: current.usage()
      }
    } catch (error) {
      // A failed or stopped chat leaves no helper of its own running.
      if (run) this.stopHelpers(run)
      run?.closeTools()
      if (signal.aborted && input.signal?.aborted) throw input.signal.reason ?? error
      throw error
    } finally {
      if (steerTimer) clearInterval(steerTimer)
      signal.removeEventListener('abort', onAbort)
      input.signal?.removeEventListener('abort', forward)
      this.controllers.delete(controller)
      this.activeThreads.delete(input.threadId)
      this.closeWhenIdle(CODEX_IDLE_CLOSE_MS)
      // A stopped turn stays registered (for routing) until the server settles it or the process dies.
      run?.mute()
      run?.cancelQuestions()
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

  private redact(text: string): string {
    return redactSecrets(text, this.secrets)
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
      // Static text: the provider name comes from the process and could carry anything.
      message: 'Codex chose a model provider other than your ChatGPT sign-in; Mousse only runs Codex on it.',
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
