import { ROUTED_AGENT_BOT_KEY, ROUTED_DEADLINE_KEY, ROUTED_METHODS, type RoutedAgentBot, type RoutedAgentMark } from '../../shared/bridge/routed'
import { isPermissionMode, narrowPermissionMode, type PermissionMode } from '../../shared/permissionMode'
import { DomainRpcError } from '../protocol/domainRegistry'

/**
 * Starting work in a thread on another of the user's computers: the sequence remote subagents (issue #469) and
 * `thread_create` with `computer` (issue #1160) share. Each step is one routed call to that computer:
 *
 *   threads.create → threads.setModel → composer.options → threads.setPermissionMode → orchestrator.send
 *
 * Every write carries its own idempotency key, made from the start's key, so a step sent again after a lost reply, a
 * restart or a retry reaches the first execution there and never acts twice. The mode's key also names the mode: it is
 * narrowed afresh each time, and the other computer refuses one key used for different words. Every write carries the
 * agent mark when the start has one (`mark`).
 *
 * The steps already done are read from the caller's own durable row (`remoteThreadId`), and `created` is called with
 * the far thread's id before anything else happens, so the caller records it first. A failure throws a `DomainRpcError`
 * with what the call said; the caller decides whether it was for good (`REMOTE_START_TRANSIENT`).
 */

/** Codes of failures that say nothing about the call itself: the next attempt tries again. */
export const REMOTE_START_TRANSIENT: ReadonlySet<string> = new Set([
  'computer_offline',
  'deadline_exceeded',
  'rate_limited',
  'cancelled',
  'outcome_uncertain',
  'result_expired',
  'bad_reply',
  'bridge_off'
])

/** The idempotency keys of one start's writes, from its own key (`<key>:create`, `<key>:model`, …). */
export function remoteStartKeys(key: string, mode?: PermissionMode) {
  return {
    create: `${key}:create`,
    model: `${key}:model`,
    mode: `${key}:mode${mode ? `:${mode}` : ''}`,
    send: `${key}:send`
  }
}

export interface RemoteThreadStart {
  /** The key every step's idempotency key is made from. */
  key: string
  /** The far thread's name. */
  name: string
  /** The far project that is the same repository; null for a thread with no project. */
  projectId: string | null
  worktree: boolean
  /**
   * Whether that computer keeps the thread out of its sidebar; sent only when given (none shows it, as before) and
   * dropped for a computer from before it (`ROUTED_DROPPABLE_KEYS`).
   */
  hidden?: boolean
  /**
   * The thread is the marking agent's subagent (`ThreadStartedFrom.agent.subagent` there); sent only when true and with
   * the mark, and dropped for a computer from before it (`ROUTED_DROPPABLE_KEYS`).
   */
  subagent?: true
  /** The model chosen with the thread (both, or neither: that computer's default). */
  instanceId: string | null
  model: string | null
  /** The most the work may run in there, before that computer's limit for this one narrows it. */
  permissionMode: PermissionMode
  /** The far thread when an earlier step made it (or a follow-up on an existing thread); null before. */
  remoteThreadId: string | null
  /**
   * Set the model on an existing `remoteThreadId` too: a launch an earlier attempt cut off after the create. Without
   * it the model is set only with the create that made the thread (a follow-up keeps the model its thread has there).
   */
  modelPending?: boolean
  /** The agent mark of every write; empty for an unmarked start (a remote subagent on an older computer). */
  mark: Record<string, RoutedAgentMark>
  /** What is sent once the thread is set up; none for a thread that only needs to exist. */
  message?: {
    content: string
    clientRequestId: string
    /** A follow-up on a thread that may be paused by a usage limit refuses instead of waiting. */
    refuseWhilePaused?: boolean
    /** The minutes of running time the run may use there (`ROUTED_DEADLINE_KEY`); only to a computer that takes it. */
    deadlineMinutes?: number
    /** The personal bot it is sent as (`ROUTED_AGENT_BOT_KEY`), sent only with the mark. */
    bot?: RoutedAgentBot
  }
}

export interface RemoteThreadStartIo {
  /** One routed call to that computer. */
  call(method: string, params: Record<string, unknown>, idem?: string): Promise<unknown>
  /** The far thread exists: record it before anything else. */
  created(remoteThreadId: string): void
  /** That computer's name, for messages. */
  computerName: string
}

