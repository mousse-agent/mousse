import { createHash } from 'node:crypto'
import { NetError, type NodeId } from '../../../shared/net'
import { isPermissionMode, isStricter, narrowPermissionMode, type PermissionMode } from '../../../shared/permissionMode'
import {
  ROUTED_AGENT_BODY_MAX,
  ROUTED_AGENT_BOT_KEY,
  ROUTED_AGENT_KEY,
  ROUTED_AGENT_METHODS,
  ROUTED_AGENT_TITLE_MAX,
  ROUTED_DEADLINE_KEY,
  type RoutedAgentMark
} from '../../../shared/bridge/routed'
import { normalizeBotLook, type KnownBotLook } from '../../../shared/bots/personal/look'
import type { Thread } from '../../../shared/types'
import type { MmsProfileServices } from '../../MmsProfileServices'
import { AGENT_MESSAGE_MAX_HOPS } from '../../orchestrator/OrchestratorService'
import { DomainRpcError } from '../../protocol/domainRegistry'
import { cleanRemoteSenderTitle } from '../../run/mcp/appTools/agentMessage'
import type { AgentActor } from '../../run/types'
import type { Clock } from '../../net/contracts'
import type { SqliteBridgeAudit } from '../../net/store/audit'
import type { AgentReach, SqliteNodePolicy } from '../../net/store/nodePolicy'

/**
 * The owner side of a routed call another computer marked as an agent's (`ROUTED_AGENT_KEY`, issue #1160).
 *
 * The mark only narrows. This computer cannot tell whether a call really came from an agent (a process that controls
 * the calling computer can send unmarked calls), so a marked call does strictly less than the same call from a person
 * there: it runs as an agent's (source `mcp`, never "Always" rules or `person_turn`), in the narrowest mode, with an
 * envelope this computer builds, inside this computer's own limits, and only on the threads the device's agents may
 * change here (`NodePolicy.agentReach`). The device limit, the block and the audit stay the controls against a computer
 * that is not trusted.
 *
 * Nothing about the sender is looked up as if it were here: the calling computer comes from the authenticated link, its
 * name from this computer's pairing record, and the sender's thread, run, title, hops and mode from the mark, each
 * cleaned and only ever used to narrow (`RemoteAgentActor`).
 */

/** Marked messages (sends, queued messages and steers) a device's agents may send one thread in `RATE_WINDOW_MS`. */
export const REMOTE_AGENT_RATE_LIMIT = 20
export const REMOTE_AGENT_RATE_WINDOW_MS = 10 * 60_000
/** Runs a device's agents may start here in a day (sends and queued messages that went through). */
export const REMOTE_AGENT_DAILY_RUNS = 200
const DAY_MS = 24 * 60 * 60_000
/** The longest id in a mark. */
const MARK_ID_MAX = 256

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * The mark as the owner takes it: exactly its five fields, ids that are short text, a title (cleaned and cut later), a
 * whole hop count of 1 or more, and a mode. A mode this version does not know reads as Ask, the strictest.
 */
export function parseRoutedAgentMark(value: unknown): RoutedAgentMark & { mode: PermissionMode } {
  if (!isRecord(value)) throw new NetError('bad_request', `${ROUTED_AGENT_KEY} names the agent that makes the call.`)
  for (const key of Object.keys(value))
    if (!['thread', 'run', 'title', 'hops', 'mode'].includes(key)) throw new NetError('bad_request', `${ROUTED_AGENT_KEY} does not take ${key}.`)
  const id = (key: 'thread' | 'run'): string => {
    const raw = value[key]
    if (typeof raw !== 'string' || !raw || raw.length > MARK_ID_MAX || raw.includes('\0')) throw new NetError('bad_request', `${ROUTED_AGENT_KEY}.${key} is not valid.`)
    return raw
  }
  if (typeof value.title !== 'string' || value.title.length > 4 * ROUTED_AGENT_TITLE_MAX) throw new NetError('bad_request', `${ROUTED_AGENT_KEY}.title is not valid.`)
  if (!Number.isSafeInteger(value.hops) || (value.hops as number) < 1 || (value.hops as number) > 1000) throw new NetError('bad_request', `${ROUTED_AGENT_KEY}.hops is not valid.`)
  if (typeof value.mode !== 'string' || value.mode.length > 32) throw new NetError('bad_request', `${ROUTED_AGENT_KEY}.mode is not valid.`)
  return { thread: id('thread'), run: id('run'), title: value.title, hops: value.hops as number, mode: isPermissionMode(value.mode) ? value.mode : 'ask' }
}

