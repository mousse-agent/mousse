import { ROUTED_AGENT_ARCHIVE_SINCE, ROUTED_AGENT_KEY, ROUTED_AGENT_READ, ROUTED_RUN_WAIT_DEADLINE_MS, ROUTED_RUN_WAIT_MAX_MS, type RoutedAgentMark } from '../../shared/bridge/routed'
import { outgoingMessageText, qualifyRoutedResult, ROUTED_THREAD_ID_KEYS } from '../../shared/bridge/routedIds'
import { parseQualifiedId, qualifyId } from '../../shared/threadRef'
import { DomainRpcError } from '../protocol/domainRegistry'
import type { RemoteComputersPort } from '../protocol/remoteComputersPort'
import type { RemoteLaunchRecord, RemoteLaunchRecords, RemoteLaunchStop } from '../run/delegation/remoteLaunches'
import type { RunWaitReply, RunWaitRun } from '../run/runWait'
import { TERMINAL_RUN_STATUSES, type RunRecord, type RunStatus, type ThreadEvent } from '../run/types'
import type { MessageRow } from '../run/mcp/appTools/messageRows'
import type { ThreadActivityState } from '../../shared/types'
import { archivedAtOf } from '../../shared/archivedAt'

/**
 * The thread tools on a thread of another of the user's computers (issue #1160): `thread_read`, `thread_wait`,
 * `thread_send`, `thread_steer`, `thread_interrupt` and `thread_archive` with a qualified id (`<node>:<id>`), `thread_list` and
 * `thread_search` with `computer`, and the Stop a person's Stop (or the deletion or expiry) of a launcher sends there.
 *
 * - **Which threads.** `reach` is the one place that decides. A thread `remote_launches` records as launched by the
 *   calling thread or a thread of its lineage is reached as before. Any other thread there is reached when agents here
 *   may work on that computer (`computerRefusal`): read as that computer shares it, and changed only by a marked call
 *   that computer decides by the reach its person gave this one ("Agents on … may change"). A refusal names why; never
 *   a bare not-found.
 * - **Calls.** Every call is a routed call through Bridge, the writes marked as the calling agent's. Each first reaches
 *   the computer (its row versions, with a connect deadline of its own), then runs with its own deadline. A call that finds
 *   the computer unreachable is tried once more about a second later before the computer is called offline. A refusal
 *   names which it was (offline, not shared, outdated, not allowed) from that computer's answer to this call, never from
 *   a state kept from before.
 * - **Ids.** Results are named the way this computer names things before a tool sees them: that computer's threads
 *   qualified, this computer's own plain, and an agent sender (`origin.from`) named by its thread on its computer.
 * - **Stops.** A Stop that cannot be delivered is kept in its row (`remote_launches.stop_*`), survives a restart and is
 *   sent once that computer answers, however long that takes; it is given up only when that computer is no longer one of
 *   the user's computers. The launcher's transcript says when it is still on its way.
 */

/** Codes of a call that did not reach the computer: tried once more before the computer is called offline. */
const UNREACHED: ReadonlySet<string> = new Set(['computer_offline', 'peer_offline', 'route_unreachable'])
/** How long reaching a computer may take, apart from the call's own deadline. */
const CONNECT_MS = 10_000
/** The deadline of a quick call (a read, a send, a Stop). */
const CALL_MS = 30_000
/** The deadline of a quick probe (the working count). */
const PROBE_MS = 8_000
/** How long a search waits for the computer (reaching it, then its answer) before it is named as not searched. */
export const SEARCH_MS = 10_000
/** Without `runs.wait`, how often a wait asks the run's status. */
export const REMOTE_WAIT_POLL_MS = 4_000
/**
 * The deadline a kept Stop records (`stop_deadline`), for an older version that reads it. This one keeps the Stop until it
 * is delivered, or that computer is no longer one of the user's computers.
 */
export const REMOTE_STOP_DEADLINE_MS = 24 * 60 * 60_000

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const codeOf = (error: unknown): string => (error instanceof DomainRpcError ? error.code : (error as { code?: unknown } | null)?.code === undefined ? 'remote_error' : String((error as { code: unknown }).code))
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A thread on another computer the caller may reach, or why not. */
export type RemoteReach =
  /** `record`: this thread (or its lineage) launched it there; absent for any other thread there. */
  | { ok: true; record?: RemoteLaunchRecord; node: string; remoteThreadId: string; computer: string; threadId: string }
  | { ok: false; code: string; message: string; computer?: string }

/** A computer the caller may list and search now, or why not. */
export type RemoteComputerReach =
  | { ok: true; node: string; computer: string; online: boolean }
  | { ok: false; code: string; message: string; computer?: string; computers?: Array<{ id: string; name: string }> }

/** One thread of `threads.list` there, its ids named the way this computer names things. */
export interface RemoteListedThread {
  id: string
  name: string
  projectId?: string | null
  startedAt?: string | null
  updatedAt: string
  archivedAt?: string | null
  parentThreadId?: string
  subagent: boolean
  /** That computer says an agent of this computer started it there (any thread of this computer, not only the caller's). */
  startedByAgentHere: boolean
  /** The caller, or a thread of its lineage, launched it there (`remote_launches`). */
  launchedByYou: boolean
}

/** What a search there found, or why that computer was not searched. */
export type RemoteSearchResult =
  | { searched: true; results: Array<Record<string, unknown>> }
  | { searched: false; code: string; message: string }

export type RemoteTarget = Extract<RemoteReach, { ok: true }>

/** A refusal the tool returns as it is: its code says which reason it was, its message names the computer. */
export class RemoteThreadRefusal extends DomainRpcError {
  constructor(code: string, message: string, readonly computer?: string, details?: Record<string, unknown>) {
    super(code, message, { ...(computer ? { computer } : {}), ...(details ?? {}) })
  }
}

/** A write that computer may or may not have done: never reported as done or as failed. */
export interface RemoteUncertain {
  status: 'uncertain'
  computer: string
  message: string
}

export type RemoteWaitResult = RunWaitReply & {
  /** How the wait learned it: `runs.wait` there, or asking the run's status every few seconds (an older computer). */
  via: 'wait' | 'poll'
  /** The caller's own run ended (or its call was cancelled) before the wait did. */
  callerEnded?: true
}

