import { createHash } from 'node:crypto'
import type { Thread, ThreadNativeHelper } from '../../../../shared/types'
import type { HeldMessage } from '../../AgentChains'
import type { SteerStrategy } from '../../CommandPolicy'
import type { RunEngine } from '../../RunEngine'
import type { AgentNotePayload, InboxRecord, MonitorEventPayload, ThreadEvent, ThreadWakePayload } from '../../types'
import type { FamilyRelation } from './types'

/**
 * What became of a message `thread_send` delivered (docs/plans/tool-api.md §2.2): a turn started with it, it was put in
 * front of the running turn, it waits for that turn's next Mousse tool call or for a running command, it waits in the
 * queue or for the thread's next turn, it waits until the person answers what the thread asked, or nothing was sent
 * because the thread is a native helper's that its runtime owns.
 */
export type SendDelivery = 'started' | 'presented' | 'waiting_for_boundary' | 'queued' | 'after_answer' | 'waiting_on_command' | 'runtime_owned'

/**
 * A `thread_send` held at its chain's budget (issue #1443): kept, not sent, and the person decides (`held_for_person`);
 * the sender ends its turn.
 */
export function heldResult(threadId: string, intent: 'work' | 'note', error: Error & { held: HeldMessage }): Record<string, unknown> {
  const { holdId, chainId, rootThreadId, replayed } = error.held
  return { threadId, intent, status: 'held', delivery: 'held_for_person', holdId, chainId, rootThreadId, replayed, note: error.message }
}

/** How long a note's sender waits to see the note reach a running turn, or start a notice turn, before it is told where the note waits. */
export const NOTE_PRESENT_WAIT_MS = 1_500

/** The inbox row of one note: the same request key always names the same row, so a retry never posts it twice. */
export function noteInboxId(requestKey: string): string {
  return `inbox:note:${createHash('sha256').update(requestKey).digest('hex').slice(0, 32)}`
}

/** Who the sender is to the receiver, from how the receiver sits in the sender's family. */
export function noteFrom(relation: Exclude<FamilyRelation, 'native'>): AgentNotePayload['from'] {
  switch (relation) {
    case 'child':
      return 'parent'
    case 'descendant':
      return 'ancestor'
    case 'parent':
      return 'subagent'
    case 'sibling':
      return 'sibling'
  }
}

/** Posts the note (or a monitor's notice) to the thread's inbox, once per request key. */
export function postNote(engine: Pick<RunEngine, 'inbox' | 'getActiveRun'>, requestKey: string, payload: AgentNotePayload | MonitorEventPayload | ThreadWakePayload, threadId: string): { row: InboxRecord; replayed: boolean } {
  const inboxId = noteInboxId(requestKey)
  const existing = engine.inbox.get(inboxId)
  if (existing) return { row: existing, replayed: true }
  const row = engine.inbox.append({ inboxId, threadId, runId: engine.getActiveRun(threadId)?.runId ?? null, kind: 'reconcile_notice', payload })
  return { row, replayed: false }
}

/** Where a posted note stands now, or undefined while the path that takes it has not decided yet. */
function settledDelivery(engine: Pick<RunEngine, 'inbox' | 'outbox'>, inboxId: string): { delivery: SendDelivery; runId: string | null } | undefined {
  const row = engine.inbox.get(inboxId)
  if (!row || row.status === 'pending') return undefined
  if (row.status === 'acknowledged') return { delivery: 'presented', runId: null }
  const effect = row.deliveredBy ? engine.outbox.get(row.deliveredBy) : null
  // A wake run took it: a notice turn starts with it.
  if (effect?.kind === 'turn.start') return { delivery: 'started', runId: effect.runId }
  // A steer the running turn read (`steerTakenBy`), or a boundary delivery that handed it over with a tool's result.
  const taken = (row.payload as { steerTakenBy?: unknown } | null)?.steerTakenBy
  if (taken && taken === row.deliveredBy) return { delivery: 'presented', runId: effect?.runId ?? null }
  return undefined
}

