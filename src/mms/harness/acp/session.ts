import { createHash, randomUUID } from 'node:crypto'
import { methods, RequestError, type NewSessionResponse } from '@agentclientprotocol/sdk'
import { ACTIVITY_DESCRIPTION_CHARS, capRecord, isAcpSubagentTool, type ActivityPatch, type ProviderToolEvent } from '../../../shared/agentActivity'
import { recordSubagentCall, subagentToolName, toolResultText } from '../../../shared/subagentTools'
import { classifyCuaCall, guardedInput, guardedOutput, guardedTitle, isGuardedCall, mousseToolOfName, USE_TOOL, useToolTargetOf } from '../../../shared/cuaActivity'
import type { PermissionMode } from '../../../shared/permissionMode'
import type { LlmModelOption } from '../../../shared/settings'
import type { ChatImageAttachment } from '../../../shared/types'
import { IMAGE_MAX_DATA_CHARS } from '../../../shared/imageLimits'
import type { UserQuestionService } from '../../orchestrator/UserQuestionService'
import { harnessAppError } from '../../../shared/harness/types'
import { compareVersions } from '../../../shared/net/version'
import type { ContinuationInfo, LiveProcessHost } from '../driver'
import { interruptWithDeadline, loadWithDeadline, SessionLoadTimeoutError } from '../supervise'
import { idleCloseFromEnv } from '../idleCloseFromEnv'
import { isAuthRequired } from './auth'
import { initializeAgent, sessionCapability, type AcpAgentInfo } from './capabilities'
import { ACP_TERMINAL_METHODS, closeAcpConnection, type AcpClientHandlers, type AcpConnection, type AcpConnectionFactory, type AcpPurpose } from './connection'
import { answerFormElicitation } from './elicitation'
import { LoadGate } from './loadGate'
import { sessionMcpServers } from './mcp'
import { mousseServerToolOf } from '../../run/mcp/attachment'
import type { McpAttachment } from '../../run/mcp/MousseMcpServer'
import { parseThinkingSuffixFromModelId } from '../../../shared/modelVariants'
import { AGENT_DEFAULT_MODEL, agentModels, agentModes, mergeModelOptions, modelOptions, planModeId, thoughtConfigOption, type ModelControl, type ThoughtConfig } from './models'
import {
  answerPermission,
  classifyGenericOption,
  questionsPrompter,
  readWorkspaceFile,
  writeWorkspaceFile,
  type AcpRequestScope,
  type ClassifyOption,
  type PermissionPrompter
} from './permissions'
import type { AcpQuirks } from './quirks'
import { answerBotPermission, checkBotFileRequest } from './botApprovals'
import type { BotAuthority } from '../../../shared/bots/personal/authority'
import { acpAgentError, acpQuotaReply, agentCancelledError, promptStopOutcome } from './stopReason'
import { xaiHandlers, xaiStopFailure } from './xai'

/** The title is generic on agy: its launch arguments name the role and describe the work. */
function subagentActivity(rawInput: unknown, title: string | undefined, background = false) {
  const args = rawInput && typeof rawInput === 'object' ? rawInput as Record<string, unknown> : {}
  const role = typeof args.Role === 'string' ? args.Role.trim() : ''
  const agentType = typeof args.TypeName === 'string' ? args.TypeName.trim().slice(0, ACTIVITY_DESCRIPTION_CHARS) : ''
  const prompt = typeof args.Prompt === 'string' ? args.Prompt.trim() : ''
  return {
    kind: 'subagent' as const,
    description: (role || title || 'Task').slice(0, ACTIVITY_DESCRIPTION_CHARS),
    ...(agentType ? { agentType } : {}),
    ...(prompt ? { prompt } : {}),
    ...(background ? { background: true as const } : {})
  }
}

/** Command activity for ACP shell tools (`run_command`), so backgrounded commands can settle in place. */
function commandActivity(rawInput: unknown, title: string | undefined) {
  const args = rawInput && typeof rawInput === 'object' ? rawInput as Record<string, unknown> : {}
  const raw = typeof args.CommandLine === 'string' ? args.CommandLine.trim()
    : typeof args.command === 'string' ? args.command.trim()
      : ''
  return {
    kind: 'command' as const,
    command: (raw || title || 'command').slice(0, 1000)
  }
}

/** The tool a bot's `use_tool` call runs, read from its arguments; undefined for any other call or before they arrive. */
function acpUseToolTarget(name: string | undefined, rawInput: unknown): string | undefined {
  return mousseToolOfName(name) === USE_TOOL ? useToolTargetOf(rawInput) : undefined
}

/**
 * A computer use call's event, held to what a transcript keeps (`src/shared/cuaActivity.ts`): a title Mousse writes,
 * and the allowlisted arguments and, once it `ended`, its bounded outcome. Undefined for any other call. A `use_tool`
 * whose arguments have not said which tool it runs keeps only the title.
 */
function acpCuaFields(
  name: string | undefined,
  rawInput: unknown,
  useToolTarget: string | undefined,
  ended?: { output?: string; failed: boolean }
): { title: string; activity?: ActivityPatch } | undefined {
  const call = classifyCuaCall(name, { input: rawInput, useToolTarget })
  if (!isGuardedCall(call)) return undefined
  const input = rawInput !== undefined ? guardedInput(call, rawInput) : undefined
  const output = ended ? guardedOutput(call, ended.output, ended.failed) : undefined
  const activity: ActivityPatch = { ...(input ? { input } : {}), ...(output !== undefined ? { output } : {}) }
  return { title: guardedTitle(call, input), ...(Object.keys(activity).length ? { activity } : {}) }
}

/**
 * A call's arguments as its row keeps them, bounded the way Claude's rows are (`capRecord`); undefined while there are
 * none (an agent may open a call with `{}` and send its arguments in a later update).
 */
function acpArgs(rawInput: unknown): Record<string, unknown> | undefined {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput) || Object.keys(rawInput).length === 0) return undefined
  return capRecord(rawInput as Record<string, unknown>)
}

function isDaemonCommand(rawInput: unknown): boolean {
  return Boolean(rawInput && typeof rawInput === 'object' && (rawInput as { IsDaemon?: unknown }).IsDaemon === true)
}

/** Extracts text from an ACP `tool_call_update`'s `rawOutput` or `content` blocks (for subagent call records and summaries). */
function extractToolOutputText(event: { rawOutput?: unknown; content?: unknown }): string | undefined {
  const { rawOutput, content } = event
  if (typeof rawOutput === 'string' && rawOutput.trim()) return rawOutput
  if (rawOutput && typeof rawOutput === 'object') {
    if (Array.isArray(rawOutput)) {
      const joined = toolResultText(rawOutput)
      if (joined) return joined
    } else {
      const obj = rawOutput as Record<string, unknown>
      if (Array.isArray(obj.content)) {
        const joined = toolResultText(obj.content)
        if (joined) return joined
      }
      if (typeof obj.delegationId === 'string' || typeof obj.childThreadId === 'string' || typeof obj.started === 'boolean') {
        try {
          return JSON.stringify(obj)
        } catch {
          // Ignore unserializable rawOutput
        }
      }
      for (const key of ['output', 'text', 'stdout', 'result', 'message'] as const) {
        if (typeof obj[key] === 'string' && (obj[key] as string).trim()) return obj[key] as string
      }
      try {
        return JSON.stringify(rawOutput)
      } catch {
        // Ignore unserializable rawOutput
      }
    }
  }
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as { type?: unknown; text?: unknown; content?: { type?: unknown; text?: unknown } }
      if (typeof b.text === 'string' && b.text) parts.push(b.text)
      else if (b.content && typeof b.content.text === 'string' && b.content.text) parts.push(b.content.text)
    }
    if (parts.length) return parts.join('')
  }
  return undefined
}

function extractToolSummary(event: { rawOutput?: unknown; content?: unknown }): string | undefined {
  const text = extractToolOutputText(event)
  if (!text) return undefined
  const line = text.replace(/\s+/g, ' ').trim()
  if (!line) return undefined
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
}

/** A background command or native subagent still running in the ACP process after a turn settled. */
interface AcpBackgroundTask {
  callId: string
  kind: 'command' | 'subagent'
  description: string
  startedAt: number
}

/** A reactive turn an ACP agent started on its own after background work completed. */
interface AcpContinuation {
  id: string
  info: ContinuationInfo
  buffer: Array<{ update: unknown; sessionId?: string }>
  claimed: boolean
  discarded: boolean
  settled: boolean
  attachWaiters: Array<() => void>
  done: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
  settleTimer?: ReturnType<typeof setTimeout>
  quietTimer?: ReturnType<typeof setTimeout>
  openTools: Map<string, string>
  sawText: boolean
  sawUsage: boolean
  modelMovedPastOpenTools: boolean
}

/** How long a reactive continuation waits after `usage_update` (with no open tools/requests) before settling. */
export const CONTINUATION_SETTLE_MS = 1_500
/** Fallback quiet window for a reactive continuation that wrote text without sending `usage_update`. */
export const CONTINUATION_QUIET_MS = 10_000
/** Grace window after a background task finishes waiting for the agent's reactive wakeup to begin. */
export const WAKE_GRACE_MS = 30_000
/** Safety cap so a forgotten or silent background task cannot hold Waiting forever. */
export const MAX_BACKGROUND_MS = 60 * 60_000
/**
 * How long a thread's agent process with no turn, background work or reactive continuation is kept before it is
 * closed. Its saved session stays, so the next turn starts a new process and reopens it. `MOUSSE_ACP_IDLE_CLOSE_MS` sets it.
 */
export const ACP_IDLE_CLOSE_MS = idleCloseFromEnv('MOUSSE_ACP_IDLE_CLOSE_MS', 15 * 60_000)

/** Out-of-turn session updates that indicate a reactive continuation turn has started. */
const CONTINUATION_START_UPDATES = new Set(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'plan'])

/**
 * The ACP session lifecycle shared by every ACP agent: one agent process per thread, kept between
 * turns while its saved session still matches the committed history, and closed after
 * {@link ACP_IDLE_CLOSE_MS} idle (the saved session stays for the next turn); `session/new`, or the saved
 * session reopened (resume, or load behind the load gate); the prompt loop with steer as
 * cancel-and-restart (or a second prompt into the running one, `steersNatively`); stop through the turn's signal or a native cancel.
 */

/** A connection the core opened, with the turn state it carries. */
export interface AcpProcess extends AcpConnection {
  sessionId?: string
  cwd?: string
  threadId?: string
  turnSignal?: AbortSignal
  /** Who answers the running turn's permission requests (its bridge's); the sessions' own otherwise. */
  turnPrompter?: PermissionPrompter
  /** The running turn's `onToolAwaiting`: a person is asked about a call. */
  turnToolAwaiting?: (callId: string, waiting: boolean) => void
  /** The permission mode of the turn running now, read per request; cleared when the turn ends. */
  permissionMode?: PermissionMode
  /** `initialize` advertised `mcpCapabilities.http`; otherwise the Mousse server goes through the stdio bridge. */
  mcpHttp?: boolean
  /** What `initialize` answered. */
  info?: AcpAgentInfo
  /** How the session's model is chosen. */
  modelControl?: ModelControl
  /** The session's `thought_level` select config option, when the active model offers one. */
  thoughtConfig?: ThoughtConfig
  /** The session's modes, the one it started in and the one it is in. */
  modes?: Array<{ id: string; name: string }>
  defaultModeId?: string
  currentModeId?: string
  /** The prompt request in flight, settled (either way) when it ends. */
  prompting?: Promise<void>
  /** Bearer token of the Mousse MCP server the session was opened with (null: none). */
  mcpToken?: string | null
  /** The MCP relay the session was opened with, `url|revision` (null: none). */
  relayKey?: string | null
  /** Provider instance whose turn opened the session. */
  instanceId?: string
  /** Hash of the session instructions the session was given (`orchestrationInstructions`). */
  instructionsHash?: string
  /** Launch-settings generation the process was started with; an older one is not reused. */
  generation: number
  /** Sign-in generation at launch; a process from before the latest sign-in cannot sign the profile out. */
  signInGeneration: number
  /**
   * Who waits for each tagged prompt's `prompt_complete` (`xaiExtensions`): one entry per prompt,
   * removed when that prompt settles, so a late completion of an earlier prompt touches nothing.
   */
  promptWaiters?: Map<string, (params: Record<string, unknown>) => void>
  /** Requests of the agent that Mousse is answering now (permission, questions, files): its silence is not counted meanwhile. */
  openRequests?: number
  /** Called when the agent shows a sign of life or such a request starts or ends (the running turn's silence timer). */
  activity?: () => void
  /** `interrupt` sent the running prompt a native cancel (cleared when the next prompt starts). */
  cancelRequested?: boolean
  /** Mousse ends this process after a stop (`interrupt`); its saved session stays resumable (`stoppedForResume`). */
  closedForResume?: boolean
  /** The slash commands the agent advertised (`available_commands_update`), without the slash. */
  commands?: Set<string>
  /** The agent answered a steer's second prompt with an error: its later steers are cut and restarted (`AcpQuirks.nativeSteerFrom`). */
  nativeSteerRefused?: boolean
  /**
   * Set on a one-shot's process (`AcpSessions.oneShot`): every request of the agent to use a tool (a permission, a
   * file read or write, a terminal, a question, an unknown request) is refused, and ends the request.
   */
  refuseTools?: (what: string) => void
  /** Settles once the process has ended (its factory's `onExit`). */
  exited?: Promise<void>
  /** Background commands/subagents still running in the agent process after a turn settled (`quirks.backgroundWork`). */
  backgroundTasks?: Map<string, AcpBackgroundTask>
  /** Background tasks that ended between turns before the reactive wakeup began. */
  recentlyEnded?: Array<{ taskId: string; description: string; summary?: string }>
  /** True once any background-capable call ran on this process, so late reactive wakeups are accepted. */
  mayWake?: boolean
  /** Grace timer holding `backgroundWork` briefly after a background command ends until wakeup starts. */
  wakeGraceTimer?: ReturnType<typeof setTimeout>
  /** Safety cap timer so background work never holds Waiting indefinitely. */
  backgroundCapTimer?: ReturnType<typeof setTimeout>
  /** Closes the process kept for its thread once it has been idle for `ACP_IDLE_CLOSE_MS`. */
  idleCloseTimer?: ReturnType<typeof setTimeout>
  /** Last value reported to `liveHost.backgroundWork(threadId, active)`. */
  reportedBackground?: boolean
  /** In-flight reactive continuation started by the agent between turns. */
  continuation?: AcpContinuation
  /** The running turn is a bot's: its authority answers every permission and file request, and nobody is asked. */
  turnBot?: Pick<BotAuthority, 'check'>
  botMcp?: AcpChatInput['mcp']
  /** An ACP permission request can refer to a tool by id alone. */
  botToolName?(callId: string): string | undefined
  /** What the bot's authority refused in the prompt running now, for the follow-up that tells the agent (`BOT_REFUSAL_FOLLOW_UPS`). */
  botRefusals?: string[]
}

/**
 * How many times one bot turn tells the agent what the bot's authority refused and lets it go on. Antigravity ends its
 * prompt after a denied request, with no reply; the follow-up names the refusal and asks it to finish the rest.
 */
export const BOT_REFUSAL_FOLLOW_UPS = 3

/** The follow-up prompt after refusals in a bot's turn. */
export function botRefusalFollowUp(refusals: readonly string[]): string {
  return [
    "Mousse refused these tool calls because this bot isn't allowed to make them:",
    ...refusals.map((refusal) => `- ${refusal}`),
    "Don't retry them. Carry on with the rest of the request without them, and say in your reply what you could not do."
  ].join('\n')
}