export interface RemoteLaunchedThreadsDeps {
  records: RemoteLaunchRecords
  /** The Bridge side; undefined while Bridge is off. */
  port: () => RemoteComputersPort | undefined
  /** Why agents here may not work on `node` now (the switch in Agent access, that computer not ticked); undefined when they may. */
  denial: (node: string, name: string) => { code: string; message: string } | undefined
  /** Whether a thread of the caller's lineage is `launcherThreadId` (the caller itself, an ancestor or a descendant). */
  related: (callerThreadId: string, launcherThreadId: string) => boolean
  /** Whether the thread is private (it stays on this computer). */
  localOnly: (threadId: string) => boolean
  /**
   * Whether the thread (or the thread at the top of its lineage) was started from another device: work another device
   * started here never reaches a further computer (one computer deep).
   */
  startedElsewhere?: (threadId: string) => boolean
  /**
   * The thread on `node` that a subagent of this computer runs in, when `threadId` is that subagent's id here (the
   * childThreadId its parent knows it by). Undefined for any other id.
   */
  remoteSubagentThread?: (node: string, threadId: string) => string | undefined
  /** A note in the launcher's transcript; skipped for a launcher that is gone. */
  note: (launcherThreadId: string, text: string) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** How often kept Stops are tried again (default 5 s). */
  stopPollMs?: number
  /** How long until a later attempt after one that found the computer unreachable (default 1 s). */
  retryMs?: number
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref?.())

/**
 * A refusal for a failed call, named for which reason it was: offline, not sharing its threads with this computer,
 * outdated, not letting this computer's agents work there, or the thread gone there. Any other code is that computer's own.
 */
export function remoteReachRefusal(error: unknown, computer: string, what: string): RemoteThreadRefusal {
  const code = codeOf(error)
  const message = messageOf(error)
  switch (code) {
    case 'computer_offline':
    case 'peer_offline':
    case 'route_unreachable':
    case 'bridge_off':
      return new RemoteThreadRefusal('computer_offline', `${computer} is offline, so ${what} did not reach it.`, computer)
    case 'computer_forbidden': {
      // Why it refused (it blocked this device, turned sharing off), for a settle notice that says so.
      const reason = error instanceof DomainRpcError && isRecord(error.details) && typeof error.details.reason === 'string' ? error.details.reason : undefined
      return new RemoteThreadRefusal('computer_not_shared', `${computer} does not share its threads with this computer (${message}), so ${what} did not reach it.`, computer, reason ? { reason } : undefined)
    }
    case 'computer_outdated':
      return new RemoteThreadRefusal('computer_outdated', `Update Mousse on ${computer}: it is too old for ${what} from an agent on this computer.`, computer)
    case 'agent_reach': {
      // That computer's person decided it, for this device: told as such, with where it is changed, and never retried.
      // The reach is in the refusal's details; a computer from before it says so only in words.
      const given = isRecord((error as { details?: unknown }).details) ? (error as { details: Record<string, unknown> }).details.reach : undefined
      const reach = given === 'none' || given === 'launched' ? given : /work here/.test(message) ? 'none' : 'launched'
      const limit = reach === 'none'
        ? `the person on ${computer} does not let this computer's agents change any thread there`
        : `the person on ${computer} lets this computer's agents change only the threads they started there`
      return new RemoteThreadRefusal(
        'outside_agent_reach',
        `${what[0]!.toUpperCase()}${what.slice(1)} was refused: ${limit}, so nothing was changed. This is their choice; do not try again. They can change it on ${computer} in Settings → Devices, under this computer's limits ("Agents on … may change": All threads). Tell the user, or ask them to make the change themselves.`,
        computer,
        { reach }
      )
    }
    case 'thread_not_found':
      return new RemoteThreadRefusal('remote_thread_gone', `${computer} has no such thread any more: it was deleted there.`, computer)
    case 'deadline_exceeded':
      return new RemoteThreadRefusal('computer_slow', `${computer} did not answer ${what} in time; it is connected, so try again in a moment.`, computer)
    default:
      return new RemoteThreadRefusal(code, message || `${computer} refused ${what}.`, computer)
  }
}

export class RemoteLaunchedThreads {
  private timer: ReturnType<typeof setTimeout> | undefined
  private passing: Promise<void> | undefined
  /** No pass runs by itself until `start`; `pass` still runs when called (a test, a restart's first pass). */
  private started = false
  private closed = false

