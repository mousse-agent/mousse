import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { AppError, redactSecrets } from '../../../shared/errors'
import { CODEX_INSTANCE_ID } from '../../../shared/providerInstances'
import { parseThinkingSuffixFromModelId } from '../../../shared/modelVariants'
import { recordSubagentCall, toolResultText } from '../../../shared/subagentTools'
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
import { killTree } from '../../harness/spawn'
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
  type CliVersionCache,
  type StoredCliConfig
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
  codexHttpStatus,
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
  type TurnError,
  type UserInput
} from './protocol'
import { codexTurnPolicy } from './childPolicy'
import { DEFAULT_TREE_TIMING, HelperTree, RpcRefused, ThreadStatuses, TreeOff, isWakeUp, type TreePorts, type TreeTiming } from './helperTree'
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
/**
 * How long a sweep (Stop, a failed turn, a cap) keeps interrupting the thread's turn and helpers
 * before the run is released, even if one of them has not stopped.
 */
export const CODEX_SWEEP_MS = 10_000
/**
 * A thread id no thread has, for the capability probe: the nil UUID is never a real thread's id, and a
 * fixed one keeps the probe's frames the same in every transcript.
 */
const TREE_PROBE_THREAD_ID = '00000000-0000-0000-0000-000000000000'
/** Timeout of the requests that read the helper tree (`thread/list`, `thread/read`). */
const TREE_REQUEST_MS = 10_000
/** Pages of `thread/list` read per snapshot before the listing is taken as broken. */
const TREE_MAX_PAGES = 100
/** The app-server process is closed once it has been unused this long after a turn... */
export const CODEX_IDLE_CLOSE_MS = 60_000
/** ...or after a sign-in check or model listing that started it. */
export const CODEX_CHECK_CLOSE_MS = 5_000
/**
 * A chat held open only by its native helpers is released when none of them has reported anything
 * for this long (the helpers are stopped, the run ends with its own text and a note)...
 */
export const CODEX_HELPER_IDLE_CAP_MS = 30 * 60_000
/** ...or when they have held it this long in total, however active they are. */
export const CODEX_HELPER_PIN_CAP_MS = 4 * 60 * 60_000
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

