import { ROUTED_RUN_WAIT_MAX_MS } from '../../shared/bridge/routed'
import { readRunResultText } from './delegation/hold'
import type { RunEngine } from './RunEngine'
import { TERMINAL_RUN_STATUSES, type RunRecord, type RunStatus } from './types'

/**
 * `runs.wait` on the computer that runs the thread (issue #1160): `thread_wait` of an agent on another computer. It waits
 * at most `ROUTED_RUN_WAIT_MAX_MS` for a run of the thread to end, or to wait on a person (a question, an approval or an
 * MCP request: nothing an agent elsewhere may answer), and answers from this computer's run events.
 *
 * - With `runId`, that run; a usage-limit pause that hands it on to the run continuing it is followed, as on one computer.
 * - Without, the run that is active or paused now, else the next one waiting to start. A thread with no run but a message
 *   in its queue is never answered `idle`: the wait goes on until a run starts (or it times out).
 */

/** A run as a wait reports it: its id and status, and what a reader of another computer may act on. */
export interface RunWaitRun {
  runId: string
  status: RunStatus
  error?: string
  interruptedBy?: unknown
  pause?: { reason?: unknown; until: string; estimated?: unknown }
}

export interface RunWaitReply {
  /**
   * finished: the run ended. needs_input: it waits on a person there. timeout: still going (or, with `pending`, about to
   * start). idle: nothing to wait for.
   */
  status: 'finished' | 'needs_input' | 'timeout' | 'idle'
  run?: RunWaitRun
  /** The run the wait was asked about, when a usage-limit pause handed it on to `run`. */
  continuedFrom?: string
  /** What waits on a person there: how many requests. */
  needsInput?: { requests: number }
  /** Why a thread with no running work is not idle: a run is preparing, or a message waits in its queue. */
  pending?: 'preparing' | 'queued_message'
  /** A finished run's final text, cut to `resultMaxChars`; `resultChars` is its full length when it was cut. */
  resultText?: string
  resultChars?: number
}

export interface RunWaitDeps {
  engine: Pick<RunEngine, 'getRun' | 'getActiveRun' | 'listRuns' | 'store'>
  /** Requests in the thread that wait on a person now. */
  waitingOnPerson(threadId: string): number
  /** Messages waiting in the thread's queue. */
  queued(threadId: string): number
  /** How often a wait looks for a request that waits on a person (they are not run events). */
  pollMs?: number
}

const ERROR_MAX_CHARS = 1_000

function runView(run: RunRecord): RunWaitRun {
  const outcome = run.outcome
  const pause = outcome?.pause
  return {
    runId: run.runId,
    status: run.status,
    ...(outcome?.error ? { error: outcome.error.slice(0, ERROR_MAX_CHARS) } : {}),
    ...(outcome?.interruptedBy ? { interruptedBy: outcome.interruptedBy } : {}),
    ...(run.status === 'paused' && pause ? { pause: { reason: pause.reason, until: pause.until, estimated: pause.estimated } } : {})
  }
}

/** One wait. Never throws for a run that is not there: the routed row already checked `runId` belongs to the thread. */
export async function waitOnRun(
  deps: RunWaitDeps,
  request: { threadId: string; runId?: string; timeoutMs: number; resultMaxChars: number; signal?: AbortSignal }
): Promise<RunWaitReply> {
  const { engine } = deps
  const { threadId } = request
  const timeoutMs = Math.max(0, Math.min(request.timeoutMs, ROUTED_RUN_WAIT_MAX_MS))
  let target = request.runId
  let continuedFrom: string | undefined

  /** The run that answers for `run`: itself, or the run a pause handed it on to. */
  const followed = (run: RunRecord): RunRecord => {
    let current = run
    for (let hops = 0; hops < 20 && TERMINAL_RUN_STATUSES.has(current.status); hops++) {
      const endedBy = current.outcome?.pause?.endedBy
      if (endedBy !== 'resume' && endedBy !== 'resume_now') break
      const next = engine.listRuns(threadId, { limit: 20 }).find((entry) => entry.outcome?.continuationOf === current.runId)
      if (!next) break
      continuedFrom ??= current.runId
      current = next
    }
    return current
  }

  const finished = (run: RunRecord): RunWaitReply => {
    const text = readRunResultText(engine.store, threadId, run.runId)
    const cut = text !== undefined && text.length > request.resultMaxChars
    return {
      status: 'finished',
      run: runView(run),
      ...(continuedFrom ? { continuedFrom } : {}),
      ...(text !== undefined ? { resultText: cut ? `${text.slice(0, request.resultMaxChars)}…` : text } : {}),
      ...(cut ? { resultChars: text!.length } : {})
    }
  }

  /** Where the thread stands now; undefined while the wait goes on. */
  const look = (final: boolean): RunWaitReply | undefined => {
    let run: RunRecord | null = null
    if (target) run = engine.getRun(target)
    else {
      run = engine.getActiveRun(threadId) ?? engine.store.getPausedRun(threadId) ?? engine.store.listQueuedRuns(threadId)[0] ?? null
      if (run && run.status !== 'queued') target = run.runId
    }
    if (run) run = followed(run)
    if (run && target) target = run.runId
    if (run && TERMINAL_RUN_STATUSES.has(run.status)) return finished(run)
    const requests = deps.waitingOnPerson(threadId)
    if (run && requests > 0) return { status: 'needs_input', run: runView(run), needsInput: { requests }, ...(continuedFrom ? { continuedFrom } : {}) }
    if (!run) {
      const queued = deps.queued(threadId)
      if (queued === 0) return { status: 'idle', ...(requests > 0 ? { needsInput: { requests } } : {}) }
      return final ? { status: 'timeout', pending: 'queued_message' } : undefined
    }
    if (!final) return undefined
    return { status: 'timeout', run: runView(run), ...(run.status === 'queued' ? { pending: 'preparing' as const } : {}), ...(continuedFrom ? { continuedFrom } : {}) }
  }

  const now = look(timeoutMs === 0)
  if (now) return now
  return new Promise<RunWaitReply>((resolve) => {
    let done = false
    const finish = (final: boolean): void => {
      if (done) return
      const reply = look(final)
      if (!reply) return
      done = true
      clearTimeout(timer)
      clearInterval(poll)
      unsubscribe()
      request.signal?.removeEventListener('abort', onAbort)
      resolve(reply)
    }
    // A run's status is an event; a question or approval is not, so it is looked for on a short interval.
    const unsubscribe = engine.store.onEvent((event) => {
      if (event.threadId === threadId && event.type === 'run.status') finish(false)
    })
    const poll = setInterval(() => finish(false), deps.pollMs ?? 500)
    const timer = setTimeout(() => finish(true), timeoutMs)
    const onAbort = (): void => finish(true)
    request.signal?.addEventListener('abort', onAbort, { once: true })
  })
}