  constructor(private readonly deps: RemoteLaunchedThreadsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private sleep(ms: number): Promise<void> {
    return (this.deps.sleep ?? defaultSleep)(ms)
  }

  /** Starts delivering kept Stops (boot, or Bridge coming up). */
  start(): void {
    this.started = true
    this.closed = false
    this.kick()
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Waits for a pass under way (tests). */
  async settled(): Promise<void> {
    while (this.passing) await this.passing
  }

  // ------------------------------------------------------------------ reach

  /**
   * Whether `callerThreadId` may reach `threadId`, a qualified id. The one place that decides it:
   * - a thread `remote_launches` says the caller, or a thread of its lineage, launched there (`record` set);
   * - any other thread of a computer agents here may work on now (`computerRefusal`), with no `record`. What it may
   *   change there that computer decides at each marked call; what it reads is what that computer shares with this one.
   */
  reach(callerThreadId: string, threadId: string): RemoteReach {
    const parsed = parseQualifiedId(threadId)
    if (!parsed) return { ok: false, code: 'invalid_thread_id', message: `${threadId} does not name a thread on another computer.` }
    // A remote subagent named by its id here (its childThreadId with that computer's id) means its thread there.
    const there = this.deps.remoteSubagentThread?.(parsed.node, parsed.id)
    const ref = there ? { ...parsed, id: there } : parsed
    const port = this.deps.port()
    const self = port?.self?.()
    if (self && ref.node === self) return { ok: false, code: 'invalid_thread_id', message: `That thread is on this computer: use its own id, ${ref.id}.` }
    const found = this.deps.records.getByRemoteThread(ref.node, ref.id)
    const listed = port?.computers()?.find((entry) => entry.node === ref.node)
    const computer = found?.computerName ?? listed?.name ?? 'that computer'
    if (this.deps.localOnly(callerThreadId))
      return { ok: false, code: 'private_thread', message: 'This is a private thread: it stays on this computer, so it cannot reach threads on other computers.', computer }
    const record = found && this.deps.related(callerThreadId, found.launcherThreadId) ? found : undefined
    if (record) {
      if (record.state === 'abandoned')
        return { ok: false, code: 'launch_abandoned', message: `The launch of «${record.title}» on ${computer} was given up (${record.lastError ?? 'refused'}); the thread there was archived.`, computer }
      return { ok: true, record, node: ref.node, remoteThreadId: ref.id, computer, threadId: qualifyId(ref.node, ref.id) }
    }
    if (!listed && !found)
      return { ok: false, code: 'unknown_computer', message: `${ref.node} is not one of the user's other computers (list_computers names them), so thread ${threadId} cannot be reached.` }
    const refused = this.computerRefusal(callerThreadId, ref.node, computer)
    if (refused) return { ok: false, ...refused, computer }
    return { ok: true, node: ref.node, remoteThreadId: ref.id, computer, threadId: qualifyId(ref.node, ref.id) }
  }

  /**
   * Why the caller may not work on `node` beyond the threads it launched there, read at every call: a private caller,
   * a caller another device started (one computer deep), or the user's switch and list in Agent access.
   */
  private computerRefusal(callerThreadId: string, node: string, computer: string): { code: string; message: string } | undefined {
    if (this.deps.localOnly(callerThreadId))
      return { code: 'private_thread', message: 'This is a private thread: it stays on this computer, so it cannot reach threads on other computers.' }
    if (this.deps.startedElsewhere?.(callerThreadId))
      return { code: 'remote_from_remote', message: `This thread was started from another device, so it cannot reach threads on ${computer}: work another device started stays one computer deep.` }
    return this.deps.denial(node, computer)
  }

  /**
   * `thread_list` and `thread_search` with `computer`: the computer `ref` names (a name or id from `list_computers`), as
   * the caller may list and search it now, or why not.
   */
  computerFor(callerThreadId: string, ref: string): RemoteComputerReach {
    const port = this.deps.port()
    if (!port) return { ok: false, code: 'remote_unavailable', message: 'Threads on other computers need Mousse to be connected to your other computers (Settings → Devices).' }
    const computers = port.computers() ?? []
    const wanted = ref.trim()
    const byNode = computers.find((entry) => entry.node === wanted)
    const byName = computers.filter((entry) => entry.name.trim().toLowerCase() === wanted.toLowerCase())
    if (!byNode && byName.length > 1)
      return { ok: false, code: 'ambiguous_computer', message: `Several of the user's computers are called "${wanted}"; name one by its id from list_computers.`, computers: byName.map(({ node, name }) => ({ id: node, name })) }
    const found = byNode ?? byName[0]
    if (!found) {
      const names = computers.map((entry) => entry.name)
      return { ok: false, code: 'unknown_computer', message: names.length ? `No computer is called "${wanted}". The user's other computers: ${names.join(', ')}.` : 'This computer is not connected to any other computer of the user.' }
    }
    const refused = this.computerRefusal(callerThreadId, found.node, found.name)
    if (refused) return { ok: false, ...refused, computer: found.name }
    return { ok: true, node: found.node, computer: found.name, online: found.online }
  }

  /** Refuses a call agents here may no longer make on that computer (the user turned it off since the launch). */
  private assertAllowed(target: RemoteTarget): void {
    const denied = this.deps.denial(target.node, target.computer)
    if (denied) throw new RemoteThreadRefusal(denied.code, denied.message, target.computer)
  }

  // ------------------------------------------------------------------ calls

  /**
   * One routed call: reach the computer within the connect deadline, then the call within its own. A call that did not
   * reach it is tried once more a second later; only then is the computer called offline. A write carries `idem`, so the
   * second attempt can never act twice there.
   */
  private async call(
    target: { node: string; computer: string },
    method: string,
    params: Record<string, unknown>,
    options: { idem?: string; deadlineMs?: number; what: string; signal?: AbortSignal; connectMs?: number; retry?: boolean }
  ): Promise<{ result: unknown; versions: Record<string, number> | undefined }> {
    const attempts = options.retry === false ? 1 : 2
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) await this.sleep(this.deps.retryMs ?? 1_000)
      const port = this.deps.port()
      if (!port) throw new RemoteThreadRefusal('computer_offline', `Connecting to your other computers is turned off on this computer, so ${options.what} did not reach ${target.computer}.`, target.computer)
      let versions: Record<string, number> | undefined
      try {
        const connect = AbortSignal.timeout(options.connectMs ?? CONNECT_MS)
        versions = port.versions ? await port.versions(target.node, options.signal ? AbortSignal.any([connect, options.signal]) : connect) : undefined
      } catch (error) {
        // Nothing was sent: the computer was not reached.
        if (attempt + 1 < attempts && UNREACHED.has(codeOf(error))) continue
        throw error
      }
      try {
        const deadline = AbortSignal.timeout(options.deadlineMs ?? CALL_MS)
        const result = await port.call(target.node, method, params, {
          ...(options.idem ? { idem: options.idem } : {}),
          signal: options.signal ? AbortSignal.any([deadline, options.signal]) : deadline
        })
        return { result, versions }
      } catch (error) {
        const lost = UNREACHED.has(codeOf(error))
        // A write the link dropped after it was reached may have gone through there: it is not known, so not retried here.
        if (lost && options.idem) throw new DomainRpcError('outcome_uncertain', `${target.computer} went offline while ${options.what} was on its way.`)
        if (lost && attempt + 1 < attempts) continue
        throw error
      }
    }
  }

  /** A result named as this computer names things: that computer's threads qualified, this computer's own plain. */
  private named(node: string, method: string, value: unknown): unknown {
    const self = this.deps.port()?.self?.()
    return localized(qualifyRoutedResult(method, value, { node, ...(self ? { self } : {}) }), self)
  }

  private async read(target: Pick<RemoteTarget, 'node' | 'computer' | 'remoteThreadId'>, method: string, params: Record<string, unknown>, what: string, signal?: AbortSignal): Promise<{ value: unknown; versions: Record<string, number> | undefined }> {
    try {
      const { result, versions } = await this.call(target, method, { threadId: target.remoteThreadId, ...params }, { what, ...(signal ? { signal } : {}) })
      return { value: this.named(target.node, method, result), versions }
    } catch (error) {
      throw remoteReachRefusal(error, target.computer, what)
    }
  }