/** Whether a steer goes into `process`'s running prompt as a second prompt, with no cancel (`AcpQuirks.nativeSteerFrom`). */
export function steersNatively(quirks: AcpQuirks, process: Pick<AcpProcess, 'info' | 'nativeSteerRefused'>): boolean {
  if (!quirks.nativeSteerFrom || process.nativeSteerRefused) return false
  const version = compareVersions(process.info?.agentInfo?.version, quirks.nativeSteerFrom)
  return version === 0 || version === 1
}

/** A client file request in a bot's turn, held to its authority; a refusal is noted for the follow-up (`botRefusals`). */
function botFileCheck(process: AcpProcess, bot: Pick<BotAuthority, 'check'>, access: 'read' | 'write', path: string): void {
  try {
    checkBotFileRequest(bot, { access, path })
  } catch (error) {
    ;(process.botRefusals ??= []).push(`${access === 'read' ? 'reading' : 'writing'} ${path}: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

/** A one-shot's file request: refused, and the request ends (`AcpProcess.refuseTools`). */
function refuseFile(refuse: (what: string) => void, what: string): Promise<never> {
  refuse(what)
  return Promise.reject(new Error('This request runs no tools.'))
}

/** The first line of every one-shot prompt (`AcpSessions.oneShot`). */
export const ONE_SHOT_INSTRUCTION = 'Use only the input below. Do not use tools, read or write files, run commands, or ask questions. Reply with only the requested text.'
/** A one-shot ends past this, whatever the agent still sends (the gateway's inactivity bound comes first when it goes quiet). */
export const ONE_SHOT_DEADLINE_MS = 180_000
/** A one-shot's answer ends once it is longer than this many characters. */
export const ONE_SHOT_OUTPUT_CAP = 128_000
/** The agent mode a one-shot selects when the agent lists it: the one that asks before every edit. */
const ONE_SHOT_MODE = 'default'
/** How long a one-shot waits for its ended process to go (a kill follows the polite signal after 3 s). */
const ONE_SHOT_REAP_MS = 8_000

/** `AcpSessions.oneShot`. */
export interface OneShotInput {
  /** An empty folder of the request's own: the session's workspace and the process's working folder. */
  cwd: string
  model: string
  system: string
  prompt: string
  signal: AbortSignal
  onActivity(): void
  /** The session the agent opened, once it has: its files are this request's (`AntigravityProviderService.oneShot`). */
  onSession?(sessionId: string): void
  /** The agent process started, with its id when it has one. */
  onStarted?(pid: number | undefined): void
  /**
   * Called once: the process tree has ended and its output is read (`AcpProcess.exited`), whenever that is (before
   * this returns, or later when it outlived {@link ONE_SHOT_REAP_MS}), or no process started. Only then may the caller
   * touch the request's files.
   */
  onEnded?(): void
  /**
   * The launch reads its sign-in somewhere turns do not (an added Antigravity entry's one-shot home): an
   * "authentication required" answer fails the request without marking the profile signed out.
   */
  signInUnverified?: boolean
  /** Tests: {@link ONE_SHOT_DEADLINE_MS} and {@link ONE_SHOT_OUTPUT_CAP}. */
  deadlineMs?: number
  outputCap?: number
}

/** Waits for `process` to end; one still running after {@link ONE_SHOT_REAP_MS} fails the request. */
async function reaped(process: AcpProcess): Promise<void> {
  if (!process.exited) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const gone = await Promise.race([
    process.exited.then(() => true),
    new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ONE_SHOT_REAP_MS) })
  ])
  clearTimeout(timer)
  if (!gone) throw harnessAppError({ code: 'protocol', message: 'The agent process did not end after its request.' })
}

/** Session updates that show the agent working on the prompt in flight (not session bookkeeping). */
const PROMPT_WORK_UPDATES = new Set(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan'])

/** A steer the turn drained; `token` names its drain when it had one. */
interface DrainedSteer {
  text: string
  token?: string
  /** The images sent with it: the prompt that carries the text carries them too. */
  images?: ChatImageAttachment[]
}

/** An image as an ACP image block, or undefined when agents are not sent it (BMP, JPEG, PNG or WebP within `IMAGE_MAX_DATA_CHARS`). */
function acpImageBlock(image: ChatImageAttachment): { type: 'image'; data: string; mimeType: string } | undefined {
  const mimeType = image.mimeType.toLowerCase()
  if (!['image/bmp', 'image/jpeg', 'image/png', 'image/webp'].includes(mimeType) || typeof image.data !== 'string' || !image.data || image.data.length > IMAGE_MAX_DATA_CHARS) return undefined
  return { type: 'image', data: image.data, mimeType }
}

/** The image blocks of steers. An image an agent is not sent is left out with a warning: the text still goes in now. */
function steerImageBlocks(steers: readonly DrainedSteer[]): Array<{ type: 'image'; data: string; mimeType: string }> {
  const images = steers.flatMap((steer) => steer.images ?? [])
  const blocks = images.flatMap((image) => acpImageBlock(image) ?? [])
  if (blocks.length < images.length) console.warn('[acp] a steer image the agent is not sent was left out', { left: images.length - blocks.length })
  return blocks
}

/** How long a steer waits for a cancelled prompt's own completion before sending the next one. */
export const PROMPT_COMPLETE_WAIT_MS = 5_000

/**
 * How long a prompt may get no reply and no update from the agent (and no request of the agent
 * waiting on the user) before the turn fails and the agent's process is ended. Long, because an
 * agent may run a quiet tool for minutes; it only has to be finite, so that a hung agent never
 * leaves a chat, a schedule or a delegating parent running for the turn's six-hour limit.
 */
export const PROMPT_SILENCE_MS = 15 * 60_000

/** A prompt that is a slash command: the agent expands it only when it opens the first block. */
const SLASH_COMMAND = /^\/([A-Za-z][\w:-]*)(\s|$)/

/**
 * The trimmed prompt when it is a slash command (`/review src`; not a path such as `/tmp/x`). When
 * the agent advertised its commands (`available_commands_update`), only one of those counts, so
 * "/tmp is full" is text; an agent that advertised none is matched by the shape alone.
 */
export function slashCommand(prompt: string, advertised?: ReadonlySet<string>): string | undefined {
  const text = prompt.trim()
  const name = SLASH_COMMAND.exec(text)?.[1]
  if (!name) return undefined
  return advertised && advertised.size > 0 && !advertised.has(name) ? undefined : text
}

/** Remembers the command names an `available_commands_update` lists (without the leading slash). */
function noteCommands(process: AcpProcess, update: unknown): void {
  const event = update as { sessionUpdate?: string; availableCommands?: unknown } | null
  if (event?.sessionUpdate !== 'available_commands_update' || !Array.isArray(event.availableCommands)) return
  process.commands = new Set(event.availableCommands.flatMap((entry) => {
    const name = (entry as { name?: unknown } | null)?.name
    return typeof name === 'string' && name.replace(/^\//, '') ? [name.replace(/^\//, '')] : []
  }))
}

function describeDuration(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.max(1, Math.round(ms / 1000))} seconds`
}

/** The agent's requests count as open while a handler answers them (see `AcpProcess.openRequests`). */
function attended(handlers: AcpClientHandlers, track: { begin(): void; end(): void }): AcpClientHandlers {
  const wrap = <A extends unknown[], R>(handle: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    track.begin()
    try {
      return await handle(...args)
    } finally {
      track.end()
    }
  }
  return {
    ...handlers,
    requestPermission: wrap(handlers.requestPermission),
    ...(handlers.readTextFile ? { readTextFile: wrap(handlers.readTextFile) } : {}),
    ...(handlers.writeTextFile ? { writeTextFile: wrap(handlers.writeTextFile) } : {}),
    ...(handlers.createElicitation ? { createElicitation: wrap(handlers.createElicitation) } : {}),
    ...(handlers.extRequests ? { extRequests: Object.fromEntries(Object.entries(handlers.extRequests).map(([method, handle]) => [method, wrap(handle)])) } : {})
  }
}

/** `instanceId` is absent on sessions saved before provider instances existed (the default instance). */
export interface SavedAcpSession {
  sessionId: string
  cwd: string
  historyKey?: string
  instanceId?: string
  /** Hash of the session instructions the session was given; changed ones are sent again on resume. */
  instructionsHash?: string
  /**
   * How the session chooses its model and which modes it has, as it said when it opened. A load
   * whose reply is missing or partial (the replay opened the gate) keeps them.
   */
  setup?: SessionSetup
}

export interface SessionSetup {
  modelControl?: ModelControl
  thoughtConfig?: ThoughtConfig
  modes?: Array<{ id: string; name: string }>
  defaultModeId?: string
}

/** Where saved sessions and the last listed models persist. */
export interface AcpSessionStore {
  saved(threadId: string): SavedAcpSession | undefined
  /** `undefined` drops the thread's session. */
  setSaved(threadId: string, saved: SavedAcpSession | undefined): void
  models(): LlmModelOption[]
  setModels(models: LlmModelOption[]): void
}

/** Token usage reported by an ACP agent across the prompt(s) of one turn (`PromptResponse.usage`). */
export interface AcpTurnUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Thought/reasoning token breakdown when reported (`thoughtTokens`). */
  reasoning?: number
  totalTokens: number
  /** True when at least one prompt reported `outputTokens`, so output speed can be derived. */
  hasOutput: boolean
}

function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Token usage carried on an ACP `session/prompt` response (`PromptResponse.usage`), or undefined when absent. */
export function readAcpPromptUsage(outcome: unknown): AcpTurnUsage | undefined {
  if (!outcome || typeof outcome !== 'object') return undefined
  const raw = (outcome as { usage?: unknown }).usage
  if (!raw || typeof raw !== 'object') return undefined
  const usage = raw as Record<string, unknown>
  const input = nonNegativeFinite(usage.inputTokens)
  const output = nonNegativeFinite(usage.outputTokens)
  const cacheRead = nonNegativeFinite(usage.cachedReadTokens)
  const cacheWrite = nonNegativeFinite(usage.cachedWriteTokens)
  const reasoning = nonNegativeFinite(usage.thoughtTokens)
  const reportedTotal = nonNegativeFinite(usage.totalTokens)
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    reportedTotal === undefined
  ) {
    return undefined
  }
  const inputTokens = input ?? 0
  const outputTokens = output ?? 0
  const cacheReadTokens = cacheRead ?? 0
  const cacheWriteTokens = cacheWrite ?? 0
  const sum = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
  const totalTokens = reportedTotal !== undefined && (reportedTotal > 0 || sum === 0) ? reportedTotal : sum
  return {
    input: inputTokens,
    output: outputTokens,
    cacheRead: cacheReadTokens,
    cacheWrite: cacheWriteTokens,
    ...(reasoning !== undefined ? { reasoning } : {}),
    totalTokens,
    hasOutput: output !== undefined
  }
}

/** Sums prompt-level ACP usage across multiple prompts of a single turn (steered turns). */
export function addAcpTurnUsage(total: AcpTurnUsage | undefined, next: AcpTurnUsage): AcpTurnUsage {
  if (!total) return { ...next }
  const reasoning =
    total.reasoning !== undefined || next.reasoning !== undefined
      ? (total.reasoning ?? 0) + (next.reasoning ?? 0)
      : undefined
  return {
    input: total.input + next.input,
    output: total.output + next.output,
    cacheRead: total.cacheRead + next.cacheRead,
    cacheWrite: total.cacheWrite + next.cacheWrite,
    ...(reasoning !== undefined ? { reasoning } : {}),
    totalTokens: total.totalTokens + next.totalTokens,
    hasOutput: total.hasOutput || next.hasOutput
  }
}

export interface AcpChatInput {
  threadId: string
  instanceId?: string
  cwd: string
  model: string
  /** `plan`: the session runs in the agent's plan mode (only where the agent offers one). */
  mode?: 'default' | 'plan'
  /**
   * The thread's permission mode for this turn: whether `session/request_permission` and client
   * file writes are answered without asking. Absent asks about everything.
   */
  permissionMode?: PermissionMode
  /** True when claiming a reactive continuation turn the ACP agent started on its own. */
  continuation?: boolean
  /** The continuation id reported by `LiveProcessHost.continuationStarted`. */
  continuationId?: string
  prompt: string
  /** Prefixed to every prompt: the turn's skills, mode, applet catalogue and usable Mousse tools. */
  turnPreamble?: string
  history?: string
  images?: ChatImageAttachment[]
  signal?: AbortSignal
  mcp?: McpAttachment | null
  /** Session instructions: in the session's first prompt, and again on a resumed session they changed for. */
  orchestrationInstructions?: string
  /**
   * A bot's turn: its session instructions are its system text (the owner's words, what it may use), so a session given
   * other ones is not reused, where they would only be a message beside the old ones. A new session gets them and the
   * history in its first prompt, as Codex starts a new thread.
   */
  bot?: true
  /** The bot's authority (`AdapterHost.bot`): it answers the turn's permission and file requests (`botApprovals.ts`). */
  botAuthority?: Pick<BotAuthority, 'check'>
  onText: (text: string) => void
  /** Mousse put `sep` into the cumulative text at `atOffset` (between prompts' replies): not the agent's words. */
  onTextSeparator?: (atOffset: number, sep: string) => void
  /** The agent's thoughts so far this turn (`agent_thought_chunk`), cumulative like `onText`. */
  onThinking?: (text: string) => void
  drainSteer?: () => string | undefined
  /**
   * A steer drain with its token (`TurnControl.drainSteerEntry`). With `expect`, it takes only when the decision now is
   * one of those deliveries. A drain is taken (`steerTaken`, then `onSteer` with its token) only once the prompt that
   * carries it reached the agent, and handed back (`returnSteer`) when that never happens.
   */
  drainSteerEntry?: (opts?: { expect?: Array<'cut' | 'native' | 'hold'> }) => { text: string; token: string; images?: ChatImageAttachment[] } | undefined
  /** The hold (`TurnControl.peekSteer`): what a drain now would do, without taking anything. */
  peekSteer?: () => { delivery: 'cut' | 'native' | 'hold' } | undefined
  /** The check right before `session/cancel` for a drained steer (`TurnControl.mayCut`): false hands it back. */
  mayCut?: (token: string) => boolean
  steerTaken?: (token: string) => void
  returnSteer?: (text: string, token: string) => void
  /** The steer is read: the prompt carrying it reached the agent. `token` names its drain, when it had one. */
  onSteer?: (text: string, token?: string) => void
  /** The prompt ended and nothing of it runs (`TurnSink.boundary`). */
  onBoundary?: () => void
  /** Another prompt of the turn was sent (`TurnSink.providerTurn`). */
  onProviderTurn?: () => void
  /** A person is asked about the call `callId` (a permission request); false once it is answered. */
  onToolAwaiting?: (callId: string, waiting: boolean) => void
  /** A tool call started, changed or ended; `status` says how it ended (`unfinished`: the turn ended first; `background`: still running after `end_turn`). */
  onTool?: (event: ProviderToolEvent & { status?: 'completed' | 'failed' | 'unfinished' | 'background' }) => void
  /** Who answers this turn's permission requests (the turn bridge's `permission`). */
  prompter?: PermissionPrompter
  /** The agent's session id, once known (provider refs name it for interrupt and terminate). */
  onSession?: (sessionId: string) => void
  /** Token usage summed across the prompts of this turn, when the agent reports `PromptResponse.usage`. */
  onUsage?: (usage: AcpTurnUsage) => void
}