const LOOK_KEYS = ['colour', 'accessory', 'kind', 'eyes', 'eyeColour'] as const

/**
 * The personal bot behind an agent's message (`ROUTED_AGENT_BOT_KEY`), as the owner shows it: an id of short text, a
 * name cleaned and cut like a sender's title, and a look of known values only (`normalizeBotLook`). Display only: it
 * changes how the message is labelled, never what the call may do.
 */
export function parseRoutedAgentBot(value: unknown): { id: string; name: string; look: KnownBotLook } {
  const bad = (): NetError => new NetError('bad_request', `${ROUTED_AGENT_BOT_KEY} is not valid.`)
  if (!isRecord(value)) throw bad()
  for (const key of Object.keys(value)) if (!['id', 'name', 'look'].includes(key)) throw bad()
  if (typeof value.id !== 'string' || !value.id || value.id.length > MARK_ID_MAX || value.id.includes('\0')) throw bad()
  if (typeof value.name !== 'string' || value.name.length > 4 * ROUTED_AGENT_TITLE_MAX) throw bad()
  const name = cleanRemoteSenderTitle(value.name, ROUTED_AGENT_TITLE_MAX)
  if (!name) throw bad()
  const look = value.look
  if (look !== undefined) {
    if (!isRecord(look)) throw bad()
    for (const [key, field] of Object.entries(look))
      if (!(LOOK_KEYS as readonly string[]).includes(key) || typeof field !== 'string' || field.length > 32) throw bad()
  }
  return { id: value.id, name, look: normalizeBotLook(look as Record<string, string> | undefined) }
}

/** The keys a marked call may carry besides the target and the mark; anything else a person's call takes is refused. */
const MARKED_KEYS: Readonly<Record<string, readonly string[]>> = {
  'threads.create': ['name', 'projectId', 'worktreeEnabled', 'startedFromProjectId', 'hidden', 'subagent'],
  'threads.setModel': ['threadId', 'model', 'ifRevision'],
  'threads.setPermissionMode': ['threadId', 'mode', 'ifRevision'],
  'orchestrator.send': ['threadId', 'content', 'mode', 'clientRequestId', 'requestId', 'refuseWhilePaused', 'forceQueue', ROUTED_DEADLINE_KEY, ROUTED_AGENT_BOT_KEY],
  'queue.enqueue': ['threadId', 'content', 'mode', 'requestId'],
  'orchestrator.steer': ['threadId', 'text', 'runId', 'clientRequestId'],
  'orchestrator.abort': ['threadId', 'runId', 'clientRequestId'],
  'threads.archive': ['threadId', 'archived']
}

/** Whether `method` takes the mark here: the rows of `ROUTED_AGENT_METHODS`, and `threads.archive` (`ROUTED_AGENT_ARCHIVE_SINCE`). */
const takesMark = (method: string): boolean => ROUTED_AGENT_METHODS[method] !== undefined || method === 'threads.archive'

export interface RemoteAgentDeps {
  services: MmsProfileServices
  policy: Pick<SqliteNodePolicy, 'get'>
  audit: Pick<SqliteBridgeAudit, 'countAgentCalls'>
  /** This computer's name for a device, from its pairing record. */
  deviceName: (node: NodeId) => string
  clock: Pick<Clock, 'now'>
}

/** What a marked call runs as: the sender (the calling computer from the authenticated link, the rest from the mark). */
export interface RemoteAgentCall {
  node: NodeId
  mark: RoutedAgentMark & { mode: PermissionMode }
  /** Runs the call the way a person's call from the device runs (`OwnerRoutes`), for what a mark changes nothing in. */
  asPerson: (method: string, params: Record<string, unknown>) => Promise<unknown>
  /** Creates a thread for the device (the backend's `threads.create`), recording who started it and its mode with it. */
  createThread: (params: Record<string, unknown>, started: { agent: NonNullable<NonNullable<Thread['startedFrom']>['agent']>; permissionMode: PermissionMode }) => Promise<unknown>
}

export class RemoteAgentCalls {
  constructor(private readonly deps: RemoteAgentDeps) {}