  /**
   * One read of the thread there, named as this computer names things; a failure is the refusal that says why. The
   * settle notice's follower finds a watched message with it (`runs.list`, `runs.get`, `queue.list`).
   */
  async readThread(target: Pick<RemoteTarget, 'node' | 'computer' | 'remoteThreadId'>, method: string, params: Record<string, unknown>, what: string, signal?: AbortSignal): Promise<unknown> {
    return (await this.read(target, method, params, what, signal)).value
  }

  // ------------------------------------------------------------------ reading

  /** `thread_read` view `events`: one page of the run events there, `limit` at most (the tool's own page). */
  async events(target: RemoteTarget, page: { afterSeq: number; limit: number }): Promise<{ events: ThreadEvent[]; maxSeq: number }> {
    this.assertAllowed(target)
    const { value } = await this.read(target, 'runs.events', { afterSeq: page.afterSeq, limit: page.limit }, 'reading the thread')
    const events = isRecord(value) && Array.isArray(value.events) ? (value.events as ThreadEvent[]) : []
    const maxSeq = isRecord(value) && typeof value.maxSeq === 'number' ? value.maxSeq : events.at(-1)?.seq ?? page.afterSeq
    return { events, maxSeq }
  }

  /**
   * `thread_read` view `messages`: the rows of one page, built there from `afterIndex` with each text cut to the tool's
   * limit, so only what the tool returns crosses.
   */
  async messages(target: RemoteTarget, page: { afterIndex: number; limit: number; textOffset: number; textMax: number }): Promise<{ messages: MessageRow[]; total: number }> {
    this.assertAllowed(target)
    const { value } = await this.read(target, 'thread.messages', {
      index: page.afterIndex,
      limit: page.limit,
      ...(page.textOffset > 0 ? { textOffset: page.textOffset } : {}),
      textMax: Math.min(page.textMax, ROUTED_AGENT_READ.textMax)
    }, 'reading its messages')
    const raw = isRecord(value) && Array.isArray(value.messages) ? value.messages : []
    const messages = raw.filter(isRecord).map(({ content, ...row }) => ({ ...row, text: typeof content === 'string' ? content : '' }) as unknown as MessageRow)
    return { messages, total: isRecord(value) && typeof value.total === 'number' ? value.total : messages.length }
  }

  /** `thread_read` view `summary`: the thread record there (`threads.get`) and its newest runs (`runs.list`). */
  async summary(target: RemoteTarget): Promise<{ thread: Record<string, unknown>; runs: Array<Record<string, unknown>> }> {
    this.assertAllowed(target)
    const [got, listed] = await Promise.all([
      this.read(target, 'threads.get', {}, 'reading the thread'),
      this.read(target, 'runs.list', { limit: 20 }, 'reading its runs')
    ])
    const thread = isRecord(got.value) && isRecord(got.value.thread) ? got.value.thread : {}
    const runs = isRecord(listed.value) && Array.isArray(listed.value.runs) ? listed.value.runs.filter(isRecord) : []
    return { thread, runs }
  }

  // ------------------------------------------------------------------ waiting

  /**
   * `thread_wait`: waits up to `timeoutMs` for the run (`runId`, else the one active or paused now) to end there, or to
   * wait on a person there. On a computer that has `runs.wait` it waits there, 40 s at a time; on an older one it asks the
   * run's status every few seconds. A thread with a run preparing or a message waiting in its queue is never idle.
   *
   * Also the follower a watch on a thread there uses (`notify` across computers): call it until it returns `finished`, or
   * `needs_input` the first time.
   */
  async follow(target: Pick<RemoteTarget, 'node' | 'computer' | 'remoteThreadId'>, request: { runId?: string; timeoutMs: number; signal?: AbortSignal }): Promise<RemoteWaitResult> {
    const until = this.now() + request.timeoutMs
    let runId = request.runId
    let continuedFrom: string | undefined
    let via: RemoteWaitResult['via'] = 'wait'
    let last: RunWaitReply | undefined
    for (;;) {
      if (request.signal?.aborted) return { ...(last ?? { status: 'timeout' }), via, callerEnded: true }
      const left = until - this.now()
      if (left <= 0) return { ...(last ?? {}), status: 'timeout', via }
      let reply: RunWaitReply
      try {
        const waited = await this.waitOnce(target, { ...(runId ? { runId } : {}), timeoutMs: Math.min(left, ROUTED_RUN_WAIT_MAX_MS), ...(request.signal ? { signal: request.signal } : {}) })
        via = waited.via
        reply = waited.reply
      } catch (error) {
        if (request.signal?.aborted) return { ...(last ?? { status: 'timeout' }), via, callerEnded: true }
        throw remoteReachRefusal(error, target.computer, 'the wait')
      }
      if (reply.continuedFrom) continuedFrom ??= reply.continuedFrom
      if (reply.run?.runId) runId = reply.run.runId
      last = { ...reply, ...(continuedFrom ? { continuedFrom } : {}) }
      if (reply.status !== 'timeout') return { ...last, via }
    }
  }

  /** One wait of at most 40 s: `runs.wait` there, or a poll of its status on a computer without it. */
  private async waitOnce(target: Pick<RemoteTarget, 'node' | 'computer' | 'remoteThreadId'>, request: { runId?: string; timeoutMs: number; signal?: AbortSignal }): Promise<{ reply: RunWaitReply; via: RemoteWaitResult['via'] }> {
    const port = this.deps.port()
    if (!port) throw new DomainRpcError('bridge_off', 'Connecting to your other computers is turned off on this computer.')
    const versions = port.versions ? await this.reachVersions(target, request.signal) : undefined
    if (versions?.['runs.wait'] !== undefined) {
      const { result } = await this.call(target, 'runs.wait', {
        threadId: target.remoteThreadId,
        ...(request.runId ? { runId: request.runId } : {}),
        timeoutMs: request.timeoutMs
      }, { what: 'the wait', deadlineMs: Math.min(ROUTED_RUN_WAIT_DEADLINE_MS, request.timeoutMs + 10_000), ...(request.signal ? { signal: request.signal } : {}) })
      return { reply: this.named(target.node, 'runs.wait', result) as RunWaitReply, via: 'wait' }
    }
    return { reply: await this.pollOnce(target, request), via: 'poll' }
  }