/** What the core learned about the agent and its sessions, for runtime facts. */
export interface AcpObservations {
  info?: AcpAgentInfo
  session?: { configOptions?: unknown[]; modes?: Array<{ id: string; name: string }>; models?: LlmModelOption[] }
}

export interface AcpSessionsOptions {
  /** The agent's name in prompts and errors ("Allow Antigravity to run this tool?"). */
  label: string
  /** The provider a usage limit the agent reports names (`antigravity`), for the pause's wording. */
  usageLimitProvider?: string
  /** The instance of sessions saved before provider instances existed. */
  defaultInstanceId: string
  questions: UserQuestionService
  connect: AcpConnectionFactory
  store: AcpSessionStore
  quirks: AcpQuirks
  /** How permission options are labelled and which are shown (default: the generic classes). */
  classifyOption?: ClassifyOption
  /** Who answers permission requests (default: the thread's questions). */
  prompter?: PermissionPrompter
  /** `_meta` sent with `initialize`. */
  initializeMeta?: Record<string, unknown>
  /** Test seam: how long a cancel may take before the process is ended (`INTERRUPT_DEADLINE_MS`). */
  cancelDeadlineMs?: number
  /** Test seam: how long a load replay may pause before the gate opens (`LOAD_REPLAY_IDLE_MS`). */
  loadIdleMs?: number
  /** Test seam: how long a prompt may get no sign of life before the turn fails (`PROMPT_SILENCE_MS`); 0 turns it off. */
  promptSilenceMs?: number
  /** Test seam: settle wait after `usage_update` in a reactive continuation (`CONTINUATION_SETTLE_MS`). */
  continuationSettleMs?: number
  /** Test seam: fallback quiet window in a reactive continuation (`CONTINUATION_QUIET_MS`). */
  continuationQuietMs?: number
  /** Test seam: grace window after a background task completes waiting for wakeup (`WAKE_GRACE_MS`). */
  wakeGraceMs?: number
  /** Test seam: max duration a background task holds Waiting (`MAX_BACKGROUND_MS`). */
  maxBackgroundMs?: number
  /** Test seam: how long an idle thread's process is kept before it is closed (`ACP_IDLE_CLOSE_MS`). */
  idleCloseMs?: number
  /** Client capabilities added to `initialize` (ACP `auth`, `elicitation`). */
  clientCapabilities?: () => Record<string, unknown>
  /** Sign-in links may arrive as URL elicitations (else only through the preset's own channel). */
  urlElicitation?: boolean
  /** Interactive agent questions may arrive as form elicitations (`elicitation/create`, `mode: 'form'`). */
  formElicitation?: boolean
  /** End a session with `session/close` (when advertised) before its process is killed. */
  closeSessions?: boolean
  /** Bumped when the launch settings change; a process from an older one is not reused. */
  launchGeneration(): number
  /** Bumped when a sign-in succeeds. */
  signInGeneration(): number
  /** The saved sign-in no longer works (the agent asked for sign-in). */
  markSignedOut(): void
  /** What a turn says when the agent wants a sign-in. */
  signInRequiredMessage: string
  /** A line for the thread (a saved session could not be reopened, so its history was handed over). */
  notice?(threadId: string, text: string): void
  /** `initialize` or a session told something new (runtime facts). */
  observed?(observations: AcpObservations): void
  /**
   * Runs before every new agent process (a managed install checks its files); a throw stops the
   * launch with that error.
   */
  beforeLaunch?(purpose: AcpPurpose): Promise<void>
}

export class AcpSessions {
  private readonly sessions = new Map<string, AcpProcess>()
  private readonly processes = new Set<AcpProcess>()
  /** Processes running a turn right now. */
  private readonly turning = new Set<AcpProcess>()
  /** Per thread, the session a turn that did not finish left resumable, until `commitInterrupted` fingerprints it. */
  private readonly interrupted = new Map<string, string>()
  /**
   * Per thread, the session whose process a stop ended on purpose (`interrupt`): the stopped turn's history still
   * commits to it (`commitConversation`), so the next turn resumes it on a new process.
   */
  private readonly stoppedForResume = new Map<string, { sessionId: string; process: AcpProcess }>()
  private stopped = false
  private liveHost: LiveProcessHost | null = null
  private readonly prompter: PermissionPrompter

  constructor(private readonly options: AcpSessionsOptions) {
    this.prompter = options.prompter ?? questionsPrompter(options.questions)
  }

  /** Where live processes report background work, task ends and reactive continuation turns. */
  setLiveHost(host: LiveProcessHost | null): void {
    this.liveHost = host
  }

  /** The reactive continuation `threadId`'s process started itself and is still running, if any. */
  inFlightContinuation(threadId: string): { id: string; discarded: boolean } | undefined {
    const cont = this.sessions.get(threadId)?.continuation
    if (!cont || cont.settled) return undefined
    return { id: cont.id, discarded: cont.discarded }
  }

  /** Whether `threadId`'s live process still holds a reactive continuation waiting to be claimed. */
  hasContinuation(threadId: string, id?: string): boolean {
    const cont = this.sessions.get(threadId)?.continuation
    return Boolean(cont && !cont.discarded && !cont.claimed && (!id || cont.id === id))
  }

  /** Drops a reactive continuation held by `threadId`'s live process (only `id`, when given). */
  discardContinuations(threadId: string, id?: string): void {
    const active = this.sessions.get(threadId)
    const cont = active?.continuation
    if (!active || !cont || (id && cont.id !== id)) return
    cont.discarded = true
    this.clearContinuationTimers(cont)
    this.wakeAttachWaiters(cont)
    if (!cont.settled) {
      cont.settled = true
      cont.resolve()
    }
    if (!this.turning.has(active)) {
      active.continuation = undefined
      this.clearBackgroundState(active)
      if (this.sessions.get(threadId) === active) {
        this.sessions.delete(threadId)
        this.forgetConversation(threadId)
      }
      setImmediate(() => { if (!this.turning.has(active)) closeAcpConnection(active) })
    }
  }

  /** Stops any running turn, background work, or reactive continuation on `threadId`'s process. */
  stopThread(threadId: string): 'stopped' | 'not_active' {
    const active = this.sessions.get(threadId)
    if (!active) return 'not_active'
    const hadWork = this.turning.has(active) || this.hasBackgroundWork(active) || Boolean(active.continuation && !active.continuation.discarded)
    if (!hadWork) return 'not_active'
    if (active.backgroundTasks?.size) {
      for (const task of active.backgroundTasks.values()) {
        try {
          this.liveHost?.taskEnded?.(threadId, {
            toolUseId: task.callId,
            taskId: task.callId,
            status: 'stopped',
            durationMs: Math.max(0, Date.now() - task.startedAt)
          })
        } catch { /* best effort */ }
      }
    }
    this.clearBackgroundState(active)
    this.failContinuation(active, new Error(`${this.options.label} was stopped`))
    this.sessions.delete(threadId)
    this.options.questions.autoRejectPendingForThread(threadId)
    closeAcpConnection(active)
    return 'stopped'
  }

  private hasBackgroundWork(process: AcpProcess): boolean {
    return Boolean(process.backgroundTasks?.size) || Boolean(process.wakeGraceTimer)
  }

  private clearContinuationTimers(cont: AcpContinuation): void {
    if (cont.settleTimer) { clearTimeout(cont.settleTimer); cont.settleTimer = undefined }
    if (cont.quietTimer) { clearTimeout(cont.quietTimer); cont.quietTimer = undefined }
  }

  private wakeAttachWaiters(cont: AcpContinuation): void {
    for (const wake of cont.attachWaiters.splice(0)) wake()
  }

  private settleContinuation(cont: AcpContinuation): void {
    if (cont.settled) return
    cont.settled = true
    this.clearContinuationTimers(cont)
    this.wakeAttachWaiters(cont)
    cont.resolve()
  }

  private failContinuation(process: AcpProcess, error: Error): void {
    const cont = process.continuation
    if (!cont) return
    cont.discarded = true
    this.clearContinuationTimers(cont)
    this.wakeAttachWaiters(cont)
    if (!cont.settled) {
      cont.settled = true
      cont.reject(error)
    }
    if (process.continuation === cont) process.continuation = undefined
  }

  private syncBackgroundWork(process: AcpProcess): void {
    const threadId = process.threadId
    if (!threadId) return
    const active = this.hasBackgroundWork(process)
    if (active && !process.backgroundCapTimer) {
      const capMs = this.options.maxBackgroundMs ?? MAX_BACKGROUND_MS
      if (capMs > 0) {
        process.backgroundCapTimer = setTimeout(() => {
          process.backgroundCapTimer = undefined
          if (!this.turning.has(process) && (!process.continuation || process.continuation.settled || process.continuation.discarded)) {
            this.clearBackgroundState(process)
            this.armIdleClose(process)
          }
        }, capMs)
        process.backgroundCapTimer.unref?.()
      }
    } else if (!active && process.backgroundCapTimer) {
      clearTimeout(process.backgroundCapTimer)
      process.backgroundCapTimer = undefined
    }
    if (Boolean(process.reportedBackground) === active) return
    process.reportedBackground = active
    try {
      this.liveHost?.backgroundWork?.(threadId, active)
    } catch { /* host notification is best effort */ }
    // The idle countdown starts again from the end of the background work.
    if (!active && !this.turning.has(process)) this.armIdleClose(process)
  }

  /** No turn, background work or live reactive continuation on the process. */
  private isIdle(process: AcpProcess): boolean {
    return !this.turning.has(process) && !this.hasBackgroundWork(process) && !(process.continuation && !process.continuation.discarded)
  }

  private disarmIdleClose(process: AcpProcess): void {
    if (process.idleCloseTimer) { clearTimeout(process.idleCloseTimer); process.idleCloseTimer = undefined }
  }

  /**
   * (Re)starts the countdown after which the process kept for its thread closes, unless it is busy then, when the
   * countdown starts over. The saved session is kept (as `closeIdle`), so the thread's next turn reopens it.
   */
  private armIdleClose(process: AcpProcess): void {
    this.disarmIdleClose(process)
    const threadId = process.threadId
    if (this.stopped || !threadId || this.sessions.get(threadId) !== process || process.connection.signal.aborted) return
    process.idleCloseTimer = setTimeout(() => {
      process.idleCloseTimer = undefined
      if (this.sessions.get(threadId) !== process) return
      if (!this.isIdle(process)) {
        this.armIdleClose(process)
        return
      }
      this.close(process)
      this.sessions.delete(threadId)
    }, this.options.idleCloseMs ?? ACP_IDLE_CLOSE_MS)
    process.idleCloseTimer.unref?.()
  }

  private clearBackgroundState(process: AcpProcess): void {
    if (process.wakeGraceTimer) { clearTimeout(process.wakeGraceTimer); process.wakeGraceTimer = undefined }
    if (process.backgroundCapTimer) { clearTimeout(process.backgroundCapTimer); process.backgroundCapTimer = undefined }
    process.backgroundTasks?.clear()
    process.recentlyEnded = undefined
    if (process.reportedBackground && process.threadId) {
      process.reportedBackground = false
      try {
        this.liveHost?.backgroundWork?.(process.threadId, false)
      } catch { /* host notification is best effort */ }
    }
  }

  private canSettleContinuationTools(cont: AcpContinuation): boolean {
    if (cont.openTools.size === 0) return true
    if (!cont.modelMovedPastOpenTools) return false
    for (const name of cont.openTools.values()) if (name !== 'run_command') return false
    return true
  }

  private continuationWaitingOnHost(process: AcpProcess): boolean {
    if ((process.openRequests ?? 0) > 0) return true
    return Boolean(process.threadId && this.options.questions.listPendingForThread(process.threadId).length > 0)
  }

  private scheduleContinuationSettle(process: AcpProcess, cont: AcpContinuation, kind: 'settle' | 'quiet'): void {
    if (cont.settled || cont.discarded) return
    const ms = kind === 'settle'
      ? (this.options.continuationSettleMs ?? CONTINUATION_SETTLE_MS)
      : (this.options.continuationQuietMs ?? CONTINUATION_QUIET_MS)
    const arm = () => {
      if (cont.settled || cont.discarded) return
      if (this.continuationWaitingOnHost(process)) {
        const retry = setTimeout(arm, Math.min(500, Math.max(20, ms)))
        retry.unref?.()
        if (kind === 'settle') cont.settleTimer = retry
        else cont.quietTimer = retry
        return
      }
      if (!this.canSettleContinuationTools(cont)) return
      this.settleContinuation(cont)
    }
    if (kind === 'settle') {
      if (cont.settleTimer) clearTimeout(cont.settleTimer)
      cont.settleTimer = setTimeout(arm, ms)
      cont.settleTimer.unref?.()
    } else {
      if (cont.quietTimer) clearTimeout(cont.quietTimer)
      cont.quietTimer = setTimeout(arm, ms)
      cont.quietTimer.unref?.()
    }
  }

  private trackContinuationUpdate(process: AcpProcess, cont: AcpContinuation, update: unknown): void {
    if (cont.settled || cont.discarded || !update || typeof update !== 'object') return
    const event = update as { sessionUpdate?: string; content?: { type?: string; text?: string }; toolCallId?: string; name?: string; status?: string }
    const kind = event.sessionUpdate
    if (kind && (PROMPT_WORK_UPDATES.has(kind) || kind === 'usage_update')) {
      this.clearContinuationTimers(cont)
    }
    if (kind === 'tool_call' && event.toolCallId) {
      cont.openTools.set(event.toolCallId, event.name ?? '')
      cont.modelMovedPastOpenTools = false
      cont.sawUsage = false
    } else if (kind === 'tool_call_update' && event.toolCallId && (event.status === 'completed' || event.status === 'failed')) {
      cont.openTools.delete(event.toolCallId)
    } else if (kind === 'agent_message_chunk' && event.content?.type === 'text' && event.content.text) {
      cont.sawText = true
      if (cont.openTools.size > 0) cont.modelMovedPastOpenTools = true
    } else if (kind === 'agent_thought_chunk' && event.content?.type === 'text' && event.content.text) {
      if (cont.openTools.size > 0) cont.modelMovedPastOpenTools = true
    }
    if (kind === 'usage_update') {
      cont.sawUsage = true
      if (this.canSettleContinuationTools(cont)) this.scheduleContinuationSettle(process, cont, 'settle')
    } else if (cont.sawText && this.canSettleContinuationTools(cont)) {
      this.scheduleContinuationSettle(process, cont, 'quiet')
    }
  }

  private maybeRearmContinuation(process: AcpProcess): void {
    const cont = process.continuation
    if (!cont || cont.settled || cont.discarded) return
    if (!this.canSettleContinuationTools(cont) || this.continuationWaitingOnHost(process)) return
    if (cont.sawUsage && !cont.settleTimer) this.scheduleContinuationSettle(process, cont, 'settle')
    else if (cont.sawText && !cont.quietTimer) this.scheduleContinuationSettle(process, cont, 'quiet')
  }

