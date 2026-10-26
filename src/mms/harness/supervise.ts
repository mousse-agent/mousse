import type { ProviderRef } from '../run/types'

/**
 * Recovery and deadlines the gateway applies to runtimes. Drivers expose primitives (a native
 * cancel, a process-tree kill, forgetting a native session) and typed failures; what happens when
 * one of them hangs or conflicts is decided here, the same way for every runtime.
 */

/** How long a native cancel may take before the runtime's processes are killed. */
export const INTERRUPT_DEADLINE_MS = 10_000
/** How long loading a saved native session may take before the turn hands history over instead. */
export const LOAD_DEADLINE_MS = 90_000

export interface InterruptibleRuntime {
  interrupt(ref: ProviderRef): Promise<'interrupted' | 'not_active'>
  /** Kills the processes serving `ref` (the whole tree); the live turn then ends. */
  terminate?(ref: ProviderRef): void
  forgetConversation?(threadId: string): void
}

/**
 * Sends the native cancel; when it has not settled by `deadlineMs`, kills the runtime's process
 * tree and forgets the thread's native session, so the next turn hands the history over instead of
 * resuming a session left in an unknown state. A runtime without `terminate` keeps its own cancel.
 * The live turn ends once, as interrupted, through its own signal.
 */
export async function interruptWithDeadline(
  runtime: InterruptibleRuntime,
  ref: ProviderRef,
  options: { threadId?: string; deadlineMs?: number } = {}
): Promise<'interrupted' | 'not_active'> {
  const cancel = runtime.interrupt(ref)
  if (!runtime.terminate) return cancel
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), options.deadlineMs ?? INTERRUPT_DEADLINE_MS)
    timer.unref?.()
  })
  try {
    const settled = await Promise.race([cancel.catch(() => 'failed' as const), deadline])
    if (settled === 'interrupted' || settled === 'not_active') return settled
    runtime.terminate(ref)
    if (options.threadId) {
      try {
        runtime.forgetConversation?.(options.threadId)
      } catch (error) {
        console.warn('[harness] could not drop a native session after a forced stop', error instanceof Error ? error.message : String(error))
      }
    }
    return 'interrupted'
  } finally {
    clearTimeout(timer)
  }
}

/** A load that did not finish in time: the caller kills the process, forgets the session and hands history over. */
export class SessionLoadTimeoutError extends Error {
  readonly code = 'session_load_timeout'
  constructor(readonly sessionId: string) {
    super(`The agent did not reopen session ${sessionId} in time.`)
    this.name = 'SessionLoadTimeoutError'
  }
}

/** Waits for `load` up to `deadlineMs`; past it, `onTimeout` runs once and the result is `SessionLoadTimeoutError`. */
export async function loadWithDeadline<T>(
  sessionId: string,
  load: Promise<T>,
  onTimeout: () => void,
  deadlineMs: number = LOAD_DEADLINE_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout()
      } finally {
        reject(new SessionLoadTimeoutError(sessionId))
      }
    }, deadlineMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([load, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** A runtime refused a message because its native agent already runs another run. */
export interface ActiveRunConflict {
  /** The native agent (conversation) the runtime named. */
  agentId: string
  /** The run it reported as active, when it said. */
  runId?: string
}

export interface RecoveryOwnership {
  /** The native agent the thread's binding stored. */
  nativeAgentId?: string
  /** Run ids Mousse itself started on that agent for this thread. */
  recordedRunIds: ReadonlySet<string>
}

/**
 * Recovers from an active-run conflict once: the conflicting run is cancelled only when it is
 * provably the thread's own (the same native agent, and a run Mousse recorded for the thread),
 * and then the current message is sent again, since none of its events were emitted. An earlier
 * turn that was interrupted or ended ambiguously is never replayed. Returns `refused` when the run
 * is not provably ours: the caller fails the turn with the conflict.
 */
export async function recoverActiveRun<T>(
  conflict: ActiveRunConflict,
  ownership: RecoveryOwnership,
  actions: { cancelRun(runId: string): Promise<void>; resend(): Promise<T> }
): Promise<{ recovered: true; value: T } | { recovered: false; reason: 'not_owned' }> {
  if (!ownership.nativeAgentId || conflict.agentId !== ownership.nativeAgentId) return { recovered: false, reason: 'not_owned' }
  if (!conflict.runId || !ownership.recordedRunIds.has(conflict.runId)) return { recovered: false, reason: 'not_owned' }
  await actions.cancelRun(conflict.runId)
  return { recovered: true, value: await actions.resend() }
}