  private async reachVersions(target: Pick<RemoteTarget, 'node' | 'computer'>, signal?: AbortSignal): Promise<Record<string, number> | undefined> {
    const port = this.deps.port()!
    for (let attempt = 0; ; attempt++) {
      try {
        const connect = AbortSignal.timeout(CONNECT_MS)
        return await port.versions!(target.node, signal ? AbortSignal.any([connect, signal]) : connect)
      } catch (error) {
        if (attempt > 0 || !UNREACHED.has(codeOf(error))) throw error
        await this.sleep(this.deps.retryMs ?? 1_000)
      }
    }
  }

  /**
   * A wait on a computer that has no `runs.wait`: the run's status every `REMOTE_WAIT_POLL_MS`, until it ends, waits on a
   * person, or `timeoutMs` passes. The final text is not read here (that computer's messages hold it).
   */
  private async pollOnce(target: Pick<RemoteTarget, 'node' | 'computer' | 'remoteThreadId'>, request: { runId?: string; timeoutMs: number; signal?: AbortSignal }): Promise<RunWaitReply> {
    const until = this.now() + request.timeoutMs
    let runId = request.runId
    const ask = async (method: string, params: Record<string, unknown>): Promise<unknown> =>
      this.named(target.node, method, (await this.call(target, method, { threadId: target.remoteThreadId, ...params }, { what: 'the wait', ...(request.signal ? { signal: request.signal } : {}) })).result)
    for (;;) {
      let run: RunRecord | undefined
      if (runId) {
        const got = await ask('runs.get', { runId })
        run = isRecord(got) && isRecord(got.run) ? (got.run as unknown as RunRecord) : undefined
        // A run a pause handed on: the run that continues it answers.
        if (run && TERMINAL_RUN_STATUSES.has(run.status) && (run.outcome?.pause?.endedBy === 'resume' || run.outcome?.pause?.endedBy === 'resume_now')) {
          const listed = await ask('runs.list', { limit: 20 })
          const next = (isRecord(listed) && Array.isArray(listed.runs) ? (listed.runs as RunRecord[]) : []).find((entry) => entry.outcome?.continuationOf === run!.runId)
          if (next) {
            runId = next.runId
            continue
          }
        }
      } else {
        const listed = await ask('runs.list', { limit: 5 })
        const runs = isRecord(listed) && Array.isArray(listed.runs) ? (listed.runs as RunRecord[]) : []
        run = runs.find((entry) => !TERMINAL_RUN_STATUSES.has(entry.status) && entry.status !== 'queued') ?? runs.find((entry) => entry.status === 'queued')
        if (run && run.status !== 'queued') runId = run.runId
      }
      if (run && TERMINAL_RUN_STATUSES.has(run.status)) return { status: 'finished', run: runView(run) }
      const pending = await ask('orchestrator.pendingQuestions', {})
      const requests = isRecord(pending) && Array.isArray(pending.pending) ? pending.pending.length : 0
      if (run && requests > 0) return { status: 'needs_input', run: runView(run), needsInput: { requests } }
      let queued = 0
      if (!run) {
        const queue = await ask('queue.list', {})
        queued = isRecord(queue) && Array.isArray(queue.items) ? queue.items.length : 0
        if (queued === 0) return { status: 'idle', ...(requests > 0 ? { needsInput: { requests } } : {}) }
      }
      const left = until - this.now()
      if (left <= 0 || request.signal?.aborted)
        return run ? { status: 'timeout', run: runView(run), ...(run.status === 'queued' ? { pending: 'preparing' as const } : {}) } : { status: 'timeout', pending: 'queued_message' }
      await this.sleep(Math.min(REMOTE_WAIT_POLL_MS, left))
    }
  }

  // ------------------------------------------------------------------ messaging

  /**
   * `thread_send`: a marked `orchestrator.send` there, keyed by the caller's request key, so a retry reaches the first
   * send and never makes a second run. A send that computer may or may not have taken is `uncertain`.
   */
  async send(target: RemoteTarget, input: { content: string; mode: 'agent' | 'plan' }, options: { clientRequestId: string; mark: RoutedAgentMark }): Promise<{ status: 'sent'; runId?: string; queued: boolean; replayed: boolean; mode?: string } | RemoteUncertain> {
    this.assertAllowed(target)
    const self = this.deps.port()?.self?.()
    // A later message from here is new work: a Stop still on its way there from before must not end it.
    if (target.record?.stop?.state === 'pending') this.deps.records.settleStop(target.record.creationKey, target.record.stop.key, 'expired', 'A later message from this computer superseded it.')
    let result: unknown
    try {
      result = (await this.call(target, 'orchestrator.send', {
        threadId: target.remoteThreadId,
        content: outgoingMessageText(input.content, { node: target.node, ...(self ? { self } : {}) }),
        mode: input.mode,
        clientRequestId: options.clientRequestId,
        [ROUTED_AGENT_KEY]: options.mark
      }, { idem: options.clientRequestId, what: 'the message' })).result
    } catch (error) {
      if (codeOf(error) === 'outcome_uncertain' || codeOf(error) === 'cancelled')
        return { status: 'uncertain', computer: target.computer, message: `${target.computer} has not confirmed the message. Call thread_send again with the same clientRequestId to learn what became of it; it is never sent twice.` }
      throw remoteReachRefusal(error, target.computer, 'the message')
    }
    const sent = isRecord(result) ? result : {}
    return {
      status: 'sent',
      ...(typeof sent.runId === 'string' ? { runId: sent.runId } : {}),
      queued: sent.queued === true,
      replayed: sent.replayed === true,
      ...(typeof sent.mode === 'string' ? { mode: sent.mode } : {})
    }
  }