  /** Handles `session/update` notifications while no turn is active on `process`. */
  private handleRestingUpdate(process: AcpProcess, update: unknown, sessionId?: string): void {
    noteCommands(process, update)
    if (!this.options.quirks.backgroundWork || !update || typeof update !== 'object') return
    const existing = process.continuation
    if (existing && !existing.settled && !existing.discarded) {
      existing.buffer.push({ update, sessionId })
      this.trackContinuationUpdate(process, existing, update)
      return
    }
    const event = update as { sessionUpdate?: string; toolCallId?: string; status?: string; rawOutput?: unknown; content?: unknown; title?: string }
    const threadId = process.threadId
    if (!threadId) return
    if (event.sessionUpdate === 'tool_call_update' && event.toolCallId && (event.status === 'completed' || event.status === 'failed')) {
      const task = process.backgroundTasks?.get(event.toolCallId)
      if (!task) return
      process.backgroundTasks!.delete(event.toolCallId)
      const summary = extractToolSummary(event)
      try {
        this.liveHost?.taskEnded?.(threadId, {
          toolUseId: task.callId,
          taskId: task.callId,
          status: event.status,
          ...(summary ? { summary } : {}),
          durationMs: Math.max(0, Date.now() - task.startedAt)
        })
      } catch { /* best effort */ }
      ;(process.recentlyEnded ??= []).push({ taskId: task.callId, description: task.description, ...(summary ? { summary } : {}) })
      if (process.wakeGraceTimer) clearTimeout(process.wakeGraceTimer)
      const graceMs = this.options.wakeGraceMs ?? WAKE_GRACE_MS
      if (graceMs > 0) {
        process.wakeGraceTimer = setTimeout(() => {
          process.wakeGraceTimer = undefined
          this.syncBackgroundWork(process)
        }, graceMs)
        process.wakeGraceTimer.unref?.()
      }
      this.syncBackgroundWork(process)
      return
    }
    if (!process.mayWake || !event.sessionUpdate || !CONTINUATION_START_UPDATES.has(event.sessionUpdate)) return
    this.startContinuation(process, threadId, { update, sessionId })
  }

  private startContinuation(process: AcpProcess, threadId: string, initial?: AcpContinuation['buffer'][number]): void {
    if (process.wakeGraceTimer) { clearTimeout(process.wakeGraceTimer); process.wakeGraceTimer = undefined }
    const ended = process.recentlyEnded?.splice(0) ?? []
    const pendingSubagents = [...(process.backgroundTasks?.values() ?? [])].filter((t) => t.kind === 'subagent')
    const tasks = [
      ...ended.map((item) => ({ taskId: item.taskId, description: item.description })),
      ...pendingSubagents.map((item) => ({ taskId: item.callId, description: item.description }))
    ]
    const summaries = ended.flatMap((item) => (item.summary ? [item.summary] : item.description ? [item.description] : []))
    if (!summaries.length && pendingSubagents.length) {
      summaries.push(...pendingSubagents.map((item) => item.description))
    }
    const id = randomUUID()
    let resolveDone!: () => void
    let rejectDone!: (error: Error) => void
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
    // Prevent unhandled rejection if the process exits before `chat({ continuation: true })` awaits `done`.
    done.catch(() => undefined)
    const cont: AcpContinuation = {
      id,
      info: { id, taskIds: tasks.map((t) => t.taskId), summaries, ...(tasks.length ? { tasks } : {}) },
      buffer: initial ? [initial] : [],
      claimed: false,
      discarded: false,
      settled: false,
      attachWaiters: [],
      done,
      resolve: resolveDone,
      reject: rejectDone,
      openTools: new Map(),
      sawText: false,
      sawUsage: false,
      modelMovedPastOpenTools: false
    }
    process.continuation = cont
    if (initial) this.trackContinuationUpdate(process, cont, initial.update)
    if (!this.liveHost?.continuationStarted) {
      this.discardContinuations(threadId, id)
      return
    }
    try {
      this.liveHost.continuationStarted(threadId, cont.info)
    } catch {
      this.discardContinuations(threadId, id)
    }
  }