  /** Runs one marked call. `params` no longer carries the mark. Throws a refusal with its own code. */
  async run(method: string, params: Record<string, unknown>, call: RemoteAgentCall): Promise<unknown> {
    if (!takesMark(method)) throw new NetError('bad_request', `${method} does not take ${ROUTED_AGENT_KEY}.`)
    for (const key of Object.keys(params))
      if (!MARKED_KEYS[method]!.includes(key))
        throw new DomainRpcError('invalid_params', `An agent's ${method} from another computer does not take ${key}.`)
    const { services } = this.deps
    const policy = this.deps.policy.get(call.node)
    // The most the sender may do here: what it runs in, never more than this computer allows its device.
    const mode = narrowPermissionMode(call.mark.mode, policy.maxPermissionMode)
    if (method === 'threads.create') return this.create(params, call, mode, policy.agentReach)
    const threadId = String(params.threadId)
    const thread = services.threads.getThread(threadId)
    if (!thread) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
    const launchedBySender = launchedBy(thread, call.node, call.mark.thread)
    // A Stop reaches only runs this device's agents started, whatever the reach: an agent may always stop its own work.
    if (method !== 'orchestrator.abort') this.assertReach(thread, call.node, policy.agentReach)
    switch (method) {
      case 'threads.setModel':
        return call.asPerson(method, params)
      case 'threads.setPermissionMode': {
        const wanted = params.mode
        if (!isPermissionMode(wanted)) throw new DomainRpcError('invalid_params', 'mode is not a permission mode.')
        // Never above the mode the sender may use, nor above the one the thread was held to when an agent of that device
        // started it, nor (on any other thread) above the mode the thread has now: an agent only narrows.
        const ceiling = narrowPermissionMode(mode, thread.startedFrom?.node === call.node && thread.startedFrom.agent ? thread.startedFrom.agent.mode : services.orchestrator.threadPermissionMode(threadId))
        if (isStricter(ceiling, wanted))
          throw new DomainRpcError('agent_mode_above_thread', `An agent on another computer may set this thread to ${ceiling} at most.`, { ceiling })
        return call.asPerson(method, params)
      }
      case 'orchestrator.send':
      case 'queue.enqueue': {
        const content = String(params.content)
        this.assertBody(content)
        // An older computer asks for `plan` to keep its task read-only; this version has no such mode, so it refuses
        // rather than run the task as an agent that may edit.
        if (params.mode !== undefined && params.mode !== 'agent')
          throw new DomainRpcError('mode_not_supported', 'This computer no longer runs read-only (plan) tasks for another computer. Send it as an agent task.')
        const deadline = params[ROUTED_DEADLINE_KEY]
        if (deadline !== undefined && (method !== 'orchestrator.send' || !Number.isSafeInteger(deadline) || (deadline as number) < 1))
          throw new DomainRpcError('invalid_params', `${ROUTED_DEADLINE_KEY} must be a whole number of minutes, at least 1.`)
        const key = this.requestKey(call, params, method === 'queue.enqueue' ? 'requestId' : 'clientRequestId')
        // A personal bot's message shows its name and face here; anything else it carries is not taken from it.
        const bot = params[ROUTED_AGENT_BOT_KEY] !== undefined ? parseRoutedAgentBot(params[ROUTED_AGENT_BOT_KEY]) : undefined
        // A bot there that started this thread (not as its subagent) makes it that bot's here too, for display: the Bot
        // threads filter, its Started-by bar and, while hidden, quiet. Hidden only now, when its create asked: an agent's
        // thread is a handoff and shows (#2004). Before the send, so its first turn is quiet already.
        if (bot && launchedBySender && !thread.startedFrom?.agent?.subagent && !thread.startedByBot) {
          services.threads.setRemoteStartedByBot(threadId, { botId: bot.id, name: bot.name, node: call.node })
          if (thread.startedFrom?.agent?.hidden) services.threads.setThreadHidden(threadId, true)
        }
        const actor = this.actor(call, mode, this.hops(threadId, call, launchedBySender), bot)
        if (!this.replay(key)) this.assertLimits(call, threadId, true)
        const sent = await services.orchestrator.sendForRemoteAgent(threadId, { content }, {
          clientRequestId: key,
          actor,
          // The agent that started the thread sends its tasks: the guidance before a subagent's task stays out of the chat.
          ...(launchedBySender ? { fromLauncher: true } : {}),
          ...(method === 'queue.enqueue' || params.forceQueue === true ? { forceQueue: true } : {}),
          ...(params.refuseWhilePaused === true ? { refuseWhilePaused: true } : {}),
          // The running time the run may use here: this computer counts it and stops the run (`RunTimeLimits`).
          ...(deadline !== undefined ? { runningMinutes: deadline as number } : {})
        })
        return sent
      }
      case 'orchestrator.steer': {
        const text = String(params.text)
        this.assertBody(text)
        // As on one computer: an agent never answers or skips a question or approval a person is asked.
        if (services.questions.listPendingForThread(threadId).length > 0)
          throw new DomainRpcError('questions_pending', `Thread ${threadId} is waiting for the user to answer a question or approval.`)
        const runId = typeof params.runId === 'string' ? params.runId : services.runEngine.getActiveRun(threadId)?.runId
        if (!runId) return { ok: false, ignored: true, reason: 'run_not_active' }
        const key = this.requestKey(call, params, 'clientRequestId')
        const actor = this.actor(call, mode, this.hops(threadId, call, launchedBySender))
        if (!this.replay(key)) this.assertLimits(call, threadId, false)
        const result = await services.orchestrator.steerForRemoteAgent(threadId, runId, text, { clientRequestId: key, actor })
        switch (result.status) {
          case 'accepted':
            return { ok: true, ignored: false, runId }
          case 'ceiling_exceeded':
            throw new DomainRpcError('ceiling_exceeded', `The run works in ${result.targetMode}, looser than the agent that sent this (${result.callerMode}).`, { callerMode: result.callerMode, targetMode: result.targetMode })
          case 'rejected':
            throw new DomainRpcError(result.reason, `The steer was refused: ${result.reason}.`)
          default:
            return { ok: false, ignored: true, reason: result.reason, runId }
        }
      }
      case 'threads.archive': {
        if (params.archived !== undefined && typeof params.archived !== 'boolean') throw new DomainRpcError('invalid_params', 'archived must be true or false.')
        const archived = params.archived !== false
        const result = await services.orchestrator.archiveForRemoteAgent(threadId, archived, {
          actor: this.actor(call, mode, 1),
          // The app's own Archive, as a person's call from the device runs it, so every window hears of it.
          archive: () => call.asPerson(method, { threadId, archived })
        })
        if (result.status === 'rejected') throw new DomainRpcError('thread_running', `Thread ${threadId} is still working, so it was not archived.`, { threadId })
        return { ok: true, threadId, archived, changed: result.changed }
      }
      case 'orchestrator.abort': {
        const key = this.requestKey(call, params, 'clientRequestId')
        const actor = this.actor(call, mode, 1)
        const stopped = await services.orchestrator.stopForRemoteAgent(threadId, typeof params.runId === 'string' ? params.runId : undefined, { clientRequestId: key, actor })
        return { ok: true, ...stopped }
      }
    }
    throw new NetError('bad_request')
  }

