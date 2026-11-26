import { ROUTED_AGENT_KEY } from '../../shared/bridge/routed'
import { DomainRpcError } from '../protocol/domainRegistry'
import type { RemoteComputersPort } from '../protocol/remoteComputersPort'
import type { RemoteLaunchRecord, RemoteLaunchRecords } from '../run/delegation/remoteLaunches'
import { hiddenOnTheWire, REMOTE_START_TRANSIENT, runRemoteThreadStart, sendRefusal, sentRunId } from './remoteThreadStart'

/**
 * Threads agents here launch on another of the user's computers (`thread_create` with `computer`, issue #1160). Each
 * launch is a `remote_launches` row written with its receipt before any call; this service moves it along with the
 * sequence remote subagents use (`runRemoteThreadStart`), every write marked as the launching agent's:
 *
 * - `starting` / `created`: create the thread there (once), set its model and mode, then send the first message;
 * - `launched`: the thread is set up; a first message the other computer did not confirm (`uncertain`) is asked for
 *   again under the same key, which reaches the first send there if it happened, so it never runs twice.
 *
 * The tool call runs the first attempt and waits for it (`launch`). A launch the call did not finish (a lost link, a
 * restart) is finished by later passes: at boot, when Bridge comes up, and every few seconds while one is open. One that
 * is refused for good before it is set up ends `abandoned`, and a thread already made for it there is archived
 * (`threads.archive`); deleting it is that computer's choice. A first message refused for good keeps the thread.
 */

export interface RemoteThreadLaunchesDeps {
  records: RemoteLaunchRecords
  /** The Bridge side; undefined while Bridge is off. */
  port: () => RemoteComputersPort | undefined
  /**
   * Whether agents here may still work on that computer (the switch in Agent access, and that computer ticked), read
   * before every attempt: a launch the user turned off since is not finished.
   */
  allowed: (node: string) => boolean
  /** The launch reached the other computer for the first time: the launcher's thread notes it. */
  launched: (record: RemoteLaunchRecord) => void
  /** How often open launches are tried again (default 5 s). */
  pollMs?: number
  /** A launch still open after this long is given up (default a day): a thread made for it there is archived. */
  giveUpMs?: number
  now?: () => number
}

/** What a launch attempt left. */
export type RemoteLaunchOutcome =
  /** The thread exists there; the row says what became of its first message. */
  | { ok: true; record: RemoteLaunchRecord }
  /** Nothing is confirmed there yet; later passes (or a retry with the same key) find out. */
  | { ok: 'pending'; code: string; message: string; record: RemoteLaunchRecord }
  /** Refused for good; nothing runs there. */
  | { ok: false; code: string; message: string; record: RemoteLaunchRecord }