  /** `thread_steer`: a marked `orchestrator.steer` there. What the owner refuses is thrown with its code. */
  async steer(target: RemoteTarget, runId: string, text: string, options: { clientRequestId: string; mark: RoutedAgentMark }): Promise<{ status: 'accepted'; runId: string } | { status: 'ignored'; reason: string; runId?: string } | RemoteUncertain> {
    this.assertAllowed(target)
    let result: unknown
    try {
      result = (await this.call(target, 'orchestrator.steer', {
        threadId: target.remoteThreadId,
        text,
        runId,
        clientRequestId: options.clientRequestId,
        [ROUTED_AGENT_KEY]: options.mark
      }, { idem: options.clientRequestId, what: 'the steer' })).result
    } catch (error) {
      const code = codeOf(error)
      if (code === 'outcome_uncertain' || code === 'cancelled')
        return { status: 'uncertain', computer: target.computer, message: `${target.computer} has not confirmed the steer. Call thread_steer again with the same clientRequestId to learn what became of it; it is never sent twice.` }
      if (code === 'run_not_found') return { status: 'ignored', reason: 'run_not_found', runId }
      // A refusal of that computer about the run or the thread (a looser run, a question waiting) keeps its own code and details.
      if (error instanceof DomainRpcError && !UNREACHED.has(code) && !['computer_forbidden', 'computer_outdated', 'agent_reach', 'thread_not_found', 'deadline_exceeded', 'bridge_off'].includes(code))
        throw new RemoteThreadRefusal(code, error.message, target.computer, isRecord(error.details) ? error.details : undefined)
      throw remoteReachRefusal(error, target.computer, 'the steer')
    }
    const steered = isRecord(result) ? result : {}
    if (steered.ok === true) return { status: 'accepted', runId: typeof steered.runId === 'string' ? steered.runId : runId }
    return { status: 'ignored', reason: typeof steered.reason === 'string' ? steered.reason : 'run_not_active', ...(typeof steered.runId === 'string' ? { runId: steered.runId } : {}) }
  }

  /**
   * `thread_interrupt`: a marked `orchestrator.abort` there. That computer stops the run only when an agent of this
   * computer started it; a thread a person took over is left as it is, and the answer says so.
   */
  async interrupt(target: RemoteTarget, runId: string | undefined, options: { clientRequestId: string; mark: RoutedAgentMark }): Promise<{ status: 'stopped' | 'left'; runId?: string; left?: string } | RemoteUncertain> {
    // An agent may always stop work it launched, even after the user turned agents on that computer off; any other
    // thread there only while it may work there.
    if (!target.record) this.assertAllowed(target)
    let result: unknown
    try {
      result = (await this.call(target, 'orchestrator.abort', {
        threadId: target.remoteThreadId,
        ...(runId ? { runId } : {}),
        clientRequestId: options.clientRequestId,
        [ROUTED_AGENT_KEY]: options.mark
      }, { idem: options.clientRequestId, what: 'the Stop' })).result
    } catch (error) {
      const code = codeOf(error)
      if (code === 'outcome_uncertain' || code === 'cancelled')
        return { status: 'uncertain', computer: target.computer, message: `${target.computer} has not confirmed the Stop. Call thread_interrupt again with the same clientRequestId to learn what became of it.` }
      if (code === 'run_not_found') return { status: 'left', left: 'run_not_active', ...(runId ? { runId } : {}) }
      throw remoteReachRefusal(error, target.computer, 'the Stop')
    }
    const stopped = isRecord(result) ? result : {}
    return {
      status: stopped.stopped === true ? 'stopped' : 'left',
      ...(typeof stopped.runId === 'string' ? { runId: stopped.runId } : runId ? { runId } : {}),
      ...(typeof stopped.left === 'string' ? { left: stopped.left } : {})
    }
  }

  /**
   * `thread_archive` there: a marked `threads.archive` (`ROUTED_AGENT_ARCHIVE_SINCE`), for a thread there by its qualified
   * id or for a subagent's thread there when its stand-in here is archived (`own`). That computer decides it by the reach
   * its person gave this one, and, as here, refuses to archive a thread that still works (`thread_running`). A computer
   * from before the marked archive is refused here as outdated, before anything is sent: an agent's archive is never sent
   * as a person's. One `idem` per request, so a retry never acts twice there; a call the link dropped is `uncertain`.
   */
  async archive(
    target: Pick<RemoteTarget, 'node' | 'computer' | 'remoteThreadId' | 'threadId' | 'record'>,
    archived: boolean,
    options: { idem: string; mark: RoutedAgentMark; own?: boolean }
  ): Promise<{ status: 'done'; archived: boolean; changed: boolean } | RemoteUncertain> {
    // As a Stop: an agent may always tidy away its own work there (a thread it launched, its subagent's); any other
    // thread there only while it may work there.
    if (!target.record && !options.own) this.assertAllowed(target as RemoteTarget)
    const what = archived ? 'the archive' : 'the unarchive'
    let result: unknown
    try {
      const port = this.deps.port()
      if (port?.versions) {
        const versions = await this.reachVersions(target)
        if ((versions?.['threads.archive'] ?? 0) < ROUTED_AGENT_ARCHIVE_SINCE)
          throw new RemoteThreadRefusal('computer_outdated', `Update Mousse on ${target.computer}: it is too old to ${archived ? 'archive' : 'unarchive'} a thread for an agent on this computer, so nothing was changed there or here.`, target.computer)
      }
      result = (await this.call(target, 'threads.archive', { threadId: target.remoteThreadId, archived, [ROUTED_AGENT_KEY]: options.mark }, { idem: options.idem, what })).result
    } catch (error) {
      if (error instanceof RemoteThreadRefusal) throw error
      const code = codeOf(error)
      if (code === 'outcome_uncertain' || code === 'cancelled')
        return { status: 'uncertain', computer: target.computer, message: `${target.computer} has not confirmed ${what} of ${target.threadId}, so nothing was changed here. Call thread_archive again with the same clientRequestId to learn what became of it; it never acts twice there.` }
      if (code === 'thread_running')
        throw new RemoteThreadRefusal('thread_running', `Thread ${target.threadId} on ${target.computer} is still working, so it was not archived there or here. If the user wants it archived anyway, stop it first with thread_interrupt, then archive it with a new clientRequestId (that computer keeps this answer under the old one).`, target.computer)
      throw remoteReachRefusal(error, target.computer, what)
    }
    const done = isRecord(result) ? result : {}
    return { status: 'done', archived, changed: done.changed !== false }
  }