  /**
   * A thread an agent on the device starts: held at once, with the thread, to the sender's mode narrowed to the device
   * limit, and marked as started by that agent (`startedFrom.agent`), so a launch cut off after this call has already
   * left a thread no wider than its launcher. `createdByThreadId` stays unset (the sender is not a thread here). With
   * `subagent: true` the thread is recorded as the sender's subagent (`ThreadStartedFrom.agent.subagent`).
   */
  private async create(params: Record<string, unknown>, call: RemoteAgentCall, mode: PermissionMode, reach: AgentReach): Promise<unknown> {
    if (reach === 'none')
      throw new DomainRpcError('agent_reach', 'This computer does not let agents on that computer work here.', { reach })
    if (params.subagent !== undefined && typeof params.subagent !== 'boolean') throw new DomainRpcError('invalid_params', 'subagent must be true or false.')
    const title = cleanRemoteSenderTitle(call.mark.title)
    const { subagent, ...create } = params
    return call.createThread(create, { agent: { thread: call.mark.thread, title, mode, ...(subagent === true ? { subagent: true as const } : {}) }, permissionMode: mode })
  }

  private assertReach(thread: Thread, node: NodeId, reach: AgentReach): void {
    if (reach === 'all') return
    if (reach === 'launched' && thread.startedFrom?.node === node && thread.startedFrom.agent) return
    throw new DomainRpcError(
      'agent_reach',
      reach === 'none'
        ? 'This computer does not let agents on that computer work here.'
        : 'Agents on that computer may change only the threads they started here.',
      { reach, threadId: thread.id }
    )
  }

  private assertBody(text: string): void {
    if (text.length > ROUTED_AGENT_BODY_MAX)
      throw new DomainRpcError('agent_message_too_long', `A message from an agent on another computer is ${ROUTED_AGENT_BODY_MAX.toLocaleString('en-US')} characters at most.`, { max: ROUTED_AGENT_BODY_MAX })
  }

