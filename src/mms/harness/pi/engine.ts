import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { isRetryableAssistantError } from '@earendil-works/pi-ai'
import { AppError } from '../../../shared/errors'
import { piPermissionKey, piToolAction } from '../../../shared/permissionKeys'
import { permissionModeAllows } from '../../../shared/permissionMode'
import { permissionActionForWrite } from '../../files/gitMetadataWrite'
import { harnessAppError } from '../../../shared/harness/types'
import type { CredentialKind } from '../../../shared/harness/status'
import { parseThinkingSuffixFromModelId } from '../../../shared/modelVariants'
import { atomicWriteFileSync, atomicWriteJsonSync } from '../../data/AtomicFs'
import { normalizeProviderError } from '../../orchestrator/providerErrors'
import type {
  AdapterHost,
  ModelInfo,
  ProviderAdapter,
  ProviderCapabilities,
  TurnControl,
  TurnInput,
  TurnResult,
  TurnSink
} from '../adapter'
import { CumulativeStream } from '../../run/transcript/promptRuntime'
import type { ProviderRef } from '../../run/types'
import type { InstanceEnv } from '../env'
import { killTree } from '../spawn'
import { COMMAND_DEADLINE_MS, INTERRUPT_DEADLINE_MS, READY_DEADLINE_MS } from '../supervise'
import { logWarn } from '../../log/diag'
import { PiBridge, type PiBridgeRegistration } from './bridge'
import { longerTtl, writtenCacheTtl } from '../promptCache'
import { DescendantTracker, OwnedGroups } from './descendants'
import { WriterEpisode, type PiToolClass } from './episode'
import { authorizeDefinitionCall, recordAuthorizedCall, withoutTransportFields } from '../../agentDefinitions/definitionGate'
import { isShellTool } from '../../agentDefinitions/runtimePolicy'
import { canonicalizeBuiltinToolName } from '../../agentDefinitions/runtimePolicy'
import type { ToolCall } from '@earendil-works/pi-ai'
import type { AgentExecutionLimit } from '../../../shared/agents/execution'
import { ANTHROPIC_OAUTH_REFUSED, BUDGET_EXHAUSTED, CREDENTIAL_UNAVAILABLE, GATE_REFUSALS, GATE_UNAVAILABLE, REQUEST_REFUSED, SPEND_CAP_MISMATCH } from './extension/messages'
import { PI_BRIDGE_ENV, type PiCatalogProvider, type PiGateRequest, type PiGateResponse, type PiReadyRequest, type PiRequestRequest, type PiRequestResponse, type PiSettleRequest, type PiTurnResponse, type PiTurnTool } from './extension/protocol'
import { addsThinkingBudget, capHonouring, fallbackModels, grantFloor, multipleCandidates, reservationRates, thinkingBudgetFor, type PiReasoning } from './reservation'
import type { SpendModelFacts } from '../policy'
import type { TurnBudget } from '../budget'
import { piLaunch, startPiProcess, type PiLaunch, type PiLockedLaunch, type PiProcess, type PiRuntimePaths, type PiThinkingLevel } from './launch'
import { PI_PATH_ARGUMENTS, piResolvePath, piResolveReadPath } from './paths'
import { piCredentialHandler, piOAuthCredential, piOAuthHandle, writePiAuth, type PiOAuthSource } from './oauthBroker'
import type { PiRpcEvent, PiRpcExit, PiRpcRequest } from './rpcClient'
import { preparePiHome, type PiSettingsInput } from './settings'
import { PI_NATIVE_TOOLS } from './nativeTools'
import { botAppToolRefusal, checkBuiltinCall, checkMessage, wallMessage } from '../../../shared/bots/personal/walls'
import { neutralToolIdempotent, neutralToolsOf } from '../../../shared/harness/tools'

/**
 * The Pi RPC engine (PR 2 §4): each thread of a `pi:*` instance runs on its own Pi process
 * (`--mode rpc`), started through the launcher with Mousse's extension, kept warm between turns.
 *
 * A process serves a turn only after its extension reported ready with every available model
 * guarded and the AWS SDK pinned to one attempt; any failure to get there (an exit, a failed
 * provider registration, a missing report within the deadline) kills the tree before `prompt`.
 * Tool calls pass the gate (`/pi/gate`): only the turn's active tools, for the turn's attempt, with
 * the writer episode and its barrier, a definition's authority over Pi's built-ins, and the run's
 * tool-call limit. Every model request is charged first (`/pi/request`): none is sent outside a
 * live turn, and the run's turn limit refuses the next one before it starts (`budgets: 'hard'`).
 * Under token or USD limits each request is also reserved first, at its final wire cap, and settled
 * with its usage (`spendLimits: 'reserved'`, PR 4 §5b).
 * The engine never retries: Pi's own retry (as `settings.json` configures it) is mapped to the
 * status line and, when exhausted, to `retriesExhausted`.
 *
 * Every ref the engine reports names its turn exactly (`nativeTurnId`), from the first one on: a
 * steer, Stop or kill reaches that turn's process or nothing, never another thread's.
 */

const execFileAsync = promisify(execFile)

/** Pi's built-in tools by class. */
const BUILTIN_CLASSES: Record<string, PiToolClass> = {
  read: 'read', grep: 'read', find: 'read', ls: 'read',
  edit: 'mutation', write: 'mutation', bash: 'mutation', powershell: 'mutation'
}
export const PI_READ_ONLY_BUILTINS: readonly string[] = ['read', 'grep', 'find', 'ls']
/** Pi's tools that walk down from a folder (`ls` lists one folder's names only). */
const PI_WALKING_TOOLS: ReadonlySet<string> = new Set(['grep', 'find'])
export const PI_ALL_BUILTINS: readonly string[] = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']
/** How long the writer waits for a dead process's tree and its sweep (the Windows sweep alone can take 20 s). */
export const CLEANUP_DEADLINE_MS = 30_000

/**
 * The variable every bot process carries: its activation. Its children inherit it across `setsid`,
 * so a later sweep can find what a bot started (Bot Phase 1 §5.9, Phase 2).
 */
export const PI_BOT_MARKER = 'MOUSSE_BOT_ACTIVATION'
/** How long a thread's process stays after its turn ended (successfully or not). */
export const PI_WARM_MS = 10 * 60_000
/** How long Pi may take to accept a prompt: its preflight can run a compaction (a model request). */
export const PI_PROMPT_DEADLINE_MS = 120_000
/** Pi's thinking levels (`--thinking`); Mousse efforts map onto them. */
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])

/** Pi's thinking level for a Mousse effort (`max` is Pi's `xhigh`; none or unknown is `off`). */
function piThinkingLevel(effort: string | undefined): PiThinkingLevel {
  return (effort && THINKING_LEVELS.has(effort) ? effort : effort === 'max' ? 'xhigh' : 'off') as PiThinkingLevel
}

export interface PiEngineCatalog {
  provider: PiCatalogProvider
  revision: number
}

/** A Mousse tool the engine offers Pi for a turn (from the Mousse MCP server's listing). */
export interface PiMousseTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  class: PiToolClass
}

export interface PiRpcEngineOptions {
  instanceId: string
  /** The pi-ai provider id of the instance. */
  provider: string
  label: string
  capabilities: ProviderCapabilities
  env: () => InstanceEnv
  stateDir: string
  runtime: () => PiRuntimePaths
  catalog: () => PiEngineCatalog
  /** The stored key of the instance; it reaches Pi only in the factory's catalogue answer. */
  apiKey?: () => string | undefined
  /**
   * Mousse's OAuth credentials (`piOAuthBroker`): the instance provider's one is written to Pi's
   * `auth.json` before every start with an opaque handle for its refresh token, and Pi's refreshes
   * come back to it over `/pi/credential`.
   */
  oauth?: PiOAuthSource
  /** Variables configured on the instance (ids only; the launcher refuses credentials). */
  extraEnv?: () => Readonly<Record<string, string>> | undefined
  /** Git Bash on Windows. */
  shellPath?: () => string | undefined
  compaction?: () => boolean
  /**
   * Mousse's tools for a thread, with their class (the gate and the barrier read it). `runId`: the
   * turn they are sent for, so a definition's turn gets them as its loop would send them.
   */
  mousseTools?: (threadId: string, runId?: string) => PiMousseTool[]
  /**
   * The user's own MCP tools the turn `runId` is offered, proxied through Mousse's MCP server (the
   * driver's `userMcp: 'proxy'`); a definition's turn gets its granted ones only.
   */
  userMcpTools?: (threadId: string, runId?: string) => Promise<PiMousseTool[]>
  warmMs?: number
  readyDeadlineMs?: number
  commandDeadlineMs?: number
  promptDeadlineMs?: number
  /** How long a steer cut's `abort` and its settlement may take together (`INTERRUPT_DEADLINE_MS`). */
  interruptDeadlineMs?: number
  /** Test seams. */
  settings?: Pick<PiSettingsInput, 'retry'>
  host?: { execPath: string; versions: Partial<NodeJS.ProcessVersions> }
  adjustLaunch?: (launch: Extract<PiLaunch, { runs: 'yes' }>) => Extract<PiLaunch, { runs: 'yes' }>
  /** Every RPC command sent (tests check that no `bash` command is ever sent). */
  onCommand?: (type: string) => void
  /** Test seam: runs inside the cleanup after a Pi process died (tests hold it). */
  sweepHook?: () => Promise<void>
  /** Test seam: delays the answer to the extension's turn request (inside Pi's prompt preflight). */
  holdTurn?: () => Promise<void>
  /** Every Pi process started, by pid (tests watch processes come and go). */
  onSpawn?: (pid: number, threadId: string) => void
  /**
   * Each process a bot turn starts, by pid and the bot thread (Bot Phase 1 §5.9): its active-time
   * supervision (`BotProcessRegistry.attachThread`). When it throws, the process is killed and the
   * turn fails. Without it the engine runs no bot turn.
   */
  onBotProcess?: (pid: number, threadId: string) => void
  /** What the instance runs on (`InstanceSnapshot.auth.credential`), for a bot turn's locked environment. */
  credentialKind?: () => CredentialKind | Promise<CredentialKind>
  /** Variables for a test build of the extension (`MOUSSE_PI_TEST_*`). */
  testEnv?: Readonly<Record<`MOUSSE_PI_TEST_${string}`, string>>
  /**
   * A line for the thread's user (`history_injected`): a turn started a new Pi session with the
   * thread's history handed over, seeded into the session or as a prompt preamble.
   */
  notice?: (threadId: string, notice: { code: 'history_injected'; message: string }) => void
  /** Test seam: runs after a seeded session file was written, before Pi loads it (tests corrupt it). */
  onSeed?: (file: string) => void
}

interface SavedThread {
  sessionId: string
  historyFingerprint?: string
  instructionsHash?: string
  /** The session's leaf entry after the last completed turn (the cursor of `get_entries since`). */
  leafId?: string
  /** The leaf entry each completed turn left, by the turn's key (`nativeTurnId`): a fork's branch point. */
  turnLeaves?: Record<string, string>
  /**
   * A native fork's branch, bound to the fork's thread before its first turn. The gateway's fence
   * keeps it (the thread has no binding of its own yet); a credential change drops it.
   */
  pendingFork?: true
}

/** A session Mousse wrote from a thread's transcript, and the roles Pi must report back for it. */
interface PiSeed {
  sessionId: string
  file: string
  roles: string[]
}

/** How many turns' leaves a thread keeps for forks. */
const FORKABLE_TURNS = 200
/** Messages Pi's `convertToLlm` passes to the model as they are: the only ones a seeded session holds. */
const SEED_ROLES = new Set(['user', 'assistant', 'toolResult'])

/** The file of a Pi session in `dir` (Pi names them `<timestamp>_<sessionId>.jsonl`). */
function sessionFileOf(dir: string, sessionId: string): string | undefined {
  try {
    const name = readdirSync(dir).find((entry) => entry.endsWith(`_${sessionId}.jsonl`))
    return name ? join(dir, name) : undefined
  } catch {
    return undefined
  }
}