export interface RemoteThreadStarted {
  remoteThreadId: string
  /** The mode the thread was set to there. */
  mode: PermissionMode
  /** `orchestrator.send`'s answer as it came: the caller reads `runId`, `queued` or a refusal from it. */
  sent?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** The far run `orchestrator.send` answered with, or undefined (queued, or refused in its answer). */
export function sentRunId(sent: unknown): string | undefined {
  return isRecord(sent) && typeof sent.runId === 'string' ? sent.runId : undefined
}

/** Why `orchestrator.send` started nothing, from its answer. */
export function sendRefusal(sent: unknown, name: string, what = 'the task'): { code: string; message: string } {
  const message = isRecord(sent) && isRecord(sent.error) && typeof sent.error.message === 'string' ? sent.error.message : `${name} did not start ${what}.`
  return { code: isRecord(sent) && sent.queued ? 'subagent_busy' : 'remote_refused', message }
}

/**
 * The `hidden` a create of a new thread on `node` sends, from what is stored (`stored`; null sends none). A computer from
 * before `hidden` on `threads.create` is sent the create without it (`routedParamsForOwner`), so the choice becomes none
 * and `drop` stores that before anything goes out: every retry then sends what the first attempt put on the wire, even
 * after that computer is updated, and is never taken as another request under the same key. Asked only before the
 * thread exists there; a port that cannot tell the versions keeps the stored choice.
 */
export async function hiddenOnTheWire(
  port: VersionsPort,
  node: string,
  stored: boolean | null,
  created: boolean,
  drop: () => void,
  signal?: AbortSignal
): Promise<boolean | null> {
  return createKeyOnTheWire('hidden', port, node, stored, created, drop, signal)
}

/** The same as `hiddenOnTheWire`, for `subagent`: the create of a remote subagent's thread says it is one. */
export async function subagentOnTheWire(
  port: VersionsPort,
  node: string,
  stored: boolean | null,
  created: boolean,
  drop: () => void,
  signal?: AbortSignal
): Promise<boolean | null> {
  return createKeyOnTheWire('subagent', port, node, stored, created, drop, signal)
}

type VersionsPort = { versions?(node: string, signal?: AbortSignal): Promise<Record<string, number> | undefined> }

async function createKeyOnTheWire(
  key: 'hidden' | 'subagent',
  port: VersionsPort,
  node: string,
  stored: boolean | null,
  created: boolean,
  drop: () => void,
  signal?: AbortSignal
): Promise<boolean | null> {
  if (stored === null || created || !port.versions) return stored
  const versions = await port.versions(node, signal)
  if ((versions?.['threads.create'] ?? 0) >= (ROUTED_METHODS['threads.create']?.since?.[key] ?? 1)) return stored
  drop()
  return null
}

/**
 * Runs the steps not yet done. `setModel` runs with the create that made the thread, or while `modelPending`; the mode is
 * set before every send, so a follow-up runs no looser than the run that sent it.
 */
export async function runRemoteThreadStart(start: RemoteThreadStart, io: RemoteThreadStartIo): Promise<RemoteThreadStarted> {
  const keys = remoteStartKeys(start.key)
  let remoteThreadId = start.remoteThreadId
  let made = false
  if (!remoteThreadId) {
    const created = await io.call('threads.create', {
      name: start.name,
      ...(start.projectId ? { projectId: start.projectId } : {}),
      worktreeEnabled: start.worktree,
      ...(start.hidden !== undefined ? { hidden: start.hidden } : {}),
      ...(start.subagent && Object.keys(start.mark).length > 0 ? { subagent: true } : {}),
      ...start.mark
    }, keys.create)
    const thread = isRecord(created) && isRecord(created.thread) ? created.thread : undefined
    if (typeof thread?.id !== 'string') throw new DomainRpcError('bad_reply', `${io.computerName} did not say which thread it created.`)
    remoteThreadId = thread.id
    made = true
    io.created(remoteThreadId)
  }
  if (start.instanceId && (made || start.modelPending))
    await io.call('threads.setModel', { threadId: remoteThreadId, model: { instanceId: start.instanceId, model: start.model ?? '' }, ...start.mark }, keys.model)
  // That computer refuses a mode above the limit it set for this one, so the mode is first narrowed to that limit.
  const options = await io.call('composer.options', {})
  const permission = isRecord(options) && isRecord(options.permission) ? options.permission : undefined
  const mode = narrowPermissionMode(start.permissionMode, isPermissionMode(permission?.limit) ? permission.limit : undefined)
  await io.call('threads.setPermissionMode', { threadId: remoteThreadId, mode, ...start.mark }, remoteStartKeys(start.key, mode).mode)
  if (!start.message) return { remoteThreadId, mode }
  const sent = await io.call('orchestrator.send', {
    threadId: remoteThreadId,
    content: start.message.content,
    clientRequestId: start.message.clientRequestId,
    ...(start.message.refuseWhilePaused ? { refuseWhilePaused: true } : {}),
    ...(start.message.deadlineMinutes ? { [ROUTED_DEADLINE_KEY]: start.message.deadlineMinutes } : {}),
    ...(start.message.bot && Object.keys(start.mark).length > 0 ? { [ROUTED_AGENT_BOT_KEY]: start.message.bot } : {}),
    ...start.mark
  }, keys.send)
  return { remoteThreadId, mode, sent }
}