  // ------------------------------------------------------------------ listing and searching

  /**
   * `thread_list` with `computer`: the threads that computer shares with this one (`threads.list`, which never answers
   * a private thread or a bot's), their projects and what each is doing, named the way this computer names things.
   */
  async list(callerThreadId: string, target: { node: string; computer: string }, filter: { projectId?: string }): Promise<{ threads: RemoteListedThread[]; projects: Array<{ id: string; name: string }>; activity: Record<string, ThreadActivityState> }> {
    const what = 'the list'
    const ask = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      try {
        return this.named(target.node, method, (await this.call(target, method, params, { what })).result)
      } catch (error) {
        throw remoteReachRefusal(error, target.computer, what)
      }
    }
    const projectId = filter.projectId === undefined ? undefined : parseQualifiedId(filter.projectId)?.node === target.node ? parseQualifiedId(filter.projectId)!.id : filter.projectId
    const [listed, projectsValue, activityValue] = await Promise.all([
      ask('threads.list', projectId ? { projectId } : {}),
      ask('projects.list', {}),
      ask('activity.snapshot', {})
    ])
    const raw = isRecord(listed) && Array.isArray(listed.threads) ? listed.threads.filter(isRecord) : []
    const self = this.deps.port()?.self?.()
    const launchedByCaller = (plain: string): boolean => {
      const record = this.deps.records.getByRemoteThread(target.node, plain)
      return Boolean(record && this.deps.related(callerThreadId, record.launcherThreadId))
    }
    const threads: RemoteListedThread[] = []
    for (const thread of raw) {
      if (typeof thread.id !== 'string' || thread.localOnly === true || thread.botOwned === true || thread.automationManager === true) continue
      const plain = parseQualifiedId(thread.id)?.id ?? thread.id
      const lineage = isRecord(thread.lineage) ? thread.lineage : undefined
      const startedFrom = isRecord(thread.startedFrom) ? thread.startedFrom : undefined
      const startedByAgentHere = Boolean(self && startedFrom?.node === self && isRecord(startedFrom.agent))
      threads.push({
        id: qualifyId(target.node, plain),
        name: typeof thread.name === 'string' ? thread.name : '',
        projectId: typeof thread.projectId === 'string' ? thread.projectId : null,
        startedAt: typeof thread.startedAt === 'string' ? thread.startedAt : null,
        updatedAt: typeof thread.updatedAt === 'string' ? thread.updatedAt : '',
        // A computer that runs an older Mousse sends it as `settledAt`.
        archivedAt: archivedAtOf(thread) ?? null,
        ...(lineage && typeof lineage.parentThreadId === 'string' ? { parentThreadId: lineage.parentThreadId } : {}),
        subagent: lineage?.relationship === 'subagent',
        startedByAgentHere,
        // Only a thread an agent here started can be one this caller launched.
        launchedByYou: startedByAgentHere && launchedByCaller(plain)
      })
    }
    const projects = (isRecord(projectsValue) && Array.isArray(projectsValue.projects) ? projectsValue.projects.filter(isRecord) : [])
      .flatMap((project) => (typeof project.id === 'string' ? [{ id: project.id, name: typeof project.name === 'string' ? project.name : '' }] : []))
    const activity = isRecord(activityValue) && isRecord(activityValue.activity) ? (activityValue.activity as Record<string, ThreadActivityState>) : {}
    return { threads, projects, activity }
  }

  /**
   * `thread_search` with `computer`: that computer's own search (`threads.search`: titles, project names and the
   * transcripts of its newest threads only, never a private thread or a bot's), within `SEARCH_MS`. A computer that
   * cannot be reached, or does not answer in time, is named as not searched, with why.
   */
  async search(target: { node: string; computer: string; online: boolean }, query: string, limit: number): Promise<RemoteSearchResult> {
    if (!target.online) return { searched: false, code: 'computer_offline', message: `${target.computer} is offline, so it was not searched.` }
    // One deadline for the whole search, the second attempt after an unreached first one included.
    const deadline = AbortSignal.timeout(SEARCH_MS)
    try {
      const { result } = await this.call(target, 'threads.search', { query, limit }, { what: 'the search', deadlineMs: SEARCH_MS, connectMs: SEARCH_MS, signal: deadline })
      const found = this.named(target.node, 'threads.search', result)
      const results = isRecord(found) && Array.isArray(found.results) ? found.results.filter(isRecord) : []
      return { searched: true, results }
    } catch (error) {
      if (deadline.aborted) return { searched: false, code: 'computer_slow', message: `${target.computer} did not answer the search within ${SEARCH_MS / 1000} s, so it was not searched.` }
      const refused = remoteReachRefusal(error, target.computer, 'the search')
      return { searched: false, code: refused.code, message: refused.message }
    }
  }

  // ------------------------------------------------------------------ the working count

  /**
   * How many of the threads `launcherThreadId` launched on other computers are working: a launch not finished yet, and a
   * launched thread whose computer says it has a run going, preparing, or a message waiting. One that cannot be asked
   * counts as working: the cap never lets more through on a guess.
   */
  async working(launcherThreadId: string): Promise<number> {
    const rows = this.deps.records.listForLauncher(launcherThreadId).filter((row) => row.state !== 'abandoned')
    const open = rows.filter((row) => row.state === 'starting' || row.state === 'created' || row.firstMessageState === 'pending' || row.firstMessageState === 'uncertain')
    const asked = rows.filter((row) => !open.includes(row) && row.remoteThreadId)
    const answers = await Promise.all(asked.map(async (row) => {
      const target = { node: row.node, computer: row.computerName, remoteThreadId: row.remoteThreadId! }
      try {
        const port = this.deps.port()
        if (!port) return true
        const versions = port.versions ? await port.versions(row.node, AbortSignal.timeout(PROBE_MS)) : undefined
        if (versions?.['runs.wait'] !== undefined) {
          const { result } = await this.call(target, 'runs.wait', { threadId: row.remoteThreadId, timeoutMs: 0 }, { what: 'the count', deadlineMs: PROBE_MS, connectMs: PROBE_MS, retry: false })
          return !(isRecord(result) && (result.status === 'idle' || result.status === 'finished'))
        }
        const { result } = await this.call(target, 'runs.list', { threadId: row.remoteThreadId, limit: 1 }, { what: 'the count', deadlineMs: PROBE_MS, connectMs: PROBE_MS, retry: false })
        const latest = isRecord(result) && Array.isArray(result.runs) ? (result.runs[0] as RunRecord | undefined) : undefined
        return latest !== undefined && !TERMINAL_RUN_STATUSES.has(latest.status)
      } catch {
        return true
      }
    }))
    return open.length + answers.filter(Boolean).length
  }

  // ------------------------------------------------------------------ Stops

  /**
   * A person stopped these launchers, or they are deleted or expired: their threads on other computers are stopped there
   * too. Each Stop is kept before it is sent, so one that cannot be delivered now is sent once that computer answers.
   */
  stopLaunchedBy(launcherThreadIds: readonly string[], reason: RemoteLaunchStop['reason']): void {
    let kept = 0
    const deadline = new Date(this.now() + REMOTE_STOP_DEADLINE_MS).toISOString()
    for (const launcherThreadId of new Set(launcherThreadIds)) {
      for (const row of this.deps.records.listForLauncher(launcherThreadId)) {
        if (!row.remoteThreadId || row.state === 'abandoned') continue
        this.deps.records.requestStop(row.creationKey, { key: `${row.creationKey}:stop:${this.now()}`, reason, deadline })
        kept += 1
      }
    }
    if (kept) this.kick()
  }

  /** Runs a pass now (and keeps passing while Stops wait). */
  kick(): void {
    if (!this.started || this.closed) return
    if (this.passing) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.passing = this.pass().finally(() => {
        this.passing = undefined
        if (!this.closed && this.deps.records.listPendingStops().length) {
          this.timer = setTimeout(() => this.kick(), this.deps.stopPollMs ?? 5_000)
          this.timer.unref?.()
        }
      })
    }, 0)
    this.timer.unref?.()
  }

  /** One attempt at every kept Stop. Never throws. */
  async pass(): Promise<void> {
    for (const row of this.deps.records.listPendingStops()) {
      if (this.closed) return
      const stop = row.stop!
      // A computer that left the user's device list can never take it; one listed as offline is tried once it answers.
      const listed = this.deps.port()?.computers()
      const computer = listed?.find((entry) => entry.node === row.node)
      if (listed && !computer) {
        this.deps.records.settleStop(row.creationKey, stop.key, 'expired', stop.result)
        if (stop.reason === 'stopped')
          this.safeNote(row.launcherThreadId, `The Stop cannot reach «${row.title}»: ${row.computerName} is no longer one of your computers, so Mousse stopped trying. Its run there may still be going.`)
        continue
      }
      if (computer && !computer.online && stop.result?.startsWith('undelivered')) continue
      try {
        const target: RemoteTarget = { ok: true, record: row, node: row.node, remoteThreadId: row.remoteThreadId!, computer: row.computerName, threadId: qualifyId(row.node, row.remoteThreadId!) }
        const done = await this.interrupt(target, undefined, { clientRequestId: stop.key, mark: { ...row.mark, hops: 1 } })
        if (done.status === 'uncertain') throw new DomainRpcError('outcome_uncertain', done.message)
        const said = done.status === 'stopped' ? `stopped run ${done.runId ?? ''}`.trim() : done.left === 'not_started_by_this_computer' ? 'left alone: a person there took the thread over' : 'nothing was running'
        this.deps.records.settleStop(row.creationKey, stop.key, 'sent', said)
        // The launcher was told the Stop had not arrived: it is told when it does.
        if (stop.reason === 'stopped' && stop.result?.startsWith('undelivered'))
          this.safeNote(row.launcherThreadId, `The Stop reached «${row.title}» on ${row.computerName}: ${said}.`)
      } catch (error) {
        const current = this.deps.records.get(row.creationKey)?.stop
        if (!current || current.state !== 'pending' || current.key !== stop.key) continue
        const first = !current.result?.startsWith('undelivered')
        this.deps.records.updateStopResult(row.creationKey, stop.key, `undelivered: ${messageOf(error)}`)
        if (first && stop.reason === 'stopped')
          this.safeNote(row.launcherThreadId, `The Stop has not reached «${row.title}» on ${row.computerName} yet (${messageOf(error)}), so its run there may still be going. Mousse sends it when ${row.computerName} answers.`)
      }
    }
  }

  private safeNote(launcherThreadId: string, text: string): void {
    try {
      this.deps.note(launcherThreadId, text)
    } catch (error) {
      console.warn('a note about a Stop on another computer could not be written', { error: messageOf(error) })
    }
  }
}