  /**
   * Opens a connection to the agent. `onAuthUrl` receives sign-in links; without it a link means the sign-in is gone.
   * `cwd`: a one-shot's own folder, where its process starts.
   */
  launch(purpose: AcpPurpose, onAuthUrl?: (url: string) => void, bot?: true, cwd?: string): AcpProcess {
    const { label, questions, quirks } = this.options
    if (this.stopped) throw new Error(`${label} provider is stopped`)
    let active: AcpProcess | undefined
    const inTurn = () => Boolean(active && this.turning.has(active))
    // When a reactive continuation has started on `active` and is waiting for the orchestrator to attach its
    // `provider-continuation` turn (`chat({ continuation: true })`), hold any permission, file or form request until the
    // turn adopts the process (or the continuation is discarded/settled). Idle processes without an open continuation
    // fail immediately below, preserving the idle-process isolation guard.
    const waitForTurn = async (): Promise<boolean> => {
      if (inTurn()) return true
      const cont = active?.continuation
      if (!cont || cont.discarded || cont.settled || cont.claimed) return false
      await new Promise<void>((resolve) => {
        if (inTurn() || cont.discarded || cont.settled) { resolve(); return }
        cont.attachWaiters.push(resolve)
      })
      return inTurn()
    }
    // An agent that wakes up on its own between turns (for instance, its own background shell task finishing) has no
    // running turn, transcript stream, lease or permission mode. Detach and close the idle process and drop its saved
    // session so it cannot keep acting unobserved or drift from Mousse's committed history; the next turn opens fresh
    // with Mousse's canonical history.
    const stopIdle = () => {
      const idle = active
      if (!idle || this.turning.has(idle)) return
      this.clearBackgroundState(idle)
      this.failContinuation(idle, new Error(`${label} cannot act outside a turn`))
      if (idle.threadId && this.sessions.get(idle.threadId) === idle) {
        this.sessions.delete(idle.threadId)
        this.forgetConversation(idle.threadId)
      }
      setImmediate(() => { if (!this.turning.has(idle)) closeAcpConnection(idle) })
    }
    const scope: AcpRequestScope = {
      get threadId() { return inTurn() ? active?.threadId : undefined },
      get cwd() { return inTurn() ? active?.cwd : undefined },
      get approvals() { return inTurn() ? active?.turnPrompter?.approvals : undefined },
      get permissionMode() { return inTurn() ? active?.permissionMode : undefined },
      aborted: () => Boolean(!inTurn() || active?.turnSignal?.aborted || active?.connection.signal.aborted),
      throwIfAborted: () => {
        if (!inTurn()) throw new Error(`${label} cannot act outside a turn`)
        active?.turnSignal?.throwIfAborted()
        active?.connection.signal.throwIfAborted()
      }
    }
    const classify = this.options.classifyOption ?? classifyGenericOption
    const handlers: AcpClientHandlers = {
      requestPermission: async (request) => {
        // A one-shot runs no tool: refused unasked, and the request ends.
        if (active?.refuseTools) {
          active.refuseTools(request.toolCall?.title ?? 'a tool')
          return { outcome: { outcome: 'cancelled' } }
        }
        // A background wake can request permission before its first session update. Create the same
        // continuation as a notification would, then let its bound turn answer the request.
        if (!inTurn() && active?.threadId && active.sessionId === request.sessionId &&
            this.sessions.get(active.threadId) === active && !active.connection.signal.aborted &&
            !active.continuation && this.hasBackgroundWork(active)) {
          this.startContinuation(active, active.threadId)
        }
        if (!(await waitForTurn())) {
          stopIdle()
          return { outcome: { outcome: 'cancelled' } }
        }
        if (active?.turnBot && scope.approvals !== 'never') {
          if (scope.aborted() || active.sessionId !== request.sessionId) return { outcome: { outcome: 'cancelled' } }
          const process = active
          const answer = answerBotPermission(active.turnBot, request, classify, {
            cwd: active.cwd!,
            mcp: active.botMcp,
            toolName: active.botToolName?.(request.toolCall.toolCallId),
            onRefused: (reason) => (process.botRefusals ??= []).push(`${request.toolCall.title ?? 'Tool'}: ${reason}`)
          })
          if (answer.outcome.outcome === 'cancelled') active.cancelRequested = true
          return answer
        }
        // While a person is asked, the call is not a foreground tool: a person's steer answers it rather than waiting.
        const callId = request.toolCall?.toolCallId
        const awaiting = callId ? active?.turnToolAwaiting : undefined
        awaiting?.(callId!, true)
        const answer = await answerPermission(active?.turnPrompter ?? this.prompter, scope, request, { label, classify }).finally(() => awaiting?.(callId!, false))
        // A prompt the agent then ends `cancelled` ends because Mousse's answer cancelled the request
        // (dismissed, timed out, or refused by policy), not because the agent chose to stop.
        if (answer.outcome.outcome === 'cancelled' && active) active.cancelRequested = true
        return answer
      },
      ...(quirks.clientFs ? {
        readTextFile: async (request) => {
          if (active?.refuseTools) return refuseFile(active.refuseTools, 'a file read')
          if (!(await waitForTurn())) {
            stopIdle()
            throw RequestError.invalidRequest(undefined, `${label} cannot read files outside a turn`)
          }
          if (active?.turnBot) {
            scope.throwIfAborted()
            if (active.sessionId !== request.sessionId) throw RequestError.invalidRequest(undefined, 'File request belongs to another session')
            botFileCheck(active, active.turnBot, 'read', request.path)
          }
          return readWorkspaceFile(scope, request)
        },
        writeTextFile: async (request) => {
          if (active?.refuseTools) return refuseFile(active.refuseTools, 'a file write')
          if (!(await waitForTurn())) {
            stopIdle()
            throw RequestError.invalidRequest(undefined, `${label} cannot write files outside a turn`)
          }
          if (active?.turnBot) {
            scope.throwIfAborted()
            if (active.sessionId !== request.sessionId) throw RequestError.invalidRequest(undefined, 'File request belongs to another session')
            botFileCheck(active, active.turnBot, 'write', request.path)
            return writeWorkspaceFile(questions, scope, request, label, true)
          }
          return writeWorkspaceFile(questions, scope, request, label)
        }
      } : {}),
      // URL elicitations carry sign-in links; form elicitations carry interactive questions for the thread's widget.
      ...((this.options.urlElicitation || this.options.formElicitation) ? { createElicitation: async (request: Parameters<NonNullable<AcpClientHandlers['createElicitation']>>[0]) => {
        const mode = (request as { mode?: unknown }).mode
        if (mode === 'url' && this.options.urlElicitation) {
          const url = (request as { url?: unknown }).url
          if (!onAuthUrl || typeof url !== 'string' || !/^https:\/\//i.test(url)) return { action: 'decline' }
          onAuthUrl(url)
          return { action: 'accept' }
        }
        if (mode === 'form' && this.options.formElicitation) {
          if (active?.turnBot) return { action: 'cancel' }
          if (active?.refuseTools) {
            active.refuseTools('a question')
            return { action: 'cancel' }
          }
          if (!(await waitForTurn())) {
            stopIdle()
            return { action: 'cancel' }
          }
          const callId = (request as { toolCallId?: unknown }).toolCallId
          const awaiting = typeof callId === 'string' && callId ? active?.turnToolAwaiting : undefined
          awaiting?.(callId as string, true)
          try {
            return await answerFormElicitation(questions, scope, request)
          } finally {
            awaiting?.(callId as string, false)
          }
        }
        return { action: 'decline' }
      } } : {}),
      ...(quirks.xaiExtensions ? xaiHandlers({
        questions,
        scope,
        awaiting: () => active?.turnToolAwaiting,
        promptComplete: (promptId, params) => active?.promptWaiters?.get(promptId)?.(params),
        onOutsideTurn: stopIdle
      }) : {})
    }
    let markExited = () => {}
    const exited = new Promise<void>((resolve) => { markExited = resolve })
    if (purpose === 'one_shot') {
      // A one-shot asks nobody and runs nothing: a question is declined, a terminal or unknown request refused, and
      // each ends the request (`AcpProcess.refuseTools`, set before `initialize`).
      handlers.createElicitation = async () => {
        active?.refuseTools?.('a question')
        return { action: 'decline' }
      }
      // From its output, beside the SDK: a tool reported while the process ends still refuses the answer.
      handlers.observe = (message) => {
        const sent = message as { method?: unknown; params?: { update?: { sessionUpdate?: unknown; title?: unknown } } } | null
        const update = sent?.method === methods.client.session.update ? sent.params?.update : undefined
        if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update')
          active?.refuseTools?.(typeof update.title === 'string' ? update.title : 'a tool')
      }
      handlers.refuseRequest = (method) => refuseFile(active?.refuseTools ?? (() => undefined), ACP_TERMINAL_METHODS.includes(method) ? `a terminal (${method})` : `an unknown request (${method})`)
    }
    const connection = this.options.connect({
      purpose,
      ...(bot ? { bot } : {}),
      ...(cwd ? { cwd } : {}),
      handlers: attended(handlers, {
        begin: () => {
          if (!active) return
          active.openRequests = (active.openRequests ?? 0) + 1
          active.activity?.()
        },
        end: () => {
          if (!active) return
          active.openRequests = Math.max(0, (active.openRequests ?? 0) - 1)
          active.activity?.()
          this.maybeRearmContinuation(active)
        }
      }),
      onAuthUrl: onAuthUrl ?? (() => {
        // The agent wants a sign-in outside a sign-in: the saved sign-in is gone or was never valid.
        if (!active) return
        if (active.signInGeneration === this.options.signInGeneration()) this.options.markSignedOut()
        active.connection.close(new Error(this.options.signInRequiredMessage))
      }),
      onExit: () => {
        // Nothing more is read from a process that has gone (a replay's connection may still be open).
        active?.connection.close()
        markExited()
        if (!active) return
        this.processes.delete(active)
        this.clearBackgroundState(active)
        this.failContinuation(active, new Error(`${label} exited`))
        // A process that ended by itself leaves nothing resumable for the stopped turn.
        if (!active.closedForResume && active.threadId && this.stoppedForResume.get(active.threadId)?.process === active)
          this.stoppedForResume.delete(active.threadId)
        if (active.threadId && this.sessions.get(active.threadId) === active) this.sessions.delete(active.threadId)
      }
    })
    active = Object.assign(connection, { generation: this.options.launchGeneration(), signInGeneration: this.options.signInGeneration(), exited })
    // Between turns, and while a session opens, keep the agent's command list and watch for background completions/wakeups.
    const resting = active
    resting.onUpdate = (update, sessionId) => this.handleRestingUpdate(resting, update, sessionId)
    this.processes.add(active)
    return active
  }

  /** `initialize`; client fs only for turns of a preset that offers it. */
  async initialize(process: AcpProcess, clientFs = false): Promise<AcpAgentInfo> {
    const info = await initializeAgent(process.connection, {
      clientFs,
      label: this.options.label,
      ...(this.options.quirks.strictProtocol ? { strictProtocol: true } : {}),
      ...(this.options.initializeMeta ? { meta: this.options.initializeMeta } : {}),
      ...(this.options.clientCapabilities ? { capabilities: this.options.clientCapabilities() } : {})
    })
    process.mcpHttp = info.mcpHttp
    process.info = info
    this.options.observed?.({ info })
    return info
  }

  /**
   * Ends the process (and the whole tree its factory started). A session the agent can close is
   * closed first, briefly, when the runtime asks for it.
   */
  close(process: AcpProcess): void {
    if (this.options.closeSessions && process.sessionId && !process.connection.signal.aborted && sessionCapability(process.info, 'close')) {
      const sessionId = process.sessionId
      const timer = setTimeout(() => closeAcpConnection(process), 2_000)
      timer.unref?.()
      void process.connection.agent.request(methods.agent.session.close, { sessionId })
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(timer)
          closeAcpConnection(process)
        })
      return
    }
    closeAcpConnection(process)
  }

  /**
   * An agent request answered "authentication required": the saved sign-in is gone. Marks the
   * profile signed out unless a sign-in finished after the process started, and returns the error to show.
   */
  authRequiredError(process: AcpProcess, error: unknown): Error | undefined {
    if (!isAuthRequired(error)) return undefined
    if (process.signInGeneration === this.options.signInGeneration()) this.options.markSignedOut()
    return new Error(this.options.signInRequiredMessage)
  }

  /**
   * A short start-up check: `initialize` only, then the process ends. Records what the agent
   * answered; throws when it does not start or answer.
   */
  async handshake(signal?: AbortSignal): Promise<AcpAgentInfo> {
    await this.options.beforeLaunch?.('handshake')
    const active = this.launch('handshake')
    const abort = () => this.close(active)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      signal?.throwIfAborted()
      return await this.initialize(active, this.options.quirks.clientFs === true)
    } finally {
      signal?.removeEventListener('abort', abort)
      closeAcpConnection(active)
    }
  }

  /** Opens one session in `cwd` and closes it: the models and modes it offers (sign-in verification, "Refresh models"). */
  async probeSession(cwd: string, signal?: AbortSignal): Promise<{ models: LlmModelOption[]; modes: Array<{ id: string; name: string }> }> {
    await this.options.beforeLaunch?.('models')
    const active = this.launch('models')
    const abort = () => this.close(active)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      await this.initialize(active)
      signal?.throwIfAborted()
      const session = await active.connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
      active.sessionId = session.sessionId
      return this.observeSession(active, session)
    } catch (error) {
      throw this.authRequiredError(active, error) ?? error
    } finally {
      signal?.removeEventListener('abort', abort)
      this.close(active)
    }
  }

  /**
   * Records a session's models and modes; returns them. `known` is what a reopened session said
   * when it opened: it stands in for what a load's missing reply would have said, and `currentModeId`
   * is the mode the replay left it in.
   */
  private observeSession(active: AcpProcess, session: unknown, known?: SessionSetup & { currentModeId?: string }): { models: LlmModelOption[]; modes: Array<{ id: string; name: string }> } {
    const { models, control } = agentModels(session, active.info?.meta)
    const modes = agentModes(session)
    active.modelControl = control.kind === 'none' && known?.modelControl ? known.modelControl : control
    active.thoughtConfig = thoughtConfigOption(session) ?? known?.thoughtConfig
    active.modes = modes.modes.length ? modes.modes : known?.modes ?? []
    active.defaultModeId = known?.defaultModeId ?? modes.current
    active.currentModeId = modes.current ?? known?.currentModeId ?? active.defaultModeId
    if (models.length) this.options.store.setModels(models)
    const configOptions = (session as { configOptions?: unknown[] } | null)?.configOptions
    this.options.observed?.({ session: { ...(Array.isArray(configOptions) ? { configOptions } : {}), modes: modes.modes, models } })
    return { models, modes: modes.modes }
  }

  private historyKey(history: string): string {
    return createHash('sha256').update(history).digest('hex')
  }

  /** Record only the canonical history that the owning turn durably committed. */
  commitConversation(threadId: string, history: string): void {
    const saved = this.options.store.saved(threadId)
    const stopped = this.stoppedForResume.get(threadId)
    this.stoppedForResume.delete(threadId)
    if (!saved || !(this.sessions.has(threadId) || stopped?.sessionId === saved.sessionId)) return
    this.options.store.setSaved(threadId, { ...saved, historyKey: this.historyKey(history) })
  }

  /**
   * A turn that did not finish (stopped, failed, a usage limit) left its saved session resumable: `history` is the
   * canonical history as that turn left it (its request included, no reply), which the next turn sends as its history,
   * so that turn resumes the session and sends only its new message. Only a session `chat` marked for it (see
   * `resumableAfterFailure`) is fingerprinted; anything else stays as it was, and the next turn hands its history to a
   * new session.
   */
  commitInterrupted(threadId: string, history: string): void {
    const sessionId = this.interrupted.get(threadId)
    this.interrupted.delete(threadId)
    this.stoppedForResume.delete(threadId)
    const saved = this.options.store.saved(threadId)
    if (!sessionId || !saved || saved.sessionId !== sessionId) return
    this.options.store.setSaved(threadId, { ...saved, historyKey: this.historyKey(history) })
  }

  /** Drops the saved session of `threadId`; its next turn starts a new one with the history in the prompt. */
  forgetConversation(threadId: string): void {
    this.stoppedForResume.delete(threadId)
    if (!this.options.store.saved(threadId)) return
    this.options.store.setSaved(threadId, undefined)
  }

  /** The thread's process serving `sessionId`. */
  private bySession(sessionId: string | undefined): AcpProcess | undefined {
    if (!sessionId) return undefined
    for (const active of this.sessions.values()) if (active.sessionId === sessionId) return active
    return undefined
  }

  /**
   * The native cancel: `session/cancel` for the running prompt, pending permission prompts
   * rejected, and the prompt awaited. The gateway bounds the wait (`interruptWithDeadline`).
   */
  async interrupt(sessionId: string | undefined): Promise<'interrupted' | 'not_active'> {
    const active = this.bySession(sessionId)
    if (!active || !this.turning.has(active) || !active.prompting) return 'not_active'
    if (active.threadId) this.options.questions.autoRejectPendingForThread(active.threadId)
    // The prompt that ends `cancelled` now ends because Mousse asked, not because the agent chose to.
    active.cancelRequested = true
    // The agent may still count its task as running after the cancel's reply: its process ends,
    // and the thread's next turn reopens the saved session on a new one. Marked before the prompt ends, so the
    // stopped turn's commit finds it whether it runs before or after the close.
    const xai = this.options.quirks.xaiExtensions
    if (xai && active.threadId) this.stoppedForResume.set(active.threadId, { sessionId: active.sessionId!, process: active })
    await active.connection.agent.notify(methods.agent.session.cancel, { sessionId: active.sessionId! })
    await active.prompting
    if (xai && !active.connection.signal.aborted) {
      active.closedForResume = true
      closeAcpConnection(active)
    }
    return 'interrupted'
  }

  /**
   * Waits for the agent to report `promptId` complete (`xaiExtensions`): `done` settles with the
   * completion's params and never rejects; `dispose` removes the waiter once the prompt settled.
   */
  private completionOf(active: AcpProcess, promptId: string): { done: Promise<Record<string, unknown>>; dispose(): void } {
    const waiters = (active.promptWaiters ??= new Map<string, (params: Record<string, unknown>) => void>())
    const done = new Promise<Record<string, unknown>>((resolve) => {
      waiters.set(promptId, (params) => {
        waiters.delete(promptId)
        resolve(params)
      })
    })
    return { done, dispose: () => waiters.delete(promptId) }
  }

  /** Kills the process of `sessionId`; the thread's next turn starts a new one with the history handed over. */
  terminate(sessionId: string | undefined): void {
    const active = this.bySession(sessionId)
    if (!active) return
    this.clearBackgroundState(active)
    this.failContinuation(active, new Error(`${this.options.label} was terminated`))
    closeAcpConnection(active)
    if (active.threadId) {
      this.sessions.delete(active.threadId)
      this.forgetConversation(active.threadId)
    }
  }

  /**
   * Reopens a saved session on a fresh process: `session/load` behind the load gate when the
   * agent can load, else `session/resume` when advertised. Null when it cannot be reopened; a load
   * that misses the gateway's deadline kills the process and forgets the session.
   */
  private async reopen(active: AcpProcess, saved: SavedAcpSession, input: AcpChatInput, mcpServers: ReturnType<typeof sessionMcpServers>): Promise<{ response: unknown; currentModeId?: string } | null> {
    if (active.info?.agentCapabilities.loadSession === true) {
      const gate = new LoadGate(saved.sessionId, this.options.loadIdleMs)
      const deliver = active.onUpdate
      // Setup the replay states (its model selector, the mode it is in) when the reply says nothing.
      let replayOptions: unknown[] | undefined
      let currentModeId: string | undefined
      active.onUpdate = (update, sessionId) => {
        const verdict = gate.update(sessionId, update)
        if (verdict === 'discard') return
        if (verdict === 'keep') {
          const event = update as { sessionUpdate?: string; configOptions?: unknown; currentModeId?: unknown }
          if (event.sessionUpdate === 'config_option_update' && Array.isArray(event.configOptions)) replayOptions = event.configOptions
          if (event.sessionUpdate === 'current_mode_update' && typeof event.currentModeId === 'string') currentModeId = event.currentModeId
        }
        deliver?.(update, sessionId)
      }
      let response: Record<string, unknown> = {}
      const load = active.connection.agent.request(methods.agent.session.load, { sessionId: saved.sessionId, cwd: input.cwd, mcpServers })
        .then((value) => {
          if (gate.state !== 'ready' && value && typeof value === 'object') response = value as Record<string, unknown>
          gate.reply()
        })
      // A failed load ends the wait at once; a late answer after the gate opened changes nothing.
      const failed = load.then(() => new Promise<never>(() => {}))
      try {
        await loadWithDeadline(saved.sessionId, Promise.race([gate.ready, failed]), () => {
          closeAcpConnection(active)
          this.forgetConversation(input.threadId)
        })
        return { response: response.configOptions === undefined && replayOptions ? { ...response, configOptions: replayOptions } : response, ...(currentModeId ? { currentModeId } : {}) }
      } finally {
        gate.dispose()
        active.onUpdate = deliver
        load.catch(() => undefined)
      }
    }
    if (sessionCapability(active.info, 'resume')) return { response: await active.connection.agent.request(methods.agent.session.resume, { sessionId: saved.sessionId, cwd: input.cwd, mcpServers }) }
    return null
  }

  /**
   * Resolves a requested model string (`gemini-4-neon:xhigh`, `gemini-4-neon`, or a legacy
   * `gemini-4-neon-high` id) against the store's listed models, separating any reasoning level.
   */
  private resolveListedModel(model: string): { modelId: string; effort?: string; listed?: LlmModelOption } {
    const listed = this.options.store.models()
    const exact = listed.find((entry) => entry.id === model)
    if (exact) return { modelId: exact.id, listed: exact }

    const parsed = parseThinkingSuffixFromModelId(model)
    if (parsed.effort) {
      const byBase = listed.find((entry) => entry.id === parsed.baseId)
      if (byBase) return { modelId: byBase.id, effort: parsed.effort, listed: byBase }
    }

    // Legacy Antigravity selections stored the reasoning level in the model id (`gemini-4-neon-high`):
    // map them onto the base model when the agent now lists base ids with separate `thought_level` efforts.
    for (const entry of listed) {
      if (!entry.efforts?.length || !model.startsWith(`${entry.id}-`)) continue
      const suffix = model.slice(entry.id.length + 1)
      if (entry.efforts.includes(suffix)) return { modelId: entry.id, effort: suffix, listed: entry }
    }

    return { modelId: parsed.baseId, ...(parsed.effort ? { effort: parsed.effort } : {}) }
  }

  /** Sets the session's model (and `thought_level` when advertised): a fixed option (preset), else the control the session offers. */
  private async selectModel(active: AcpProcess, model: string): Promise<void> {
    const { label, store, quirks } = this.options
    const resolved = this.resolveListedModel(model)
    const setModel = async (): Promise<unknown> => {
      if (quirks.modelConfigId) {
        if (!resolved.listed) throw new Error(`This ${label} model is unavailable for the signed-in account`)
        return await active.connection.agent.request(methods.agent.session.setConfigOption, {
          sessionId: active.sessionId!,
          configId: quirks.modelConfigId,
          value: resolved.modelId
        })
      }
      if (resolved.modelId === AGENT_DEFAULT_MODEL) return undefined
      const listed = store.models()
      if (listed.length && !resolved.listed) throw new Error(`This ${label} model is unavailable for the signed-in account`)
      const control = active.modelControl ?? { kind: 'none' }
      if (control.kind === 'config') {
        return await active.connection.agent.request(methods.agent.session.setConfigOption, {
          sessionId: active.sessionId!,
          configId: control.configId,
          value: resolved.modelId
        })
      }
      if (control.kind === 'set_model') {
        await active.connection.agent.request('session/set_model', { sessionId: active.sessionId!, modelId: resolved.modelId })
        return undefined
      }
      throw new Error(`${label} offers no model choice; use its default model`)
    }
    const response = await setModel()
    const responseOptions = (response as { configOptions?: unknown } | null)?.configOptions
    if (Array.isArray(responseOptions) && responseOptions.length > 0) {
      active.thoughtConfig = thoughtConfigOption({ configOptions: responseOptions })
    }
    active.turnSignal?.throwIfAborted()
    const thought = active.thoughtConfig
    if (!thought) return
    const requested = resolved.effort && thought.values.includes(resolved.effort) ? resolved.effort : undefined
    const fallback = !requested && resolved.listed?.defaultEffort &&
      thought.values.includes(resolved.listed.defaultEffort) &&
      thought.currentValue !== resolved.listed.defaultEffort
      ? resolved.listed.defaultEffort
      : undefined
    const target = requested ?? fallback
    if (!target) return
    const thoughtResponse = await active.connection.agent.request(methods.agent.session.setConfigOption, {
      sessionId: active.sessionId!,
      configId: thought.configId,
      value: target
    })
    const updatedOptions = (thoughtResponse as { configOptions?: unknown } | null)?.configOptions
    if (Array.isArray(updatedOptions) && updatedOptions.length > 0) {
      active.thoughtConfig = thoughtConfigOption({ configOptions: updatedOptions })
    } else {
      active.thoughtConfig = { ...thought, currentValue: target }
    }
  }

  /** Puts the session in the agent's plan mode for a plan turn, and back for a normal one. */
  private async selectMode(active: AcpProcess, mode: AcpChatInput['mode']): Promise<void> {
    const plan = planModeId(active.modes ?? [])
    if (mode === 'plan') {
      if (!plan) throw new Error(`${this.options.label} has no plan mode`)
      if (active.currentModeId === plan) return
      await active.connection.agent.request(methods.agent.session.setMode, { sessionId: active.sessionId!, modeId: plan })
      active.currentModeId = plan
      return
    }
    if (plan && active.currentModeId === plan && active.defaultModeId && active.defaultModeId !== plan) {
      await active.connection.agent.request(methods.agent.session.setMode, { sessionId: active.sessionId!, modeId: active.defaultModeId })
      active.currentModeId = active.defaultModeId
    }
  }

  /**
   * `mcp` attaches the Mousse MCP server to the ACP session (SPEC §15.2) and `orchestrationInstructions`
   * goes into the session's first prompt. The token is stable per thread, so a live session is reused
   * across turns; only a changed token (after a revocation) or MCP relay closes it and resumes with the new one.
   */
  async chat(input: AcpChatInput): Promise<string> {
    const { label, store, questions, quirks } = this.options
    input.signal?.throwIfAborted()
    this.interrupted.delete(input.threadId)
    this.stoppedForResume.delete(input.threadId)
    const historyKey = this.historyKey(input.history ?? '')
    const instanceId = input.instanceId ?? this.options.defaultInstanceId
    // A native session belongs to the instance that opened it; another instance starts fresh.
    const stored = store.saved(input.threadId)
    let saved = stored && (stored.instanceId ?? this.options.defaultInstanceId) === instanceId ? stored : undefined
    let active = this.sessions.get(input.threadId)
    let claimedContinuation: AcpContinuation | undefined
    let priorSubagentIds: string[] = []
    if (input.continuation) {
      const cont = active?.continuation
      if (!active || active.connection.signal.aborted || !cont || cont.discarded || (input.continuationId && cont.id !== input.continuationId)) {
        return ''
      }
      claimedContinuation = cont
      priorSubagentIds = [...(active.backgroundTasks?.values() ?? [])].filter((task) => task.kind === 'subagent').map((task) => task.callId)
    }
    const instructionsHash = input.orchestrationInstructions ? createHash('sha256').update(input.orchestrationInstructions).digest('hex').slice(0, 32) : undefined
    // A bot's session given other instructions is neither reused nor resumed (`AcpChatInput.bot`): a new one is opened.
    const opened = active ? active.instructionsHash : saved?.instructionsHash
    const botStale = input.bot === true && instructionsHash !== undefined && opened !== undefined && opened !== instructionsHash
    if (botStale) saved = undefined
    const mcpToken = input.mcp?.token ?? null
    // A new relay catalogue reopens the session too: an agent reads its tool lists when the session opens.
    const relayKey = input.mcp?.relay ? `${input.mcp.relay.url}|${input.mcp.relay.revision}` : null
    if (!claimedContinuation && active && (botStale || active.connection.signal.aborted || active.generation !== this.options.launchGeneration() || active.cwd !== input.cwd || saved?.historyKey !== historyKey || (active.mcpToken ?? null) !== mcpToken || (active.relayKey ?? null) !== relayKey || (active.instanceId ?? this.options.defaultInstanceId) !== instanceId)) {
      this.clearBackgroundState(active)
      this.failContinuation(active, new Error(`${label} session replaced`))
      this.close(active)
      this.sessions.delete(input.threadId)
      active = undefined
    }
    let freshProcess = !active
    if (!active) await this.options.beforeLaunch?.('turn')
    active ??= this.launch('turn', undefined, input.botAuthority ? true : undefined)
    let current = active
    const adopt = (next: AcpProcess) => {
      next.threadId = input.threadId
      next.instanceId = instanceId
      next.cwd = input.cwd
      next.turnSignal = input.signal
      next.turnPrompter = input.prompter
      next.turnToolAwaiting = input.onToolAwaiting
      // Read per request, so a change applies from the next turn without restarting the agent.
      next.permissionMode = input.permissionMode ?? 'ask'
      next.turnBot = input.botAuthority
      next.botMcp = input.botAuthority ? input.mcp : undefined
      next.botToolName = input.botAuthority ? (id) => openTools.get(id)?.name : undefined
      next.botRefusals = undefined
      this.disarmIdleClose(next)
      this.turning.add(next)
      current = next
    }
    adopt(active)
    const abort = () => {
      questions.autoRejectPendingForThread(input.threadId)
      this.failContinuation(current, new Error(`${label} was stopped`))
      // Closing also aborts setup RPCs; a lost startup abort must never dispatch a prompt.
      this.close(current)
    }
    input.signal?.addEventListener('abort', abort, { once: true })
    let text = ''
    let thinking = ''
    // The blank line Mousse puts between prompts' replies is its own, not the agent's: a row it opens drops it.
    const appendTextSeparator = (): void => {
      if (!text) return
      input.onTextSeparator?.(text.length, '\n\n')
      text += '\n\n'
    }
    let turnUsage: AcpTurnUsage | undefined
    interface TrackedTool {
      title: string
      name?: string
      rawInput?: unknown
      /** A bot's use_tool call: the tool its arguments name, once they are in. */
      useToolTarget?: string
      startedAt: number
      isDaemon: boolean
      isInvokeSubagent: boolean
      description: string
      /** Any call but a subagent, a command or a computer use call: its row shows its bounded arguments and result. */
      plain: boolean
      /** The row has its arguments. */
      argsShown: boolean
    }
    interface LaunchedSubagent {
      callId: string
      description: string
      startedAt: number
      textResponses: number
      sawTextInStep: boolean
    }
    const openTools = new Map<string, TrackedTool>()
    const launchedSubagents = new Map<string, LaunchedSubagent>()
    let resumed = !freshProcess
    let steerTimer: ReturnType<typeof setInterval> | undefined
    let steerFailure: unknown
    // A prompt is in flight, and the agent's silence is counted (`PROMPT_SILENCE_MS`).
    let prompting = false
    // A prompt of this turn was sent, and the agent showed it works on one (`PROMPT_WORK_UPDATES`).
    let promptSent = false
    let worked = false
    // Steers drained for the next prompt, and those the prompt in flight carries that the agent has not shown it has.
    // A drain with a token is read (`steerTaken`, `onSteer`) only once the agent works on the prompt that carries it,
    // or answers it; until then a failure hands it back (`returnSteer`), so it is never lost
    // (docs/design/steer-and-interruptions.md §2.6, §2.7).
    const pendingSteers: DrainedSteer[] = []
    const carried: DrainedSteer[] = []
    // A steer sent as a second prompt while one runs (`steersNatively`), with the steers it carries. The running
    // prompt's answer shows the agent took it in: from then on it is the prompt in flight, and its end ends the turn.
    let riding: { reply: Promise<unknown>; steers: DrainedSteer[] } | undefined
    const readCarried = (): void => {
      for (const entry of carried.splice(0)) {
        if (!entry.token) continue
        input.steerTaken?.(entry.token)
        try {
          input.onSteer?.(entry.text, entry.token)
        } catch (error) {
          // Not saved: it goes back, and the turn fails rather than going on without it.
          input.returnSteer?.(entry.text, entry.token)
          steerFailure ??= error
          closeAcpConnection(current)
        }
      }
    }
    const handBack = (): void => {
      const unconfirmed = riding?.steers.splice(0) ?? []
      riding = undefined
      for (const entry of [...carried.splice(0), ...unconfirmed, ...pendingSteers.splice(0)]) if (entry.token) input.returnSteer?.(entry.text, entry.token)
    }
    // The prompt in flight (xAI tags each one), and whether an earlier prompt of the turn may still send updates: one a
    // steer cancelled whose own end never came within `PROMPT_COMPLETE_WAIT_MS`. Its late updates are not work on
    // the prompt that carries the steers, so they never mark those read.
    let promptInFlight: string | undefined
    let earlierMayTrail = false
    const ofPromptInFlight = (update: object): boolean => {
      const meta = (update as { _meta?: unknown })._meta
      const tagged = meta && typeof meta === 'object' ? (meta as { promptId?: unknown }).promptId : undefined
      if (typeof tagged === 'string' && promptInFlight) return tagged === promptInFlight
      return !earlierMayTrail
    }
    const silenceMs = this.options.promptSilenceMs ?? PROMPT_SILENCE_MS
    let silenceTimer: ReturnType<typeof setTimeout> | undefined
    let silenceFailure: Error | undefined
    /** Restarts the silence timer on a sign of life; it does not run while the agent waits on a request of its own. */
    const watchSilence = () => {
      clearTimeout(silenceTimer)
      silenceTimer = undefined
      if (!prompting || !(silenceMs > 0) || (current.openRequests ?? 0) > 0) return
      // Mousse's own tools (`ask_user`, approvals) ask the user through the thread's
      // questions, not through the ACP connection, and may wait up to an hour: the agent is not
      // silent while one is open. The clock starts over (a full window) once the last one is answered.
      if (questions.listPendingForThread(input.threadId).length > 0) {
        silenceTimer = setTimeout(watchSilence, Math.min(500, silenceMs))
        silenceTimer.unref?.()
        return
      }
      silenceTimer = setTimeout(() => {
        // A question may have been asked since the timer started: look again before giving up.
        if ((current.openRequests ?? 0) > 0 || questions.listPendingForThread(input.threadId).length > 0) return watchSilence()
        silenceFailure = harnessAppError({
          code: 'timeout',
          message: `${label} did not answer: it sent no reply and no update for ${describeDuration(silenceMs)}, so it was stopped. Send the message again.`,
          instanceId,
          // The agent had the prompt the whole time and may have acted on it without saying so.
          promptTaken: true
        })
        closeAcpConnection(current)
      }, silenceMs)
      silenceTimer.unref?.()
    }
    const onUpdate = (update: unknown) => {
      watchSilence()
      noteCommands(current, update)
      if (!update || typeof update !== 'object') return
      const event = update as { sessionUpdate?: string; content?: unknown; toolCallId?: string; title?: string; name?: string; status?: string; rawInput?: unknown; rawOutput?: unknown; configOptions?: NewSessionResponse['configOptions']; currentModeId?: string }
      const textContent = event.content && typeof event.content === 'object' && !Array.isArray(event.content) ? event.content as { type?: string; text?: string } : undefined
      // The agent works on the prompt that carries drained steers: they are read now, before what it writes.
      // An update that may be a cancelled prompt's late one does not count: the carrying prompt's reply reads them then.
      if (prompting && event.sessionUpdate && PROMPT_WORK_UPDATES.has(event.sessionUpdate) && ofPromptInFlight(update)) {
        worked = true
        readCarried()
      }
      if (event.sessionUpdate === 'agent_message_chunk' && textContent?.type === 'text') {
        const chunk = textContent.text ?? ''
        if (chunk) for (const sub of launchedSubagents.values()) sub.sawTextInStep = true
        if (chunk.length > 0) {
          text += chunk
          input.onText(text)
        }
      }
      if (event.sessionUpdate === 'usage_update') {
        for (const sub of launchedSubagents.values()) {
          if (sub.sawTextInStep) {
            sub.textResponses += 1
            sub.sawTextInStep = false
          }
        }
      }
      // Agents such as Antigravity say what they are doing between tool calls as thoughts, not as message text.
      if (event.sessionUpdate === 'agent_thought_chunk' && textContent?.type === 'text' && textContent.text) {
        thinking += textContent.text
        input.onThinking?.(thinking)
      }
      if (event.sessionUpdate === 'tool_call' && event.toolCallId) {
        const subagent = isAcpSubagentTool(event.name)
        const isInvokeSubagent = quirks.backgroundWork === true && event.name === 'invoke_subagent'
        const isCommand = quirks.backgroundWork === true && event.name === 'run_command'
        const activity = subagent
          ? subagentActivity(event.rawInput, event.title, isInvokeSubagent && !input.bot)
          : isCommand
            ? commandActivity(event.rawInput, event.title)
            : undefined
        const record = subagentToolName(event.name) ? (recordSubagentCall(event.name, event.rawInput, {}) ?? undefined) : undefined
        // A start with a title only names a Mousse tool by it (`computer_use_request (mousse MCP Server)`): kept as that
        // title, a form `mousseServerToolOf` reads, never made into another name.
        const name = event.name ?? (event.title !== undefined && mousseServerToolOf(event.title)?.server === 'mousse' ? event.title : undefined)
        // A computer use call (or a bot's use_tool, until its arguments say which tool it runs) never keeps the agent's
        // own title: it may quote what the call types.
        const useToolTarget = acpUseToolTarget(name, event.rawInput)
        const cua = acpCuaFields(name, event.rawInput, useToolTarget)
        const title = cua ? cua.title : subagent && activity?.kind === 'subagent' ? `${label} subagent: ${activity.description}` : event.title ?? event.name ?? `${label} tool`
        const description = subagent && activity?.kind === 'subagent'
          ? activity.description
          : isCommand && activity?.kind === 'command'
            ? activity.command
            : title
        // Any other call's row shows what it was called with (a search's query, a fetch's URL), as Claude's rows do.
        const plain = !subagent && !isCommand && !subagentToolName(name)
        const args = plain && !cua ? acpArgs(event.rawInput) : undefined
        openTools.set(event.toolCallId, {
          title,
          name,
          rawInput: event.rawInput,
          ...(useToolTarget ? { useToolTarget } : {}),
          startedAt: Date.now(),
          isDaemon: isCommand && isDaemonCommand(event.rawInput),
          isInvokeSubagent,
          description,
          plain,
          argsShown: args !== undefined
        })
        const startActivity = cua ? cua.activity : activity
        // A subagent call is never waited on by a held steer; any other call of an agent counts as foreground.
        input.onTool?.({
          phase: 'start',
          callId: event.toolCallId,
          title,
          toolName: name,
          ...(useToolTarget ? { useToolTarget } : {}),
          ...(startActivity ? { activity: startActivity } : {}),
          ...(args ? { input: args } : {}),
          ...(record ? { record } : {})
        })
      }
      // A running call's own progress (its output, a new status) is a tool event: it restarts the release window.
      if (event.sessionUpdate === 'tool_call_update' && event.toolCallId && openTools.has(event.toolCallId) && event.status !== 'completed' && event.status !== 'failed') {
        const tracked = openTools.get(event.toolCallId)!
        // A call opened with no arguments (or `{}`) gets them from its first update that has some.
        if (event.rawInput !== undefined && acpArgs(tracked.rawInput) === undefined) tracked.rawInput = event.rawInput
        // Arguments that arrive late say which tool a use_tool runs, and what a computer use call keeps of them.
        tracked.useToolTarget ??= acpUseToolTarget(tracked.name, tracked.rawInput)
        const cua = acpCuaFields(tracked.name, tracked.rawInput, tracked.useToolTarget)
        if (cua) tracked.title = cua.title
        // Any other call's row gets its late arguments once.
        const lateArgs = !cua && tracked.plain && !tracked.argsShown ? acpArgs(tracked.rawInput) : undefined
        if (lateArgs) tracked.argsShown = true
        const updateActivity: ActivityPatch | undefined = cua?.activity ?? (lateArgs ? { input: lateArgs } : undefined)
        input.onTool?.({
          phase: 'update',
          callId: event.toolCallId,
          title: tracked.title,
          ...(tracked.name ? { toolName: tracked.name } : {}),
          ...(tracked.useToolTarget ? { useToolTarget: tracked.useToolTarget } : {}),
          ...(updateActivity ? { activity: updateActivity } : {})
        })
      }
      if (event.sessionUpdate === 'tool_call_update' && event.toolCallId && (event.status === 'completed' || event.status === 'failed')) {
        const tracked = openTools.get(event.toolCallId)
        const bg = current.backgroundTasks?.get(event.toolCallId)
        if (!tracked && bg) {
          current.backgroundTasks?.delete(event.toolCallId)
          const summary = extractToolSummary(event)
          try {
            this.liveHost?.taskEnded?.(input.threadId, {
              toolUseId: bg.callId,
              taskId: bg.callId,
              status: event.status,
              ...(summary ? { summary } : {}),
              durationMs: Math.max(0, Date.now() - bg.startedAt)
            })
          } catch { /* best effort */ }
        } else {
          openTools.delete(event.toolCallId)
          const isBackgroundLaunch = tracked?.isInvokeSubagent && event.status === 'completed' && !input.bot
          if (tracked && isBackgroundLaunch) {
            launchedSubagents.set(event.toolCallId, {
              callId: event.toolCallId,
              description: tracked.description,
              startedAt: tracked.startedAt,
              textResponses: 0,
              sawTextInStep: false
            })
          }
          const toolName = tracked?.name ?? event.name
          const rawInput = tracked?.rawInput ?? event.rawInput
          const outputText = extractToolOutputText(event)
          const record = subagentToolName(toolName)
            ? (recordSubagentCall(toolName, rawInput, { text: outputText, isError: event.status === 'failed' }) ?? undefined)
            : undefined
          // Any other call's row keeps its result text (bounded where the row is kept), as Claude's rows do: a web
          // search's row lists the sites it found from it.
          const resultOutput = !record && outputText && (tracked?.plain ?? true) ? { output: outputText } : undefined
          // A computer use call (directly or through a bot's use_tool) keeps only its allowlisted arguments and a bounded
          // outcome: computer_use_request's outcome line, a fixed label for a failure, never the text it returned.
          const cuaName = toolName ?? (event.title !== undefined && mousseServerToolOf(event.title)?.server === 'mousse' ? event.title : undefined)
          const useToolTarget = tracked?.useToolTarget ?? acpUseToolTarget(cuaName, rawInput)
          const cua = record ? undefined : acpCuaFields(cuaName, rawInput, useToolTarget, { output: outputText, failed: event.status === 'failed' })
          input.onTool?.({
            phase: 'complete',
            callId: event.toolCallId,
            title: cua ? cua.title : (event.title ?? tracked?.title ?? `${label} tool`),
            ...(cuaName ? { toolName: cuaName } : {}),
            ...(useToolTarget ? { useToolTarget } : {}),
            status: isBackgroundLaunch ? 'background' : event.status,
            ...(record ? { record } : {}),
            ...(cua ? (cua.activity ? { activity: cua.activity } : {}) : resultOutput ? { activity: resultOutput } : {})
          })
        }
      }
      if (event.sessionUpdate === 'config_option_update' && event.configOptions) {
        current.thoughtConfig = thoughtConfigOption({ configOptions: event.configOptions })
        const raw = quirks.modelConfigId
          ? modelOptions({ configOptions: event.configOptions })
          : agentModels({ configOptions: event.configOptions }).models
        const updated = mergeModelOptions(store.models(), raw, event.configOptions)
        if (updated.length) store.setModels(updated)
      }
      if (event.sessionUpdate === 'current_mode_update' && typeof event.currentModeId === 'string') current.currentModeId = event.currentModeId
    }
    try {
      input.signal?.throwIfAborted()
      if (freshProcess) {
        let session: unknown
        let known: (SessionSetup & { currentModeId?: string }) | undefined
        for (;;) {
          await this.initialize(current, quirks.clientFs === true)
          input.signal?.throwIfAborted()
          const mcpServers = sessionMcpServers(input.mcp, { http: current.mcpHttp === true && quirks.mcp !== 'stdio' })
          current.mcpToken = mcpToken
          current.relayKey = relayKey
          session = undefined
          if (saved?.cwd === input.cwd && saved.historyKey === historyKey) {
            const reopenedId = saved.sessionId
            try {
              let reopened = true
              if (quirks.preferResume) session = await current.connection.agent.request(methods.agent.session.resume, { sessionId: reopenedId, cwd: input.cwd, mcpServers })
              else {
                // Setup metadata of a load replay applies; replayed conversation is dropped.
                current.onUpdate = onUpdate
                const loaded = await this.reopen(current, saved, input, mcpServers)
                reopened = loaded !== null
                if (loaded) {
                  session = loaded.response
                  known = { ...saved.setup, ...(loaded.currentModeId ? { currentModeId: loaded.currentModeId } : {}) }
                }
              }
              if (reopened) {
                current.sessionId = reopenedId
                resumed = true
              }
            } catch (error) {
              if (error instanceof SessionLoadTimeoutError) {
                // The process is gone and the session forgotten: a fresh one gets the history.
                this.processes.delete(current)
                this.turning.delete(current)
                saved = undefined
                this.options.notice?.(input.threadId, `${label} did not reopen this chat's session in time, so the chat history was handed to a new session.`)
                await this.options.beforeLaunch?.('turn')
                adopt(this.launch('turn', undefined, input.botAuthority ? true : undefined))
                freshProcess = true
                continue
              }
              input.signal?.throwIfAborted()
              current.connection.signal.throwIfAborted()
            }
          }
          if (!current.sessionId) {
            const created = await current.connection.agent.request(methods.agent.session.new, { cwd: input.cwd, mcpServers })
            current.sessionId = created.sessionId
            session = created
          }
          break
        }
        input.signal?.throwIfAborted()
        // Until the owning turn commits its updated history, this ACP session is
        // deliberately non-resumable after a crash or a failed/aborted prompt (an
        // agent that resumes by `session/resume` may be fingerprinted after one: `commitInterrupted`).
        // A resumed session keeps the instructions it was given; a new one has none yet.
        current.instructionsHash = resumed ? saved?.instructionsHash : undefined
        const instructions = current.instructionsHash ? { instructionsHash: current.instructionsHash } : {}
        store.setSaved(input.threadId, { sessionId: current.sessionId!, cwd: input.cwd, instanceId, ...instructions })
        if (quirks.modelConfigId) {
          const models = modelOptions((session ?? {}) as Pick<NewSessionResponse, 'configOptions'> & Record<string, unknown>)
          if (models.length) store.setModels(models)
          current.thoughtConfig = thoughtConfigOption(session)
        } else {
          this.observeSession(current, session ?? {}, known)
          store.setSaved(input.threadId, {
            sessionId: current.sessionId!, cwd: input.cwd, instanceId, ...instructions,
            setup: {
              ...(current.modelControl ? { modelControl: current.modelControl } : {}),
              ...(current.thoughtConfig ? { thoughtConfig: current.thoughtConfig } : {}),
              modes: current.modes ?? [],
              ...(current.defaultModeId ? { defaultModeId: current.defaultModeId } : {})
            }
          })
        }
        this.sessions.set(input.threadId, current)
      }
      active = current
      active.onUpdate = claimedContinuation
        ? (update) => {
            onUpdate(update)
            if (claimedContinuation && !claimedContinuation.settled) this.trackContinuationUpdate(active!, claimedContinuation, update)
          }
        : onUpdate
      if (!active.sessionId) throw new Error(`${label} session was not created`)
      input.onSession?.(active.sessionId)
      if (!claimedContinuation) {
        await this.selectModel(active, input.model)
        if (!quirks.modelConfigId) await this.selectMode(active, input.mode)
      }
      input.signal?.throwIfAborted()
      const imageBlocks = (input.images ?? []).map((image) => {
        const block = acpImageBlock(image)
        if (!block) throw new Error(`${label} cannot send image ${image.name}; use BMP, JPEG, PNG, or WebP under 10 MiB`)
        return block
      })
      let cancelSent = false
      const turnProcess = active
      // The hold (docs/design/steer-and-interruptions.md §2.7): a person's steer waits while a tool runs. While a prompt
      // runs only a cut is taken, unless the agent steers natively: then whatever may go in now joins the running work as
      // a second prompt. Between prompts (the boundary), whatever can go in joins the next prompt.
      const holds = Boolean(input.peekSteer && input.drainSteerEntry)
      const native = () => prompting && !cancelSent && steersNatively(quirks, turnProcess)
      const drain = (): DrainedSteer | undefined => {
        if (holds) {
          const delivery = input.peekSteer!()?.delivery
          const now: Array<'cut' | 'native'> = prompting && !native() ? ['cut'] : ['cut', 'native']
          if (!delivery || delivery === 'hold' || !now.includes(delivery)) return undefined
          return input.drainSteerEntry!({ expect: now })
        }
        if (input.drainSteerEntry) return input.drainSteerEntry()
        const text = input.drainSteer?.()
        return text ? { text } : undefined
      }
      /** Cancels the running prompt for the drained steers: the next prompt carries them. */
      const cut = (): void => {
        cancelSent = true
        questions.autoRejectPendingForThread(input.threadId)
        if (claimedContinuation && !claimedContinuation.settled) {
          void turnProcess.connection.agent.notify(methods.agent.session.cancel, { sessionId: turnProcess.sessionId! }).catch(() => undefined)
          this.settleContinuation(claimedContinuation)
          return
        }
        // The same cancel and deadline as a stop: an agent that does not stop for the steer is
        // ended, and the turn fails rather than replaying a request whose outcome is unknown.
        void interruptWithDeadline({
          interrupt: async () => {
            await turnProcess.connection.agent.notify(methods.agent.session.cancel, { sessionId: turnProcess.sessionId! })
            await turnProcess.prompting
            return 'interrupted'
          },
          terminate: () => {
            steerFailure ??= new Error(`${label} did not stop for the new guidance, so it was ended. Send the guidance again.`)
            closeAcpConnection(turnProcess)
            this.sessions.delete(input.threadId)
          },
          forgetConversation: (threadId) => this.forgetConversation(threadId)
        }, { provider: '', ...(turnProcess.sessionId ? { sessionId: turnProcess.sessionId } : {}) }, { threadId: input.threadId, ...(this.options.cancelDeadlineMs !== undefined ? { deadlineMs: this.options.cancelDeadlineMs } : {}) })
          .catch((error) => { steerFailure ??= error; this.close(turnProcess) })
      }
      /**
       * Sends the drained steers as a second prompt into the running one, with no cancel: nothing the agent does now is
       * stopped. They are read once the running prompt has answered (the agent took them in) and the agent works on
       * them or answers; an error answer before that hands them back, and this process cuts from then on.
       */
      const sendNative = (): void => {
        const steers = pendingSteers.splice(0)
        const reply = turnProcess.connection.agent.request(methods.agent.session.prompt, { sessionId: turnProcess.sessionId!,
          prompt: [{ type: 'text' as const, text: steers.map((entry) => entry.text).join('\n') }, ...steerImageBlocks(steers)] })
        const sent = { reply, steers }
        riding = sent
        // A stop's cancel ends both prompts: it waits for the second one too.
        const running = turnProcess.prompting
        turnProcess.prompting = Promise.all([running, reply.then(() => undefined, () => undefined)]).then(() => undefined)
        if (claimedContinuation && !claimedContinuation.settled) this.settleContinuation(claimedContinuation)
        reply.catch((error: unknown) => {
          // Only an error answer while the first prompt still runs is a refusal; a closed connection ends the turn anyway.
          const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
          if (riding !== sent || typeof code !== 'number' || input.signal?.aborted) return
          riding = undefined
          turnProcess.nativeSteerRefused = true
          console.warn('[acp] the agent refused a steer sent as a second prompt; it is cut in instead', { code })
          for (const entry of sent.steers.splice(0)) {
            if (entry.token) input.returnSteer?.(entry.text, entry.token)
            else pendingSteers.push(entry)
          }
          if (pendingSteers.length && prompting && !cancelSent) cut()
        })
      }
      const collectSteer = () => {
        if (input.signal?.aborted || steerFailure) return
        // One second prompt at a time: the next steer waits until the running prompt shows the agent took this one.
        if (prompting && riding) return
        try {
          const nativeNow = native()
          const entry = drain()
          const steer = entry?.text.trim()
          if (!entry || !steer) return
          const drained: DrainedSteer = { text: steer, ...(entry.token ? { token: entry.token } : {}), ...(entry.images?.length ? { images: entry.images } : {}) }
          // The check at dispatch: a tool that started since the decision is not cancelled for this steer (a native
          // steer cancels nothing).
          if (prompting && !cancelSent && !nativeNow && drained.token && input.mayCut && !input.mayCut(drained.token)) {
            input.returnSteer?.(drained.text, drained.token)
            return
          }
          // A drain without a token keeps the old rule: read when it is drained.
          if (!drained.token) input.onSteer?.(steer)
          pendingSteers.push(drained)
          if (nativeNow) sendNative()
          else if (prompting && !cancelSent) cut()
        } catch (error) { steerFailure = error; this.close(turnProcess) }
      }
      steerTimer = setInterval(collectSteer, 100)
      steerTimer.unref?.()
      const history = !resumed && input.history
        ? `Previous conversation (context only; do not repeat earlier actions):\n${input.history}\n\nCurrent request:\n`
        : ''
      // The session's instructions go into its first prompt, and again into a resumed session's prompt
      // when they changed since (their hash is kept with the session). A slash command goes out
      // without them: the next prompt that is not a command carries them.
      const command = slashCommand(input.prompt, active.commands)
      const orchestration = !command && input.orchestrationInstructions && (!resumed || active.instructionsHash !== instructionsHash)
        ? `<mousse_orchestration_instructions>\n${input.orchestrationInstructions}\n</mousse_orchestration_instructions>\n\n`
        : ''
      if (!command && instructionsHash && active.instructionsHash !== instructionsHash) {
        active.instructionsHash = instructionsHash
        const savedNow = store.saved(input.threadId)
        if (savedNow) store.setSaved(input.threadId, { ...savedNow, instructionsHash })
      }
      const preamble = input.turnPreamble ? input.turnPreamble + '\n\nCurrent request:\n' : ''
      // The text blocks of the prompt. A command is the first block alone, as typed, because agents
      // parse a command at the start of the first block; the history the agent needs follows it.
      // (An agent that joins every block before it parses may still read the command literally.)
      let blocks = command
        ? [command, history + preamble].filter((block) => block)
        : [orchestration + history + preamble + (input.prompt || '(image attachment)')]
      let commandTurn = command !== undefined
      let attachments = imageBlocks
      // A native steer's prompt the agent took in: the loop waits on it next, and sends nothing.
      let adopted: Promise<unknown> | undefined
      let botFollowUps = 0
      let runPromptLoop = true
      if (claimedContinuation) {
        claimedContinuation.claimed = true
        prompting = true
        promptSent = true
        input.onProviderTurn?.()
        active.activity = watchSilence
        watchSilence()
        for (const buffered of claimedContinuation.buffer.splice(0)) onUpdate(buffered.update)
        this.wakeAttachWaiters(claimedContinuation)
        // Re-check settle conditions in case a request or buffered update arrived before attach.
        this.maybeRearmContinuation(active)
        await claimedContinuation.done
        if (active.continuation === claimedContinuation) active.continuation = undefined
        if (riding) {
          readCarried()
          const taken = riding
          riding = undefined
          carried.push(...taken.steers.splice(0))
          adopted = taken.reply
          active.prompting ??= adopted.then(() => undefined, () => undefined)
          input.onProviderTurn?.()
          appendTextSeparator()
          watchSilence()
        } else {
          prompting = false
          watchSilence()
          input.signal?.throwIfAborted()
          if (steerFailure) throw steerFailure
          input.onBoundary?.()
          collectSteer()
          if (steerFailure) throw steerFailure
          if (pendingSteers.length) {
            const steers = pendingSteers.splice(0)
            carried.push(...steers)
            blocks = [steers.map((entry) => entry.text).join('\n')]
            commandTurn = false
            attachments = steerImageBlocks(steers)
            appendTextSeparator()
          } else {
            runPromptLoop = false
          }
        }
      }
      if (runPromptLoop) for (;;) {
        input.signal?.throwIfAborted()
        if (steerFailure) throw steerFailure
        let reply: Promise<unknown>
        let promptId: string | undefined
        if (adopted) {
          reply = adopted
          adopted = undefined
        } else {
          collectSteer()
          if (pendingSteers.length) {
            const steers = pendingSteers.splice(0)
            carried.push(...steers)
            const guidance = 'Additional guidance:\n' + steers.map((entry) => entry.text).join('\n')
            if (commandTurn) blocks = [blocks[0], blocks[1] ? `${blocks[1]}\n\n${guidance}` : guidance]
            else blocks = [`${blocks[0]}\n\n${guidance}`]
            // The steers' images join the prompt they ride in.
            attachments = [...attachments, ...steerImageBlocks(steers)]
          }
          prompting = true
          // A boundary the previous prompt's end reported is over.
          input.onProviderTurn?.()
          cancelSent = false
          active.cancelRequested = false
          active.activity = watchSilence
          watchSilence()
          // Any accepted prompt makes the old history fingerprint stale until commit.
          const accepted = store.saved(input.threadId)
          if (accepted) {
            const { historyKey: _stale, ...rest } = accepted
            store.setSaved(input.threadId, rest)
          }
          // xAI: the prompt is tagged, and ends at its reply or its `prompt_complete`, whichever is first.
          promptId = quirks.xaiExtensions ? randomUUID() : undefined
          promptInFlight = promptId
          promptSent = true
          reply = active.connection.agent.request(methods.agent.session.prompt, { sessionId: active.sessionId,
            prompt: [...blocks.map((block) => ({ type: 'text' as const, text: block })), ...attachments], ...(promptId ? { _meta: { promptId } } : {}) })
        }
        const completion = promptId ? this.completionOf(active, promptId) : undefined
        const request: Promise<unknown> = completion ? Promise.race([reply, completion.done]) : reply
        if (completion) reply.catch(() => undefined)
        active.prompting ??= request.then(() => undefined, () => undefined)
        let outcome: unknown
        try {
          outcome = await request
        } catch (error) {
          completion?.dispose()
          throw error
        } finally {
          // A steer's prompt that rides on is still the work a stop waits for.
          active.prompting = riding?.reply.then(() => undefined, () => undefined)
        }
        // The SDK settles an answer at once but hands an update to its handlers a few steps later: what the agent
        // wrote just before it answered (often its whole reply) is still on its way. It lands before the turn ends.
        await new Promise<void>((resolve) => setImmediate(resolve))
        const promptUsage = readAcpPromptUsage(outcome)
        if (promptUsage) turnUsage = addAcpTurnUsage(turnUsage, promptUsage)
        if (riding) {
          // A native steer rides: the prompt answered because the agent took it into the running work (or the prompt
          // was already ending, and it runs next). The steer's prompt carries the turn on, and its end ends the turn,
          // so this answer's stop reason is not the turn's. Its steers are read once the agent works on them or answers.
          readCarried()
          const taken = riding
          riding = undefined
          carried.push(...taken.steers.splice(0))
          adopted = taken.reply
          active.prompting ??= adopted.then(() => undefined, () => undefined)
          completion?.dispose()
          input.onProviderTurn?.()
          appendTextSeparator()
          watchSilence()
          continue
        }
        prompting = false
        // The agent answered the prompt: it has the steers it carried, whatever it says of how it ended.
        readCarried()
        watchSilence()
        if (completion) {
          // A steer's cancel: the next prompt waits (briefly) for the cancelled task to report its end.
          if (cancelSent) {
            let timer: ReturnType<typeof setTimeout> | undefined
            const ended = await Promise.race([completion.done.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), PROMPT_COMPLETE_WAIT_MS) })])
            clearTimeout(timer)
            // Its end did not come: it may still send updates while the next prompt runs.
            if (!ended) earlierMayTrail = true
          }
          completion.dispose()
          // However the prompt ended, a refusal or an error is never a finished turn.
          const failure = cancelSent || input.signal?.aborted ? undefined : xaiStopFailure(label, outcome)
          if (failure) throw failure
        }
        if (!cancelSent && !active.cancelRequested && !input.signal?.aborted) {
          // The agent's own word on how the prompt ended (its reply, or xAI's `prompt_complete`): a
          // refusal or a limit is never a clean success, and a cancel Mousse did not ask for is an
          // interruption.
          const ended = promptStopOutcome(label, outcome)
          if (ended === 'cancelled') throw agentCancelledError(label)
          if (ended) throw ended
          // agy ends a prompt normally whose reply is its quota notice: the turn failed, and the run pauses.
          const quota = this.options.usageLimitProvider ? acpQuotaReply(text, this.options.usageLimitProvider) : undefined
          if (quota) throw quota
        }
        input.signal?.throwIfAborted()
        if (steerFailure) throw steerFailure
        // The prompt is over and none of its tools runs: a held steer goes in as the next prompt, with no cancel
        // (strict release waits for this).
        input.onBoundary?.()
        collectSteer()
        if (steerFailure) throw steerFailure
        if (!pendingSteers.length) {
          // A bot's turn whose authority refused something: the agent is told and goes on (it may have stopped there).
          const refusals = active.turnBot ? active.botRefusals?.splice(0) ?? [] : []
          if (!refusals.length || botFollowUps >= BOT_REFUSAL_FOLLOW_UPS) break
          botFollowUps += 1
          blocks = [botRefusalFollowUp(refusals)]
          commandTurn = false
          attachments = []
          appendTextSeparator()
          continue
        }
        const steers = pendingSteers.splice(0)
        carried.push(...steers)
        blocks = [steers.map((entry) => entry.text).join('\n')]
        commandTurn = false
        attachments = steerImageBlocks(steers)
        appendTextSeparator()
      }
      for (const sub of launchedSubagents.values()) {
        if (sub.sawTextInStep) {
          sub.textResponses += 1
          sub.sawTextInStep = false
        }
      }
      for (const [callId, tracked] of openTools) {
        if (quirks.backgroundWork && !input.bot && tracked.name === 'run_command') {
          input.onTool?.({ phase: 'complete', callId, title: tracked.title, toolName: tracked.name, status: 'background' })
          active.mayWake = true
          if (!tracked.isDaemon) {
            ;(active.backgroundTasks ??= new Map()).set(callId, { callId, kind: 'command', description: tracked.description, startedAt: tracked.startedAt })
          }
        } else {
          input.onTool?.({
            phase: 'complete',
            callId,
            title: tracked.title,
            ...(tracked.name ? { toolName: tracked.name } : {}),
            ...(tracked.useToolTarget ? { useToolTarget: tracked.useToolTarget } : {}),
            status: 'unfinished'
          })
        }
      }
      if (quirks.backgroundWork && !input.bot) {
        for (const sub of launchedSubagents.values()) {
          active.mayWake = true
          if (sub.textResponses >= 2) {
            try {
              this.liveHost?.taskEnded?.(input.threadId, {
                toolUseId: sub.callId,
                taskId: sub.callId,
                status: 'completed',
                durationMs: Math.max(0, Date.now() - sub.startedAt)
              })
            } catch { /* best effort */ }
          } else {
            ;(active.backgroundTasks ??= new Map()).set(sub.callId, { callId: sub.callId, kind: 'subagent', description: sub.description, startedAt: sub.startedAt })
          }
        }
        if (claimedContinuation) {
          for (const callId of priorSubagentIds) {
            const task = active.backgroundTasks?.get(callId)
            if (!task) continue
            active.backgroundTasks!.delete(callId)
            try {
              this.liveHost?.taskEnded?.(input.threadId, {
                toolUseId: task.callId,
                taskId: task.callId,
                status: 'completed',
                durationMs: Math.max(0, Date.now() - task.startedAt)
              })
            } catch { /* best effort */ }
          }
        }
        this.syncBackgroundWork(active)
      }
      if (turnUsage) input.onUsage?.(turnUsage)
      return text
    } catch (error) {
      // An agent that reopens a saved session by `session/resume` keeps it after a failed or stopped prompt. The next
      // turn may resume it when the agent holds what Mousse's history then says: a prompt of this turn reached it, the
      // session already held the conversation before it (resumed or reused) or the agent worked on it (a new session's
      // first prompt carries the handed-over history, which the agent may not have kept if it never started), and no
      // steer is in doubt (one a prompt carried that the agent never showed it read goes back and runs again, so
      // Mousse's history lacks what the agent may hold). The adapter then fingerprints it (`commitInterrupted`).
      const steerInDoubt = steerFailure !== undefined || carried.some((entry) => entry.token)
      const sessionId = current.sessionId
      if (quirks.preferResume && promptSent && (resumed || worked) && !steerInDoubt && sessionId && store.saved(input.threadId)?.sessionId === sessionId)
        this.interrupted.set(input.threadId, sessionId)
      // Drained steers no prompt delivered go back; they run as the follow-up.
      handBack()
      this.clearBackgroundState(current)
      this.failContinuation(current, error instanceof Error ? error : new Error(String(error)))
      this.close(current)
      this.sessions.delete(input.threadId)
      if (steerFailure) throw steerFailure
      if (silenceFailure && !input.signal?.aborted) throw silenceFailure
      // A sign-in the agent asks for is a sign-in; any other error the agent answered with is shown in its words.
      throw this.authRequiredError(current, error) ?? (input.signal?.aborted ? undefined : acpAgentError(error, this.options.usageLimitProvider)) ?? error
    } finally {
      clearTimeout(silenceTimer)
      current.activity = undefined
      if (steerTimer) clearInterval(steerTimer)
      input.signal?.removeEventListener('abort', abort)
      current.onUpdate = (update, sessionId) => this.handleRestingUpdate(current, update, sessionId)
      current.turnSignal = undefined
      current.turnPrompter = undefined
      current.turnToolAwaiting = undefined
      current.permissionMode = undefined
      current.turnBot = undefined
      current.botMcp = undefined
      current.botToolName = undefined
      current.botRefusals = undefined
      this.turning.delete(current)
      // A bot's native command or helper may outlive its tool call. End the process tree with the turn.
      if (input.botAuthority) this.close(current)
      else this.armIdleClose(current)
    }
  }

  /**
   * One request with no tools (`DriverRuntime.oneShot`): a chat title, a pull request draft or a commit message. A
   * fresh agent process and session of its own in `cwd` (an empty folder the caller made for it), where the process
   * also starts, with no MCP server and no client file system, in the agent's `default` mode when it has one. The
   * prompt is {@link ONE_SHOT_INSTRUCTION}, the system text and the prompt. Every permission, file, terminal or
   * unknown request and every question is refused, and so is any tool call the agent reports; each ends the request
   * as `one_shot_tool_refused`. The answer is the agent's text, ended past {@link ONE_SHOT_OUTPUT_CAP} characters or
   * {@link ONE_SHOT_DEADLINE_MS}. One attempt, never saved or resumed; `signal` stops it. The process tree is ended
   * while the refusals still listen, so a tool it reports while it ends refuses the answer too, and is waited for up
   * to {@link ONE_SHOT_REAP_MS}: one still running then fails the request, and `onEnded` says when it has gone.
   */
  async oneShot(input: OneShotInput): Promise<string> {
    const { label, quirks } = this.options
    input.signal.throwIfAborted()
    // xAI's tagged prompts end on a notice this request does not wait for.
    if (quirks.xaiExtensions) throw harnessAppError({ code: 'unsupported', message: `${label} cannot run a single request.` })
    let active: AcpProcess
    try {
      await this.options.beforeLaunch?.('one_shot')
      input.signal.throwIfAborted()
      active = this.launch('one_shot', undefined, undefined, input.cwd)
    } catch (error) {
      // Nothing started: nothing of this request runs on.
      input.onEnded?.()
      throw error
    }
    active.cwd = input.cwd
    input.onStarted?.(active.child.pid)
    // Registered first, so the caller hears of the end before this request settles on it (`reaped`).
    if (active.exited) void active.exited.then(() => input.onEnded?.())
    else input.onEnded?.()
    let failed: Error | undefined
    const fail = (error: Error) => {
      failed ??= error
      closeAcpConnection(active)
    }
    // Set before `initialize`: whatever the agent asks for from its start is refused.
    active.refuseTools = (what) => fail(harnessAppError({ code: 'one_shot_tool_refused', message: `${label} tried to use a tool (${what}) in a request that runs none, so Mousse stopped it.` }))
    const deadlineMs = input.deadlineMs ?? ONE_SHOT_DEADLINE_MS
    const deadline = setTimeout(() => fail(harnessAppError({ code: 'timeout', message: `${label} did not answer within ${Math.round(deadlineMs / 1000)} seconds.` })), deadlineMs)
    deadline.unref?.()
    const cap = input.outputCap ?? ONE_SHOT_OUTPUT_CAP
    let text = ''
    let prompting = false
    // From the start too: a tool call before any prompt is refused like one during it.
    active.onUpdate = (update) => {
      if (!update || typeof update !== 'object' || failed) return
      const event = update as { sessionUpdate?: string; content?: { type?: string; text?: string }; title?: string; name?: string }
      // A tool is refused before anything else runs, a slow activity callback included.
      if (event.sessionUpdate === 'tool_call' || event.sessionUpdate === 'tool_call_update') {
        active.refuseTools?.(event.title ?? event.name ?? 'a tool')
        return
      }
      if (!prompting) return
      input.onActivity()
      if (event.sessionUpdate === 'agent_message_chunk' && event.content?.type === 'text') {
        text += event.content.text ?? ''
        if (text.length > cap) fail(harnessAppError({ code: 'protocol', message: `${label} wrote more than ${cap.toLocaleString('en-US')} characters, so Mousse stopped it.` }))
      }
    }
    const abort = () => closeAcpConnection(active)
    input.signal.addEventListener('abort', abort, { once: true })
    try {
      await this.initialize(active)
      input.signal.throwIfAborted()
      input.onActivity()
      const session = await active.connection.agent.request(methods.agent.session.new, { cwd: input.cwd, mcpServers: [] })
      active.sessionId = session.sessionId
      input.onSession?.(session.sessionId)
      input.signal.throwIfAborted()
      input.onActivity()
      // The session's model control, read without recording anything: this session is not the profile's.
      active.thoughtConfig = thoughtConfigOption(session)
      if (!quirks.modelConfigId) active.modelControl = agentModels(session, active.info?.meta).control
      await this.selectModel(active, input.model)
      input.signal.throwIfAborted()
      // The agent's `default` mode, where one is listed: it asks before it edits, and every ask is refused.
      const modes = agentModes(session)
      if (modes.current !== ONE_SHOT_MODE && modes.modes.some((mode) => mode.id === ONE_SHOT_MODE)) {
        await active.connection.agent.request(methods.agent.session.setMode, { sessionId: active.sessionId, modeId: ONE_SHOT_MODE })
        input.signal.throwIfAborted()
      }
      if (failed) throw failed
      const prompt = [ONE_SHOT_INSTRUCTION, input.system, input.prompt].filter((part) => part.trim()).join('\n\n')
      prompting = true
      const outcome = await active.connection.agent.request(methods.agent.session.prompt, { sessionId: active.sessionId, prompt: [{ type: 'text', text: prompt }] })
      // What the agent wrote just before it answered is still on its way (see `chat`).
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (failed) throw failed
      input.signal.throwIfAborted()
      const ended = promptStopOutcome(label, outcome)
      if (ended === 'cancelled') throw agentCancelledError(label)
      if (ended) throw ended
      return text
    } catch (error) {
      if (failed) throw failed
      if (input.signal.aborted) throw error
      if (input.signInUnverified && isAuthRequired(error)) throw harnessAppError({ code: 'signed_out', message: `${label} answered that this request is not signed in.` })
      throw this.authRequiredError(active, error) ?? acpAgentError(error) ?? error
    } finally {
      clearTimeout(deadline)
      input.signal.removeEventListener('abort', abort)
      // The tree ends first, while the connection still listens: `refuseTools` and `onUpdate` stay until it has gone,
      // so a tool reported or requested while it ends still refuses the answer.
      if (active.child.exitCode === null && active.child.signalCode === null) active.child.kill()
      let gone: unknown
      try {
        await reaped(active)
      } catch (error) {
        gone = error
        closeAcpConnection(active)
      }
      active.onUpdate = undefined
      // A refusal seen while the process ended outranks the answer, and a process that did not end (`ONE_SHOT_REAP_MS`).
      if (failed) throw failed
      if (gone) throw gone
    }
  }

  /** Whether any agent process runs a turn or holds active background work now. */
  busy(): boolean {
    if (this.turning.size > 0) return true
    for (const active of this.sessions.values()) {
      if (this.hasBackgroundWork(active) || (active.continuation && !active.continuation.discarded)) return true
    }
    return false
  }

  /** Idle agent processes close now; a busy one (or one with background work) is replaced on that thread's next turn. */
  closeIdle(): void {
    for (const [threadId, active] of this.sessions) {
      if (!this.isIdle(active)) continue
      this.disarmIdleClose(active)
      this.close(active)
      this.sessions.delete(threadId)
    }
  }

  closeAll(): void {
    for (const active of this.processes) {
      this.disarmIdleClose(active)
      this.clearBackgroundState(active)
      this.failContinuation(active, new Error(`${this.options.label} provider closed`))
      closeAcpConnection(active)
    }
    this.sessions.clear()
    this.stoppedForResume.clear()
  }

  stop(): void {
    this.stopped = true
    this.closeAll()
  }
}