  /**
   * The count of agent messages in a row this one is. The caller's number only adds: this computer takes the larger of
   * it and its own count, one more than the agent messages in a row the thread's latest run ended. A follow-up from the
   * agent that started the thread is its own work there, as a follow-up to a subagent is on one computer: the owner adds
   * none of its own count, so a remote subagent's tasks do not run into the limit one after another.
   */
  private hops(threadId: string, call: RemoteAgentCall, launchedBySender: boolean): number {
    let own = 0
    if (!launchedBySender) {
      const latest = this.deps.services.runEngine.listRuns(threadId, { limit: 1 })[0]
      own = (latest?.outcome?.agentHops ?? 0) + 1
    }
    const hops = Math.max(call.mark.hops, own, 1)
    if (hops > AGENT_MESSAGE_MAX_HOPS)
      throw new DomainRpcError('agent_hops_exceeded', `This message would be agent message number ${hops} in a row without a person in between; the limit is ${AGENT_MESSAGE_MAX_HOPS}. Wait for a person to reply before going on.`, { hops, max: AGENT_MESSAGE_MAX_HOPS })
    return hops
  }

  private actor(call: RemoteAgentCall, mode: PermissionMode, hops: number, bot?: { id: string; name: string; look: KnownBotLook }): AgentActor {
    return {
      kind: 'agent',
      threadId: call.mark.thread,
      runId: call.mark.run,
      toolCallId: `routed:${call.node}`,
      hops,
      remote: {
        node: call.node,
        computer: cleanRemoteSenderTitle(this.deps.deviceName(call.node)) || 'another computer',
        title: cleanRemoteSenderTitle(call.mark.title),
        mode,
        ...(bot ? { bot } : {})
      }
    }
  }

  /**
   * The key the call is kept under here, named after the calling computer so it can never match (and replay or conflict
   * with) a key of this computer or of another device. A call without one is keyed by its sender's run and words.
   */
  private requestKey(call: RemoteAgentCall, params: Record<string, unknown>, field: 'clientRequestId' | 'requestId'): string {
    const given = typeof params[field] === 'string' && params[field] ? (params[field] as string) : typeof params.requestId === 'string' && params.requestId ? params.requestId : undefined
    if (given) return `routed-agent:${call.node}:${given}`
    const digest = createHash('sha256').update(JSON.stringify([call.mark.thread, call.mark.run, params.threadId, params.content ?? params.text ?? null, params.runId ?? null])).digest('hex').slice(0, 24)
    return `routed-agent:${call.node}:${digest}`
  }

  /** A retry of a call this computer already took: it answers with the first result, past every limit. */
  private replay(key: string): boolean {
    try {
      return Boolean(this.deps.services.runEngine.store.getReceipt(key))
    } catch {
      return false
    }
  }

  /**
   * The limits only a device's agents have here, each refused with a code of its own: too many messages to one thread,
   * and too many runs in a day (`startsRun`: a send or a queued message, not a steer). The queue caps (per sender and in
   * all) and the repeat check are the ones every agent's message has, on one computer or two (`sendToThreadAsAgent`),
   * with a sender on another computer counted by its computer and thread there.
   */
  private assertLimits(call: RemoteAgentCall, threadId: string, startsRun: boolean): void {
    const now = this.deps.clock.now()
    const sent = this.deps.audit.countAgentCalls(call.node, ['orchestrator.send', 'queue.enqueue', 'orchestrator.steer'], now - REMOTE_AGENT_RATE_WINDOW_MS, threadId)
    if (sent >= REMOTE_AGENT_RATE_LIMIT)
      throw new DomainRpcError('agent_rate_limited', `Agents on that computer sent this thread ${REMOTE_AGENT_RATE_LIMIT} messages in the last ${REMOTE_AGENT_RATE_WINDOW_MS / 60_000} minutes; try again later.`, { limit: REMOTE_AGENT_RATE_LIMIT })
    if (startsRun && this.deps.audit.countAgentCalls(call.node, ['orchestrator.send', 'queue.enqueue'], now - DAY_MS) >= REMOTE_AGENT_DAILY_RUNS)
      throw new DomainRpcError('agent_daily_budget', `Agents on that computer started ${REMOTE_AGENT_DAILY_RUNS} runs here in the last day, the most this computer allows; try again tomorrow.`, { limit: REMOTE_AGENT_DAILY_RUNS })
  }
}

/** Whether an agent of `node` started the thread here, and (with `sender`) that agent's own thread did. */
export function launchedBy(thread: Pick<Thread, 'startedFrom'>, node: string, sender?: string): boolean {
  const agent = thread.startedFrom?.node === node ? thread.startedFrom.agent : undefined
  return Boolean(agent) && (sender === undefined || agent!.thread === sender)
}