function runView(run: RunRecord): RunWaitRun {
  const outcome = run.outcome
  const pause = outcome?.pause
  return {
    runId: run.runId,
    status: run.status as RunStatus,
    ...(outcome?.error ? { error: String(outcome.error).slice(0, 1_000) } : {}),
    ...(outcome?.interruptedBy ? { interruptedBy: outcome.interruptedBy } : {}),
    ...(run.status === 'paused' && pause ? { pause: { reason: pause.reason, until: pause.until, estimated: pause.estimated } } : {})
  }
}

/**
 * A qualified result as an agent here reads it: an id this computer's own (`<self>:<id>`, a thread here that thread
 * names) is plain again, and an agent sender (`origin.from { node, thread, run }`) names its thread qualified unless it
 * is this computer's, so no id of another computer resolves to a thread here.
 */
export function localized(value: unknown, self: string | undefined, depth = 0): unknown {
  if (depth > 64) return value
  if (Array.isArray(value)) return value.map((item) => localized(item, self, depth + 1))
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value)) {
    if (typeof inner === 'string' && ROUTED_THREAD_ID_KEYS.includes(key)) {
      const ref = parseQualifiedId(inner)
      out[key] = ref && self && ref.node === self ? ref.id : inner
      continue
    }
    if (key === 'from' && value.kind === 'agent' && isRecord(inner) && typeof inner.node === 'string' && typeof inner.thread === 'string') {
      out[key] = { ...inner, thread: inner.node === self ? inner.thread : qualifyId(inner.node, inner.thread) }
      continue
    }
    out[key] = localized(inner, self, depth + 1)
  }
  return out
}