/**
 * Waits up to `waitMs` for the note to reach a turn (`presented`) or start one (`started`), then says where it waits:
 * for the running command on a runtime that steers natively, for the turn's next Mousse tool call on one that restarts
 * its reply, or for the thread's next turn. A note stays pending until its path confirms it was presented.
 */
export async function noteDelivery(
  engine: Pick<RunEngine, 'inbox' | 'outbox' | 'getActiveRun' | 'on' | 'off'>,
  input: { threadId: string; inboxId: string; attention: AgentNotePayload['attention']; strategy: () => SteerStrategy | null; signal: AbortSignal; waitMs?: number }
): Promise<{ delivery: SendDelivery; runId: string | null }> {
  const { threadId, inboxId } = input
  const active = engine.getActiveRun(threadId)
  const strategy = input.strategy()
  // Only a run that steers natively takes the note now, and only an idle thread starts a notice turn for it: on any
  // other path nothing changes before the run's next Mousse tool call or the thread's next turn.
  const mayChange = active ? strategy === 'native' : input.attention === 'needed'
  const settled = await waitFor(engine, threadId, () => settledDelivery(engine, inboxId), mayChange ? input.waitMs ?? NOTE_PRESENT_WAIT_MS : 0, input.signal)
  if (settled) return settled
  const now = engine.getActiveRun(threadId)
  if (!now) return { delivery: 'queued', runId: null }
  const path = input.strategy()
  if (path === 'native') return { delivery: 'waiting_on_command', runId: now.runId }
  if (path === 'interrupt_restart') return { delivery: 'waiting_for_boundary', runId: now.runId }
  return { delivery: 'queued', runId: now.runId }
}

/** `check` until it decides, re-read on each event of the thread and every 100 ms, for at most `waitMs`. */
async function waitFor<T>(engine: Pick<RunEngine, 'on' | 'off'>, threadId: string, check: () => T | undefined, waitMs: number, signal: AbortSignal): Promise<T | undefined> {
  const first = check()
  if (first !== undefined || waitMs <= 0 || signal.aborted) return first
  return new Promise<T | undefined>((resolve) => {
    let done = false
    const finish = (value: T | undefined): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearInterval(poll)
      engine.off('event', onEvent)
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const again = (): void => {
      const value = check()
      if (value !== undefined) finish(value)
    }
    const onEvent = (event: ThreadEvent): void => {
      if (event.threadId === threadId) again()
    }
    const onAbort = (): void => finish(check())
    const timer = setTimeout(() => finish(check()), waitMs)
    const poll = setInterval(again, 100)
    engine.on('event', onEvent)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * The result of a message to a native helper's mirror thread (docs/plans/tool-api.md §2.7): nothing is sent, and the
 * result names the runtime's own agent id and the tool that reaches the helper (Claude Code's SendMessage, from the
 * hosting run's agent). Codex takes no message from outside for its helpers: the hosting thread is told instead.
 */
export function runtimeOwnedResult(thread: Thread & { native: ThreadNativeHelper }, callerThreadId: string): Record<string, unknown> {
  const native = thread.native
  const hostThreadId = thread.lineage?.parentThreadId ?? null
  const own = hostThreadId === callerThreadId
  const to = native.sendTo ?? native.agentId
  const how = native.runtime === 'claude'
    ? own
      ? `Use your SendMessage with to "${to}".`
      : `Only the agent of thread ${hostThreadId ?? 'that hosts it'} reaches it, with its SendMessage to "${to}": send that thread a note instead.`
    : `Codex runs this helper itself and takes no message for it from outside; ${own ? 'it reports back to your run.' : `send thread ${hostThreadId ?? 'that hosts it'} a note instead.`}`
  return {
    threadId: thread.id,
    delivery: 'runtime_owned' satisfies SendDelivery,
    runtime: native.runtime,
    agentId: native.agentId,
    messageTool: native.runtime === 'claude' ? { name: 'SendMessage', to } : null,
    hostThreadId,
    sent: false,
    note: `Nothing was sent: thread ${thread.id} mirrors a helper ${native.runtime === 'claude' ? 'Claude Code' : 'Codex'} started, and its runtime owns its turns. ${how}`
  }
}