const CALL_TIMEOUT_MS = 20_000
const codeOf = (error: unknown): string => (error instanceof DomainRpcError ? error.code : 'remote_error')
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class RemoteThreadLaunches {
  private timer: ReturnType<typeof setTimeout> | undefined
  private passing: Promise<void> | undefined
  private again = false
  private closed = true
  private paused = false
  /** Launches an attempt is working on now: one at a time each, so nothing is sent twice. */
  private readonly inFlight = new Map<string, Promise<RemoteLaunchOutcome>>()

  constructor(private readonly deps: RemoteThreadLaunchesDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Starts finishing open launches (boot, or Bridge coming up). */
  start(): void {
    this.closed = false
    this.schedule(0)
  }

  /** No pass runs by itself while paused; `pass` still runs when called (tests). */
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

  kick(): void {
    this.schedule(0)
  }

  async settled(): Promise<void> {
    while (this.passing) await this.passing
  }

  /** One attempt at the launch `creationKey`, awaited: the tool call that wrote it, or its retry. */
  launch(creationKey: string): Promise<RemoteLaunchOutcome> {
    const running = this.inFlight.get(creationKey)
    if (running) return running
    const record = this.deps.records.get(creationKey)
    if (!record) return Promise.reject(new Error(`Unknown launch ${creationKey}.`))
    const task = this.advance(record).finally(() => {
      this.inFlight.delete(creationKey)
      if (this.deps.records.hasOpen()) this.kick()
    })
    this.inFlight.set(creationKey, task)
    return task
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
        const next = this.again ? 0 : this.deps.pollMs ?? 5_000
        this.again = false
        if (this.deps.records.hasOpen()) this.schedule(next)
      })
    }, ms)
    this.timer.unref?.()
  }

  /** One attempt at every open launch. Never throws. */
  async pass(): Promise<void> {
    for (const listed of this.deps.records.listOpen()) {
      if (this.closed) return
      if (this.inFlight.has(listed.creationKey)) continue
      try {
        await this.launch(listed.creationKey)
      } catch (error) {
        this.deps.records.update(listed.creationKey, { lastError: messageOf(error) })
      }
    }
  }

  /** The outcome a row already holds, for a launch with nothing left to do. */
  private outcomeOf(record: RemoteLaunchRecord): RemoteLaunchOutcome {
    if (record.remoteThreadId && record.state !== 'abandoned') return { ok: true, record }
    if (record.state === 'abandoned') return { ok: false, code: 'remote_refused', message: record.lastError ?? `${record.computerName} refused the launch.`, record }
    return { ok: 'pending', code: 'outcome_uncertain', message: record.lastError ?? `${record.computerName} has not confirmed the thread yet.`, record }
  }

  private async advance(record: RemoteLaunchRecord): Promise<RemoteLaunchOutcome> {
    const setUp = record.state === 'launched'
    const sending = record.firstMessageState === 'pending' || record.firstMessageState === 'uncertain'
    if (record.state === 'abandoned' || (setUp && !sending)) return this.outcomeOf(record)
    const key = record.creationKey
    const name = record.computerName
    let remoteThreadId = record.remoteThreadId
    let step = ''
    // Too old to finish: whatever was made there is archived, and nothing more is sent.
    if (this.now() - Date.parse(record.createdAt) >= (this.deps.giveUpMs ?? 24 * 60 * 60_000))
      return this.abandon(record, remoteThreadId, `${name} did not confirm the launch within a day, so it was given up.`, 'launch_expired')
    if (!this.deps.allowed(record.node)) {
      const message = `The user no longer allows agents to work on ${name}.`
      if (!setUp) return this.abandon(record, remoteThreadId, message, 'computer_not_allowed')
      return { ok: true, record: this.deps.records.update(key, { firstMessageState: 'failed', lastError: message })! }
    }
    try {
      const port = this.deps.port()
      if (!port) throw new DomainRpcError('bridge_off', 'Connecting to your other computers is turned off on this computer.')
      const mark = { [ROUTED_AGENT_KEY]: record.mark }
      const hidden = await hiddenOnTheWire(port, record.node, record.hidden, remoteThreadId !== null,
        () => this.deps.records.update(key, { hidden: null }), AbortSignal.timeout(CALL_TIMEOUT_MS))
      const started = await runRemoteThreadStart({
        key,
        name: record.title,
        projectId: record.remoteProjectId,
        worktree: record.worktree,
        ...(hidden !== null ? { hidden } : {}),
        instanceId: record.instanceId,
        model: record.model,
        permissionMode: record.permissionMode,
        remoteThreadId,
        modelPending: !setUp,
        mark,
        ...(sending && record.firstMessage ? { message: { ...record.firstMessage, clientRequestId: key } } : {})
      }, {
        computerName: name,
        call: (method, params, idem) => {
          step = method
          return port.call(record.node, method, params, { ...(idem ? { idem } : {}), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) })
        },
        created: (id) => {
          remoteThreadId = id
          this.deps.records.update(key, { remoteThreadId: id, state: 'created', lastError: null })
        }
      })
      const runId = sentRunId(started.sent)
      // A send answered without a run: queued behind other work there (still delivered), or refused in its answer.
      const refused = started.sent !== undefined && !runId && !(started.sent as { queued?: unknown }).queued
      const firstMessageState = !sending ? record.firstMessageState : refused ? 'failed' : 'sent'
      const updated = this.deps.records.update(key, {
        state: 'launched',
        remoteMode: started.mode,
        firstMessageState,
        ...(runId ? { remoteRunId: runId } : {}),
        lastError: refused ? sendRefusal(started.sent, name, 'the first message').message : null
      })!
      if (!setUp) this.deps.launched(updated)
      return { ok: true, record: updated }
    } catch (error) {
      const code = codeOf(error)
      const message = messageOf(error)
      const transient = REMOTE_START_TRANSIENT.has(code)
      if (step === 'orchestrator.send') {
        // The thread is set up there; only its first message is in doubt, or refused.
        const updated = this.deps.records.update(key, {
          state: 'launched',
          firstMessageState: transient ? 'uncertain' : 'failed',
          lastError: message
        })!
        if (!setUp) this.deps.launched(updated)
        return { ok: true, record: updated }
      }
      if (transient) {
        const updated = this.deps.records.update(key, { lastError: message })!
        return remoteThreadId ? { ok: true, record: updated } : { ok: 'pending', code, message, record: updated }
      }
      return this.abandon(record, remoteThreadId, message, code)
    }
  }

  /** Ends a launch that will not be finished. A thread already made for it there is archived, never deleted. */
  private async abandon(record: RemoteLaunchRecord, remoteThreadId: string | null, message: string, code: string): Promise<RemoteLaunchOutcome> {
    const updated = this.deps.records.update(record.creationKey, { state: 'abandoned', lastError: message })!
    if (remoteThreadId) {
      const port = this.deps.port()
      await port?.call(record.node, 'threads.archive', { threadId: remoteThreadId, archived: true }, { idem: `${record.creationKey}:archive`, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) }).catch(() => undefined)
    }
    return { ok: false, code, message, record: updated }
  }
}