/** The header line of a Pi session file (`{type:'session', id, cwd, ...}`), read without loading the file. */
function sessionHeaderOf(file: string): { line: string; header: { type?: unknown; id?: unknown; cwd?: unknown } } | undefined {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.alloc(64 * 1024)
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, read).toString('utf8')
    const end = text.indexOf('\n')
    if (end < 0) return undefined
    const line = text.slice(0, end)
    const header = JSON.parse(line) as { type?: unknown; id?: unknown; cwd?: unknown }
    return header?.type === 'session' ? { line, header } : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * A saved session is resumable in `cwd` only when its file is there and its header names `cwd`:
 * Pi finds `--session <id>` among the sessions of its working directory, and one recorded for
 * another directory (a fork's first turn in its own worktree) would make it ask on stdin. Mousse
 * owns the files, so the header is moved to `cwd`. False when the session cannot be resumed.
 */
function prepareSession(dir: string, sessionId: string, cwd: string): boolean {
  const file = sessionFileOf(dir, sessionId)
  const found = file ? sessionHeaderOf(file) : undefined
  if (!file || !found || found.header.id !== sessionId) return false
  const target = resolvePath(cwd)
  if (typeof found.header.cwd === 'string' && resolvePath(found.header.cwd) === target) return true
  try {
    const content = readFileSync(file, 'utf8')
    atomicWriteFileSync(file, `${JSON.stringify({ ...found.header, cwd: target })}${content.slice(found.line.length)}`, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/** A Pi process failed before or during a turn in a way Mousse must not paper over. */
function protocolError(instanceId: string, message: string): AppError {
  return harnessAppError({ code: 'protocol', message, instanceId })
}

/** The crash rule: a turn whose process died under it ends interrupted, once. */
function interruptedError(message: string): AppError {
  return new AppError({ code: 'interrupted', message, errorInfo: { category: 'unavailable', retryable: false } })
}

/** What a turn that hit a limit says. */
function limitMessage(limit: AgentExecutionLimit | undefined, overshoot?: number): string {
  if (overshoot !== undefined && limit?.kind === 'input_tokens') return `The provider counted ${overshoot} more input token${overshoot === 1 ? '' : 's'} than Mousse reserved for the request, so this run stopped.`
  if (overshoot !== undefined && limit?.kind === 'cost_usd') return `The request cost $${overshoot.toFixed(6)} more than Mousse reserved for it, so this run stopped.`
  if (overshoot !== undefined) return `The provider exceeded its output cap by ${overshoot} token${overshoot === 1 ? '' : 's'}, so this run stopped.`
  if (limit?.kind === 'turns') return `This run reached its limit of ${limit.limit} model request${limit.limit === 1 ? '' : 's'}, so the next one was not sent.`
  if (limit?.kind === 'tool_calls') return `This run reached its limit of ${limit.limit} tool call${limit.limit === 1 ? '' : 's'}, so it stopped before the next step.`
  if (limit?.kind === 'input_tokens') return `The next model request could go over this run's limit of ${limit.limit} input tokens, so it was not sent.`
  if (limit?.kind === 'output_tokens') return `Too little of this run's limit of ${limit.limit} output tokens is left for the next model request at this effort, so it was not sent.`
  if (limit?.kind === 'cost_usd') return `The next model request could go over this run's cost limit of $${limit.limit}, so it was not sent.`
  return 'This run reached one of its limits, so the next step was not sent.'
}

function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown })?.content
  if (!Array.isArray(content)) return ''
  return content.filter((block): block is { type: 'text'; text: string } => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('')
}

/** The tool calls an assistant message ends with (pi-ai `toolCall` blocks), in order. */
function toolCallsOf(message: unknown): Array<{ id: string; name: string; arguments: unknown }> {
  const content = (message as { content?: unknown })?.content
  if (!Array.isArray(content)) return []
  return content
    .filter((block): block is { type: 'toolCall'; id: string; name: string; arguments?: unknown } => block?.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string')
    .map((block) => ({ id: block.id, name: block.name, arguments: block.arguments }))
}

function linesOf(text: unknown): number {
  return typeof text === 'string' && text ? text.split('\n').length : 0
}

/** Resolves after `promise` settles or `ms` passes, whichever is first. */
function within(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    void promise.then(() => resolve(), () => resolve()).finally(() => clearTimeout(timer))
  })
}

/**
 * Windows keeps a dead parent's pid in its children's `ParentProcessId`, so the descendants of a Pi
 * that died on its own can still be found and killed (POSIX reparents them; there the group kill
 * of `killTree` is the best effort). Only processes started after Pi are considered, so a reused
 * pid is never followed.
 */
async function killOrphans(pid: number, startedAt: number): Promise<void> {
  if (process.platform !== 'win32') return
  // Asynchronous throughout: the daemon's event loop never waits on the sweep.
  const listed = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $([int64]($_.CreationDate.ToUniversalTime() - [datetime]\'1970-01-01\').TotalMilliseconds)" }'],
  { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).catch(() => undefined)
  if (!listed?.stdout) return
  const table = listed.stdout.split(/\r?\n/).map((line) => line.trim().split(' ').map(Number)).filter((row) => row.length === 3 && row.every(Number.isFinite))
  const found = new Set<number>()
  let frontier = [pid]
  while (frontier.length) {
    const next: number[] = []
    for (const [child, parent, created] of table) {
      if (!frontier.includes(parent) || found.has(child) || created + 1000 < startedAt) continue
      found.add(child)
      next.push(child)
    }
    frontier = next
  }
  await Promise.allSettled([...found].map((child) => execFileAsync('taskkill', ['/PID', String(child), '/T', '/F'], { windowsHide: true, timeout: 10_000 })))
}

/** How often a running turn asks whether a person's steer should cut in (`TurnControl.peekSteer`). */
export const PI_STEER_POLL_MS = 100

/**
 * A steer the turn owns, in exactly one state (docs/design/steer-and-interruptions.md §3.2): `sending` (Pi's native
 * `steer` was sent and not answered), `queued` (Pi accepted it into its queue), `cutHeld` (a cut holds it for the
 * continuation prompt). A steer Pi read, or one handed back, leaves the list.
 */
interface PiSteer {
  text: string
  token: string
  /** A person's message: once a reply started after it was sent, it cuts in rather than wait for Pi's next step. */
  person: boolean
  state: 'sending' | 'queued' | 'cutHeld'
  /** An assistant reply started after the native send while it was still unread. */
  replyStarted?: boolean
  /**
   * The cut's `clear_queue` returned it. Pi takes a steer out of its queue at a step's end but keeps its text, which
   * `clear_queue` returns, until it shows it after preparing the next step: until the cut's settlement such a steer
   * may still be read, and is then taken rather than carried into the continuation as well.
   */
  cleared?: boolean
}

/** A steer cut in progress (§3.2, "The cut"). */
interface PiCut {
  /** The operation generation it runs under: a Stop or a later cut raises the turn's. */
  gen: number
  /** `aborting` from the moment `abort` is written until its settlement barrier; `continuing` while the prompt is sent. */
  stage: 'clearing' | 'aborting' | 'continuing'
  /** Pi settled the prompt on its own before the abort was written: nothing is left to abort. */
  settled: boolean
  /** The continuation settled before its `prompt` was answered: the turn settles once it is. */
  deferredSettle: boolean
  /** Resolves the wait for the settlement barrier: the first `agent_settled` after the `abort` request. */
  barrier?: () => void
  /**
   * The continuation `prompt` and Pi's answer to it, once sent. Pi records the prompt's user message as soon as it
   * accepts it, even when an abort comes before any request (spike S3 item 7): a Stop waits for this answer.
   */
  continuation?: Promise<'started' | 'refused'>
  /** The steers the continuation carries. */
  carried?: PiSteer[]
}

/** One turn on a process: the attempt, its tools, the episode and the event state. */
class PiTurn {
  readonly episode: WriterEpisode
  readonly classes = new Map<string, PiToolClass>()
  readonly active: Set<string>
  /**
   * `running` until `agent_end`; `ending` after it (a steer then waits); `retrying` during a backoff; `cutting` while a
   * steer cut runs (no native steer is sent, the poll only peeks); `stopping` after Stop.
   */
  phase: 'running' | 'ending' | 'retrying' | 'cutting' | 'stopping' = 'running'
  /** Raised at each cut and at Stop: an older generation's operation neither continues nor settles the turn. */
  opGen = 0
  /** The turn's control lane: a cut's steps run here one after another, and Stop waits for it. */
  lane: Promise<void> = Promise.resolve()
  cut: PiCut | undefined
  /** Ends a cut's waits once Stop comes. */
  readonly halt = new AbortController()
  /**
   * Where Pi's own run is, whatever Mousse does with the turn (a cut or a Stop): `running` from a `turn_start`,
   * `ending` from an `agent_end`, `retrying` from an `auto_retry_start`. A cut that ends without an abort goes back to it.
   */
  piPhase: 'running' | 'ending' | 'retrying' = 'running'
  /**
   * Pi's step ended (`turn_end`) and its next request has not started: Pi may have taken a steer out of its queue and
   * show it once the next step is prepared (a compaction can come first). A cut waits for this to end before `abort`.
   */
  stepGap = false
  /** Calls whose approval the person is asked for now: a steer that cuts answers them. */
  readonly asking = new Set<string>()
  /**
   * Aborted when a cut is about to abort Pi, or at Stop: a call waiting at the gate (for the person's approval, or for
   * the writer) is refused at once, since Pi's abort waits for the gate. A cut's continuation gets a new one.
   */
  gateRelease = new AbortController()
  /** Woken after each Pi event, a Stop and a crash: a cut waiting for a condition checks it again. */
  readonly wakers = new Set<() => void>()
  /** An assistant message is open (between its `message_start` and its `message_end`). */
  replyOpen = false
  /** Pi compacts its context: a person's steer waits for it, and never stops it. */
  compacting = false
  poll: ReturnType<typeof setInterval> | undefined
  /**
   * Tool calls reported at their assistant message's end that Pi has not started yet (`steerBoundary: 'announce'`).
   * After an abort Pi starts none of the rest of the batch: those still here at the step's `turn_end` never ran.
   */
  readonly announced = new Set<string>()
  /** The step ran tools and has not reached its `turn_end` yet: a steer released by their results goes in there. */
  stepTools = false
  pendingError: string | undefined
  /**
   * Mousse refused a request or tool call of this turn (one of the fixed request-path texts). It
   * decides the turn's end whatever Pi reports after it: an automatic compaction whose summary was
   * refused ends only in a `compaction_end` error, never in a failed assistant message.
   */
  refusal: string | undefined
  retryExhaustedError: AppError | undefined
  /** Pi's retry limit, as its last `auto_retry_start` stated it. */
  maxRetries = 0
  /**
   * The next model request answers the person (the turn's prompt, or a steer just sent): it shows as waiting for the
   * model. A request between tool calls does not; the turn reads as thinking there, as with every runtime.
   */
  awaitingModel = true
  /** The text of each assistant message that ended the turn's steps, in order (the reply joins them). */
  readonly texts: string[] = []
  /** The Stop in progress: a second caller (thread Stop after a turn Stop) waits for the same one. */
  stopping: Promise<'interrupted' | 'not_active'> | undefined
  /** Pi acknowledged the prompt (its preflight ended); before that, Stop must kill the process. */
  promptAccepted = false
  progressed = false
  readonly startedAt = Date.now()
  readonly openTools = new Map<string, { name: string; mousse: boolean }>()
  /** A bot's built-in calls with a `started` ledger row, by call id. */
  readonly ledgerRows = new Map<string, string>()
  /** Steers the turn owns and Pi has not read, each with its drain's token: it is accepted by that token alone. */
  readonly steers: PiSteer[] = []
  /** Native `steer` requests sent at `turn_end` and not answered yet; the turn's end and Stop wait for them before `clear_queue`. */
  readonly steerSends = new Set<Promise<void>>()
  usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  /** When the turn's last request was answered, and the longest cache lifetime its requests wrote (`cacheWrite1h`). */
  promptCache: { at?: number; ttlMs?: number } = {}
  /** The current assistant message's text blocks by `contentIndex`. */
  text = new Map<number, string>()
  /** The turn's reply as one cumulative stream, broken at each tool call and closed with the joined text when the turn ends. */
  readonly reply: CumulativeStream
  thinking = ''
  settled!: () => void
  failed!: (error: unknown) => void
  readonly done: Promise<void>

  constructor(
    /** Names this turn in every ref it reports (`nativeTurnId`). */
    readonly key: string,
    /**
     * Stamped on every Mousse MCP call of the turn (`_mousse_turn`): the turn token the app-tool
     * registry registered for this run, so a call of an earlier turn is refused.
     */
    readonly attemptToken: string,
    readonly input: TurnInput,
    readonly sink: TurnSink,
    readonly ctl: TurnControl,
    readonly host: AdapterHost,
    readonly tools: PiMousseTool[],
    builtins: readonly string[]
  ) {
    for (const tool of tools) this.classes.set(tool.name, tool.class)
    for (const name of builtins) this.classes.set(name, BUILTIN_CLASSES[name] ?? 'mutation')
    this.active = new Set([...builtins, ...tools.map((tool) => tool.name)])
    const access = host.tools.toolAccess
    // The parent's writer, held for the whole episode (`runWriter` through the turn's tool access).
    const writer = !input.child?.readOnly && access
      ? (released: Promise<void>) => new Promise<void>((acquired, refused) => {
          access.execute('pi_writer_episode', {}, () => {
            acquired()
            return released
          }).catch(refused)
        })
      : undefined
    this.episode = new WriterEpisode(writer ? { acquire: writer } : {})
    this.reply = new CumulativeStream((phase, content) => sink.text({ phase, content, contentIndex: 0 }))
    this.done = new Promise<void>((resolve, reject) => {
      this.settled = resolve
      this.failed = reject
    })
    // A turn that ended through one path must not also reject unobserved through another.
    this.done.catch(() => {})
  }

  /** The reply so far: every ended step's text, then the current message's. */
  replyText(): string {
    const current = [...this.text.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join('')
    return [...this.texts, current].filter((text) => text.trim()).join('\n\n')
  }

  /** Wakes every wait on the turn's state (`PiRpcEngine.until`). */
  wake(): void {
    for (const waker of [...this.wakers]) waker()
  }

  /**
   * The model produced output. Said on every output, as other runtimes do: it ends a step the line under Working
   * shows (a retry's wait, say) when the retried reply streams into the same row.
   */
  progress(): void {
    this.progressed = true
    this.sink.progress()
    this.ctl.heartbeat()
  }
}

/** A thread's Pi process. */
class PiThreadProcess {
  ready = false
  readyReport: PiReadyRequest | undefined
  fatal: string | undefined
  /** The Pi process itself is gone (its descendants may not be yet). */
  dead = false
  /** Mousse killed it (its tree went with it); otherwise its death was unexpected. */
  killed = false
  /** Stopped or killed: a start in progress spawns nothing more, and the thread is never reused. */
  cancelled = false
  /** The start in progress, awaited by a Stop that cancelled it. */
  starting: Promise<unknown> | undefined
  /** POSIX: Pi's descendants, recorded while it runs (its shells run in groups of their own). */
  descendants: DescendantTracker | undefined
  tracking: ReturnType<typeof setInterval> | undefined
  /** POSIX: the shells' process groups the extension reported, verified as Mousse's. */
  groups = new OwnedGroups()
  exit: PiRpcExit | undefined
  turn: PiTurn | undefined
  /** Reservations not settled yet, by id, with the turn and budget they were made for. */
  readonly reservations = new Map<string, { turn: PiTurn; budget: TurnBudget }>()
  warm: ReturnType<typeof setTimeout> | undefined
  sessionId: string | undefined
  /** The stored key it was started with (a rotated key restarts it). */
  keyFingerprint = ''
  readonly startedAt = Date.now()
  readonly readyWaiters = new Set<() => void>()
  readonly failures = new Set<(reason: string) => void>()
  process: PiProcess | undefined
  registration: PiBridgeRegistration | undefined

  constructor(
    readonly threadId: string,
    readonly cwd: string,
    public model: string,
    public thinking: PiThinkingLevel,
    /** An agent definition's or a bot's turn: a process and an in-memory session of its own, never saved, resumed or kept warm. */
    readonly ephemeral = false,
    /** A bot's turn: the process runs in the locked environment and is reported to its supervision. */
    readonly bot?: PiBotProcess
  ) {}

  get alive(): boolean {
    return !this.exit && !this.dead && !this.fatal
  }

  /** Settles once the process and everything holding its output are gone. */
  get closed(): Promise<unknown> {
    // The sweep is created when the process exits (an explicit kill included), so it is read after.
    return (this.process?.client.exited ?? Promise.resolve()).then(() => this.sweep)
  }

  /** The orphan sweep after an unexpected death (Windows). */
  sweep: Promise<void> | undefined

  fail(reason: string): void {
    if (!this.fatal) this.fatal = reason
    for (const listener of [...this.failures]) listener(reason)
  }
}

/** A turn between its first ref and its process: Stop and kill find it by its key. */
/** What a bot turn's process is started with (Bot Phase 1 §5.9). */
interface PiBotProcess {
  /** The bot thread the turn runs on (its supervision finds the dispatch by it). */
  threadId: string
  locked: PiLockedLaunch
}

interface StartingTurn {
  threadId: string
  thread?: PiThreadProcess
  turn?: PiTurn
  cancelled: boolean
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g

/**
 * The path a Pi file tool writes, spelled as Pi resolves it (`resolveToCwd` in pi-coding-agent): odd spaces read as
 * spaces, a leading `@` is dropped, and `~` is the home folder. Relative paths stay relative to the thread's folder.
 */
function piToolPath(path: string): string {
  let normalized = path.replace(UNICODE_SPACES, ' ')
  if (normalized.startsWith('@')) normalized = normalized.slice(1)
  if (normalized === '~') return homedir()
  if (normalized.startsWith('~/') || (process.platform === 'win32' && normalized.startsWith('~\\'))) return join(homedir(), normalized.slice(2))
  if (/^file:\/\//.test(normalized)) {
    try {
      return fileURLToPath(normalized)
    } catch {
      return normalized
    }
  }
  return normalized
}

export class PiRpcEngine implements ProviderAdapter {
  readonly driver = 'pi' as const
  readonly capabilities: ProviderCapabilities
  private readonly bridge = new PiBridge()
  private readonly threads = new Map<string, PiThreadProcess>()
  /** Every turn by its key, from its first ref to its end. */
  private readonly turns = new Map<string, StartingTurn>()
  /** Processes killed or dead whose tree has not finished closing; `stop()` waits for them. */
  private readonly closing = new Set<PiThreadProcess>()
  private readonly starts = new Set<Promise<unknown>>()
  private stopped = false
  /**
   * The `refresh` Pi holds in `auth.json`: opaque, for this instance and this engine only. Every
   * process of the instance shares its agent dir (and so the file); a handle from another instance
   * or an earlier run of Mousse is refused.
   */
  private oauthHandle: string
  /** The credential retirement in progress, if any; starts and forks wait for it. */
  private retiring: Promise<void> | undefined
  /** The credential epoch in which a start last wrote `auth.json`. */
  private authWrittenEpoch = -1
  /** Moves on with every credential change; a start or refresh across one is refused. */
  private credentialEpoch = 0
  /** The account claim of the credential the processes were given (when it has one). */
  private oauthSubject: string | undefined
  /** Threads already told their history went into a new session (once per thread). */
  private readonly historyNoticed = new Set<string>()

  constructor(private readonly options: PiRpcEngineOptions) {
    this.capabilities = options.capabilities
    this.oauthHandle = piOAuthHandle(options.instanceId)
  }

  describe(_model: string): ModelInfo {
    return { contextUsage: 'reported' }
  }

  // -- Saved sessions ------------------------------------------------------------------------------

  private get savedPath(): string {
    return join(this.options.stateDir, 'threads.json')
  }

  private saved(): Record<string, SavedThread> {
    try {
      const parsed = JSON.parse(readFileSync(this.savedPath, 'utf8')) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, SavedThread>) : {}
    } catch {
      return {}
    }
  }

  private save(threadId: string, entry: SavedThread | undefined): void {
    const all = this.saved()
    const previous = all[threadId]?.sessionId
    if (entry) all[threadId] = entry
    else delete all[threadId]
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(this.savedPath, all, { mode: 0o600 })
    // A session no thread maps to is never resumed or forked again: its file goes (best effort: a
    // process still closing may hold it open on Windows).
    // Never one a thread's live process runs, either.
    const live = [...this.threads.values()].some((thread) => thread.sessionId === previous && !thread.dead)
    if (previous && previous !== entry?.sessionId && !live && !Object.values(all).some((other) => other.sessionId === previous)) {
      const file = sessionFileOf(this.sessionsDir, previous)
      if (file) {
        try {
          rmSync(file, { force: true })
        } catch {
          // Held open: it stays, unreferenced.
        }
      }
    }
  }

  /**
   * The thread's next turn starts a new Pi session with the history handed over. A native fork's
   * branch waiting for its first turn is kept: it was made for this thread under the current
   * credential (a credential change drops it, `retireCredentials`).
   */
  forgetConversation(threadId: string): void {
    if (!this.saved()[threadId]?.pendingFork) this.save(threadId, undefined)
    const thread = this.threads.get(threadId)
    if (thread && !thread.turn) void this.kill(thread)
  }

  /**
   * The provider's credential changed (sign-in, sign-out, another account): every process goes,
   * with the handle it held, so none refreshes into the next account; Pi's `auth.json` is removed
   * once they closed (a refresh answered just before cannot write it back), and pending forks made
   * under the old credential are dropped.
   *
   * Starts and forks wait until it finished (`afterRetirement`), so nothing of the new credential
   * exists while it cleans up: it never removes another epoch's `auth.json`, branch or session.
   */
  retireCredentials(): Promise<void> {
    const previous = this.retiring ?? Promise.resolve()
    // A failed retirement does not skip the next one.
    const retiring = previous.catch(() => {}).then(() => this.retire())
    const gate = retiring.finally(() => {
      if (this.retiring === gate) this.retiring = undefined
    })
    this.retiring = gate
    return gate
  }

  private async retire(): Promise<void> {
    const epoch = ++this.credentialEpoch
    this.oauthHandle = piOAuthHandle(this.options.instanceId)
    this.oauthSubject = undefined
    // The processes and the token go first: a failed write of the thread list below cannot keep them.
    const closing = [...this.threads.values()].map((thread) => this.kill(thread))
    this.removeAuthFile()
    try {
      for (const [threadId, entry] of Object.entries(this.saved())) if (entry.pendingFork) this.save(threadId, undefined)
    } catch (error) {
      console.warn('[harness] could not drop pending forks', { instanceId: this.options.instanceId, error: error instanceof Error ? error.message : String(error) })
    }
    await within(Promise.allSettled([...closing, ...[...this.closing].map((thread) => thread.closed)]), CLEANUP_DEADLINE_MS)
    // Again once the old processes closed (a refresh answered just before cannot write it back).
    if (epoch === this.credentialEpoch && this.authWrittenEpoch !== epoch) this.removeAuthFile()
  }

  /** Waits while a credential retirement runs (a start or fork then belongs to the new credential). */
  private async afterRetirement(): Promise<void> {
    while (this.retiring) await this.retiring.catch(() => {})
  }

  /**
   * An API key or ambient credential changed: processes not running a turn go (the next turn starts
   * with the new credential, as a rotated key restarts a process anyway); running turns finish.
   */
  releaseIdle(): void {
    // Idle: between turns, in its warm period (not starting, not handed to a turn being set up).
    for (const thread of [...this.threads.values()]) if (thread.warm && !thread.turn && !thread.starting) void this.kill(thread)
  }

  /** Pi's private `auth.json` (an OAuth access token) is removed. */
  private removeAuthFile(): void {
    const home = this.options.env().home
    if (!home || !this.options.oauth) return
    try {
      writePiAuth(home, this.options.provider, undefined)
    } catch (error) {
      console.warn('[harness] could not remove the Pi auth file', { instanceId: this.options.instanceId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  // -- Processes ----------------------------------------------------------------------------------

  /** Kills the thread's whole tree; it stays tracked (for `stop()`) until it closed. */
  private kill(thread: PiThreadProcess): Promise<unknown> {
    thread.cancelled = true
    if (thread.tracking) clearInterval(thread.tracking)
    if (thread.warm) clearTimeout(thread.warm)
    thread.warm = undefined
    thread.registration?.close()
    if (this.threads.get(thread.threadId) === thread) this.threads.delete(thread.threadId)
    if (!thread.process) return Promise.resolve()
    if (!thread.exit) {
      if (!thread.dead && !thread.killed) {
        thread.killed = true
        killTree(thread.process.child)
      }
      this.closing.add(thread)
      void thread.closed.finally(() => this.closing.delete(thread))
    }
    return thread.closed
  }

  /** The turn a ref names: by its key, else by its native session. Never any other thread's. */
  private target(ref: ProviderRef): { entry?: StartingTurn; thread?: PiThreadProcess } {
    if (ref.nativeTurnId) {
      const entry = this.turns.get(ref.nativeTurnId)
      return entry ? { entry, ...(entry.thread ? { thread: entry.thread } : {}) } : {}
    }
    if (ref.sessionId) {
      const thread = [...this.threads.values()].find((candidate) => candidate.sessionId === ref.sessionId)
      return thread ? { thread } : {}
    }
    return {}
  }

  /** Kills the processes serving `ref` (the gateway's deadline); its live turn ends. */
  terminate(ref: ProviderRef): void {
    const { entry, thread } = this.target(ref)
    if (entry) entry.cancelled = true
    if (thread) void this.kill(thread)
  }

  /** Kills every process, a process still starting included; settles once all of them closed. */
  async stop(): Promise<void> {
    this.stopped = true
    // Killed first: a process still starting fails its ready wait at once instead of at its deadline.
    const killed = [...this.threads.values()].map((thread) => this.kill(thread))
    await Promise.allSettled([...this.starts])
    const closed = [...killed, ...[...this.threads.values()].map((thread) => this.kill(thread))]
    await Promise.allSettled([...closed, ...[...this.closing].map((thread) => thread.closed)])
    this.bridge.stop()
    // The access token does not outlive the engine on disk.
    this.removeAuthFile()
  }

  /**
   * What token and USD limits need from `model` (a catalogue id with its effort suffix): an API
   * whose cap pi-ai always sends, a price, and the smallest wire cap a request at this effort can
   * carry (the thinking budget plus the answer room on budget-thinking models, else 256).
   */
  spendModel(model: string): SpendModelFacts | undefined {
    const { baseId, effort } = parseThinkingSuffixFromModelId(model)
    const entry = this.options.catalog().provider.models.find((candidate) => candidate.id === baseId)
    if (!entry) return undefined
    const level = piThinkingLevel(effort)
    const reasoning = level === 'off' || !entry.reasoning ? undefined : (level as PiReasoning)
    const rates = reservationRates(entry.api, entry.cost, fallbackModels(entry).map((fallback) => fallback.cost))
    return {
      label: entry.name || entry.id,
      outputCap: capHonouring(entry) && !multipleCandidates(entry),
      // A USD limit needs both an input and an output price (held at their highest rates).
      priced: rates !== undefined,
      effort: reasoning ?? 'off',
      smallestCap: grantFloor(addsThinkingBudget(entry, reasoning) ? thinkingBudgetFor(reasoning!) : 0),
      ...(rates ? { outputUsdPerToken: rates.output } : {})
    }
  }

  private thinkingFor(model: string): { modelId: string; thinking: PiThinkingLevel } {
    const { baseId, effort } = parseThinkingSuffixFromModelId(model)
    const thinking = piThinkingLevel(effort)
    return { modelId: baseId, thinking }
  }

  /**
   * One RPC command under a deadline: past it the process is killed and its session forgotten.
   * `signal` (the turn's) cancels the wait.
   */
  private send<T>(thread: PiThreadProcess, command: PiRpcRequest, deadlineMs = this.options.commandDeadlineMs ?? COMMAND_DEADLINE_MS, signal?: AbortSignal): Promise<T> {
    this.options.onCommand?.(command.type)
    const process = thread.process
    if (!process) return Promise.reject(protocolError(this.options.instanceId, `${this.options.label} is not running.`))
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        // Rejected first, so the race ends with the deadline and not with the aborted command.
        reject(protocolError(this.options.instanceId, `${this.options.label} did not answer ${command.type} in time.`))
        controller.abort()
        if (!thread.ephemeral) this.save(thread.threadId, undefined)
        void this.kill(thread)
      }, deadlineMs)
      timer.unref?.()
    })
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) controller.abort()
    return Promise.race([process.client.send(command, { signal: controller.signal }) as unknown as Promise<T>, deadline]).finally(() => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    })
  }

  /** The thread's process for this turn: the warm one, or a new one that reported ready. */
  private async processFor(
    input: TurnInput, cwd: string, resume: string | undefined, starting: StartingTurn,
    /** An agent definition's or a bot's turn: a new process under a key of its own (never the thread's warm one). */
    ephemeral?: { key: string; bot?: PiBotProcess }
  ): Promise<{ thread: PiThreadProcess; resumed: boolean }> {
    // Before the process is registered: a credential retirement in progress would count it as one
    // of the old credential's and kill it.
    await this.afterRetirement()
    if (starting.cancelled || this.stopped) throw protocolError(this.options.instanceId, `${this.options.label} was stopped while it started.`)
    const { modelId, thinking } = this.thinkingFor(input.model)
    const keyFingerprint = fingerprint(this.options.apiKey?.() ?? '')
    const processKey = ephemeral?.key ?? input.threadId
    const existing = this.threads.get(processKey)
    if (existing && existing.alive && existing.ready && existing.cwd === cwd && !existing.turn && resume && existing.sessionId === resume && existing.keyFingerprint === keyFingerprint) {
      starting.thread = existing
      if (existing.warm) clearTimeout(existing.warm)
      existing.warm = undefined
      if (existing.model !== modelId) {
        await this.send(existing, { type: 'set_model', provider: this.options.provider, modelId })
        existing.model = modelId
      }
      if (existing.thinking !== thinking) {
        await this.send(existing, { type: 'set_thinking_level', level: thinking })
        existing.thinking = thinking
      }
      return { thread: existing, resumed: true }
    }
    // A rotated key, another workspace or a stale session: a new process.
    if (existing) await within(this.kill(existing), INTERRUPT_DEADLINE_MS)
    // Stopped while the old process went: no replacement.
    if (starting.cancelled || this.stopped) throw protocolError(this.options.instanceId, `${this.options.label} was stopped while it started.`)
    const thread = new PiThreadProcess(processKey, cwd, modelId, thinking, Boolean(ephemeral), ephemeral?.bot)
    thread.keyFingerprint = keyFingerprint
    starting.thread = thread
    this.threads.set(processKey, thread)
    const started = this.start(thread, resume, () => starting.cancelled)
    thread.starting = started
    this.starts.add(started)
    try {
      await started
    } finally {
      this.starts.delete(started)
      // Started (or failed): no longer starting, so `releaseIdle` sees it as the idle process it is.
      if (thread.starting === started) thread.starting = undefined
    }
    if (starting.cancelled) {
      await within(this.kill(thread), CLEANUP_DEADLINE_MS)
      throw protocolError(this.options.instanceId, `${this.options.label} was stopped while it started.`)
    }
    return { thread, resumed: Boolean(resume) }
  }

  private async start(thread: PiThreadProcess, sessionId: string | undefined, cancelled: () => boolean = () => false): Promise<void> {
    await this.afterRetirement()
    const stopping = () => protocolError(this.options.instanceId, `${this.options.label} is stopping.`)
    if (this.stopped) throw stopping()
    await this.bridge.start()
    if (this.stopped || thread.cancelled || cancelled()) throw stopping()
    const env = this.options.env()
    if (!env.home) throw protocolError(this.options.instanceId, 'Pi runs only with its Mousse-owned home.')
    const shellPath = this.options.shellPath?.()
    preparePiHome(env.home, {
      ...(shellPath ? { shellPath } : {}),
      ...(this.options.compaction ? { compaction: this.options.compaction() } : {}),
      ...(this.options.settings?.retry ? { retry: this.options.settings.retry } : {})
    })
    const epoch = this.credentialEpoch
    const grant = await this.options.oauth?.credential(this.options.provider)
    if (this.stopped || thread.cancelled || cancelled()) throw stopping()
    // The credential changed while it was read: this start does not get it.
    if (epoch !== this.credentialEpoch) throw protocolError(this.options.instanceId, `${this.options.label}'s sign-in changed while it started.`)
    if (grant) this.oauthSubject ??= grant.subject
    writePiAuth(env.home, this.options.provider, grant ? piOAuthCredential(grant, this.oauthHandle) : undefined)
    this.authWrittenEpoch = epoch
    const registration = this.bridge.register({
      ...(this.options.oauth
        ? {
            credential: piCredentialHandler({
              provider: this.options.provider,
              source: this.options.oauth,
              // The handle of this process's credential epoch; a credential change replaces it.
              handle: () => (epoch === this.credentialEpoch ? this.oauthHandle : undefined),
              // A refresh that returns another account's credential retires every process.
              accept: (next) => {
                if (epoch !== this.credentialEpoch) return false
                if (this.oauthSubject && next.subject && next.subject !== this.oauthSubject) {
                  void this.retireCredentials()
                  return false
                }
                return true
              }
            })
          }
        : {}),
      catalog: async (first) => {
        const catalog = this.options.catalog()
        const key = first ? this.options.apiKey?.() : undefined
        return { provider: catalog.provider, catalogRevision: catalog.revision, ...(key ? { apiKey: key } : {}) }
      },
      ready: (report) => {
        thread.readyReport = report
        for (const waiter of [...thread.readyWaiters]) waiter()
      },
      turn: async () => {
        await this.options.holdTurn?.()
        return this.turnFor(thread)
      },
      gate: (request) => this.gate(thread, request),
      request: async (request) => this.admitRequest(thread, request),
      settle: (request) => this.settleRequest(thread, request),
      quiesce: async (request, signal) => {
        const turn = thread.turn
        if (!turn || turn.attemptToken !== request.attemptToken) return { ok: false, reason: GATE_REFUSALS.denied }
        try {
          await turn.episode.quiesce(request.toolCallId, signal)
          return { ok: true }
        } catch (error) {
          return { ok: false, reason: error instanceof Error ? error.message : GATE_REFUSALS.denied }
        }
      },
      group: async ({ pgid, ended }) => {
        if (!Number.isInteger(pgid) || pgid <= 1) throw new Error('bad group')
        // A group that cannot be verified is refused: the shell then runs nothing.
        if (ended) await thread.groups.ended()
        else await thread.groups.record(pgid)
      },
      fatal: (request) => {
        thread.fail(`${request.reason}: ${request.message}`)
        void this.kill(thread)
      }
    })
    thread.registration = registration
    const extraEnv = this.options.extraEnv?.()
    const launched = piLaunch({
      env,
      runtime: this.options.runtime(),
      stateDir: this.options.stateDir,
      provider: this.options.provider,
      model: thread.model,
      thinking: thread.thinking,
      ...(sessionId ? { sessionId } : {}),
      ...(thread.ephemeral ? { ephemeral: true } : {}),
      ...(thread.bot ? { locked: thread.bot.locked } : {}),
      ...(extraEnv ? { extraEnv } : {}),
      engineEnv: { ...(this.options.testEnv ?? {}), [PI_BRIDGE_ENV]: JSON.stringify(registration.address) } as Record<`MOUSSE_PI_${string}`, string>,
      ...(this.options.host ? { host: this.options.host } : {})
    })
    if (launched.runs !== 'yes') {
      registration.close()
      if (this.threads.get(thread.threadId) === thread) this.threads.delete(thread.threadId)
      throw harnessAppError({ code: 'wont_run', message: launched.reason, instanceId: this.options.instanceId })
    }
    const launch = this.options.adjustLaunch ? this.options.adjustLaunch(launched) : launched
    // Checked again right before the spawn: Stop may have come while the home was prepared.
    if (this.stopped || thread.cancelled || cancelled()) {
      registration.close()
      if (this.threads.get(thread.threadId) === thread) this.threads.delete(thread.threadId)
      throw stopping()
    }
    const bot = thread.bot
    const onBotProcess = this.options.onBotProcess
    let started: PiProcess
    try {
      started = startPiProcess(env, launch, {
        cwd: thread.cwd,
        handlers: {
          event: (event) => this.event(thread, event),
          exit: (exit) => this.closed(thread, exit)
        },
        // A bot's process is supervised from its start: one that cannot be is killed at once.
        ...(bot && onBotProcess ? { onProcess: (pid: number) => onBotProcess(pid, bot.threadId) } : {})
      })
    } catch (error) {
      registration.close()
      if (this.threads.get(thread.threadId) === thread) this.threads.delete(thread.threadId)
      throw protocolError(this.options.instanceId, `${this.options.label} could not supervise this bot's process (${error instanceof Error ? error.message : String(error)}), so it was stopped.`)
    }
    thread.process = started
    if (started.child.pid) this.options.onSpawn?.(started.child.pid, thread.threadId)
    // The process itself is gone: its descendants are killed now, before its output closes.
    started.child.once('exit', () => this.died(thread))
    if (this.stopped || thread.cancelled) {
      thread.killed = false
      void this.kill(thread)
      throw stopping()
    }
    if (process.platform !== 'win32' && started.child.pid) {
      // Recorded while Pi runs: after Pi's death its shells are reparented and untraceable.
      const tracker = new DescendantTracker(started.child.pid)
      thread.descendants = tracker
      thread.tracking = setInterval(() => {
        if (thread.turn?.openTools.size) void tracker.snapshot()
        if (thread.groups.size) void thread.groups.refresh().catch(() => {})
      }, 1000)
      thread.tracking.unref?.()
    }
    await this.awaitReady(thread)
  }

  /**
   * Ready: the extension's report (every provider guarded, the AWS pins seen), then every model Pi
   * offers belongs to a guarded provider. Anything else kills the tree; no prompt was sent.
   */
  private async awaitReady(thread: PiThreadProcess): Promise<void> {
    const deadlineMs = this.options.readyDeadlineMs ?? READY_DEADLINE_MS
    const failed = (message: string): never => {
      void this.kill(thread)
      throw protocolError(this.options.instanceId, message)
    }
    try {
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const done = (error?: Error) => {
          clearTimeout(timer)
          thread.readyWaiters.delete(onReady)
          thread.failures.delete(onFailure)
          if (error) reject(error)
          else resolve()
        }
        const onReady = () => done()
        const onFailure = (reason: string) => done(new Error(reason))
        if (thread.fatal) return done(new Error(thread.fatal))
        if (thread.exit || thread.dead) return done(new Error('exited'))
        if (thread.readyReport) return done()
        thread.readyWaiters.add(onReady)
        thread.failures.add(onFailure)
        timer = setTimeout(() => done(new Error(`no ready report within ${Math.round(deadlineMs / 1000)} seconds`)), deadlineMs)
        timer.unref?.()
      })
    } catch (error) {
      const stderr = thread.process?.stderr().trim().split('\n').slice(-5).join('\n')
      if (stderr) console.warn('[harness] Pi did not start', { instanceId: this.options.instanceId, stderr })
      failed(`${this.options.label} could not start (${error instanceof Error ? error.message : String(error)}).`)
    }
    const report = thread.readyReport!
    if (report.aws.maxAttempts !== '1' || report.aws.retryMode !== 'standard')
      failed(`${this.options.label} started without Mousse's AWS retry settings.`)
    const { models } = await this.send<{ models: Array<{ provider: string }> }>(thread, { type: 'get_available_models' })
    const guarded = new Set(report.guarded)
    const unguarded = [...new Set(models.map((model) => model.provider))].filter((provider) => !guarded.has(provider))
    if (unguarded.length) failed(`${this.options.label} offered models Mousse cannot guard (${unguarded.join(', ')}).`)
    if (thread.fatal) failed(`${this.options.label} could not register its providers.`)
    const state = await this.send<{ sessionId?: string }>(thread, { type: 'get_state' })
    thread.sessionId = state.sessionId
    thread.ready = true
  }

  // -- Turns --------------------------------------------------------------------------------------

  private turnFor(thread: PiThreadProcess): PiTurnResponse {
    const turn = thread.turn
    const catalogRevision = this.options.catalog().revision
    if (!turn) return { attemptToken: '', sessionInstructions: '', tools: [], activeBuiltins: [], mcp: null, catalogRevision }
    const tools: PiTurnTool[] = turn.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema, class: tool.class }))
    // An agent definition's system prompt (with its granted skills, as the loop sends them) replaces
    // Pi's as written: none of Mousse's chat instructions (orchestration, applets) is added.
    const instructions = turn.input.instructions?.placement === 'replace' ? turn.input.instructions.text : undefined
    return {
      attemptToken: turn.attemptToken,
      sessionInstructions: instructions === undefined ? turn.host.bridge?.sessionInstructions ?? '' : '',
      ...(instructions !== undefined ? { systemPrompt: instructions } : {}),
      tools,
      activeBuiltins: [...turn.active].filter((name) => Object.hasOwn(BUILTIN_CLASSES, name)),
      mcp: turn.host.bridge?.mcp ?? null,
      catalogRevision
    }
  }

  /**
   * One model request about to go (an agent request, a compaction, a summary or one of Pi's
   * retries): refused outside a live turn and after Stop; under a count limit it is charged to the
   * run, and refused once the run's turn limit (or an earlier limit) is reached. Under a token or
   * USD limit it is then reserved: the grant is the wire cap it must carry, at most the one it asked
   * for. The model must be the turn's, and its cap support and prices are read from Mousse's own
   * catalogue, never from the request; a request that cannot show its spend (no bound, no cap, a
   * model whose cap is not honoured, no price under a USD limit) is refused.
   */
  private admitRequest(thread: PiThreadProcess, request: Partial<PiRequestRequest> = {}): PiRequestResponse {
    const turn = thread.turn
    if (!turn || turn.phase === 'stopping' || !thread.alive) {
      if (turn && turn.phase !== 'stopping') turn.refusal ??= REQUEST_REFUSED
      return { ok: false, reason: REQUEST_REFUSED }
    }
    const budget = turn.host.budget
    // Asked without its spend under a spend limit: nothing is charged, the request asks again with it.
    if (budget?.reserves && !request.spend && !budget.exhausted) return { ok: false, reason: REQUEST_REFUSED, spendRequired: true }
    const decision = budget?.request() ?? { ok: true }
    if (!decision.ok) {
      turn.refusal ??= BUDGET_EXHAUSTED
      return { ok: false, reason: BUDGET_EXHAUSTED }
    }
    if (!budget?.reserves) return { ok: true }
    const spend = request.spend
    const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
    const modelId = parseThinkingSuffixFromModelId(turn.input.model).baseId
    const entry = this.options.catalog().provider.models.find((candidate) => candidate.id === modelId)
    const rates = entry ? reservationRates(entry.api, entry.cost, fallbackModels(entry).map((fallback) => fallback.cost)) : undefined
    const refuse = (): PiRequestResponse => {
      turn.refusal ??= REQUEST_REFUSED
      return { ok: false, reason: REQUEST_REFUSED }
    }
    if (!spend || !entry || spend.model?.provider !== this.options.provider || spend.model.id !== modelId || spend.model.api !== entry.api) return refuse()
    if (!capHonouring(entry) || multipleCandidates(entry) || !finite(spend.inputBound) || !finite(spend.wireCap) || !finite(spend.thinkingBudget)) return refuse()
    if (budget.limits.maxUsd !== undefined && !rates) return refuse()
    const reserved = budget.reserve({
      inputBound: spend.inputBound,
      wireCap: spend.wireCap,
      floor: grantFloor(spend.thinkingBudget),
      price: rates ?? { input: 0, output: 0 }
    })
    if (!reserved.ok) {
      turn.refusal ??= BUDGET_EXHAUSTED
      return { ok: false, reason: BUDGET_EXHAUSTED }
    }
    thread.reservations.set(reserved.id, { turn, budget })
    return { ok: true, reservation: { id: reserved.id, cap: reserved.cap } }
  }

  /**
   * A reserved request ended. A request that went over its reservation (output above the cap it was
   * sent, input above its bound, or cost above what was held) ends the run: the turn fails
   * `budget_exhausted` with the overshoot, and every later step is refused. A reservation that is
   * never settled (the process died mid-request) stays charged in full.
   */
  private settleRequest(thread: PiThreadProcess, request: PiSettleRequest): void {
    const held = thread.reservations.get(request.reservationId)
    if (!held) return
    thread.reservations.delete(request.reservationId)
    const { turn, budget } = held
    const outcome = request.outcome
    const amount = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
    const settled = budget.settle(request.reservationId, outcome?.kind === 'released'
      ? { kind: 'released' }
      : { kind: 'used', input: amount(outcome?.input), output: amount(outcome?.output), usd: amount(outcome?.usd), ...(outcome?.partial ? { partial: true } : {}) })
    if (!settled.ok) turn.refusal ??= BUDGET_EXHAUSTED
  }

  /**
   * Default deny: the turn's active tools, for its attempt, under the writer barrier. A read-only
   * child's file tools, and a definition's, are checked on the path Pi would open (Pi's own
   * resolution: `@`, `~`, `file://`, Git Bash drive paths), and Pi is handed that checked absolute
   * path to run on. A definition run holds Pi's built-ins to its grants, policy and approvals (its
   * app tools are held by the Mousse MCP registry). An allowed call is then charged to the run's
   * tool-call limit; the call that would pass it never runs.
   */
  private async gate(thread: PiThreadProcess, request: PiGateRequest): Promise<PiGateResponse> {
    const turn = thread.turn
    if (!turn || turn.attemptToken !== request.attemptToken || turn.phase === 'stopping') return { allow: false, reason: GATE_REFUSALS.denied }
    // A cut is aborting this prompt: Pi runs none of its calls.
    if (turn.gateRelease.signal.aborted) return { allow: false, reason: GATE_REFUSALS.denied }
    if (!turn.active.has(request.toolName)) return { allow: false, reason: `${GATE_REFUSALS.denied}: ${request.toolName} is not available in this turn` }
    const kind = turn.classes.get(request.toolName) ?? 'mutation'
    const access = turn.input.child?.readOnly ? turn.host.tools.toolAccess : undefined
    const builtin = Object.hasOwn(BUILTIN_CLASSES, request.toolName)
    const definition = turn.host.definition
    let input = request.input
    let rewritten: Record<string, unknown> | undefined
    // An app or MCP tool is approved as the registry will run it: without transport fields.
    if (definition && !builtin) input = withoutTransportFields(request.input)
    if (access || ((definition || turn.host.bot) && builtin)) {
      input = { ...request.input }
      const argument = PI_PATH_ARGUMENTS[request.toolName]
      if (argument) {
        const raw = input[argument.key] ?? argument.fallback
        if (typeof raw !== 'string') return { allow: false, reason: `${GATE_REFUSALS.denied}: ${request.toolName} needs a path` }
        const home = this.options.env().env.HOME ?? this.options.env().env.USERPROFILE
        // `read` opens a variant of a missing path when one exists: the gate checks that one.
        const resolved = (request.toolName === 'read' ? piResolveReadPath : piResolvePath)(raw, thread.cwd, home ? { home } : {})
        input[argument.key] = resolved
        rewritten = { [argument.key]: resolved }
      }
    }
    if (access) {
      try {
        await access.execute(request.toolName, input, async () => undefined)
      } catch (error) {
        return { allow: false, reason: error instanceof Error ? error.message : GATE_REFUSALS.denied }
      }
    }
    // A bot turn: each built-in is held to the bot's grant (tools, roots, scratch) on the path Pi
    // will open. Its app and MCP tools are held by the Mousse MCP registry. Nobody is asked.
    const bot = turn.host.bot
    if (bot && builtin) {
      const decided = checkBuiltinCall(bot, PI_NATIVE_TOOLS, request.toolName, input)
      if (!decided.ok) return { allow: false, reason: checkMessage(decided) }
      // Pi's `grep` and `find` walk down from their folder and read hidden files, and take no exclusions Mousse could
      // add (one `glob` of the bot's own): a walk over a folder that holds a place closed to bots is refused.
      const walked = PI_WALKING_TOOLS.has(request.toolName) ? input[PI_PATH_ARGUMENTS[request.toolName]!.key] : undefined
      if (typeof walked === 'string' && bot.closedBelow?.(walked)) return { allow: false, reason: wallMessage({ kind: 'search_closed', tool: request.toolName, path: walked }) }
    }
    // A bot's app tool, or one of its owner's MCP tools the turn was offered (by its proxied name), is checked here too
    // (the registry checks it again when it runs), so a refused call never costs a tool call. An MCP tool is checked as
    // the grant holds it (server and tool), as Claude Code's gate checks a relayed one.
    if (bot && !builtin) {
      const args = withoutTransportFields(request.input)
      const mcp = bot.mcpTools?.find((tool) => tool.providerName === request.toolName)
      if (mcp) {
        const decided = bot.check({ kind: 'mcp', server: mcp.server, tool: mcp.tool, serverName: mcp.serverName, args })
        if (!decided.ok) return { allow: false, reason: checkMessage(decided) }
      } else {
        const refusal = botAppToolRefusal(bot, request.toolName, args)
        if (refusal) return { allow: false, reason: refusal }
      }
    }
    // A definition run: every call, built-in or app/MCP, is authorized in full (approval included)
    // before it is charged, so a refused call never costs a tool call.
    if (definition) {
      // Where Pi's shell is not contained (`weak`: a no-shell record), a shell command asks a person
      // first whatever the grants say, bound to these exact arguments, and an unattended run runs none.
      const uncontainedShell = builtin && isShellTool(request.toolName) && this.capabilities.containment !== 'strong'
      // The arguments checked (and approved) are the ones the tool runs with.
      const decided = await authorizeDefinitionCall(definition, { toolName: request.toolName, args: input, projectPath: thread.cwd, signal: turn.input.signal, ...(uncontainedShell ? { uncontainedShell } : {}) })
      if (!decided.allowed) return { allow: false, reason: decided.message }
      // Stopped while the approval was pending, or the run is no longer the thread's active run (it
      // ended elsewhere, or another took the thread): nothing runs, as on the loop and the MCP path.
      if (thread.turn !== turn || (turn.phase as PiTurn['phase']) === 'stopping') return { allow: false, reason: GATE_REFUSALS.denied }
      if (turn.host.tools.runActive?.() === false) return { allow: false, reason: `${GATE_REFUSALS.denied}: the run is no longer active` }
    }
    // The thread's permission mode: a command (and, under Ask, an edit) asks the user first. A definition
    // run and a bot run are held to their own grants above and never ask a person.
    if (!definition && !bot && builtin) {
      const refusal = await this.askPermission(turn, request.toolName, input, thread.cwd, request.toolCallId)
      if (refusal) return refusal
      if (thread.turn !== turn || (turn.phase as PiTurn['phase']) === 'stopping') return { allow: false, reason: GATE_REFUSALS.denied }
    }
    // The writer wait ends when a cut aborts Pi or Stop comes (`gateRelease`): Pi's abort waits for the gate.
    const decision = await turn.episode.authorize(request.toolCallId, kind, turn.gateRelease.signal)
    if (!decision.allow) return decision
    // A definition's call is checked once more right before it is charged and runs (the writer wait
    // above can be long): a run that is no longer the thread's active one runs nothing.
    if (definition && (turn.host.tools.runActive?.() === false || thread.turn !== turn || (turn.phase as PiTurn['phase']) === 'stopping')) {
      turn.episode.ended(request.toolCallId)
      return { allow: false, reason: `${GATE_REFUSALS.denied}: the run is no longer active` }
    }
    const counted = turn.host.budget?.toolCall() ?? { ok: true }
    if (!counted.ok) {
      turn.episode.ended(request.toolCallId)
      turn.refusal ??= BUDGET_EXHAUSTED
      return { allow: false, reason: GATE_REFUSALS.budget }
    }
    // An app or MCP tool runs through the Mousse MCP registry, which takes this authorization
    // instead of asking for approval a second time.
    if (definition && !builtin) recordAuthorizedCall(definition, { turnToken: turn.attemptToken, toolName: request.toolName, callId: request.toolCallId, args: input })
    // A bot's or a definition's built-in is in the run's tool ledger before it runs (`started`, then
    // `committed` or `failed` from its end event), by its neutral class's idempotency: an `edit`
    // cut off without an outcome is then found and shown to the owner. A bot: no row, no call. A
    // definition: the same wherever the host keeps a ledger (the orchestrator always does).
    if ((bot || (definition && turn.host.tools.toolLedger)) && builtin) {
      const ledger = turn.host.tools.toolLedger
      const neutral = neutralToolsOf(PI_NATIVE_TOOLS, request.toolName)
      const row = ledger?.start({ type: 'toolCall', id: request.toolCallId, name: request.toolName, arguments: input } as ToolCall, { idempotent: neutral.length > 0 && neutral.every(neutralToolIdempotent) })
      if (!row) {
        turn.episode.ended(request.toolCallId)
        return { allow: false, reason: `${GATE_REFUSALS.denied}: the call could not be recorded` }
      }
      turn.ledgerRows.set(request.toolCallId, row)
    }
    return rewritten ? { allow: true, input: rewritten } : { allow: true }
  }

  /**
   * Asks the user before a built-in tool the turn's permission mode does not allow without asking
   * (`bash` under Ask and Auto-accept edits, `edit` and `write` under Ask). An edit or write into Git's
   * own files counts as a command (`permissionActionForWrite`) and names the file. Null when the call may
   * go on. A turn with no way to ask, or whose approvals are refused, denies: nothing runs unapproved.
   */
  private async askPermission(turn: PiTurn, toolName: string, input: Record<string, unknown>, cwd: string, callId?: string): Promise<PiGateResponse | null> {
    const kind = piToolAction(toolName)
    // Full access runs commands and edits alike without asking.
    if (!kind || permissionModeAllows(turn.input.permissionMode, 'command')) return null
    const target = typeof input.path === 'string' ? input.path : undefined
    const write = kind === 'edit' && target !== undefined ? await permissionActionForWrite(cwd, piToolPath(target)) : undefined
    const action = write?.action ?? kind
    if (permissionModeAllows(turn.input.permissionMode, action)) return null
    const prompter = turn.host.bridge?.permission
    const denied = (reason: string): PiGateResponse => ({ allow: false, reason })
    if (!prompter || prompter.approvals === 'never') return denied(`${GATE_REFUSALS.denied}: ${toolName} needs the user's approval and this turn cannot ask`)
    const detail = typeof input.command === 'string' ? input.command : target ?? JSON.stringify(input)
    const what = write?.action === 'command' ? "change Git's own files" : kind === 'command' ? 'run this command' : 'edit this file'
    // A person's steer that cuts in answers the question (docs/design/steer-and-interruptions.md §2.1), and a Stop ends
    // it: Pi's abort waits for this gate, so the wait ends with the cut or the Stop (`gateRelease`).
    const release = turn.gateRelease.signal
    const steered = (): PiGateResponse => turn.phase === 'stopping' || turn.input.signal.aborted
      ? denied(`The user stopped the run before approving the request to ${what}.`)
      : denied(`The user sent a new message instead of approving the request to ${what}. Do not retry it unless they ask.`)
    if (release.aborted) return steered()
    // While the person is asked, the call is not a running tool: a steer cuts in, and answers it. Nor is any other
    // call of its batch: Pi passes every call of a batch through this gate before it runs any (in parallel mode), or
    // runs them one after another (sequential mode, where the earlier ones have ended), so none runs meanwhile.
    const behind = callId ? [...turn.openTools.keys()].filter((id) => id !== callId) : []
    if (callId) {
      turn.asking.add(callId)
      for (const id of [callId, ...behind]) turn.sink.toolAwaiting?.(id, true)
    }
    let onRelease: (() => void) | undefined
    try {
      const released = new Promise<'released'>((resolve) => {
        onRelease = () => resolve('released')
        release.addEventListener('abort', onRelease, { once: true })
      })
      const chosen = await Promise.race([released, prompter.choose({
        threadId: turn.input.threadId,
        title: write?.action === 'command' ? `Allow Pi to ${what} (${write.gitFile})?` : `Allow Pi to ${what}?\n${detail.slice(0, 4000)}`,
        options: [
          { optionId: 'allow', kind: 'allow_once', label: 'Allow once', scope: 'once' },
          { optionId: 'reject', kind: 'reject_once', label: 'Reject', scope: 'once' }
        ],
        // The key stays the tool's class (an edit); the action is what the mode and who may answer go by.
        approval: { action, permissionKey: piPermissionKey(kind), tool: { name: toolName, input, cwd } }
      }, { signal: release })])
      if (chosen === 'released' || release.aborted) return steered()
      if (chosen === 'allow' && !turn.input.signal.aborted) return null
      return denied(`The user rejected the request to ${what}. Do not retry it unless they ask.`)
    } catch {
      if (release.aborted) return steered()
      return denied(`${GATE_REFUSALS.denied}: the user did not approve ${toolName}`)
    } finally {
      if (onRelease) release.removeEventListener('abort', onRelease)
      if (callId) {
        turn.asking.delete(callId)
        for (const id of [callId, ...behind]) turn.sink.toolAwaiting?.(id, false)
      }
    }
  }

  async startTurn(input: TurnInput, sink: TurnSink, ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    // An agent definition's turn (PR 4 4d-rpc) comes whole: its authority, its own system prompt in
    // place of Pi's, and a session of its own. Anything less is refused before anything runs.
    const definitionTurn = input.session === 'ephemeral' || input.instructions !== undefined || host.definition !== undefined
    if (definitionTurn && (input.session !== 'ephemeral' || input.instructions?.placement !== 'replace' || !host.definition))
      throw harnessAppError({
        code: 'policy_unenforceable',
        message: "This turn does not carry everything an agent definition needs (its authority, its instructions and a session of its own), so it does not run.",
        missing: ['toolControl'],
        instanceId: this.options.instanceId
      })
    const key = randomUUID()
    const ref: ProviderRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model, nativeTurnId: key }
    sink.providerRef(ref)
    const starting: StartingTurn = { threadId: input.threadId, cancelled: false }
    this.turns.set(key, starting)
    const startedAt = Date.now()
    // Stop during a cold start: the starting process is killed and the turn ends aborted.
    const onEarlyAbort = () => {
      starting.cancelled = true
      if (!starting.turn && starting.thread) void this.kill(starting.thread)
    }
    input.signal.addEventListener('abort', onEarlyAbort, { once: true })
    if (definitionTurn || host.bot) {
      try {
        return await this.ephemeralTurn(key, ref, starting, startedAt, input, sink, ctl, host)
      } finally {
        input.signal.removeEventListener('abort', onEarlyAbort)
        this.turns.delete(key)
      }
    }
    try {
      const cwd = input.cwd ?? join(this.options.stateDir, 'chats', fingerprint(input.threadId).slice(0, 16))
      mkdirSync(cwd, { recursive: true })
      const history = input.nativeHistory ?? ''
      let saved: SavedThread | undefined = this.saved()[input.threadId]
      // History the orchestrator handed over in the prompt (a provider switch, or a fork that could
      // not branch natively) stands in for any native session of the thread.
      const handedOver = input.historyHandedOver === true
      // Unplanned handoffs: whether a turn ran elsewhere since the branch is unknown, so the branch
      // is not trusted and the raw history is handed over (as before native forks).
      if (saved?.pendingFork && input.handoffUnplanned === true && !handedOver && !history) {
        // Nothing to hand over in the branch's place: the fork's own history is empty, and running
        // without the parent's would answer out of context. The turn fails; the resend plans again.
        throw harnessAppError({ code: 'binding_stale', message: `${this.options.label} could not prepare this fork's history. Send the message again.`, instanceId: this.options.instanceId })
      }
      if (saved?.pendingFork && (handedOver || input.handoffUnplanned === true)) {
        // The prompt carries the parent's history: the branch (made before turns elsewhere, or before
        // a re-fork that did not happen) is not resumed beside it.
        this.save(input.threadId, undefined)
        saved = undefined
      }
      // A pending fork resumes its branch whatever the thread's history holds: every turn of the fork
      // thread since the branch was made ran here and failed or stopped (one that completed replaced
      // the mapping; one elsewhere comes back with the history handed over), and its message is resent.
      const matches = !handedOver && saved?.historyFingerprint === fingerprint(history)
      let resume = saved && (saved.pendingFork || matches) ? saved.sessionId : undefined
      // A cold resume needs the session's file, in this workspace (a fork's first turn runs in its own).
      const warm = this.threads.get(input.threadId)
      const warmOnIt = warm?.alive && warm.cwd === cwd && warm.sessionId === resume
      if (resume && !warmOnIt && !prepareSession(this.sessionsDir, resume, cwd)) resume = undefined
      if (saved?.pendingFork && !resume) {
        // A fork's first turn has no history of its own: running it on a new session would lose the
        // parent's. The branch is dropped, so the retry forks again or hands the history over.
        this.save(input.threadId, undefined)
        throw harnessAppError({ code: 'binding_stale', message: `${this.options.label} could not open this fork's session. Send the message again.`, instanceId: this.options.instanceId })
      }
      let started: { thread: PiThreadProcess; resumed: boolean }
      try {
        if (input.signal.aborted || starting.cancelled) throw new Error('aborted')
        started = resume || !history ? await this.processFor(input, cwd, resume, starting) : await this.handOver(input, cwd, starting)
      } catch (error) {
        if (input.signal.aborted || starting.cancelled) return this.abortedResult(input, ref, startedAt)
        throw error
      }
      if (history && !resume) this.historyNotice(input.threadId)
      return await this.runTurn(started.thread, started.resumed, key, starting, ref, input, sink, ctl, host, history)
    } finally {
      input.signal.removeEventListener('abort', onEarlyAbort)
      this.turns.delete(key)
    }
  }

  /**
   * An agent definition's or a bot's turn: a new Pi process with an in-memory session
   * (`--no-session`) under a key of its own, so it never resumes, saves or warms a session and never
   * touches the thread's own process. Its prior conversation goes in the prompt, and the process is
   * gone when the turn ends. A definition's system prompt replaces Pi's (`before_agent_start`) and
   * its tools are exactly its grants. A bot's process (Bot Phase 1 §5.9) runs in the locked
   * environment (`lockedEnv`, with the bot marker) and is reported to its supervision as it starts.
   */
  private async ephemeralTurn(
    key: string, ref: ProviderRef, starting: StartingTurn, startedAt: number,
    input: TurnInput, sink: TurnSink, ctl: TurnControl, host: AdapterHost
  ): Promise<TurnResult> {
    // A bot's turn works in its files folder, as on Claude Code and Codex: its commands start there,
    // and the gate resolves every relative path against it (`gate`).
    const files = host.bot && !host.definition ? host.bot.workspace?.files : undefined
    const cwd = files ?? input.cwd ?? join(this.options.stateDir, 'chats', fingerprint(input.threadId).slice(0, 16))
    mkdirSync(cwd, { recursive: true })
    let bot: PiBotProcess | undefined
    if (host.bot && !host.definition) {
      if (!this.options.onBotProcess)
        throw harnessAppError({ code: 'policy_unenforceable', message: `${this.options.label} has no bot supervision here, so a bot does not run on it.`, missing: ['containment'], instanceId: this.options.instanceId })
      const scratch = host.bot.workspace?.scratch ?? cwd
      mkdirSync(join(scratch, 'tmp'), { recursive: true, mode: 0o700 })
      const credential = (await this.options.credentialKind?.()) ?? 'unknown'
      bot = { threadId: input.threadId, locked: { credential, scratch, marker: { [PI_BOT_MARKER]: host.bot.activationId } } }
    }
    let started: { thread: PiThreadProcess; resumed: boolean }
    try {
      if (input.signal.aborted || starting.cancelled) throw new Error('aborted')
      started = await this.processFor(input, cwd, undefined, starting, bot ? { key: `bot:${key}`, bot } : { key: `definition:${key}` })
    } catch (error) {
      if (input.signal.aborted || starting.cancelled) return this.abortedResult(input, ref, startedAt)
      throw error
    }
    try {
      return await this.runTurn(started.thread, false, key, starting, ref, input, sink, ctl, host, input.nativeHistory ?? '')
    } finally {
      await within(this.kill(started.thread), CLEANUP_DEADLINE_MS)
    }
  }

  private abortedResult(input: TurnInput, ref: ProviderRef, startedAt: number): TurnResult {
    const contextKey = `${input.llmProvider}:${input.model}`
    return {
      text: '', aborted: true, modelName: input.model, totalResponseTimeMs: Date.now() - startedAt,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: contextKey, contextModelKey: contextKey, nativeMessages: [], providerRef: ref
    }
  }

  private async runTurn(
    thread: PiThreadProcess, resumed: boolean, key: string, starting: StartingTurn, baseRef: ProviderRef,
    input: TurnInput, sink: TurnSink, ctl: TurnControl, host: AdapterHost, history: string
  ): Promise<TurnResult> {
    const ref: ProviderRef = { ...baseRef, ...(thread.sessionId ? { sessionId: thread.sessionId } : {}) }
    if (thread.sessionId) sink.providerRef(ref)
    let builtins = !input.cwd ? [] : input.mode === 'plan' || input.child?.readOnly ? PI_READ_ONLY_BUILTINS : PI_ALL_BUILTINS
    let tools = host.bridge?.mcp ? this.options.mousseTools?.(input.threadId, input.runId) ?? [] : []
    // The user's own MCP servers reach Pi's agent through Mousse's MCP server, like the app tools.
    if (host.bridge?.mcp && host.bridge.userMcp === 'proxy' && this.options.userMcpTools) {
      const appTools = new Set(tools.map((tool) => tool.name))
      tools = [...tools, ...(await this.options.userMcpTools(input.threadId, input.runId)).filter((tool) => !appTools.has(tool.name))]
    }
    // An agent definition's turn offers exactly its grants (the policy's allowlist, else its effective
    // grants), and never a delegation tool: a definition delegates nothing, as on the legacy loop.
    if (host.definition) {
      const { grants, mcpTools } = host.definition
      const allowed = new Set(host.bridge?.toolPolicy?.allow ?? [
        ...grants.builtinTools.map((grant) => canonicalizeBuiltinToolName(grant.id)),
        ...grants.mcpTools.map((grant) => grant.id),
        ...(mcpTools ?? []).map((tool) => tool.providerName)
      ])
      builtins = builtins.filter((name) => allowed.has(name))
      tools = tools.filter((tool) => allowed.has(tool.name) && tool.class !== 'delegation')
    }
    // A bot's turn offers only its granted built-ins: an ungranted one does not exist for the model,
    // as on the locked Claude turn (`escalate` is how it asks). `bash` comes with "run commands",
    // granted as a whole; it runs in the locked environment, from the bot's files folder.
    if (host.bot) {
      const granted = new Set([...host.bot.tools].flatMap((tool) => PI_NATIVE_TOOLS[tool] ?? []))
      builtins = builtins.filter((name) => granted.has(name))
    }
    const turn = new PiTurn(key, host.bridge?.turnToken ?? key, input, sink, ctl, host, tools, builtins)
    thread.turn = turn
    starting.turn = turn
    const onAbort = () => void this.stopTurn(thread, turn)
    input.signal.addEventListener('abort', onAbort, { once: true })
    let failure: unknown
    try {
      if (input.signal.aborted) throw new Error('aborted')
      const handoff = !resumed && history ? `Previous conversation (context only; do not repeat earlier actions):\n${history}\n\nCurrent request:\n` : ''
      // A definition's message is its own: no chat preamble (applets, the Mousse tools usable now).
      const preamble = host.bridge?.turnPreamble && !host.definition ? `${host.bridge.turnPreamble}\n\n` : ''
      let message = `${handoff}${preamble}${input.prompt || '(image attachment)'}`
      // A leading `/` would run a Pi extension command instead of reaching the model.
      if (message.startsWith('/')) message = ` ${message}`
      const images = (input.images ?? []).map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType }))
      // Pi answers a prompt after its preflight (auth, compaction, extensions): bounded, and Stop cancels the wait.
      await this.send(thread, { type: 'prompt', message, ...(images.length ? { images } : {}) }, this.options.promptDeadlineMs ?? PI_PROMPT_DEADLINE_MS, input.signal)
      turn.promptAccepted = true
      // On the hold (docs/design/steer-and-interruptions.md §3): a person's steer cuts in while Pi writes.
      if (ctl.peekSteer) {
        turn.poll = setInterval(() => this.pollSteer(thread, turn), PI_STEER_POLL_MS)
        turn.poll.unref?.()
      }
      await turn.done
    } catch (error) {
      failure = error
    } finally {
      input.signal.removeEventListener('abort', onAbort)
      if (turn.poll) clearInterval(turn.poll)
    }
    const stopped = input.signal.aborted || turn.phase === 'stopping'
    if (stopped && failure !== undefined && !thread.dead) await turn.done.catch(() => {})
    // A process that died keeps the episode (and the writer) until its tree is gone.
    if (thread.dead || thread.exit) await within(thread.closed, CLEANUP_DEADLINE_MS)
    turn.episode.close()
    if (thread.turn === turn) thread.turn = undefined
    // Every ended turn, failed or not, leaves its process for the warm period only (a definition's
    // or a bot's process goes when its turn ends: `ephemeralTurn`).
    if (thread.alive && !thread.ephemeral) {
      thread.warm = setTimeout(() => void this.kill(thread), this.options.warmMs ?? PI_WARM_MS)
      thread.warm.unref?.()
    }
    if (failure !== undefined && !stopped) {
      if (thread.fatal) throw protocolError(this.options.instanceId, `${this.options.label} could not register its providers, so the turn was stopped before any request.`)
      throw failure
    }
    // Context for the gauge, from Pi's own measurement.
    let context: { input: number; cacheRead: number; cacheWrite: number; contextWindow?: number; modelName?: string } | undefined
    if (thread.alive && !stopped) {
      try {
        const stats = await this.send<{ contextUsage?: { tokens: number | null; contextWindow: number } }>(thread, { type: 'get_session_stats' })
        if (stats.contextUsage?.tokens != null)
          context = { input: stats.contextUsage.tokens, cacheRead: 0, cacheWrite: 0, contextWindow: stats.contextUsage.contextWindow, modelName: thread.model }
      } catch {
        // The gauge waits for the next turn.
      }
    }
    sink.providerMetrics({ totalResponseTimeMs: Date.now() - turn.startedAt, totalTokensUsed: turn.usage.input + turn.usage.output, ...(context ? { context } : {}), ...(turn.promptCache.at ? { promptCache: { ...turn.promptCache } } : {}) })
    // Every step's text, as the legacy loop's reply joins them (a steered turn answers more than once).
    // A stopped turn keeps its partial reply; a finished one is every step's text, joined.
    const text = stopped ? turn.replyText() : turn.texts.join('\n\n')
    // A stopped or failed reply stays open: the orchestrator closes it as incomplete.
    if (!stopped) turn.reply.complete(text)
    // A definition's in-memory session is never mapped to the thread.
    if (thread.ephemeral) {
      // Nothing to save.
    } else if (!stopped) {
      const committed = host.context.nativeHistoryAfterTurn(text)
      if (thread.sessionId) {
        const leaves = await this.turnLeaf(thread, input.threadId, key)
        this.save(input.threadId, { sessionId: thread.sessionId, historyFingerprint: fingerprint(committed), instructionsHash: fingerprint(host.bridge?.sessionInstructions ?? ''), ...leaves })
      }
    } else if (thread.sessionId && thread.alive && host.context.nativeHistoryNow) {
      this.save(input.threadId, { sessionId: thread.sessionId, historyFingerprint: fingerprint(host.context.nativeHistoryNow()), ...this.leavesOf(input.threadId, thread.sessionId) })
    }
    const contextKey = `${input.llmProvider}:${input.model}`
    return {
      text,
      aborted: stopped,
      modelName: input.model,
      totalResponseTimeMs: Date.now() - turn.startedAt,
      totalTokensUsed: turn.usage.input + turn.usage.output,
      usage: turn.usage,
      contextSignature: contextKey,
      contextModelKey: contextKey,
      nativeMessages: [],
      providerRef: ref
    }
  }

  /**
   * Stop: fence steers, clear Pi's queue (returning what it held once), revoke the episode, abort.
   * Past the deadline the tree is killed, and the turn ends only once it is gone.
   */
  private stopTurn(thread: PiThreadProcess, turn: PiTurn): Promise<'interrupted' | 'not_active'> {
    // One graceful Stop per turn: a later caller (thread Stop, deletion) waits for it instead of
    // cutting it off with a kill before `clear_queue` and `abort` reached Pi.
    turn.stopping ??= this.stopTurnOnce(thread, turn)
    return turn.stopping
  }

  private async stopTurnOnce(thread: PiThreadProcess, turn: PiTurn): Promise<'interrupted' | 'not_active'> {
    turn.phase = 'stopping'
    const cut = turn.cut
    // A Stop during a cut wins: the cut's next step sees the new generation and starts nothing, its waits end now, and
    // what it held comes back first in the queue (below).
    turn.opGen += 1
    turn.halt.abort()
    turn.cut?.barrier?.()
    // Pi's abort waits for the gate: a call waiting there (an approval, the writer) is refused now, so neither a cut's
    // abort nor Stop's own waits for a person who may never answer.
    this.releaseGate(turn, false)
    turn.wake()
    turn.episode.revoke()
    if (!thread.alive) {
      await within(thread.closed, INTERRUPT_DEADLINE_MS)
      turn.settled()
      return 'interrupted'
    }
    if (!turn.promptAccepted) {
      // Pi runs an accepted-later prompt detached from `abort` (its preflight: compaction,
      // `before_agent_start`): the process goes, and its session with the half-started prompt.
      if (!thread.ephemeral) this.save(thread.threadId, undefined)
      this.returnSteers(turn)
      await within(this.kill(thread), CLEANUP_DEADLINE_MS)
      turn.settled()
      return 'interrupted'
    }
    // A cut's request in flight (a `clear_queue` whose answer moves steers to the cut) is applied before Stop's own.
    await within(turn.lane, this.options.interruptDeadlineMs ?? INTERRUPT_DEADLINE_MS)
    // A native `steer` sent at `turn_end` and not answered yet would be queued after `clear_queue`, and the model
    // would read it as well as its next turn: Stop waits for its answer first, within the command deadline.
    await within(this.steerSendsAnswered(turn), this.options.commandDeadlineMs ?? COMMAND_DEADLINE_MS)
    if (thread.killed || !thread.alive) {
      // Its deadline killed Pi, and Pi's queue went with it: nothing goes to the dying process.
      this.returnSteers(turn)
      await within(this.kill(thread), CLEANUP_DEADLINE_MS)
      turn.settled()
      return 'interrupted'
    }
    try {
      const cleared = await this.send<{ steering: string[]; followUp: string[] }>(thread, { type: 'clear_queue' })
      this.returnCleared(turn, cleared)
      // `abort` also cancels a pending retry backoff.
      await this.send(thread, { type: 'abort' }, INTERRUPT_DEADLINE_MS)
    } catch {
      // The command deadline killed the tree: the writer is released only once it is gone, and the
      // steers Pi still held come back once. A continuation Pi may have recorded goes with the session.
      if (cut?.continuation && !thread.ephemeral) this.save(thread.threadId, undefined)
      this.returnSteers(turn)
      await within(this.kill(thread), CLEANUP_DEADLINE_MS)
    }
    // A cut's continuation prompt: Pi records its user message once it accepts it, even when the abort comes before
    // any request (spike S3 item 7), and the next turn resumes that session. So it is taken once Pi answers it; if Pi
    // never answers, the process goes with its session (as for a first prompt Pi never accepted), and it comes back.
    if (cut?.continuation) {
      let outcome: 'started' | 'refused' | undefined
      await within(cut.continuation.then((value) => { outcome = value }), thread.alive && !thread.killed ? this.options.interruptDeadlineMs ?? INTERRUPT_DEADLINE_MS : 0)
      if (outcome === 'started') {
        for (const steer of cut.carried ?? []) if (turn.steers.includes(steer)) this.steerRead(turn, steer)
      } else if (outcome === undefined) {
        if (!thread.ephemeral) this.save(thread.threadId, undefined)
        await within(this.kill(thread), CLEANUP_DEADLINE_MS)
      }
    }
    // What a cut still holds never reached Pi: it comes back once, before the turn ends (Pi settles before it answers
    // the abort, and a hand-back after the turn's end would land nowhere).
    this.returnSteers(turn, 'cutHeld')
    turn.settled()
    return 'interrupted'
  }

  /** Hands back, once, every steer the turn owns that Pi did not take (only those in `state`, when given). */
  private returnSteers(turn: PiTurn, state?: PiSteer['state']): void {
    const back = turn.steers.filter((steer) => !state || steer.state === state)
    for (const steer of back) turn.steers.splice(turn.steers.indexOf(steer), 1)
    for (const steer of back) turn.ctl.returnSteer?.(steer.text, steer.token)
  }

  async interrupt(ref: ProviderRef): Promise<'interrupted' | 'not_active'> {
    const { entry, thread } = this.target(ref)
    if (entry && !entry.turn) {
      // Still starting: the start is cancelled and its process killed.
      entry.cancelled = true
      if (entry.thread) await within(this.kill(entry.thread), INTERRUPT_DEADLINE_MS)
      return 'interrupted'
    }
    const turn = entry?.turn ?? thread?.turn
    const owner = entry?.thread ?? thread
    if (!turn || !owner || owner.turn !== turn) return 'not_active'
    return this.stopTurn(owner, turn)
  }

  /**
   * Stop for a thread (also on its deletion): its live turn, then its whole tree, warm or not,
   * background work included. Settles once the tree is gone.
   */
  async stopThread(threadId: string): Promise<'stopped' | 'not_active'> {
    const starting = [...this.turns.values()].filter((entry) => entry.threadId === threadId && !entry.turn)
    for (const entry of starting) entry.cancelled = true
    // A definition's or a bot's turn runs on a process of its own, under its own key.
    const ephemeral = [...this.turns.values()].filter((entry) => entry.threadId === threadId && entry.turn && entry.thread?.ephemeral)
    for (const entry of ephemeral) {
      await this.stopTurn(entry.thread!, entry.turn!)
      await within(this.kill(entry.thread!), INTERRUPT_DEADLINE_MS)
    }
    const thread = this.threads.get(threadId) ?? starting.find((entry) => entry.thread)?.thread
    if (!thread) return starting.length || ephemeral.length ? 'stopped' : 'not_active'
    if (thread.turn) await this.stopTurn(thread, thread.turn)
    await within(this.kill(thread), INTERRUPT_DEADLINE_MS)
    // A start still in progress spawns nothing more; one that already spawned is killed with its tree.
    if (thread.starting) {
      await within(thread.starting, INTERRUPT_DEADLINE_MS)
      await within(this.kill(thread), INTERRUPT_DEADLINE_MS)
    }
    return 'stopped'
  }

  /**
   * Native fork (SPEC §16.2): a new Pi session holding the source session up to the end of the turn
   * `ref` names (its key, `nativeTurnId`, not the ordinal: Mousse's run ordinals do not count Pi's
   * prompts). `clone` when that turn is the session's latest, else `fork` before the prompt that
   * followed it. A process of its own on the source session does it, so the source thread's process
   * is untouched, under the command deadline. `target` is the thread the fork belongs to: its first
   * turn resumes the new session. Null (a portable handoff) without a target to bind the session
   * to, when the turn's branch point is unknown (a turn before 2c, a stopped one) or Pi declines.
   */
  async forkSession(ref: ProviderRef, _atTurnOrdinal: number, target?: { threadId: string }): Promise<ProviderRef | null> {
    await this.afterRetirement()
    if (!target || !ref.sessionId || !ref.nativeTurnId || !ref.model || this.stopped) return null
    const leaf = Object.values(this.saved()).find((entry) => entry.sessionId === ref.sessionId)?.turnLeaves?.[ref.nativeTurnId]
    const file = leaf ? sessionFileOf(this.sessionsDir, ref.sessionId) : undefined
    const cwd = file ? sessionHeaderOf(file)?.header.cwd : undefined
    if (!leaf || typeof cwd !== 'string') return null
    const { modelId, thinking } = this.thinkingFor(ref.model)
    const thread = new PiThreadProcess(`fork:${randomUUID()}`, cwd, modelId, thinking)
    thread.keyFingerprint = fingerprint(this.options.apiKey?.() ?? '')
    // Tracked like a thread's process, so `stop()` kills it; no turn ever runs on it.
    this.threads.set(thread.threadId, thread)
    try {
      const started = this.start(thread, ref.sessionId)
      thread.starting = started
      this.starts.add(started)
      try {
        await started
      } finally {
        this.starts.delete(started)
        if (thread.starting === started) thread.starting = undefined
      }
      const after = await this.send<{ entries: Array<{ id: string; type: string; message?: { role?: string } }> }>(thread, { type: 'get_entries', since: leaf })
      // Pi 1.x records a system message before a turn whose prompt or tools changed: the next turn
      // starts at its first user message.
      const next = after.entries.find((entry) => entry.type === 'message' && entry.message?.role !== 'system')
      if (!next) {
        if ((await this.send<{ cancelled: boolean }>(thread, { type: 'clone' })).cancelled) return null
      } else {
        const { messages } = await this.send<{ messages: Array<{ entryId: string }> }>(thread, { type: 'get_fork_messages' })
        if (next.message?.role !== 'user' || !messages.some((message) => message.entryId === next.id)) return null
        if ((await this.send<{ cancelled: boolean }>(thread, { type: 'fork', entryId: next.id })).cancelled) return null
      }
      const { sessionId } = await this.send<{ sessionId?: string }>(thread, { type: 'get_state' })
      // Pi writes a branch once it holds a reply; one it did not write cannot be resumed.
      if (!sessionId || sessionId === ref.sessionId || !sessionFileOf(this.sessionsDir, sessionId)) return null
      // The fork's thread has no history of its own before its first turn, which resumes the branch.
      this.save(target.threadId, { sessionId, historyFingerprint: fingerprint(''), pendingFork: true })
      return { provider: ref.provider, ...(ref.instanceId ? { instanceId: ref.instanceId } : {}), model: ref.model, sessionId }
    } finally {
      await within(this.kill(thread), CLEANUP_DEADLINE_MS)
    }
  }

  // -- Sessions handed over -------------------------------------------------------------------------

  private get sessionsDir(): string {
    return join(this.options.stateDir, 'sessions')
  }

  /**
   * A new session for a thread with history and no session to resume (a thread from the pi loop,
   * whose refs name none, or one whose session was forgotten): seeded from the thread's transcript
   * and checked with `get_messages`. Anything wrong, and the history goes in the prompt instead
   * (`resumed: false`).
   */
  private async handOver(input: TurnInput, cwd: string, starting: StartingTurn): Promise<{ thread: PiThreadProcess; resumed: boolean }> {
    let seed: PiSeed | undefined
    try {
      seed = this.seedSession(input, cwd)
    } catch (error) {
      console.warn('[harness] could not seed a Pi session', { instanceId: this.options.instanceId, error: error instanceof Error ? error.message : String(error) })
    }
    if (seed) {
      try {
        const started = await this.processFor(input, cwd, seed.sessionId, starting)
        if (await this.seedLoaded(started.thread, seed)) return started
        await within(this.kill(started.thread), CLEANUP_DEADLINE_MS)
      } catch (error) {
        if (input.signal.aborted || starting.cancelled) throw error
      }
      console.warn('[harness] Pi did not load the seeded session; the history goes in the prompt', { instanceId: this.options.instanceId })
      try {
        rmSync(seed.file, { force: true })
      } catch {
        // A stray seed is never resumed: no thread maps to it.
      }
    }
    const started = await this.processFor(input, cwd, undefined, starting)
    return { thread: started.thread, resumed: false }
  }

  /**
   * Writes a v3 Pi session holding the thread's transcript before the admitted message: the
   * messages Pi's `convertToLlm` passes as they are (user, assistant, tool results), chained in
   * order, and the compaction memory as a compaction entry that keeps all of them. Undefined when
   * there is nothing to seed.
   */
  private seedSession(input: TurnInput, cwd: string): PiSeed | undefined {
    const prior = input.messages.at(-1)?.role === 'user' ? input.messages.slice(0, -1) : input.messages
    const messages = prior.filter((message) => SEED_ROLES.has(message.role))
    const summary = input.contextSummary?.trim()
    if (!messages.length && !summary) return undefined
    const sessionId = randomUUID()
    const timestamp = new Date().toISOString()
    const ids = new Set<string>()
    const entryId = (): string => {
      let id = randomUUID().slice(0, 8)
      while (ids.has(id)) id = randomUUID().slice(0, 8)
      ids.add(id)
      return id
    }
    // The model and thinking level, as Pi records them in every session it creates: a session
    // without a thinking entry gets one appended when Pi next opens it (a fork would write it into
    // this, the source session).
    const { modelId, thinking } = this.thinkingFor(input.model)
    const modelEntry = entryId()
    const thinkingEntry = entryId()
    const lines: Array<Record<string, unknown>> = [
      { type: 'session', version: 3, id: sessionId, timestamp, cwd: resolvePath(cwd) },
      { type: 'model_change', id: modelEntry, parentId: null, timestamp, provider: this.options.provider, modelId },
      { type: 'thinking_level_change', id: thinkingEntry, parentId: modelEntry, timestamp, thinkingLevel: thinking }
    ]
    const roles: string[] = []
    let parentId: string | null = thinkingEntry
    let firstKeptEntryId: string | undefined
    for (const message of messages) {
      const id = entryId()
      firstKeptEntryId ??= id
      lines.push({ type: 'message', id, parentId, timestamp, message })
      roles.push(message.role)
      parentId = id
    }
    if (summary) {
      lines.push({ type: 'compaction', id: entryId(), parentId, timestamp, summary, tokensBefore: 0, ...(firstKeptEntryId ? { firstKeptEntryId } : {}) })
      roles.unshift('compactionSummary')
    }
    mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 })
    const file = join(this.sessionsDir, `${timestamp.replace(/[:.]/g, '-')}_${sessionId}.jsonl`)
    atomicWriteFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, { mode: 0o600 })
    this.options.onSeed?.(file)
    return { sessionId, file, roles }
  }

  /** Pi runs the seeded session and holds exactly the seeded messages. */
  private async seedLoaded(thread: PiThreadProcess, seed: PiSeed): Promise<boolean> {
    if (thread.sessionId !== seed.sessionId) return false
    try {
      const { messages } = await this.send<{ messages: Array<{ role?: unknown }> }>(thread, { type: 'get_messages' })
      return messages.length === seed.roles.length && messages.every((message, index) => message?.role === seed.roles[index])
    } catch {
      return false
    }
  }

  /** The thread is told its history was handed to a new session (`history_injected`). */
  private historyNotice(threadId: string): void {
    if (this.historyNoticed.has(threadId)) return
    this.historyNoticed.add(threadId)
    try {
      this.options.notice?.(threadId, { code: 'history_injected', message: `${this.options.label} started a new session for this chat, with the chat history handed over.` })
    } catch (error) {
      console.warn('[harness] notice failed', error instanceof Error ? error.message : String(error))
    }
  }

  /** The fork points the thread keeps for `sessionId` (none when it ran another session). */
  private leavesOf(threadId: string, sessionId: string): Pick<SavedThread, 'leafId' | 'turnLeaves'> {
    const saved = this.saved()[threadId]
    if (saved?.sessionId !== sessionId) return {}
    return { ...(saved.leafId ? { leafId: saved.leafId } : {}), ...(saved.turnLeaves ? { turnLeaves: saved.turnLeaves } : {}) }
  }

  /**
   * The session's leaf after a completed turn, kept under the turn's key beside the thread's earlier
   * turns in the same session. Read with `get_entries since` the previous leaf, so only the turn's
   * own entries cross the pipe. Without it the turn cannot be forked natively.
   */
  private async turnLeaf(thread: PiThreadProcess, threadId: string, key: string): Promise<Pick<SavedThread, 'leafId' | 'turnLeaves'>> {
    const kept = this.leavesOf(threadId, thread.sessionId ?? '')
    const read = async (since?: string): Promise<string | undefined> => {
      if (!thread.alive) return undefined
      try {
        const { leafId } = await this.send<{ leafId: string | null }>(thread, { type: 'get_entries', ...(since ? { since } : {}) })
        return leafId ?? undefined
      } catch {
        return undefined
      }
    }
    // A cursor Pi no longer knows is read again from the start.
    const leafId = (await read(kept.leafId)) ?? (kept.leafId ? await read() : undefined)
    if (!leafId) return kept
    return { leafId, turnLeaves: Object.fromEntries(Object.entries({ ...kept.turnLeaves, [key]: leafId }).slice(-FORKABLE_TURNS)) }
  }

  // -- Events -------------------------------------------------------------------------------------

  /** The Pi process exited (its output may stay open while descendants hold it). */
  private died(thread: PiThreadProcess): void {
    if (thread.dead) return
    thread.dead = true
    thread.registration?.close()
    if (thread.warm) clearTimeout(thread.warm)
    if (this.threads.get(thread.threadId) === thread) this.threads.delete(thread.threadId)
    const child = thread.process?.child
    if (thread.tracking) clearInterval(thread.tracking)
    // An unexpected death: whatever Pi started is found and killed (a kill by Mousse took the tree,
    // and the recorded shell groups go too).
    if (child && !thread.killed) {
      try {
        killTree(child)
      } catch {
        // Best effort: the orphan sweep follows.
      }
    }
    if (child?.pid && !thread.sweep) thread.sweep = this.sweep(thread, child.pid, !thread.killed)
    // Set before tracking: `closed` includes the sweep.
    this.closing.add(thread)
    void thread.closed.finally(() => this.closing.delete(thread))
    for (const listener of [...thread.failures]) listener(`exited with code ${child?.exitCode ?? child?.signalCode ?? 'unknown'}`)
    const turn = thread.turn
    if (!turn) return
    // The crash rule: open tools end interrupted once, waiting delegations reject.
    for (const [callId, tool] of turn.openTools)
      turn.sink.tool({ kind: tool.mousse ? 'mcp_tool_call' : 'build_tool_result', phase: 'complete', callId, title: `Tool ${tool.name}`, summary: 'Interrupted: the agent stopped.', details: [] })
    turn.openTools.clear()
    turn.episode.revoke()
    // A cut waiting for its settlement ends here: the process that would settle is gone, and its steers come back below.
    turn.opGen += 1
    turn.cut?.barrier?.()
    turn.gateRelease.abort()
    turn.wake()
    this.returnSteers(turn)
    if (turn.phase === 'stopping' || turn.input.signal.aborted) turn.settled()
    else if (thread.fatal) turn.failed(protocolError(this.options.instanceId, `${this.options.label} could not register its providers, so the turn was stopped before any request.`))
    else turn.failed(interruptedError(`${this.options.label} stopped unexpectedly during the turn (exit code ${child?.exitCode ?? 'none'}${child?.signalCode ? `, ${child.signalCode}` : ''}).`))
  }

  /**
   * After Pi's death: the shell groups it reported (POSIX), the descendants recorded as a backup,
   * and on Windows the orphans found by their parent id (only after an unexpected death).
   */
  private async sweep(thread: PiThreadProcess, pid: number, unexpected: boolean): Promise<void> {
    try {
      await this.options.sweepHook?.()
      await Promise.all([
        thread.groups.kill(),
        unexpected ? killOrphans(pid, thread.startedAt) : undefined,
        unexpected ? thread.descendants?.killRecorded() : undefined
      ])
    } catch {
      // Best effort.
    }
  }

  /** The process and everything holding its output are gone. */
  private closed(thread: PiThreadProcess, exit: PiRpcExit): void {
    thread.exit = exit
    this.died(thread)
    // Tracking ends with `thread.closed` (the pipes and the orphan sweep), not here.
    thread.turn?.episode.crashed()
  }

  private event(thread: PiThreadProcess, event: PiRpcEvent): void {
    if (event.type === 'extension_ui_request') {
      // Every dialog is cancelled; fire-and-forget requests need no answer.
      if (['select', 'confirm', 'input', 'editor'].includes(String(event.method)))
        thread.process?.client.respond({ type: 'extension_ui_response', id: String(event.id), cancelled: true })
      return
    }
    if (event.type === 'extension_error') {
      // A provider registration that failed at bind left a built-in unguarded: fatal before any prompt.
      if (event.event === 'register_provider') {
        thread.fail(`register_provider: ${String(event.error)}`)
        void this.kill(thread)
      }
      return
    }
    const turn = thread.turn
    if (!turn) return
    this.turnEvent(thread, turn, event)
    // A cut waiting on Pi's state looks again.
    turn.wake()
  }

  private turnEvent(thread: PiThreadProcess, turn: PiTurn, event: PiRpcEvent): void {
    const { sink } = turn
    switch (event.type) {
      case 'turn_start':
        turn.piPhase = 'running'
        // A step's leftovers never outlive it: a missed end event would hold a steer for the rest of the turn.
        turn.stepTools = false
        this.compactionOver(turn)
        // A cut keeps its phase until its continuation is accepted; a retry's next attempt runs again.
        if (turn.phase !== 'stopping' && turn.phase !== 'cutting') turn.phase = 'running'
        // Pi's next request is on its way: a steer from here cuts it rather than wait for the step after it.
        if (turn.ctl.peekSteer) sink.boundary?.(false)
        if (turn.awaitingModel) {
          turn.awaitingModel = false
          sink.status?.('waiting')
        }
        return
      case 'turn_end': {
        turn.stepTools = false
        // The batch is over: a call Pi never started (an abort stops the rest of a batch) will not run.
        this.closeUnstarted(turn)
        // Pi now takes a steer from its queue for the next step and shows it once that step is prepared. A failed
        // attempt's end is not a step: Pi retries the request.
        if (turn.pendingError === undefined) turn.stepGap = true
        // Steers Mousse holds join the live turn at its next step. During a cut nothing new is sent to Pi.
        if (turn.phase !== 'running') return
        // On the hold, Pi's step boundary: a held steer goes in natively, with no cut (§2.2). A failed attempt's end
        // is not one: Pi retries the request, and a person's steer cuts the backoff.
        const onHold = turn.ctl.peekSteer !== undefined
        if (onHold && turn.pendingError !== undefined) return
        if (onHold) sink.boundary?.()
        const entry = onHold ? turn.ctl.drainSteerEntry?.({ expect: 'native' }) : turn.ctl.drainSteerEntry?.()
        // Off the hold a steer keeps Pi's next-step path whoever sent it: it never cuts.
        if (entry) this.sendNativeSteer(thread, turn, { text: entry.text, token: entry.token, person: onHold && entry.cut === true, state: 'sending' })
        return
      }
      case 'message_start': {
        const message = event.message as { role?: string }
        if (message?.role === 'assistant') {
          turn.text = new Map()
          turn.thinking = ''
          turn.replyOpen = true
          // Pi showed what it took from its queue for this step (it does so before the request).
          turn.stepGap = false
          // A reply that starts while a person's steer is still unread: Pi will not read it before this reply ends.
          for (const steer of turn.steers) if (steer.state === 'sending' || steer.state === 'queued') steer.replyStarted = true
          this.releaseCheck(thread, turn)
        } else if (message?.role === 'user' && turn.steers.length) {
          // Pi reads its queue in order, one user message per steer. Exact text, oldest first. A steer a cut holds is
          // matched only while Pi may still show it (`cleared`); the continuation prompt is matched by its own response,
          // not by its text.
          const text = textOf(message).trim()
          const steer = turn.steers.find((entry) => (entry.state === 'sending' || entry.state === 'queued' || (entry.state === 'cutHeld' && entry.cleared === true)) && entry.text.trim() === text)
          if (steer) this.steerRead(turn, steer)
        }
        return
      }
      case 'message_update':
        return this.streamUpdate(turn, event.assistantMessageEvent as { type: string; contentIndex: number; delta?: string; content?: string } | undefined)
      case 'message_end': {
        const message = event.message as { role?: string; content?: unknown; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number; cost?: { total?: number } }; stopReason?: string; errorMessage?: string }
        if (message?.role !== 'assistant') return
        turn.replyOpen = false
        // Every attempt's usage, failed ones included: they can be billable.
        const usage = message.usage ?? {}
        const reported = { input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0 }
        // Pi's own price of the request, from the catalogue Mousse registered.
        const cost = usage.cost?.total
        if (reported.input || reported.output || reported.cacheRead || reported.cacheWrite) {
          sink.usage({ ...reported, ...(typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? { costUsd: cost } : {}) })
          turn.usage = { input: turn.usage.input + reported.input, output: turn.usage.output + reported.output, cacheRead: turn.usage.cacheRead + reported.cacheRead, cacheWrite: turn.usage.cacheWrite + reported.cacheWrite }
          // A lifetime only where pi reports the one-hour share (its Anthropic transport): the rest of a write
          // is then the default five minutes. Other providers say nothing of a lifetime.
          const oneHour = usage.cacheWrite1h
          const ttlMs = typeof oneHour === 'number' ? writtenCacheTtl({ oneHour, fiveMinute: reported.cacheWrite - oneHour }) : undefined
          turn.promptCache = { at: Date.now(), ttlMs: longerTtl(turn.promptCache.ttlMs, ttlMs) }
        }
        if (message.stopReason === 'error') {
          turn.pendingError = message.errorMessage || 'The provider request failed'
          return
        }
        if (message.stopReason === 'aborted') {
          // A steer's cut: what was shown stays as written, above the Steer block, and the continuation opens a new
          // segment (§3.2 step 3). Only the words shown: what Pi received but never streamed stays out. A Stop keeps
          // the partial reply as it is.
          if (turn.phase === 'cutting') {
            const shown = [...turn.text.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join('')
            if (shown.trim()) turn.texts.push(shown)
            turn.text = new Map()
            turn.reply.break()
          }
          return
        }
        turn.pendingError = undefined
        const text = textOf(message)
        if (text.trim()) turn.texts.push(text)
        // Counted once: the message's blocks are in `texts` now.
        turn.text = new Map()
        // The calls this message ends with are announced: Pi runs them next, and a person's steer waits for them.
        const calls = toolCallsOf(message)
        if (calls.length) turn.stepTools = true
        for (const call of calls) this.toolStarted(thread, turn, call.id, call.name, call.arguments, true)
        return
      }
      case 'tool_execution_start': {
        void thread.descendants?.snapshot()
        void thread.groups.refresh().catch(() => {})
        this.toolStarted(thread, turn, String(event.toolCallId), String(event.toolName), event.args, false)
        return
      }
      case 'tool_execution_update':
        void thread.descendants?.snapshot()
        void thread.groups.refresh().catch(() => {})
        turn.ctl.heartbeat()
        return
      case 'tool_execution_end': {
        const callId = String(event.toolCallId)
        const name = String(event.toolName)
        const open = turn.openTools.get(callId)
        turn.openTools.delete(callId)
        turn.announced.delete(callId)
        turn.episode.ended(callId)
        const failed = event.isError === true
        const row = turn.ledgerRows.get(callId)
        if (row) {
          turn.ledgerRows.delete(callId)
          if (failed) turn.host.tools.toolLedger?.failed(row)
          else turn.host.tools.toolLedger?.commit(row)
        }
        sink.tool({
          kind: open?.mousse ? 'mcp_tool_call' : 'build_tool_result',
          phase: 'complete',
          callId,
          title: `Tool ${name}`,
          summary: failed ? 'The tool returned an error.' : 'The tool returned successfully.',
          details: [`Tool: ${name}`],
          response: textOf(event.result).slice(0, 4000)
        })
        if (!failed && (name === 'edit' || name === 'write')) {
          const args = (event.args ?? {}) as { content?: string; newText?: string; edits?: Array<{ newText?: string }> }
          const lines = name === 'write' ? linesOf(args.content) : linesOf(args.newText) + (args.edits ?? []).reduce((sum, edit) => sum + linesOf(edit.newText), 0)
          if (lines) sink.lineEdits(lines)
        }
        return
      }
      case 'auto_retry_start':
        // The failed attempt's partial text is not part of the reply.
        turn.text = new Map()
        // Pi dropped the failed attempt from its context; its partial output is superseded.
        turn.pendingError = undefined
        turn.maxRetries = Number(event.maxAttempts) || turn.maxRetries
        turn.piPhase = 'retrying'
        if (turn.phase === 'running' || turn.phase === 'ending') turn.phase = 'retrying'
        if (turn.ctl.peekSteer) sink.boundary?.(false)
        sink.retry(Number(event.attempt) || 1, {
          ...(turn.maxRetries ? { maxAttempts: turn.maxRetries } : {}),
          ...(Number.isFinite(Number(event.delayMs)) && event.delayMs !== undefined ? { delayMs: Number(event.delayMs) } : {})
        })
        return
      case 'auto_retry_end': {
        if (event.success === true || turn.phase === 'stopping' || event.finalError === 'Retry cancelled') return
        // Exhausted only when the last attempt was the last allowed one; a later attempt that failed
        // for another reason (a refusal, an auth error) keeps its own classification.
        if (!turn.maxRetries || (Number(event.attempt) || 0) < turn.maxRetries) return
        if (!isRetryableAssistantError({ stopReason: 'error', errorMessage: String(event.finalError ?? '') } as Parameters<typeof isRetryableAssistantError>[0])) return
        const cause = new Error(String(event.finalError ?? 'The provider request failed'))
        const normalized = normalizeProviderError(cause, this.options.provider)
        turn.retryExhaustedError = new AppError({
          code: normalized.code,
          message: normalized.message,
          errorInfo: normalized.errorInfo,
          details: { ...((normalized.details as Record<string, unknown> | undefined) ?? {}), retriesExhausted: true }
        }, cause)
        return
      }
      case 'compaction_start':
        turn.compacting = true
        // Pi compacts while it prepares its next request: the step boundary is over, and a person's steer waits for the
        // compaction ("Waits for compaction", with Send now) instead of going in natively.
        if (turn.ctl.peekSteer) sink.boundary?.(false)
        sink.compaction('start')
        return
      case 'compaction_end': {
        turn.compacting = false
        // A summary request Mousse refused (or could not be asked about) fails the compaction only.
        const failure = typeof event.errorMessage === 'string' ? event.errorMessage : ''
        const refusal = [BUDGET_EXHAUSTED, REQUEST_REFUSED, GATE_UNAVAILABLE, SPEND_CAP_MISMATCH].find((text) => failure.includes(text))
        if (refusal) turn.refusal ??= refusal
        sink.compaction(event.result ? 'complete' : 'unchanged')
        return
      }
      case 'agent_end':
        turn.piPhase = 'ending'
        // Pi took nothing from its queue for another step: it would have run it.
        turn.stepGap = false
        if (turn.phase === 'running') turn.phase = 'ending'
        return
      case 'agent_settled':
        turn.stepGap = false
        turn.stepTools = false
        this.compactionOver(turn)
        // A turn being stopped is settled by its Stop, once it has handed back what the turn holds: Pi settles before
        // it answers Stop's `abort`.
        if (turn.phase === 'stopping') return turn.stopping ? undefined : turn.settled()
        if (turn.phase === 'cutting' && turn.cut) {
          const cut = turn.cut
          // The settlement barrier: the first `agent_settled` after the abort was written. Several `agent_end`s (a
          // retry's) may come before it; only this one says the aborted prompt is over.
          if (cut.barrier) {
            const release = cut.barrier
            cut.barrier = undefined
            return release()
          }
          // The continuation settled before its `prompt` was answered: the turn settles once it is.
          if (cut.stage === 'continuing') {
            cut.deferredSettle = true
            return
          }
          // Pi finished the prompt on its own while the cut cleared its queue: there is nothing left to abort.
          cut.settled = true
          return
        }
        return this.settle(thread, turn)
      default:
        return
    }
  }

  /**
   * The prompt settled (not stopped, not cut). A steer sent at the last `turn_end` that Pi never read would stay in
   * Pi's queue and reach the model at the next prompt, while Mousse also runs it as a turn of its own: Pi's queue is
   * emptied first (#368). The turn ends whatever the hand-back does: a steer not handed back keeps its row
   * `steering`, and the step before the next claim (`returnOrphanedSteers`) runs it once.
   */
  private settle(thread: PiThreadProcess, turn: PiTurn): void {
    // Pi is idle: no cut starts, and one on the lane acts no more (an abort now would reach an idle Pi and never settle).
    if (turn.phase !== 'stopping') turn.phase = 'ending'
    turn.piPhase = 'ending'
    turn.opGen += 1
    turn.wake()
    if (turn.steers.length || turn.steerSends.size) {
      void this.returnUnreadAtEnd(thread, turn)
        .catch((error: unknown) => this.handBackFailed(thread, error))
        // A Stop that came meanwhile settles the turn itself, once it has handed back what the turn holds.
        .finally(() => { if (!turn.stopping) this.endTurn(turn) })
      return
    }
    return this.endTurn(turn)
  }

  /**
   * The step's `turn_end`: Pi has run its batch. A call it announced and never started (an abort stops the rest of a
   * batch, `pi-agent-core` `executeToolCalls`) gets no start or end event of its own: its row closes here, so it holds
   * no steer for the rest of the turn.
   */
  private closeUnstarted(turn: PiTurn): void {
    for (const callId of turn.announced) {
      const tool = turn.openTools.get(callId)
      turn.openTools.delete(callId)
      if (tool) turn.sink.tool({ kind: tool.mousse ? 'mcp_tool_call' : 'build_tool_result', phase: 'complete', callId, title: `Tool ${tool.name}`, summary: 'Not run: the agent stopped before this call started.', details: [`Tool: ${tool.name}`] })
    }
    turn.announced.clear()
  }

  /** A compaction whose end never came is over (a new step started, or the prompt settled): a steer waits no more. */
  private compactionOver(turn: PiTurn): void {
    if (!turn.compacting) return
    turn.compacting = false
    turn.sink.compaction('unchanged')
  }

  /**
   * A tool call starts: announced at the end of the assistant message that holds it (`announced`), or run
   * (`tool_execution_start`). Its row opens once, at the first of the two, so a person's steer waits from there.
   */
  private toolStarted(thread: PiThreadProcess, turn: PiTurn, callId: string, name: string, args: unknown, announced: boolean): void {
    const mousse = !Object.hasOwn(BUILTIN_CLASSES, name)
    if (!announced) {
      turn.progress()
      turn.announced.delete(callId)
    }
    if (turn.openTools.has(callId)) return
    if (announced) turn.announced.add(callId)
    turn.openTools.set(callId, { name, mousse })
    // A note that came before this call keeps its own row, above it; the next one starts below.
    turn.reply.break()
    turn.sink.tool({
      kind: mousse ? 'mcp_tool_call' : 'build_tool_call',
      phase: 'start',
      callId,
      title: `Tool ${name}`,
      summary: mousse ? name : 'Called a local project tool (Pi coding agent).',
      details: [`Tool: ${name}`],
      response: JSON.stringify(args ?? {}, null, 2)
    })
  }

  // -- Steers (docs/design/steer-and-interruptions.md §3.2) ---------------------------------------

  /** Pi read `steer` from its queue (its user message): taken and accepted by its own token, once. */
  private steerRead(turn: PiTurn, steer: PiSteer): void {
    turn.steers.splice(turn.steers.indexOf(steer), 1)
    turn.ctl.steerTaken?.(steer.token)
    turn.sink.steerAccepted(steer.text, steer.token)
  }

  /** A native `steer` (Pi's next step reads it). Its answer moves it to `queued` and checks the release condition. */
  private sendNativeSteer(thread: PiThreadProcess, turn: PiTurn, steer: PiSteer): void {
    turn.steers.push(steer)
    turn.awaitingModel = true
    // A leading `/` would be expanded by Pi (a skill or prompt template), and the text it shows would match no steer.
    const message = steer.text.startsWith('/') ? ` ${steer.text}` : steer.text
    const sending: Promise<void> = this.send(thread, { type: 'steer', message }).then(() => {
      // Applied whatever the generation: a steer Pi read meanwhile stays taken, one still `sending` is queued now.
      if (steer.state === 'sending' && turn.steers.includes(steer)) steer.state = 'queued'
      this.releaseCheck(thread, turn)
    }, () => {
      const index = turn.steers.indexOf(steer)
      if (index < 0) return
      turn.steers.splice(index, 1)
      // A hand-back that fails leaves the steer's row `steering`: the step before the next claim runs it.
      try {
        turn.ctl.returnSteer?.(steer.text, steer.token)
      } catch (error) {
        this.handBackFailed(thread, error)
      }
    }).finally(() => turn.steerSends.delete(sending))
    turn.steerSends.add(sending)
  }

  /**
   * The release condition (§3.2, "Release at `turn_end`"): while an assistant reply that started after the native
   * send is open, and a person's steer from that send is `sending` or `queued`, Pi will not read it before the reply
   * ends, so the cut runs for it. Checked at the reply's start and when the native send is answered.
   */
  private releaseCheck(thread: PiThreadProcess, turn: PiTurn): void {
    if (turn.phase !== 'running' || !turn.replyOpen || !thread.alive) return
    if (!turn.steers.some((steer) => steer.person && steer.replyStarted && (steer.state === 'sending' || steer.state === 'queued'))) return
    this.startCut(thread, turn)
  }

  /**
   * The turn's poll on the hold: what a drain now would do. A person's steer while Pi writes, thinks or waits to
   * retry cuts in; while a tool is announced or runs it is held (the orchestrator shows what it waits for); while Pi
   * compacts it waits for the compaction, which a steer never stops. An agent's steer waits for Pi's next step.
   */
  private pollSteer(thread: PiThreadProcess, turn: PiTurn): void {
    const ctl = turn.ctl
    if (!ctl.peekSteer || !thread.alive || thread.turn !== turn) return
    if (turn.phase !== 'running' && turn.phase !== 'retrying') return
    const peek = ctl.peekSteer()
    if (peek?.delivery !== 'cut' || turn.compacting) return
    // The step's tools have their results and its `turn_end` is a moment away: the steer goes in natively there.
    if (turn.stepTools && turn.openTools.size === 0) return
    const entry = ctl.drainSteerEntry?.({ expect: 'cut' })
    if (!entry) return
    this.startCut(thread, turn, { text: entry.text, token: entry.token, person: entry.cut !== false, state: 'cutHeld' })
  }

  /** Starts a cut (§3.2 step 1): from here no native steer is sent, and the lane runs its steps. */
  private startCut(thread: PiThreadProcess, turn: PiTurn, held?: PiSteer): void {
    turn.phase = 'cutting'
    turn.opGen += 1
    const cut: PiCut = { gen: turn.opGen, stage: 'clearing', settled: false, deferredSettle: false }
    turn.cut = cut
    if (held) turn.steers.push(held)
    turn.lane = turn.lane.then(() => this.runCut(thread, turn, cut)).catch((error: unknown) => {
      logWarn('PiRpcEngine', 'a steer cut failed', error, { instanceId: this.options.instanceId, threadId: thread.threadId })
    })
  }

  /** The cut's steps on the lane (§3.2 step 2). Each wait ends at a Stop or a crash, which hand its steers back. */
  private async runCut(thread: PiThreadProcess, turn: PiTurn, cut: PiCut): Promise<void> {
    const current = () => turn.opGen === cut.gen && turn.phase === 'cutting' && thread.turn === turn && thread.alive && !thread.killed
    const held = () => turn.steers.filter((steer) => steer.state === 'cutHeld')
    /** Nothing to abort: Pi settled on its own, or it is past its run (`agent_end`), where only a compaction can run. */
    const over = () => cut.settled || turn.piPhase === 'ending'
    // 2.1 A native steer still unanswered is answered first, so it cannot be queued behind `clear_queue`.
    await this.steerSendsAnswered(turn)
    if (!current()) return
    // Pi read every steer this cut was for meanwhile, or it has nothing left to cut: no abort.
    if (over() || (!held().length && !turn.steers.some((steer) => steer.person && steer.state === 'queued'))) return this.endCutWithoutAbort(thread, turn, cut)
    // 2.2 Pi's queue comes out, in order. An abort does not empty it (spike S3).
    let cleared: { steering: string[]; followUp: string[] } | undefined
    try {
      cleared = await this.send<{ steering: string[]; followUp: string[] }>(thread, { type: 'clear_queue' })
    } catch {
      // Its deadline killed Pi: the crash hands every steer back.
      return
    }
    // Applied whatever the generation: a Stop hands back what the cut now holds.
    this.moveCleared(turn, cleared)
    if (!current()) return
    // Pi may have taken a steer out of its queue at the step's end and show it once the next step is prepared (a
    // compaction can come first), and Pi's abort stops a compaction: the abort waits until Pi's next request starts
    // (or the prompt ends) and no compaction runs. A steer Pi shows meanwhile is taken (`cleared`), not carried twice.
    await this.until(turn, () => !current() || over() || (!turn.stepGap && !turn.compacting))
    if (!current()) return
    if (over() || !held().length) return this.endCutWithoutAbort(thread, turn, cut)
    // 2.3 The check at dispatch: a tool announced meanwhile holds the steer again, in the same hold.
    const ctl = turn.ctl
    if (ctl.mayCut && !held().some((steer) => ctl.mayCut!(steer.token))) return this.endCutWithoutAbort(thread, turn, cut)
    // 2.4–2.5 `abort`, then the settlement barrier, within one deadline together.
    const deadlineMs = this.options.interruptDeadlineMs ?? INTERRUPT_DEADLINE_MS
    cut.stage = 'aborting'
    // Pi's abort waits for the gate: the steer answers what the turn asks the person, and a writer wait lets go.
    this.releaseGate(turn, held().some((steer) => steer.person))
    const settled = new Promise<void>((resolve) => { cut.barrier = resolve })
    const aborted = this.send(thread, { type: 'abort' }, deadlineMs + COMMAND_DEADLINE_MS).catch(() => undefined)
    const inTime = await new Promise<boolean>((resolve) => {
      const done = (value: boolean) => {
        clearTimeout(timer)
        turn.halt.signal.removeEventListener('abort', halted)
        resolve(value)
      }
      // A Stop does not wait for this abort: it sends its own.
      const halted = () => done(true)
      const timer = setTimeout(() => done(false), deadlineMs)
      timer.unref?.()
      turn.halt.signal.addEventListener('abort', halted, { once: true })
      void Promise.all([aborted, settled]).then(() => done(true))
    })
    if (!current()) return
    if (!inTime) return this.cutTimedOut(thread, turn)
    // After the barrier nothing of the aborted prompt is left: a steer still `queued` was taken out of Pi's queue
    // and never shown, so the continuation carries it; nothing held can be shown by Pi any more.
    for (const steer of turn.steers) {
      if (steer.state === 'queued') steer.state = 'cutHeld'
      steer.cleared = false
    }
    // Steers sent during the cut join its continuation: cut on their own, they would only abort it.
    this.joinCutSteers(turn)
    const texts = held()
    if (!texts.length) {
      // Pi showed every steer before its prompt ended: the turn ends with what it has, and nothing goes in twice.
      turn.cut = undefined
      return this.settle(thread, turn)
    }
    // 2.6 The continuation, in the same process and session. Its calls pass the gate again.
    cut.stage = 'continuing'
    turn.awaitingModel = true
    turn.gateRelease = new AbortController()
    let message = texts.map((steer) => steer.text.trim()).join('\n')
    if (message.startsWith('/')) message = ` ${message}`
    // Its answer is kept on the cut: a Stop meanwhile waits for it, since Pi keeps an accepted prompt in its session.
    const answer = this.send(thread, { type: 'prompt', message }, this.options.promptDeadlineMs ?? PI_PROMPT_DEADLINE_MS).then(() => 'started' as const, () => 'refused' as const)
    cut.continuation = answer
    cut.carried = texts
    const halted = new Promise<'halted'>((resolve) => {
      if (turn.halt.signal.aborted) resolve('halted')
      else turn.halt.signal.addEventListener('abort', () => resolve('halted'), { once: true })
    })
    const outcome = await Promise.race([answer, halted])
    if (!current()) return
    if (outcome === 'refused') {
      // Refused: the steers come back and run as the next turn; the turn ends with what it has.
      turn.cut = undefined
      this.returnSteers(turn, 'cutHeld')
      return this.settle(thread, turn)
    }
    // 4. Accepted: each steer is taken and accepted by its own token.
    for (const steer of texts) if (turn.steers.includes(steer)) this.steerRead(turn, steer)
    turn.cut = undefined
    turn.phase = 'running'
    turn.piPhase = 'running'
    if (cut.deferredSettle) this.settle(thread, turn)
  }

  /**
   * A cut ends with no abort: what it still holds goes back to the orchestrator (the hold resumes, or after Pi's
   * `agent_end` it runs as the next turn), the turn goes back to where Pi is (`piPhase`), and a prompt that settled
   * during the cut settles the turn now.
   */
  private endCutWithoutAbort(thread: PiThreadProcess, turn: PiTurn, cut: PiCut): void {
    if (turn.cut === cut) turn.cut = undefined
    if (turn.phase === 'cutting') turn.phase = turn.piPhase
    for (const steer of turn.steers) steer.cleared = false
    this.returnSteers(turn, 'cutHeld')
    if (cut.settled) this.settle(thread, turn)
  }

  /** Person's steers that came while the cut ran, drained for its continuation (one drain joins them all). */
  private joinCutSteers(turn: PiTurn): void {
    const ctl = turn.ctl
    for (let round = 0; round < 4 && ctl.peekSteer?.()?.delivery === 'cut'; round += 1) {
      const entry = ctl.drainSteerEntry?.({ expect: 'cut' })
      if (!entry) return
      turn.steers.push({ text: entry.text, token: entry.token, person: entry.cut !== false, state: 'cutHeld' })
    }
  }

  /**
   * The gate lets go of every call of the prompt being aborted: Pi's abort waits for the gate. `answer`: a person's
   * steer answers the questions the turn asks them, as the person (docs/design/steer-and-interruptions.md §2.1).
   */
  private releaseGate(turn: PiTurn, answer: boolean): void {
    // Every question pending on the thread, Mousse's own (`ask_user`, a quick action's approval) as well as Pi's, as
    // a steer on the other agents does (§2.1).
    if (answer) {
      try {
        turn.host.bridge?.permission?.rejectPending?.(turn.input.threadId)
      } catch (error) {
        logWarn('PiRpcEngine', 'a pending approval could not be answered for a steer', error, { instanceId: this.options.instanceId, threadId: turn.input.threadId })
      }
    }
    turn.gateRelease.abort()
  }

  /** Resolves once `ready()` holds, checked after each Pi event, a Stop and a crash (and at once). */
  private until(turn: PiTurn, ready: () => boolean): Promise<void> {
    if (ready() || turn.halt.signal.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const check = () => {
        if (!ready() && !turn.halt.signal.aborted) return
        turn.wakers.delete(check)
        resolve()
      }
      turn.wakers.add(check)
    })
  }

  /**
   * `clear_queue`'s steers move to the cut, oldest first; a text that matches none goes back as text, so nothing is
   * dropped. Pi may still show one it took out of its queue at the step's end (`cleared`).
   */
  private moveCleared(turn: PiTurn, cleared: { steering: string[]; followUp: string[] } | undefined): void {
    for (const text of [...(cleared?.steering ?? []), ...(cleared?.followUp ?? [])]) {
      const steer = turn.steers.find((entry) => entry.state === 'queued' && entry.text.trim() === text.trim())
      if (steer) {
        steer.state = 'cutHeld'
        steer.cleared = true
      } else turn.ctl.returnSteer?.(text)
    }
  }

  /** The abort or its settlement missed the deadline: the steers come back and the turn ends as a Stop would. */
  private async cutTimedOut(thread: PiThreadProcess, turn: PiTurn): Promise<void> {
    turn.phase = 'stopping'
    turn.cut = undefined
    this.returnSteers(turn)
    await within(this.kill(thread), CLEANUP_DEADLINE_MS)
    turn.settled()
  }

  /** The prompt settled (not stopped): the turn ends as Mousse's own record of it says. */
  private endTurn(turn: PiTurn): void {
    // Mousse's own record decides: a refused step ends the turn, whatever Pi made of it.
    if (turn.refusal) return turn.failed(this.requestError(turn.refusal, turn))
    if (turn.pendingError && this.mousseRefusal(turn.pendingError)) return turn.failed(this.requestError(turn.pendingError, turn))
    if (turn.retryExhaustedError) return turn.failed(turn.retryExhaustedError)
    if (turn.pendingError) return turn.failed(this.requestError(turn.pendingError, turn))
    return turn.settled()
  }

  /**
   * The turn's end with steers Pi was sent and never read (#368): wait for any native `steer` still unanswered, then
   * `clear_queue`, and hand back once each steer it returns and each one still held, as Stop does. Each then runs
   * once, as the next turn, and Pi's queue holds nothing. A `clear_queue` that fails killed Pi on its deadline, and
   * its queue with it: the steers are handed back all the same.
   */
  private async returnUnreadAtEnd(thread: PiThreadProcess, turn: PiTurn): Promise<void> {
    await this.steerSendsAnswered(turn)
    // A Stop meanwhile hands them back itself, once the same steer sends are answered.
    if (!turn.steers.length || turn.phase === 'stopping') return
    // A steer send past its deadline killed Pi, and its queue went with it: nothing goes to the dying process, the
    // steers come back, and the reply Pi finished stands.
    if (thread.killed || !thread.alive) return this.returnSteers(turn)
    let cleared: { steering: string[]; followUp: string[] } | undefined
    try {
      cleared = await this.send<{ steering: string[]; followUp: string[] }>(thread, { type: 'clear_queue' })
    } catch {
      // Handed back below.
    }
    this.returnCleared(turn, cleared)
    // Pi neither showed nor returned them: it does not have them.
    this.returnSteers(turn)
  }

  /** Waits until every native `steer` the turn sent is answered or failed; each is bounded by the command deadline. */
  private async steerSendsAnswered(turn: PiTurn): Promise<void> {
    while (turn.steerSends.size) await Promise.allSettled([...turn.steerSends])
  }

  /** Hands back, once, each steer `clear_queue` took out of Pi's queue. */
  private returnCleared(turn: PiTurn, cleared: { steering: string[]; followUp: string[] } | undefined): void {
    for (const text of [...(cleared?.steering ?? []), ...(cleared?.followUp ?? [])]) {
      // A steer a cut holds is not in Pi's queue: only one Pi was sent can come out of it.
      const index = turn.steers.findIndex((steer) => steer.state !== 'cutHeld' && steer.text.trim() === text.trim())
      const steer = index >= 0 ? turn.steers.splice(index, 1)[0] : undefined
      turn.ctl.returnSteer?.(text, steer?.token)
    }
  }

  /** A steer hand-back threw: its row stays `steering`, and the step before the next claim runs it once. */
  private handBackFailed(thread: PiThreadProcess, error: unknown): void {
    logWarn('PiRpcEngine', 'a steer could not be handed back; it runs before the next queued message', error, { instanceId: this.options.instanceId, threadId: thread.threadId })
  }

  private streamUpdate(turn: PiTurn, update: { type: string; contentIndex: number; delta?: string; content?: string } | undefined): void {
    if (!update) return
    const { sink } = turn
    turn.progress()
    switch (update.type) {
      // The reply is every step's text, joined; a tool call closes its row (see `tool_execution_start`).
      case 'text_start':
        turn.text.set(update.contentIndex, '')
        return turn.reply.update(turn.replyText())
      case 'text_delta':
        turn.text.set(update.contentIndex, `${turn.text.get(update.contentIndex) ?? ''}${update.delta ?? ''}`)
        return turn.reply.update(turn.replyText())
      case 'text_end':
        turn.text.set(update.contentIndex, update.content ?? turn.text.get(update.contentIndex) ?? '')
        return turn.reply.update(turn.replyText())
      case 'thinking_start':
        turn.thinking = ''
        return sink.thinking({ phase: 'start', content: '' })
      case 'thinking_delta':
        turn.thinking += update.delta ?? ''
        return sink.thinking({ phase: 'delta', content: turn.thinking })
      case 'thinking_end':
        turn.thinking = update.content ?? turn.thinking
        return sink.thinking({ phase: 'complete', content: turn.thinking })
      default:
        return
    }
  }

  private mousseRefusal(message: string): boolean {
    return [ANTHROPIC_OAUTH_REFUSED, CREDENTIAL_UNAVAILABLE, BUDGET_EXHAUSTED, REQUEST_REFUSED, GATE_UNAVAILABLE, SPEND_CAP_MISMATCH].some((text) => message.includes(text))
  }

  /**
   * A failed request's error: Mousse's own refusals by kind, anything else as a provider error. A
   * budget refusal names the limit from the run's counter record, never from Pi's text.
   */
  private requestError(message: string, turn: PiTurn): Error {
    if (message.includes(BUDGET_EXHAUSTED)) {
      const limit = turn.host.budget?.exhausted
      const text = turn.host.budget?.lost
        ? "This run's earlier usage is no longer known (Mousse restarted, or the run had already ended), so it cannot continue under its limits."
        : limitMessage(limit, turn.host.budget?.overshoot)
      return harnessAppError({ code: 'budget_exhausted', message: text, ...(limit ? { limit } : {}), instanceId: this.options.instanceId })
    }
    if (message.includes(SPEND_CAP_MISMATCH))
      return protocolError(this.options.instanceId, `${this.options.label} built a model request whose output cap did not match its reservation, so nothing was sent.`)
    if (message.includes(REQUEST_REFUSED) || message.includes(GATE_UNAVAILABLE))
      return protocolError(this.options.instanceId, `${this.options.label} could not get Mousse's approval for a model request, so nothing was sent.`)
    if (message.includes(ANTHROPIC_OAUTH_REFUSED))
      return harnessAppError({ code: 'auth_expired', message: `${this.options.label} will not send a Claude subscription credential. Use an Anthropic API key here, or Claude Code for a Claude subscription.`, instanceId: this.options.instanceId })
    if (message.includes(CREDENTIAL_UNAVAILABLE))
      return harnessAppError({ code: 'signed_out', message: `${this.options.label} has no usable credential. Sign in again from Providers.`, instanceId: this.options.instanceId })
    return normalizeProviderError(new Error(message), this.options.provider)
  }
}