type SavedThread = {
  codexThreadId: string
  cwd: string
  /** Provider instance that owns the Codex thread; absent means the default `codex` instance. */
  instanceId?: string
  /** Fingerprint of the canonical history the thread holds; set after the turn commits, or after a stopped turn is fingerprinted. */
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
type AccountProbe = CodexAccountReading

/** An account check's answer: `label`/`subject` override what `account()` derives from plan and email. */
export type CodexAccountReading =
  | { kind: 'signed_in'; planType: string; email: string | null; label?: string; subject?: string }
  | { kind: 'signed_out'; message: string }
  | { kind: 'error'; message: string }

export type { CodexStatus }

/** Where the account the app-server runs as is read from, instead of `account/read`. */
export interface CodexAccountSource {
  read(signal?: AbortSignal): Promise<CodexAccountReading>
}

/** Where the models are listed from, instead of `model/list`. */
export interface CodexModelSource {
  list(signal?: AbortSignal): Promise<LlmModelOption[]>
}

/** What one app-server launch adds, and what ends with that process. */
export interface CodexLaunchExtras {
  /** Appended after the stored launch args. */
  args: string[]
  env?: Record<string, string>
  /**
   * Called once, when that process has actually exited (or never started). A closed or lost
   * connection is not enough: the process may still run, with whatever it cached.
   */
  onExit(): void
}

/**
 * How one Codex instance runs. Every field is optional: without them the service is the built-in
 * instance (the terminal sign-in, `<profileHome>/providers/codex`, `account/read`, `model/list`).
 */
export interface CodexServiceOptions {
  /** Mousse's state for this instance (settings, saved threads, standalone workspaces). */
  dir?: string
  /** The app-server's environment before the stored launch variables. */
  env?: () => NodeJS.ProcessEnv
  clientInfo?: { name: string; title: string }
  /** The provider every thread runs on, pinned in the request, the config layer and the response check. */
  modelProvider?: string
  /** Runs before each app-server launch. A rejection fails that launch. */
  prepareLaunch?: (signal?: AbortSignal) => Promise<CodexLaunchExtras>
  account?: CodexAccountSource
  models?: CodexModelSource
}

/** A turn Codex ended as failed, with what it said about why. The message is redacted. */
export class CodexTurnFailure extends Error {
  readonly codexErrorInfo: TurnError['codexErrorInfo']
  readonly additionalDetails: string | null
  readonly httpStatus?: number

  constructor(message: string, error: TurnError | undefined) {
    super(message)
    this.name = 'CodexTurnFailure'
    this.codexErrorInfo = error?.codexErrorInfo ?? null
    this.additionalDetails = typeof error?.additionalDetails === 'string' ? error.additionalDetails : null
    const status = codexHttpStatus(error?.codexErrorInfo)
    if (status !== undefined) this.httpStatus = status
  }
}

export type CodexServiceDependencies = {
  /** Starts the app-server process; tests and the replay kit substitute it. */
  launch?: (launch: CodexLaunch) => CodexProcess
  /** Overrides the PATH lookup (tests). */
  findBinary?: () => string | undefined
  /** Default per-request timeout (initialize, account/read, thread/start ...). */
  requestTimeoutMs?: number
  /** Overrides both idle-close delays (tests). */
  idleCloseMs?: number
  /** Overrides how long native helpers may be silent / hold a chat open (tests). */
  helperIdleCapMs?: number
  helperPinCapMs?: number
  /** Overrides how long a sweep keeps stopping the helpers (tests). */
  helperSweepMs?: number
  /** Overrides the waits of the helper tree (tests). */
  helperTiming?: Partial<TreeTiming>
  /** `codex --version` lookups (tests). */
  versions?: CliVersionCache
  /**
   * How `stopAll` ends a process (tests): after a normal close, the wait before the whole tree is
   * killed, then the wait for its exit before `stopAll` gives up and rejects.
   */
  stopTiming?: { killAfterMs?: number; exitDeadlineMs?: number }
  /** Kills a process and everything it started (tests substitute it; it may throw). */
  killTree?: (process: CodexProcess) => void
}

/** `stopAll`: a closed process gets this long before its tree is killed. */
export const CODEX_STOP_KILL_AFTER_MS = 3_000
/** `stopAll`: after the tree kill, how long the exit may take before the stop fails. */
export const CODEX_STOP_EXIT_DEADLINE_MS = 5_000

/** A launched app-server, tracked from spawn to its actual exit. */
interface LiveProcess {
  process: CodexProcess
  conn: CodexConnection
  exited: Promise<void>
  done: boolean
}

function defaultKillTree(process: CodexProcess): void {
  if (process.pid) killTree(process as unknown as ChildProcess)
  else process.kill('SIGKILL')
}

export interface CodexToolEvent {
  phase: 'start' | 'complete'
  callId: string
  title: string
  toolName?: string
  /** A Mousse subagent call's bounded record (`recordSubagentCall`). */
  record?: NonNullable<ReturnType<typeof recordSubagentCall>>
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
  /** Prefixed to the prompt: the turn's skills, mode, applet catalogue and usable Mousse tools. */
  turnPreamble?: string
  /** Canonical prior turns; injected as a preamble when no matching Codex thread is resumed. */
  history?: string
  images?: ChatImageAttachment[]
  signal?: AbortSignal
  mode?: 'plan' | 'default'
  /** Set for a delegated child's turns (first and resumed); see `codexTurnPolicy`. */
  child?: ChildTurnPolicy
  /** The Mousse MCP server for this run (SPEC §15.2); null attaches none. */
  mcp?: { url: string; token: string } | null
  /**
   * Codex developer instructions for a new, resumed or forked thread (SPEC §15.3). A loaded thread
   * that continues with other instructions gets the new text in that turn's prompt.
   */
  developerInstructions?: string
  onText: (text: string) => void
  onThinking?: (text: string) => void
  onTool?: (event: CodexToolEvent) => void
  /**
   * Every `item/started` and `item/completed` notification of a tool item, as the server sent it
   * (never the completions `closeTools` adds for rows left open): the drained-turn proof of the
   * turn's Mousse MCP calls.
   */
  onToolNotification?: (event: { phase: 'start' | 'complete'; callId: string; toolName?: string }) => void
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
      const call = item as {
        server?: string
        tool?: string
        status?: string
        arguments?: unknown
        result?: { content?: unknown; structuredContent?: unknown } | null
        error?: unknown
      }
      const toolName = `mcp__${call.server}__${call.tool}`
      // Mousse's subagent tools keep a bounded record of the call, so the app can tell which task a row is.
      const record = recordSubagentCall(
        toolName,
        call.arguments,
        phase === 'start'
          ? {}
          : {
              text: toolResultText(call.result?.content) ?? (call.result?.structuredContent ? JSON.stringify(call.result.structuredContent) : undefined),
              isError: call.status === 'failed' || Boolean(call.error)
            }
      )
      return { phase, callId: item.id, title: `${call.server}.${call.tool}`, toolName, ...(record ? { record } : {}) }
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
  /** The last `error` notification Codex gave up on (`willRetry: false`). */
  lastError: TurnError | undefined
  interruptRequested = false
  /** A `turn/start` is on its way; its turn id is not known yet. */
  startInFlight = false
  /** A turn of this run is running: one Mousse started, or one the server started and the run adopted. */
  turnOpen = false
  /** The run waits for its helpers: a turn the server starts on its own is adopted. */
  holding = false
  /** The helpers of this thread as the server lists them; set once the run first waits for them (tree mode). */
  tree: HelperTree | undefined
  /** Set once the run is being stopped: interrupting everything under the thread, then releasing it. */
  sweeping: Promise<void> | undefined
  /** The turn Stop interrupted itself (the sweep's first round does not send it again). */
  stopInterrupt: string | undefined
  /** The app-server process this run talks to; a sweep never reaches into a replacement process. */
  conn: CodexConnection | undefined
  /** A turn the server started on its own while the run waited for its helpers. */
  private adoptedTurn: string | undefined
  /** An adopted turn that ended `failed` or `interrupted`: the run fails with it. */
  adoptedFailure: CodexTurn | undefined
  private adoptedFailureWaiters: Array<() => void> = []
  /** The run has interrupted its own thread (Stop, a cap or a failure sweep): an `interrupted` turn is then expected. */
  selfInterrupted = false
  /** The chat returned; late events only settle the turn and reach nobody. */
  private muted = false
  private readonly questionsDone = new AbortController()
  /** Ends this run's pending questions: the turn stopped, ended, or lost its process. */
  readonly questionSignal: AbortSignal
  private readonly completedTurns = new Map<string, CodexTurn>()
  private idleWaiters: Array<() => void> = []
  private activityWaiters: Array<() => void> = []
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
    this.poke()
    this.finish()
  }

  settled(): void {
    this.finish()
  }

  /** The `turn/start` response named the turn Mousse's input went into (a running server turn takes it as a steer). */
  turnStarted(turn: CodexTurn): void {
    this.turnId = turn.id
    // The input was steered into a turn the run had adopted: that is Mousse's own turn now, and it settles the run.
    if (this.adoptedTurn === turn.id) this.adoptedTurn = undefined
    // A failure noted for an earlier adopted turn does not fail this one.
    if (this.adoptedFailure && this.adoptedFailure.id !== turn.id) this.adoptedFailure = undefined
    this.startInFlight = false
    // A `turn/completed` that came while the response was on its way was held back; only this turn settles the run.
    const done = this.completedTurns.get(turn.id)
    if (done) {
      this.settle?.resolve(done)
      this.settle = undefined
    }
    this.wakeIdle()
  }

  /** Resolves when an adopted turn has ended `failed` or `interrupted` (at once if one already has). */
  whenAdoptedFails(signal: AbortSignal): Promise<void> {
    if (this.adoptedFailure) return Promise.resolve()
    return new Promise((done) => {
      const finish = (): void => {
        signal.removeEventListener('abort', leave)
        done()
      }
      // The hold ended another way: the waiter goes with it.
      const leave = (): void => {
        const index = this.adoptedFailureWaiters.indexOf(finish)
        if (index !== -1) this.adoptedFailureWaiters.splice(index, 1)
      }
      this.adoptedFailureWaiters.push(finish)
      signal.addEventListener('abort', leave, { once: true })
    })
  }

  /** Something concerning this run happened; a sweep waiting for news looks again. */
  poke(): void {
    for (const waiter of this.activityWaiters.splice(0)) waiter()
  }

  /** Resolves after `ms`, on the next `poke`, or when `signal` aborts. */
  nextActivity(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve()
    return new Promise((done) => {
      const finish = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', finish)
        done()
      }
      const timer = setTimeout(finish, Math.max(0, ms))
      timer.unref?.()
      signal?.addEventListener('abort', finish, { once: true })
      this.activityWaiters.push(finish)
    })
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

  /** Adds a closing note to the reply (after the Codex text), streamed like any other text. */
  addNote(note: string): void {
    const id = `mousse-note-${this.order.length}`
    this.order.push(id)
    this.parts.set(id, note)
    this.input.onText(this.text)
  }

  closeTools(): void {
    for (const event of this.openTools.values()) this.input.onTool?.({ ...event, phase: 'complete' })
    this.openTools.clear()
  }

  handle(notification: CodexNotification): void {
    const started = notificationParams(notification, 'turn/started')
    if (started) {
      if (this.holding && !this.startInFlight && !this.turnOpen && !this.muted) {
        // The server started a turn on its own (a helper's message woke the thread): it is this run's
        // turn now, so Stop interrupts it by id, a steer joins it, and the wait resumes after it.
        this.turnId = started.turn.id
        this.adoptedTurn = started.turn.id
        this.turnOpen = true
      } else this.turnId ??= started.turn.id
      return
    }
    const completed = notificationParams(notification, 'turn/completed')
    if (completed) {
      this.completedTurns.set(completed.turn.id, completed.turn)
      if (this.adoptedTurn === completed.turn.id) {
        this.adoptedTurn = undefined
        // Mousse's own turn may be running by now; it keeps its turn open, and this one's end is not its news.
        const current = this.turnId === completed.turn.id
        if (current) this.turnOpen = false
        // An interruption this run asked for itself (a cap or a Stop sweep) is how the run ends, not a failure.
        const failed = completed.turn.status === 'failed' || (completed.turn.status === 'interrupted' && !this.selfInterrupted)
        if (current && failed) {
          this.adoptedFailure = completed.turn
          for (const waiter of this.adoptedFailureWaiters.splice(0)) waiter()
        }
      } else if (!this.startInFlight && (!this.turnId || completed.turn.id === this.turnId)) {
        // While a `turn/start` is on its way, any turn of the thread may complete: `turnStarted` settles.
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
        this.input.onToolNotification?.({ phase: 'start', callId: event.callId, toolName: event.toolName })
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
      const settled = toolEvent(item, 'complete')
      if (settled) this.input.onToolNotification?.({ phase: 'complete', callId: settled.callId, toolName: settled.toolName })
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
      else this.lastError = error.error
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
  private app?: {
    conn: CodexConnection
    ready: Promise<CodexConnection>
    verified: boolean
    generation: number
    /** Resolves when the process has exited (or never started). */
    exited: Promise<void>
    /** What this process last said about every thread (a broadcast, whichever thread a run holds). */
    statuses: ThreadStatuses
    /**
     * Whether this process lists a thread's descendants by ancestor (`thread/list`, experimental); unset
     * until the capability probe has answered. `off` is final for the process: master's direct-helper tracking.
     */
    tree?: 'on' | 'off'
    treeProbe?: Promise<void>
  }
  /** Bumped when the launch settings change; a process from an older generation is replaced once idle. */
  private launchGeneration = 0
  private probeResult?: { at: number; result: AccountProbe }
  private probing?: Promise<void>
  private modelDiscoveryStarted = false
  /** Bumped by `clearModels`: a listing started before it is not saved. */
  private modelsEpoch = 0
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
  /** Stops in progress by Mousse thread: the sweep that still interrupts a released chat's turn and helpers. */
  private readonly pendingSweeps = new Map<string, Promise<void>>()
  /** Helpers of finished chats that were told to stop before their turn id was known. */
  private readonly orphans = new Set<NativeHelpers>()
  private readonly loaded = new Map<string, { mcpToken: string | null; cwd: string; childKey: string; instructionsHash?: string }>()
  private readonly activeThreads = new Set<string>()
  private readonly controllers = new Set<AbortController>()
  private readonly readyToCommit = new Set<string>()
  /** Threads whose last turn was stopped after its Codex thread was opened, by that Codex thread id (`commitInterrupted`). */
  private readonly interruptedThreads = new Map<string, string>()
  /** Mousse MCP tokens handed to Codex; never echoed into errors or status messages. */
  private readonly secrets = new Set<string>()

  private readonly modelProvider: string
  /** A launch being prepared (`prepareLaunch`); callers arriving meanwhile share it. */
  private launching?: Promise<CodexConnection>
  /** Bumped by `stopAll`: a launch prepared before it never starts. */
  private launchEpoch = 0
  private readonly preparing = new Set<AbortController>()
  /** Every app-server this service started that has not exited yet, attached or not. */
  private readonly processes = new Set<LiveProcess>()

  constructor(
    private readonly profileHome: string,
    private readonly questions: UserQuestionService,
    private readonly dependencies: CodexServiceDependencies = {},
    private readonly options: CodexServiceOptions = {}
  ) {
    this.dir = options.dir ?? join(profileHome, 'providers', CODEX_PROVIDER_ID)
    this.modelProvider = options.modelProvider ?? CODEX_MODEL_PROVIDER
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

  /** The listed models, or the Codex default until a listing runs. */
  models(): LlmModelOption[] {
    if (this.options.models) return this.settings.models ?? []
    return this.settings.models?.length ? this.settings.models : CODEX_FALLBACK_MODELS
  }

  llmProvider(): LlmProviderOption | undefined {
    if (!this.configured()) return undefined
    return {
      id: CODEX_PROVIDER_ID,
      label: 'Codex',
      models: this.models()
    }
  }

  private checkDue(force = false): boolean {
    if (this.stopped || this.settingsError || this.settings.disconnected) return false
    return force || !this.probeResult || Date.now() - this.probeResult.at >= CODEX_ACCOUNT_TTL_MS
  }

  private async probe(): Promise<AccountProbe> {
    try {
      if (this.options.account) return await this.options.account.read()
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
    const result = this.options.account ? await this.options.account.read(signal) : await this.readAccount(conn, signal)
    if (this.options.account && this.app?.conn === conn) this.app.verified = result.kind === 'signed_in'
    this.probeResult = { at: Date.now(), result }
    if (result.kind !== 'signed_in')
      throw new AppError({ code: 'codex_not_connected', message: this.signInMessage(), errorInfo: { category: 'unavailable', retryable: false } })
    return conn
  }

  /**
   * Checks the terminal sign-in with a live `account/read` when the cached result is missing,
   * older than five minutes, or `force` (Recheck, a turn's account check) is set. The last result
   * stays the synchronous view (`configured()`, listings) until the new one arrives.
   */
  async status(options: { force?: boolean } = {}): Promise<CodexStatus> {
    // A check already running may have read the sign-in before it changed: wait, then check again.
    if (options.force) await this.probing
    if (this.binary() && this.checkDue(options.force)) {
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

  /**
   * Forgets the listed models (the account changed: its plan may list others). A listing that
   * ends after this was asked for the old account and is not saved.
   */
  clearModels(): void {
    this.modelsEpoch += 1
    this.modelDiscoveryStarted = false
    if (!this.settings.models) return
    delete this.settings.models
    this.save()
  }

  /** Lists the account's models (`model/list`, every page) and stores them for the picker. */
  async refreshModels(): Promise<LlmModelOption[]> {
    if (this.options.models) {
      const epoch = this.modelsEpoch
      const listed = await this.options.models.list()
      if (!listed.length) throw new Error('Codex returned no models')
      if (epoch !== this.modelsEpoch) throw new Error('The account changed while its models were listed. Refresh models again.')
      this.settings.models = listed
      this.save()
      return listed
    }
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

  /**
   * Drops the saved Codex thread of `threadId`, so its next turn starts a new Codex thread with the
   * history in the prompt (the account it was saved under changed).
   */
  forgetConversation(threadId: string): void {
    if (!this.settings.threads?.[threadId]) return
    const { [threadId]: _dropped, ...rest } = this.settings.threads
    this.settings.threads = rest
    this.save()
  }

  /**
   * The account of the last live sign-in check, when it was a ChatGPT sign-in: the plan for display
   * and `subject`, the account's email as Codex reports it, which the gateway only hashes (never
   * shown or stored). No subject when Codex reports no email.
   */
  account(): { label?: string; subject?: string } | undefined {
    const result = this.probeResult?.result
    if (result?.kind !== 'signed_in') return undefined
    if (result.label !== undefined || result.subject !== undefined)
      return { ...(result.label ? { label: result.label } : {}), ...(result.subject ? { subject: result.subject } : {}) }
    const email = result.email?.trim().toLowerCase()
    // Codex reports the plan in lower case (`plus`, `pro`); the page names it as ChatGPT does.
    const plan = result.planType ? `${result.planType[0]!.toUpperCase()}${result.planType.slice(1)}` : ''
    return { label: plan ? `ChatGPT ${plan}` : 'ChatGPT', ...(email ? { subject: `chatgpt:${email}` } : {}) }
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

  /** The stored executable, launch args and variables, as saved (no lookup, no version check). */
  storedLaunch(): StoredCliConfig {
    return { ...(this.settings.binaryPath ? { binaryPath: this.settings.binaryPath } : {}), args: storedCliArgs(this.settings), env: storedCliEnv(this.settings) }
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

  /**
   * Stops every app-server process of this service and waits until it has exited, so nothing keeps
   * running with what that process cached (a token of a sign-in that changed). Running chats fail;
   * a launch being prepared never starts. The service stays usable: the next use starts a new
   * process, which checks its account again.
   */
  async stopAll(reason: string): Promise<void> {
    this.launchEpoch += 1
    for (const preparing of this.preparing) preparing.abort(new Error(reason))
    const launching = this.launching
    this.abortInFlight(reason)
    this.probeResult = undefined
    if (this.app) this.app.verified = false
    // A launch being prepared never starts (the epoch moved on); one already spawning is tracked.
    await launching?.catch(() => undefined)
    await this.stopProcesses([...this.processes])
  }

  /**
   * Closes `live` (the attached process and detached ones still shutting down), kills each tree
   * that has not exited after the grace, and waits for every exit. Rejects when a kill throws or a
   * process is still running at the deadline: the caller must not assume it stopped.
   */
  private async stopProcesses(live: LiveProcess[]): Promise<void> {
    if (!live.length) return
    const timing = this.dependencies.stopTiming ?? {}
    const killAfterMs = timing.killAfterMs ?? CODEX_STOP_KILL_AFTER_MS
    const deadlineMs = timing.exitDeadlineMs ?? CODEX_STOP_EXIT_DEADLINE_MS
    // `lost` fails the runs on the attached one; a detached one is closed again (harmless).
    for (const entry of live) entry.conn.close()
    const failures: string[] = []
    await Promise.all(live.map(async (entry) => {
      if (await exitWithin(entry.exited, killAfterMs)) return
      try {
        (this.dependencies.killTree ?? defaultKillTree)(entry.process)
      } catch (error) {
        failures.push(`the kill failed (${error instanceof Error ? error.message : String(error)})`)
        return
      }
      if (!(await exitWithin(entry.exited, deadlineMs))) failures.push('it did not exit in time')
    }))
    if (failures.length) throw new Error(`Codex could not be stopped: ${failures.join('; ')}.`)
  }

  stop(): void {
    this.stopped = true
    for (const preparing of this.preparing) preparing.abort(new Error('Codex provider is stopped'))
    if (this.idleClose) clearTimeout(this.idleClose.timer)
    this.idleClose = undefined
    this.abortInFlight()
    this.app?.conn.close()
  }

  private abortInFlight(reason = 'Codex was disconnected'): void {
    for (const controller of this.controllers) controller.abort(new Error(reason))
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
    const prepare = this.options.prepareLaunch
    if (!prepare) return this.launch(target)
    if (this.launching) return this.launching
    const epoch = this.launchEpoch
    const preparing = new AbortController()
    this.preparing.add(preparing)
    const launching = prepare(preparing.signal)
      .then((extras) => {
        // A stop while the launch was prepared wins: what it prepared is released, nothing starts.
        if (this.stopped || epoch !== this.launchEpoch) {
          extras.onExit()
          throw new Error(this.stopped ? 'Codex provider is stopped' : 'Codex was restarted')
        }
        return this.launch(target, extras)
      })
      .finally(() => {
        this.preparing.delete(preparing)
        if (this.launching === launching) this.launching = undefined
      })
    this.launching = launching
    return launching
  }

  /** Starts the app-server process and initializes it. */
  private launch(target: CliLaunch, extras?: CodexLaunchExtras): Promise<CodexConnection> {
    let process: CodexProcess
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      process = (this.dependencies.launch ?? spawnCodexAppServer)({
        binary: target.command,
        ...(target.args.length ? { entryArgs: target.args } : {}),
        args: [...storedCliArgs(this.settings), ...(extras?.args ?? [])],
        env: { ...this.environment(), ...extras?.env },
        cwd: this.dir
      })
    } catch (error) {
      extras?.onExit()
      return Promise.reject(error)
    }
    const conn = new CodexAppServerClient(process, { defaultTimeoutMs: this.dependencies.requestTimeoutMs, secrets: () => this.secrets })
    // A spawn `error` with no pid means the process never started; otherwise only `exit` counts.
    const exited = new Promise<void>((done) => {
      if (process.exitCode !== null || process.signalCode !== null) return done()
      process.once('exit', () => done())
      process.once('error', () => {
        if (!process.pid) done()
      })
    })
    const live: LiveProcess = { process, conn, exited, done: false }
    this.processes.add(live)
    void exited.then(() => {
      live.done = true
      this.processes.delete(live)
      // Its leases (token broker, install files) end only now, when nothing of it runs.
      extras?.onExit()
    })
    // A connection that ended on its own (output closed) leaves a process nobody can use: it is
    // closed too, and still tracked until it exits.
    conn.signal.addEventListener('abort', () => {
      if (!live.done) conn.close()
    }, { once: true })
    const statuses = new ThreadStatuses()
    conn.onNotification((notification) => this.route(notification, statuses))
    conn.setServerRequestHandler((request) => this.serve(request))
    conn.signal.addEventListener('abort', () => this.lost(conn, conn.signal.reason), { once: true })
    const clientInfo = this.options.clientInfo ?? { name: 'mousse', title: 'Mousse' }
    const ready = conn
      .request('initialize', {
        clientInfo: { ...clientInfo, version: mousseVersion() },
        // Experimental API: `thread/list` filters by ancestor. It also stops the server dropping experimental
        // notifications and keeps extra fields on approval requests; Mousse ignores both.
        capabilities: { experimentalApi: true, requestAttestation: false }
      })
      .then(() => {
        conn.notify('initialized')
        return conn
      })
    ready.catch(() => conn.close())
    this.app = { conn, ready, verified: false, generation: this.launchGeneration, exited, statuses }
    return ready
  }

  private environment(): NodeJS.ProcessEnv {
    return withUserEnv(this.options.env?.() ?? codexEnvironment(), storedCliEnv(this.settings))
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
    this.orphans.clear()
    // The next process must prove its own sign-in before it gets a turn.
    this.probeResult = undefined
    for (const [threadId, run] of [...this.turns]) {
      this.turns.delete(threadId)
      run.fail(reason)
    }
  }

  private route(notification: CodexNotification, statuses: ThreadStatuses): void {
    // Recorded here, in the order the process sent them and before any response resolves.
    statuses.note(notification)
    if (isWakeUp(notification))
      for (const held of this.turns.values()) {
        held.tree?.noteWake(notification)
        held.poke()
      }
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
    const tracker = owner?.helpers ?? [...this.orphans].find((helpers) => helpers.has(threadId))
    if (tracker) {
      tracker.handle(notification)
      // A stopped tracker is kept only while a helper still lacks its turn id, whichever path resolved it.
      if (!tracker.awaitingTurn()) this.orphans.delete(tracker)
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

  /**
   * Records the history a stopped turn left in its Codex thread, so the next turn resumes that thread
   * instead of starting a new one with the history replayed. A stop before the thread was opened saves
   * nothing.
   */
  commitInterrupted(threadId: string, history: string): void {
    const codexThreadId = this.interruptedThreads.get(threadId)
    this.interruptedThreads.delete(threadId)
    const saved = this.settings.threads?.[threadId]
    if (!codexThreadId || !saved || saved.codexThreadId !== codexThreadId) return
    saved.historyKey = historyKey(history)
    this.save()
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
    void this.startSweep(run)
  }

  /**
   * Interrupts the direct helpers master tracks (named by spawn items), those running now and any that
   * start later. The parent's interrupt does not reach them; each helper thread is interrupted on its
   * own. With `everyRound`, a sweep also interrupts each running one without a turn id, which stops
   * whatever turn it runs. In tree mode this is the floor under the listed tree.
   */
  private stopHelpers(run: TurnRun, everyRound = false): void {
    const conn = run.conn
    if (!conn || conn.signal.aborted) return
    const interrupt = (threadId: string, turnId: string): void => {
      void conn.request('turn/interrupt', { threadId, turnId }, { timeoutMs: INTERRUPT_TIMEOUT_MS }).catch(() => {
        /* the helper ended meanwhile, or the process is gone */
      })
    }
    run.helpers.stopAll(interrupt)
    if (everyRound) for (const threadId of run.helpers.running()) interrupt(threadId, '')
    // A known helper whose turn has not started is interrupted when it does, even after this chat ended.
    if (run.helpers.awaitingTurn()) this.orphans.add(run.helpers)
  }

  private sendInterrupt(run: TurnRun): void {
    const conn = run.conn
    if (!conn || conn.signal.aborted || !run.turnId || run.turnCompleted()) return
    run.stopInterrupt = run.turnId
    this.interruptTurn(run, conn, run.turnId)
  }

  /** Interrupts the run's own thread: its turn by id when one is known and running, else whatever turn it runs. */
  private interruptRoot(run: TurnRun, conn: CodexConnection, round: number): void {
    this.interruptTurn(run, conn, run.turnId && !run.turnCompleted() ? run.turnId : '', round)
  }

  /**
   * `turn/interrupt` on the run's thread. Stop sends its own first; the sweep's first round does not repeat
   * that same interrupt, and every later round sends again (a stopped turn can be followed by a queued one).
   */
  private interruptTurn(run: TurnRun, conn: CodexConnection, turnId: string, round?: number): void {
    run.selfInterrupted = true
    if (round === 0 && run.stopInterrupt === turnId) return
    void conn.request('turn/interrupt', { threadId: run.codexThreadId, turnId }, { timeoutMs: INTERRUPT_TIMEOUT_MS }).catch(() => {
      /* the turn ended meanwhile, or the process is gone */
    })
  }

  // -------------------------------------------------------------------------------------------
  // Helper tree

  /** Marks the process as not listing descendants (final for it) and says so once. */
  private treeOff(app: NonNullable<typeof this.app>, why: string): void {
    if (app.tree === 'off') return
    app.tree = 'off'
    console.warn(`[codex] Codex helpers are tracked from their spawn items only: ${why}`)
  }

  /**
   * Whether this process lists a thread's descendants by ancestor. Two requests with a made-up
   * thread id: both filters at once must be refused as exclusive, and one ancestor filter alone
   * must list nothing. An older server ignores the filters and answers a listing; one without a
   * state database answers an error. A transport failure leaves the question open until the next chat.
   */
  private async ensureTreeMode(conn: CodexConnection): Promise<void> {
    const app = this.app
    if (!app || app.conn !== conn || app.tree) return
    app.treeProbe ??= this.probeTree(conn, app).finally(() => {
      app.treeProbe = undefined
    })
    await app.treeProbe
  }

  private async probeTree(conn: CodexConnection, app: NonNullable<typeof this.app>): Promise<void> {
    const probeId = TREE_PROBE_THREAD_ID
    const options = { timeoutMs: this.dependencies.requestTimeoutMs ?? TREE_REQUEST_MS }
    try {
      try {
        await conn.request('thread/list', { parentThreadId: probeId, ancestorThreadId: probeId, limit: 1 }, options)
        return this.treeOff(app, 'thread/list does not refuse exclusive filters')
      } catch (error) {
        if (!(error instanceof CodexRpcError)) throw error
        if (!/mutually exclusive/i.test(error.message)) return this.treeOff(app, `thread/list answered "${error.message}"`)
      }
      const listing = await conn.request('thread/list', { ancestorThreadId: probeId, limit: 1, useStateDbOnly: true }, options)
      if (!Array.isArray(listing?.data) || listing.data.length > 0) return this.treeOff(app, 'thread/list lists threads of an unknown ancestor')
      if (this.app === app) app.tree = 'on'
    } catch (error) {
      if (error instanceof CodexRpcError) this.treeOff(app, `thread/list answered "${error.message}"`)
      // Otherwise the process or the request failed: the question stays open for the next chat.
    }
  }

  private treePorts(conn: CodexConnection): TreePorts {
    const refused = (error: unknown): unknown => (error instanceof CodexRpcError ? new RpcRefused(error.message) : error)
    const timeout = this.dependencies.requestTimeoutMs ?? TREE_REQUEST_MS
    return {
      now: () => Date.now(),
      // A snapshot the tree gave up on aborts `signal`: its pending request fails and no further page is asked.
      read: async (threadId, signal) => {
        try {
          return (await conn.request('thread/read', { threadId }, { timeoutMs: timeout, ...(signal ? { signal } : {}) })).thread
        } catch (error) {
          throw refused(error)
        }
      },
      list: async (ancestorThreadId, signal) => {
        const rows: unknown[] = []
        let cursor: string | null | undefined
        try {
          for (let page = 0; page < TREE_MAX_PAGES; page += 1) {
            signal?.throwIfAborted()
            const response = await conn.request(
              'thread/list',
              { ancestorThreadId, limit: 100, useStateDbOnly: true, ...(cursor ? { cursor } : {}) },
              { timeoutMs: timeout, ...(signal ? { signal } : {}) }
            )
            if (!Array.isArray(response?.data)) throw new RpcRefused('thread/list returned no data')
            rows.push(...response.data)
            cursor = response.nextCursor
            if (!cursor) return rows
          }
        } catch (error) {
          throw refused(error)
        }
        throw new RpcRefused('thread/list returned too many pages')
      },
      interrupt: (threadId, turnId) => {
        void conn.request('turn/interrupt', { threadId, turnId }, { timeoutMs: INTERRUPT_TIMEOUT_MS }).catch(() => {
          /* the thread ended meanwhile, or the process is gone */
        })
      }
    }
  }

  /** The run's tree, created on first use. Only called in tree mode. */
  private treeOf(run: TurnRun, conn: CodexConnection, app: NonNullable<typeof this.app>): HelperTree {
    run.tree ??= new HelperTree(
      run.codexThreadId,
      this.treePorts(conn),
      app.statuses,
      run.helpers,
      this.dependencies.helperTiming ? { ...DEFAULT_TREE_TIMING, ...this.dependencies.helperTiming } : undefined
    )
    return run.tree
  }

  /**
   * Interrupts everything under the run's thread until it is at rest: its own turn, the helpers the
   * server lists (any depth), the ones seen placed under it, and the direct helpers master tracks. Ends
   * at a quiescence pair, when `signal` aborts, when the process is gone, or after `CODEX_SWEEP_MS`
   * even if something has not stopped. Without the capability, master's helper tracking does the same
   * per round.
   */
  private async sweep(run: TurnRun, signal?: AbortSignal): Promise<void> {
    const app = this.app
    const conn = run.conn
    if (!app || !conn || app.conn !== conn || conn.signal.aborted) return
    const deadlineAt = Date.now() + (this.dependencies.helperSweepMs ?? CODEX_SWEEP_MS)
    let fellBack = false
    if (app.tree === 'on') {
      try {
        const outcome = await this.treeOf(run, conn, app).sweep({
          deadlineAt,
          ...(signal ? { signal } : {}),
          interruptRoot: (round) => this.interruptRoot(run, conn, round),
          interruptFloor: () => this.stopHelpers(run, true),
          dead: () => conn.signal.aborted
        })
        if (outcome === 'deadline') console.warn('[codex] a thread or helper did not stop after being interrupted; releasing the run')
        return
      } catch (error) {
        if (!(error instanceof TreeOff)) throw error
        this.treeOff(app, error.message)
        run.tree = undefined
        fellBack = true
      }
    }
    // A sweep that fell back from the tree has already interrupted the root once.
    for (let round = fellBack ? 1 : 0; ; round += 1) {
      if (conn.signal.aborted || signal?.aborted) return
      this.stopHelpers(run)
      // Master's view: the turn Mousse knows. A turn still starting is interrupted when its id arrives.
      if (run.turnId && !run.turnCompleted()) this.interruptTurn(run, conn, run.turnId, round)
      if (run.isIdle() && run.helpers.running().length === 0) return
      const left = deadlineAt - Date.now()
      if (left <= 0) {
        console.warn('[codex] a thread or helper did not stop after being interrupted; releasing the run')
        return
      }
      await run.nextActivity(Math.min(this.dependencies.helperTiming?.sweepRoundMs ?? 500, left), signal)
    }
  }

  /**
   * Starts the sweep that ends a stopped or failed run, once: the chat has already been rejected, the
   * thread's turn and helpers are still being interrupted. The run is released when it ends, and the
   * thread's next chat waits for it.
   */
  private startSweep(run: TurnRun): Promise<void> {
    if (run.sweeping) return run.sweeping
    const done = this.sweep(run)
      .catch((error: unknown) => console.warn('[codex] stopping the helpers failed', error instanceof Error ? error.message : String(error)))
      .then(() => {
        this.release(run)
        if (this.pendingSweeps.get(run.mousseThreadId) === done) this.pendingSweeps.delete(run.mousseThreadId)
      })
    run.sweeping = done
    this.pendingSweeps.set(run.mousseThreadId, done)
    return done
  }

  /** The run no longer receives the thread's events and nothing waits for it. */
  private release(run: TurnRun): void {
    if (this.turns.get(run.codexThreadId) === run) this.turns.delete(run.codexThreadId)
    run.tree = undefined
    run.settled()
    this.closeWhenIdle(CODEX_IDLE_CLOSE_MS)
  }

  /**
   * Opens the thread's Codex thread for this turn: the loaded one, a resumed saved one, or a new
   * one. A failed resume starts a new thread and reports `broken`.
   */
  private async openThread(
    conn: CodexConnection,
    input: CodexChatInput,
    signal: AbortSignal
  ): Promise<{ codexThreadId: string; model: string | undefined; continued: boolean; instructionsStale?: boolean }> {
    const cwd = resolve(input.cwd)
    const instructionsHash = input.developerInstructions ? historyKey(input.developerInstructions).slice(0, 32) : undefined
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
      modelProvider: this.modelProvider,
      config: { ...overrides, model_provider: this.modelProvider },
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
      if (loaded && loaded.mcpToken === mcpToken && loaded.cwd === cwd && loaded.childKey === childKey) {
        // A loaded thread keeps the developer instructions it was opened with: changed ones go into the prompt.
        const instructionsStale = instructionsHash !== undefined && loaded.instructionsHash !== instructionsHash
        loaded.instructionsHash = instructionsHash
        return { codexThreadId: saved.codexThreadId, model: undefined, continued: true, instructionsStale }
      }
      if (loaded) {
        // The attachment, cwd or child policy changed while the thread is loaded. A resume would
        // keep the old config, so fork it: Codex loads the history into a new thread with the new
        // config, and the old thread is released.
        const forked = pinnedProvider(this.modelProvider, await conn.request('thread/fork', { threadId: saved.codexThreadId, excludeTurns: true, ...params }, { signal }))
        this.loaded.delete(saved.codexThreadId)
        this.loaded.set(forked.thread.id, { mcpToken, cwd, childKey, instructionsHash })
        await conn.request('thread/unsubscribe', { threadId: saved.codexThreadId }, { signal, timeoutMs: 5_000 }).catch(() => undefined)
        signal.throwIfAborted()
        return { codexThreadId: forked.thread.id, model: forked.model, continued: true }
      }
      try {
        const resumed = pinnedProvider(this.modelProvider, await conn.request('thread/resume', { threadId: saved.codexThreadId, excludeTurns: true, ...params }, { signal }))
        this.loaded.set(resumed.thread.id, { mcpToken, cwd, childKey, instructionsHash })
        return { codexThreadId: resumed.thread.id, model: resumed.model, continued: true }
      } catch (error) {
        signal.throwIfAborted()
        conn.signal.throwIfAborted()
        if (!(error instanceof CodexRpcError)) throw error
        const fresh = pinnedProvider(this.modelProvider, await conn.request('thread/start', params, { signal }))
        this.loaded.set(fresh.thread.id, { mcpToken, cwd, childKey, instructionsHash })
        return { codexThreadId: fresh.thread.id, model: fresh.model, continued: false }
      }
    }
    const fresh = pinnedProvider(this.modelProvider, await conn.request('thread/start', params, { signal }))
    this.loaded.set(fresh.thread.id, { mcpToken, cwd, childKey, instructionsHash })
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
    this.interruptedThreads.delete(input.threadId)
    try {
      // A stopped run on this thread is still interrupting its turn and helpers; the new turn starts after.
      const sweeping = this.pendingSweeps.get(input.threadId)
      if (sweeping) await abortable(sweeping, signal)
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
      await abortable(this.ensureTreeMode(conn), signal)
      const thread = await this.openThread(conn, input, signal)
      signal.throwIfAborted()
      const codexThreadId = thread.codexThreadId
      // The thread is not resumable until the turn commits its history.
      this.settings.threads = { ...this.settings.threads, [input.threadId]: { codexThreadId, cwd: resolve(input.cwd), instanceId: input.instanceId ?? CODEX_INSTANCE_ID } }
      this.save()
      input.onSession?.({ codexThreadId })
      const current = new TurnRun(codexThreadId, input.threadId, input.mode ?? 'default', signal, input, (id) => this.strays.get(id))
      run = current
      current.conn = conn
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
      // Wakes the wait for native helpers when a steer has to start a turn of its own.
      let steerWake: (() => void) | undefined
      const hold = (text: string): void => {
        undelivered.push(text)
        steerWake?.()
      }
      const deliver = (text: string): void => {
        steering = steering.then(async () => {
          if (!current.turnOpen || !current.turnId || signal.aborted) {
            hold(text)
            return
          }
          try {
            await conn.request('turn/steer', { threadId: codexThreadId, expectedTurnId: current.turnId, input: [textInput(text)] }, { signal })
          } catch (error) {
            if (!(error instanceof CodexRpcError)) throw error
            hold(text)
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
        (thread.instructionsStale && input.developerInstructions
          ? `<mousse_session_instructions>\n${input.developerInstructions}\n</mousse_session_instructions>\n\n`
          : '') +
        (input.turnPreamble ? input.turnPreamble + '\n\nCurrent request:\n' : '') +
        (!thread.continued && input.history
          ? `Previous conversation (context only; do not repeat earlier actions):\n${input.history}\n\nCurrent request:\n`
          : '')
      let nextInput: UserInput[] = [textInput(preamble + (input.prompt || '(image attachment)')), ...images]
      let lastTurn: CodexTurn | undefined
      // When native helpers first held this chat open; the pin cap counts from here.
      let pinnedSince: number | undefined
      // Set when a cap stopped the helpers: the note that ends the reply, once any held steer has run.
      let abandoned: string | undefined
      // A turn ran after the cap stopped the helpers.
      let afterCap = false
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
            // Assigned, not defaulted: a server turn that ended just before may have left its id behind.
            current.turnStarted(started.turn)
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
        current.turnOpen = true
        input.onSession?.({ codexThreadId, turnId: current.turnId })
        // Steers drained before the turn existed go in now.
        for (const steer of undelivered.splice(0)) deliver(steer)
        lastTurn = await Promise.race([completion, aborted])
        current.turnOpen = false
        // Stop must not wait for a steer the server has not answered yet.
        await Promise.race([steering, aborted])
        collectSteer()
        await Promise.race([steering, aborted])
        if (lastTurn.status === 'failed') throw this.turnFailure(lastTurn.error, current.lastError)
        if (lastTurn.status === 'interrupted') {
          signal.throwIfAborted()
          throw new Error('Codex interrupted the turn')
        }
        if (!undelivered.length) {
          // Codex completes the parent's turn while the helpers it started keep running, so this chat
          // (the child's run) stays open until they settle: the thread's whole helper tree when the
          // process lists it, the direct helpers seen in the thread's items otherwise. Stop interrupts
          // them and ends the wait; a steer that arrives meanwhile starts a turn; helpers silent for
          // too long are abandoned.
          const treeMode = this.app?.conn === conn && this.app.tree === 'on'
          if ((treeMode || current.helpers.running().length) && !abandoned) {
            pinnedSince ??= Date.now()
            const held = await this.holdChat(current, input, conn, aborted, new Promise<void>((wake) => (steerWake = wake)), pinnedSince)
            steerWake = undefined
            // Stop interrupts the helpers, and their end can be reported before the abort is seen.
            signal.throwIfAborted()
            this.throwAdoptedFailure(current, signal)
            if (held) {
              // A steer that arrived in the same tick still gets its turn before the run ends.
              await this.stopAbandoned(current, conn, signal)
              abandoned = held
            }
          }
          if (!undelivered.length) break
        }
        if (abandoned) afterCap = true
        nextInput = [textInput(undelivered.splice(0).join('\n'))]
      }
      // A turn that ran after the cap (a held steer) does not wait for helpers; its own are interrupted
      // before the run ends.
      this.throwAdoptedFailure(current, signal)
      if (afterCap) await this.stopAbandoned(current, conn, signal)
      if (abandoned) current.addNote(abandoned)
      this.release(current)
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
      // A failed or stopped chat leaves nothing of its own running: the thread's turn and every helper
      // under it are interrupted until they are at rest (or the sweep's deadline), after the chat has
      // already been rejected. The run is released when that ends.
      if (run) void this.startSweep(run)
      run?.closeTools()
      if (signal.aborted && input.signal?.aborted) {
        // The thread exists on the server: the adapter may fingerprint it (`commitInterrupted`).
        if (run && scope === this.scope) this.interruptedThreads.set(input.threadId, run.codexThreadId)
        throw input.signal.reason ?? error
      }
      throw error
    } finally {
      if (steerTimer) clearInterval(steerTimer)
      signal.removeEventListener('abort', onAbort)
      input.signal?.removeEventListener('abort', forward)
      this.controllers.delete(controller)
      this.activeThreads.delete(input.threadId)
      this.closeWhenIdle(CODEX_IDLE_CLOSE_MS)
      // A stopped turn stays registered (for routing) until its sweep ends or the process dies.
      run?.mute()
      run?.cancelQuestions()
    }
  }

  /**
   * The wait for helpers: the helper tree the server lists when the process does that, else the direct
   * helpers seen in the thread's items (master's tracking, also the fallback when the tree turns out
   * unusable). Returns when they have settled or a steer wants a turn (nothing returned), or the note
   * of a cap.
   */
  private async holdChat(
    run: TurnRun,
    input: CodexChatInput,
    conn: CodexConnection,
    aborted: Promise<never>,
    steerArrived: Promise<void>,
    pinnedSince: number
  ): Promise<string | undefined> {
    const app = this.app
    if (app?.conn === conn && app.tree === 'on') {
      try {
        return await this.holdTree(run, input, conn, app, aborted, steerArrived, pinnedSince)
      } catch (error) {
        if (!(error instanceof TreeOff)) throw error
        this.treeOff(app, error.message)
        run.tree = undefined
      }
    }
    return run.helpers.running().length ? this.holdForHelpers(run, input, aborted, steerArrived, pinnedSince) : undefined
  }

  /** A turn the run adopted ended `failed` or `interrupted`: the run fails like one of Mousse's own turns, and its sweep follows. */
  private throwAdoptedFailure(run: TurnRun, signal: AbortSignal): void {
    const turn = run.adoptedFailure
    if (!turn) return
    if (turn.status === 'failed') throw this.turnFailure(turn.error, run.lastError)
    signal.throwIfAborted()
    throw new Error('Codex interrupted the turn')
  }

  /** Ends the helpers a cap gave up on: swept in tree mode, interrupted as master did otherwise. */
  private async stopAbandoned(run: TurnRun, conn: CodexConnection, signal: AbortSignal): Promise<void> {
    if (this.app?.conn === conn && this.app.tree === 'on') await abortable(this.sweep(run, signal), signal)
    else this.stopHelpers(run)
    signal.throwIfAborted()
  }

  /**
   * Waits until the thread's helper tree is quiescent (see `HelperTree`): returns nothing then, or
   * when a steer wants a turn; or a cap's note. A `turn/started` the server sends on its own meanwhile
   * is adopted by the run. Throws `TreeOff` when the process turns out not to list descendants.
   */
  private async holdTree(
    run: TurnRun,
    input: CodexChatInput,
    conn: CodexConnection,
    app: NonNullable<typeof this.app>,
    aborted: Promise<never>,
    steerArrived: Promise<void>,
    pinnedSince: number
  ): Promise<string | undefined> {
    const tree = this.treeOf(run, conn, app)
    const enteredAt = Date.now()
    const cap = this.capTimer(pinnedSince, () => Math.max(run.helpers.lastActivityAt, tree.lastActivityAt, enteredAt))
    const stop = new AbortController()
    const quiet = tree.untilQuiescent(stop.signal).then(() => undefined)
    quiet.catch(() => undefined)
    // The process dying ends the wait: the chat then fails as it would anywhere else.
    const gone = new Promise<never>((_resolve, reject) => {
      const fail = (): void => reject(conn.signal.reason)
      if (conn.signal.aborted) fail()
      else conn.signal.addEventListener('abort', fail, { once: true })
      stop.signal.addEventListener('abort', () => conn.signal.removeEventListener('abort', fail), { once: true })
    })
    gone.catch(() => undefined)
    const beat = setInterval(() => input.onHeartbeat?.(), 5_000)
    beat.unref?.()
    run.holding = true
    try {
      return await Promise.race([quiet, steerArrived.then(() => undefined), run.whenAdoptedFails(stop.signal).then(() => undefined), cap.expired, aborted, gone])
    } finally {
      run.holding = false
      stop.abort()
      clearInterval(beat)
      cap.cancel()
    }
  }

  /**
   * Holds a chat whose own turn is done while its native helpers run. Returns when they have all
   * settled or a steer wants a turn (nothing returned), or when the cap expires: no helper has
   * reported anything for the idle cap, or they have held the chat for the pin cap in total (the
   * note to end the reply with). Stop rejects through `aborted`. Heartbeats keep the run alive.
   */
  private async holdForHelpers(
    run: TurnRun,
    input: CodexChatInput,
    aborted: Promise<never>,
    steerArrived: Promise<void>,
    pinnedSince: number
  ): Promise<string | undefined> {
    const enteredAt = Date.now()
    const cap = this.capTimer(pinnedSince, () => Math.max(run.helpers.lastActivityAt, enteredAt))
    const beat = setInterval(() => input.onHeartbeat?.(), 5_000)
    beat.unref?.()
    try {
      return await Promise.race([run.helpers.whenSettled().then(() => undefined), steerArrived.then(() => undefined), cap.expired, aborted])
    } finally {
      clearInterval(beat)
      cap.cancel()
    }
  }

  /**
   * Resolves with the note of a cap: no activity (as `lastActivity` reports it) for the idle cap, or
   * the pin cap since `pinnedSince`.
   */
  private capTimer(pinnedSince: number, lastActivity: () => number): { expired: Promise<string>; cancel: () => void } {
    const idleCap = this.dependencies.helperIdleCapMs ?? CODEX_HELPER_IDLE_CAP_MS
    const pinCap = this.dependencies.helperPinCapMs ?? CODEX_HELPER_PIN_CAP_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<string>((done) => {
      const check = (): void => {
        const now = Date.now()
        const idleFor = now - lastActivity()
        const pinned = now - pinnedSince
        const minutes = (ms: number): string => {
          const count = Math.max(1, Math.round(ms / 60_000))
          return `${count} minute${count === 1 ? '' : 's'}`
        }
        if (pinned >= pinCap) return done(`Some helpers were abandoned after ${minutes(pinned)}`)
        if (idleFor >= idleCap) return done(`Some helpers were abandoned after ${minutes(idleFor)} without activity`)
        timer = setTimeout(check, Math.max(1, Math.min(idleCap - idleFor, pinCap - pinned)))
        timer.unref?.()
      }
      check()
    })
    return { expired, cancel: () => clearTimeout(timer) }
  }

  /**
   * The failure of a turn Codex ended as failed, its texts redacted: the turn's own error, with the
   * kind of the last error Codex gave up on when the turn's names none.
   */
  private turnFailure(turnError: TurnError | null | undefined, lastError: TurnError | undefined): CodexTurnFailure {
    const error = turnError ? { ...turnError, codexErrorInfo: turnError.codexErrorInfo ?? lastError?.codexErrorInfo ?? null } : lastError
    return new CodexTurnFailure(this.redact(error?.message || 'Codex turn failed'), error ? {
      ...error,
      additionalDetails: typeof error.additionalDetails === 'string' ? this.redact(error.additionalDetails) : null
    } : undefined)
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

/** Refuses a thread whose effective provider is not the one Mousse pinned (`expected`). */
function pinnedProvider<T extends { modelProvider?: string }>(expected: string, response: T): T {
  if (response.modelProvider !== expected)
    throw new AppError({
      code: 'codex_provider_not_chatgpt',
      // Static text: the provider name comes from the process and could carry anything.
      message: 'Codex chose another model provider than the one Mousse set; Mousse only runs Codex on that one.',
      errorInfo: { category: 'unavailable', retryable: false }
    })
  return response
}

function textInput(text: string): UserInput {
  return { type: 'text', text, text_elements: [] }
}

/** Whether `exited` settles within `ms`. */
function exitWithin(exited: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

/** `promise`, or the signal's reason once it aborts first (the promise itself keeps running). */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Codex turn cancelled'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error('Codex turn cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** Builds the profile's Codex service (registration seam; see `run/adapters/codex/index.ts`). */
export function createCodexProviderService(
  profileHome: string,
  questions: UserQuestionService,
  deps: CodexServiceDependencies = {},
  options: CodexServiceOptions = {}
): CodexProviderService {
  return new CodexProviderService(profileHome, questions, deps, options)
}
