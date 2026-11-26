import { modelFacingReplyText } from '../../shared/applets'
import { ROUTED_AGENT_KEY, ROUTED_DEADLINE_KEY, ROUTED_DEADLINE_SINCE, type RoutedAgentMark } from '../../shared/bridge/routed'
import { qualifyId } from '../../shared/threadRef'
import type { ThreadRunsOn } from '../../shared/types'
import { DomainRpcError } from '../protocol/domainRegistry'
import type { RemoteComputer, RemoteComputersPort } from '../protocol/remoteComputersPort'
import type { RemoteSubagentOverlay, RemoteSubagentRecord } from '../run/delegation/remoteSubagents'
import type { RunEngine } from '../run/RunEngine'
import type { RunTerminalStatus } from '../run/terminal'
import { TERMINAL_RUN_STATUSES, type RunOutcome, type RunStatus } from '../run/types'
import { hiddenOnTheWire, REMOTE_START_TRANSIENT, runRemoteThreadStart, sendRefusal, sentRunId } from './remoteThreadStart'

/**
 * Remote subagents (issue #469): a subagent an agent starts on another of the user's computers. That
 * computer runs it as an ordinary thread, under its own provider accounts, in its project that is the
 * same repository as the parent's. This computer keeps a stand-in: the subagent's thread here holds its
 * tasks, and each task's child run stays `queued` (it has no `turn.start`) while a `remote_subagents`
 * row binds it to the run there. This service moves those rows along:
 *
 * - `starting`: create the thread there (once), set its permission mode and model, send the task (the sequence
 *   `runRemoteThreadStart` shares with `thread_create` on another computer);
 * - `running`: read the run there until it ends, then end the stand-in with its status and final message,
 *   so the task publishes and the parent hears exactly as for a local subagent;
 * - `stopping`: the task ended here first (a Stop, a cancel, the time limit): tell the run there to stop. The row stays
 *   until that computer took the Stop, also across restarts; the subagent's row shows the Stop as requested meanwhile.
 *
 * Besides the tasks, it keeps each subagent's thread there expiring with its root thread here (`remote_expiry`, issue
 * #685): the expiry is set there right after the thread is made, and every later change or removal is sent until that
 * computer took it. That computer deletes the thread at expiry itself, also when it was offline then.
 *
 * A task with `maxMinutes` (`limitMinutes`) gives that computer the limit as running time where it takes one
 * (`ROUTED_DEADLINE_KEY`): it counts only the time the run works, not the time it waits on a person, and stops the run
 * itself. An older computer is stopped from here instead, after that many minutes of wall time (`deadlineAt`).
 *
 * Every call is a routed call, so the other computer applies its own limits to it: its switch for working on its
 * threads, and the permission limit it set for this computer. Where that computer knows the agent mark
 * (`ROUTED_AGENT_KEY`), the calls that change its threads carry it, and it handles them as an agent's, not a person's.
 * An older computer gets them unmarked, as before. Which form a subagent's calls take is decided by its first call and
 * kept on its rows (`marked`): the other computer's replay ledger is keyed by method, so a task that changed form
 * mid-flight could be sent twice.
 * A call that fails because that computer is offline is tried again on the next pass; the row says why.
 */

export interface RemoteSubagentsDeps {
  engine: RunEngine
  /** The Bridge side; undefined while Bridge is off. */
  port: () => RemoteComputersPort | undefined
  /** The subagent's title, the far thread's name. */
  titleOf: (threadId: string) => string | undefined
  /** Records the stand-in's link to the far thread. */
  setRunsOn: (threadId: string, runsOn: ThreadRunsOn) => void
  /** Shows what was answered in the stand-in's transcript; never sent to a model. */
  recordMessage: (threadId: string, role: 'user' | 'assistant', text: string) => void
  /** Something a subagent row shows changed (the computer went offline, a question waits there). */
  changed: (childThreadId: string) => void
  /** Whether the subagent's stand-in thread still exists here; a gone one's expiry row goes once it was sent. */
  threadExists?: (childThreadId: string) => boolean
  /** How often open tasks are read (default 4 s). */
  pollMs?: number
  now?: () => number
}

/** The outcome of starting a task there right away (`launch`). */
export type RemoteLaunch =
  | { ok: true; remoteThreadId: string; remoteRunId: string }
  /** The far run may or may not exist yet; the next passes find out. */
  | { ok: 'pending'; message: string }
  /** Nothing runs there; the caller ends the task here. */
  | { ok: false; code: string; message: string }

/** A pass waits for one call at most this long, so one slow computer does not hold the others. */
const CALL_TIMEOUT_MS = 20_000
/** The soonest expiry sent to another computer: it takes none less than a minute away (`expiryRefusal`). */
const EXPIRY_SOONEST_MS = 90_000

function codeOf(error: unknown): string {
  return error instanceof DomainRpcError ? error.code : 'remote_error'
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** The far run's status as the stand-in's terminal status. */
function terminalStatus(status: RunStatus): RunTerminalStatus {
  return status === 'completed' || status === 'cancelled' || status === 'interrupted' || status === 'failed' ? status : 'failed'
}

/**
 * The final message of a far run: the last assistant message after the run's own user message, with each applet it
 * published, or failed to publish, as one line (`modelFacingReplyText`), as a local run's result has it.
 */
export function finalAssistantText(messages: unknown, userMessageId: string | null | undefined): string | undefined {
  if (!Array.isArray(messages)) return undefined
  const from = userMessageId ? messages.findIndex((message) => isRecord(message) && message.id === userMessageId) : -1
  for (let at = messages.length - 1; at > from; at -= 1) {
    const message: unknown = messages[at]
    if (!isRecord(message) || message.role !== 'assistant') continue
    const text = modelFacingReplyText(message)
    if (text.trim()) return text
  }
  return undefined
}

export class RemoteSubagents {
  private timer: ReturnType<typeof setTimeout> | undefined
  private passing: Promise<void> | undefined
  private again = false
  private closed = true
  /** No pass runs by itself while set; `pass` still runs when called. */
  private paused = false
  /** What each open task's far run was doing when last read, by delegation id. */
  private readonly seen = new Map<string, RemoteSubagentOverlay['activity']>()
  /** Computers a call found offline, until one answers again. */
  private readonly offline = new Set<string>()
  /** Tasks a call is working on now (a launch, or a pass): one at a time each, so nothing is sent twice. */
  private readonly inFlight = new Set<string>()

  constructor(private readonly deps: RemoteSubagentsDeps) {}

  private get records() {
    return this.deps.engine.remoteSubagents
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Starts following the open tasks (boot, or Bridge coming up). */
  start(): void {
    this.closed = false
    this.schedule(0)
  }

  /** Stops the passes that run by themselves; a caller runs them with `pass` (tests). */
  pause(): void {
    this.paused = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Runs a pass soon: a task was added, stopped or cancelled here. */
  kick(): void {
    this.schedule(0)
  }

  /** Resolves once the pass in progress (if any) has finished. For tests and shutdown. */
  async settled(): Promise<void> {
    while (this.passing) await this.passing
  }

  /** The user's other computers, as the device list has them now. */
  computers(): RemoteComputer[] {
    return this.deps.port()?.computers() ?? []
  }

  computerName(node: string): string {
    return this.computers().find((computer) => computer.node === node)?.name ?? 'the other computer'
  }

  /** What the stand-in `childThreadId` shows: the computer, and what its latest open task does there. */
  overlay(childThreadId: string): RemoteSubagentOverlay | undefined {
    const tasks = this.records.listForChildThread(childThreadId)
    const latest = tasks.at(-1)
    if (!latest) return undefined
    const open = [...tasks].reverse().find((task) => task.state === 'starting' || task.state === 'running')
    const computer = this.computers().find((entry) => entry.node === latest.node)
    const remoteThreadId = tasks.find((task) => task.remoteThreadId)?.remoteThreadId
    const activity = open ? (open.waitingInput ? 'needs_input' : this.seen.get(open.delegationId) ?? (open.remoteRunId ? undefined : 'starting')) : undefined
    const stopping = tasks.find((task) => task.state === 'stopping')
    const lastError = (open ?? stopping ?? latest).lastError
    return {
      node: latest.node,
      computerName: computer?.name ?? 'the other computer',
      online: Boolean(computer?.online) && !this.offline.has(latest.node),
      ...(remoteThreadId ? { ref: qualifyId(latest.node, remoteThreadId) } : {}),
      ...(activity ? { activity } : {}),
      ...(stopping ? { stopRequested: true as const } : {}),
      ...(lastError ? { lastError } : {})
    }
  }

  /**
   * Starts a task that was just committed (`delegate_task`, `continue_subagent`): the first pass of its row,
   * awaited, so the caller hears at once when the other computer refused it.
   */
  async launch(delegationId: string): Promise<RemoteLaunch> {
    const record = this.records.get(delegationId)
    if (!record) return { ok: false, code: 'unknown_task', message: `Unknown remote task ${delegationId}.` }
    // A pass that picked the new row up first finishes its own start; this one reads what it did.
    while (this.inFlight.has(delegationId)) await (this.passing ?? new Promise((resolve) => setTimeout(resolve, 50)))
    const current = this.records.get(delegationId)
    if (!current || current.state !== 'starting') {
      this.kick()
      return current?.remoteRunId && current.remoteThreadId
        ? { ok: true, remoteThreadId: current.remoteThreadId, remoteRunId: current.remoteRunId }
        : { ok: 'pending', message: current?.lastError ?? 'The other computer has not confirmed the task yet.' }
    }
    this.inFlight.add(delegationId)
    try {
      return await this.advanceStart(current, 'leave')
    } finally {
      this.inFlight.delete(delegationId)
      this.kick()
    }
  }

  private schedule(ms: number): void {
    if (this.closed || this.paused) return
    if (this.passing) {
      this.again = true
      return
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.passing = this.pass().finally(() => {
        this.passing = undefined
        const next = this.again ? 0 : this.deps.pollMs ?? 4_000
        this.again = false
        if (this.records.hasOpen() || this.expiry.hasPending()) this.schedule(next)
      })
    }, ms)
    this.timer.unref?.()
  }

  private get expiry() {
    return this.deps.engine.remoteExpiry
  }

  /** One pass over every open task, then every expiry still to send. Never throws. */
  async pass(): Promise<void> {
    for (const listed of this.records.listOpen()) {
      if (this.closed) return
      if (this.inFlight.has(listed.delegationId)) continue
      // Read again: a launch may have moved it on while the pass was busy with another task.
      const record = this.records.get(listed.delegationId)
      if (!record || record.state === 'done') continue
      this.inFlight.add(record.delegationId)
      try {
        await this.step(record)
      } catch (error) {
        this.records.update(record.delegationId, { lastError: messageOf(error) })
      } finally {
        this.inFlight.delete(record.delegationId)
      }
    }
    for (const row of this.expiry.listPending()) {
      if (this.closed) return
      await this.sendExpiry(row.childThreadId)
    }
  }

  /**
   * Sets the expiry the subagent's thread there must have (`remote_expiry`). Kept pending while that computer cannot be
   * reached. An expiry less than a minute away (or past: the root here expired while that computer was offline) is
   * sent as a minute and a half from now, the soonest that computer takes, so its thread still goes. Never throws.
   */
  private async sendExpiry(childThreadId: string): Promise<void> {
    const row = this.expiry.get(childThreadId)
    if (!row || row.state !== 'pending' || !row.remoteThreadId) return
    let expiresAt = row.expiresAt
    if (expiresAt !== null) {
      const soonest = this.now() + EXPIRY_SOONEST_MS
      if (!(Date.parse(expiresAt) >= soonest)) expiresAt = new Date(soonest).toISOString()
    }
    try {
      await this.call({ node: row.node, childThreadId }, 'threads.setExpiry', {
        threadId: row.remoteThreadId,
        expiresAt,
        ...(expiresAt !== null && row.stopsRun ? { stopsRun: true } : {})
      }, `remote-expiry:${childThreadId}:${row.generation}:${expiresAt ?? 'none'}`)
      this.expiry.markSent(childThreadId, row.generation)
    } catch (error) {
      const code = codeOf(error)
      // Not reached, or no answer that says what happened: tried again on a later pass.
      if (!(error instanceof DomainRpcError) || REMOTE_START_TRANSIENT.has(code)) return this.expiry.noteError(childThreadId, row.generation, messageOf(error))
      // Gone there, or already expired and being archived there: nothing is left to set. Any other refusal is that
      // computer's answer for good (it does not let this one change its threads): kept as the reason, not asked again.
      this.expiry.markSent(childThreadId, row.generation, code === 'thread_not_found' || code === 'thread_expired' ? undefined : messageOf(error))
    }
    if (this.deps.threadExists && !this.deps.threadExists(childThreadId)) this.expiry.remove(childThreadId)
  }

  private async step(record: RemoteSubagentRecord): Promise<void> {
    const local = this.deps.engine.getRun(record.childRunId)
    // The task ended here first: a Stop, a cancel, a failed start, or the time limit.
    if ((!local || TERMINAL_RUN_STATUSES.has(local.status)) && record.state !== 'stopping') {
      if (!record.remoteThreadId) return this.setState(record, 'done')
      this.setState(record, 'stopping')
      return this.stopThere({ ...record, state: 'stopping' })
    }
    if (record.state === 'stopping') return this.stopThere(record)
    if (record.deadlineAt && this.now() >= Date.parse(record.deadlineAt)) {
      const minutes = record.limitMinutes ?? Math.round((Date.parse(record.deadlineAt) - Date.parse(record.createdAt)) / 60_000)
      const where = this.computerName(record.node)
      await this.deps.engine.settleRemoteRun(record.childRunId, 'interrupted', {
        error: record.waitingInput
          ? `Stopped after its ${minutes}-minute limit while it waited for an answer on ${where}.`
          : `Stopped after its ${minutes}-minute limit on ${where}.`
      })
      // The next pass sees the stand-in ended and stops the run there.
      return this.kick()
    }
    if (record.state === 'starting') {
      await this.advanceStart(record, 'settle')
      return
    }
    await this.follow(record)
  }

  private setState(record: RemoteSubagentRecord, state: RemoteSubagentRecord['state']): void {
    this.records.update(record.delegationId, { state })
    if (state === 'done') this.seen.delete(record.delegationId)
    this.deps.changed(record.childThreadId)
  }

  /**
   * Whether the task's calls carry the agent mark, decided once: the form of the subagent's earlier tasks when it has
   * any (a subagent never mixes forms), else whether its computer takes the mark now. Kept on the row before any call.
   */
  private async markedForm(record: RemoteSubagentRecord): Promise<boolean> {
    if (record.marked !== null) return record.marked
    const earlier = this.records.listForChildThread(record.childThreadId).find((task) => task.marked !== null)
    let marked: boolean
    if (earlier) marked = earlier.marked!
    else if (record.remoteThreadId) marked = false
    else {
      const port = this.deps.port()
      if (!port) throw new DomainRpcError('bridge_off', 'Connecting to your other computers is turned off on this computer.')
      marked = await port.takesAgentMark(record.node, AbortSignal.timeout(CALL_TIMEOUT_MS))
    }
    this.records.update(record.delegationId, { marked })
    record.marked = marked
    return marked
  }

  /**
   * The mark of the task's calls: the parent thread and the run that sent the task, the parent's title, the count of
   * agent messages in a row this task is, and the mode the task runs in. Undefined for an unmarked task.
   */
  private markOf(record: RemoteSubagentRecord): Record<string, RoutedAgentMark> {
    if (record.marked !== true) return {}
    const delegation = this.deps.engine.delegations.get(record.delegationId)
    const thread = delegation?.parentThreadId ?? record.childThreadId
    const run = delegation?.parentRunId ?? record.childRunId
    const hops = (this.deps.engine.getRun(run)?.outcome?.agentHops ?? 0) + 1
    return { [ROUTED_AGENT_KEY]: { thread, run, title: this.deps.titleOf(thread) ?? '', hops, mode: record.permissionMode } }
  }

  /** A call to the task's computer, bounded; it notes whether the computer answered. */
  private async call(record: Pick<RemoteSubagentRecord, 'node' | 'childThreadId'>, method: string, params: Record<string, unknown>, idem?: string): Promise<unknown> {
    const port = this.deps.port()
    if (!port) throw new DomainRpcError('bridge_off', 'Connecting to your other computers is turned off on this computer.')
    try {
      const result = await port.call(record.node, method, params, { ...(idem ? { idem } : {}), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) })
      if (this.offline.delete(record.node)) this.deps.changed(record.childThreadId)
      // Some answers carry their refusal (`{ ok: false, error }`) instead of failing the call.
      if (isRecord(result) && result.ok === false && typeof result.error === 'string')
        throw new DomainRpcError('remote_refused', result.error)
      return result
    } catch (error) {
      if (codeOf(error) === 'computer_offline' && !this.offline.has(record.node)) {
        this.offline.add(record.node)
        this.deps.changed(record.childThreadId)
      }
      throw error
    }
  }

  /**
   * Create (once), set the mode and model, send. Stops at the first failure and says what it means. A
   * refusal that leaves nothing running there ends the row; `settle` also ends the task here with the
   * reason, `leave` lets the caller end it (a tool call that refuses instead of starting).
   */
  private async advanceStart(record: RemoteSubagentRecord, onRefusal: 'settle' | 'leave'): Promise<RemoteLaunch> {
    const name = this.computerName(record.node)
    let remoteThreadId = record.remoteThreadId
    try {
      await this.markedForm(record)
      const deadlineMinutes = await this.runningLimitThere(record)
      const port = this.deps.port()
      const hidden = port
        ? await hiddenOnTheWire(port, record.node, record.hidden, record.remoteThreadId !== null, () => {
          this.records.update(record.delegationId, { hidden: null })
          record.hidden = null
        }, AbortSignal.timeout(CALL_TIMEOUT_MS))
        : record.hidden
      const started = await runRemoteThreadStart({
        key: `remote-subagent:${record.delegationId}`,
        name: this.deps.titleOf(record.childThreadId) ?? 'Subagent',
        projectId: record.projectId,
        worktree: record.worktree,
        // Out of that computer's sidebar; none for a task from before this, or for a computer that does not take it when
        // the first attempt goes out: every retry sends what that attempt did.
        ...(hidden !== null ? { hidden } : {}),
        instanceId: record.instanceId,
        model: record.model,
        permissionMode: record.permissionMode,
        remoteThreadId: record.remoteThreadId,
        mark: this.markOf(record),
        message: {
          content: record.prompt,
          mode: record.chatMode,
          clientRequestId: `remote-subagent:${record.delegationId}`,
          // A follow-up on a thread that may be paused by a usage limit refuses, as a follow-up on one computer does.
          // A thread made for this task has never run, so the first task sends nothing extra to an older computer.
          ...(record.remoteThreadId ? { refuseWhilePaused: true } : {}),
          ...(deadlineMinutes ? { deadlineMinutes } : {})
        }
      }, {
        computerName: name,
        call: (method, params, idem) => this.call(record, method, params, idem),
        created: (id) => {
          remoteThreadId = id
          this.records.update(record.delegationId, { remoteThreadId: id })
          this.expiry.setRemoteThread(record.childThreadId, id)
          this.deps.setRunsOn(record.childThreadId, { node: record.node, computerName: name, ref: qualifyId(record.node, id) })
        }
      })
      const runId = sentRunId(started.sent)
      if (!runId) {
        const refused = sendRefusal(started.sent, name)
        throw new DomainRpcError(refused.code, refused.message)
      }
      // That computer took the limit and stops the run itself, by its running time: this one no longer stops it by the clock.
      const limitTaken = deadlineMinutes !== undefined && isRecord(started.sent) && started.sent[ROUTED_DEADLINE_KEY] === deadlineMinutes
      this.records.update(record.delegationId, { remoteRunId: runId, state: 'running', lastError: null, lastSeenAt: new Date(this.now()).toISOString(), ...(limitTaken ? { deadlineAt: null } : {}) })
      this.seen.set(record.delegationId, 'starting')
      this.deps.changed(record.childThreadId)
      // A new thread there gets its expiry now; one that cannot be set yet is sent on a later pass.
      await this.sendExpiry(record.childThreadId)
      return { ok: true, remoteThreadId: started.remoteThreadId, remoteRunId: runId }
    } catch (error) {
      const code = codeOf(error)
      const message = messageOf(error)
      this.records.update(record.delegationId, { lastError: message })
      if (REMOTE_START_TRANSIENT.has(code)) return { ok: 'pending', message }
      // Refused for good: the task ends here with the reason, and a thread made for it there is archived. Deleting
      // is that computer's own choice; nothing is lost there without it.
      this.setState(record, 'done')
      if (remoteThreadId && !record.remoteThreadId)
        await this.call(record, 'threads.archive', { threadId: remoteThreadId, archived: true }).catch(() => undefined)
      if (onRefusal === 'settle') await this.deps.engine.settleRemoteRun(record.childRunId, 'failed', { error: `${name} refused the task: ${message}` })
      return { ok: false, code, message }
    }
  }

  /**
   * The minutes of running time to send with the task: its limit, when its calls are marked and that computer takes a
   * limit on a send (`ROUTED_DEADLINE_KEY`). Undefined for no limit, or an older computer (stopped from here instead).
   */
  private async runningLimitThere(record: RemoteSubagentRecord): Promise<number | undefined> {
    if (!record.limitMinutes || record.marked !== true) return undefined
    const port = this.deps.port()
    if (!port?.versions) return undefined
    const versions = await port.versions(record.node, AbortSignal.timeout(CALL_TIMEOUT_MS))
    return (versions?.['orchestrator.send'] ?? 0) >= ROUTED_DEADLINE_SINCE ? record.limitMinutes : undefined
  }

  /** Reads the far run; once it ended, ends the stand-in with its status and final message. */
  private async follow(record: RemoteSubagentRecord): Promise<void> {
    const name = this.computerName(record.node)
    let run: Record<string, unknown>
    try {
      const got = await this.call(record, 'runs.get', { threadId: record.remoteThreadId, runId: record.remoteRunId })
      if (!isRecord(got) || !isRecord(got.run)) throw new DomainRpcError('bad_reply', `${name} sent an unreadable run.`)
      run = got.run
    } catch (error) {
      const code = codeOf(error)
      if (code === 'run_not_found' || code === 'thread_not_found') {
        this.setState(record, 'done')
        await this.deps.engine.settleRemoteRun(record.childRunId, 'failed', { error: `The task's thread on ${name} is gone.` })
        return
      }
      this.records.update(record.delegationId, { lastError: messageOf(error) })
      return
    }
    const status = String(run.status) as RunStatus
    const stamp = { lastError: null, lastSeenAt: new Date(this.now()).toISOString() }
    if (!TERMINAL_RUN_STATUSES.has(status)) {
      // A question or approval there is not stored in its runs; it is read on its own.
      const pending = await this.call(record, 'orchestrator.pendingQuestions', { threadId: record.remoteThreadId }).catch(() => undefined)
      const waitingInput = isRecord(pending) && Array.isArray(pending.pending) ? pending.pending.length > 0 : record.waitingInput
      const activity: RemoteSubagentOverlay['activity'] = waitingInput ? 'needs_input' : status === 'paused' ? 'paused' : status === 'queued' || status === 'starting' ? 'starting' : 'working'
      const before = this.seen.get(record.delegationId)
      this.seen.set(record.delegationId, activity)
      this.records.update(record.delegationId, { ...stamp, waitingInput })
      if (before !== activity || waitingInput !== record.waitingInput || record.lastError) this.deps.changed(record.childThreadId)
      return
    }
    const text = await this.resultText(record, run)
    const outcome = isRecord(run.outcome) ? run.outcome : {}
    const ended: RunOutcome = {
      ...(typeof outcome.error === 'string' ? { error: `On ${name}: ${outcome.error}` } : {}),
      // A person who stopped it there stopped it; anything else that cut it off did not.
      ...(outcome.interruptedBy === 'user' ? { interruptedBy: 'user' } : {})
    }
    this.records.update(record.delegationId, { ...stamp, waitingInput: false })
    await this.deps.engine.settleRemoteRun(record.childRunId, terminalStatus(status), Object.keys(ended).length ? ended : undefined, text)
    if (text) this.deps.recordMessage(record.childThreadId, 'assistant', text)
    this.setState(record, 'done')
  }

  /** The far run's final message, with where its work is when it had a worktree there. */
  private async resultText(record: RemoteSubagentRecord, run: Record<string, unknown>): Promise<string | undefined> {
    let text: string | undefined
    try {
      const snapshot = await this.call(record, 'thread.snapshot', { threadId: record.remoteThreadId, transcript: true })
      text = finalAssistantText(isRecord(snapshot) ? snapshot.messages : undefined, typeof run.userMessageId === 'string' ? run.userMessageId : null)
    } catch {
      /* the status still ends the task; the text can be read on that computer */
    }
    if (!record.worktree) return text
    try {
      const status = await this.call(record, 'workspace.getStatus', { threadId: record.remoteThreadId })
      const metadata = isRecord(status) && isRecord(status.metadata) ? status.metadata : undefined
      if (typeof metadata?.branch === 'string') {
        const head = typeof metadata.headSha === 'string' ? ` at ${metadata.headSha.slice(0, 12)}` : ''
        return `${text ?? ''}\n\n[The work is on branch ${metadata.branch}${head} on ${this.computerName(record.node)}.]`.trim()
      }
    } catch {
      /* no workspace to name */
    }
    return text
  }

  /** Tells the far run (or thread) to stop; `done` once that computer accepted it. */
  private async stopThere(record: RemoteSubagentRecord): Promise<void> {
    if (!record.remoteThreadId) return this.setState(record, 'done')
    try {
      await this.call(record, 'orchestrator.abort', {
        threadId: record.remoteThreadId,
        ...(record.remoteRunId ? { runId: record.remoteRunId } : {}),
        clientRequestId: `remote-subagent:${record.delegationId}:stop`,
        ...this.markOf(record)
      })
      this.setState(record, 'done')
    } catch (error) {
      const code = codeOf(error)
      // A run or thread that is gone there has nothing left to stop.
      if (code === 'run_not_found' || code === 'thread_not_found') return this.setState(record, 'done')
      this.records.update(record.delegationId, { lastError: messageOf(error) })
    }
  }
}
