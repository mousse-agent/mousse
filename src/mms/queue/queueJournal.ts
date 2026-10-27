/**
 * Durable agent commands on a thread's queue (issue #184, SPEC §15.1). A command is written to the run
 * database in full (`queue_commands`), together with its audit event, before the queue file changes; its side
 * effects (ending the queued run an item owned, giving its notice rows back) commit in one transaction with the
 * `applied` marker. So:
 *  - a crash at any point is finished from the entry alone, by whichever change to that thread's queue comes
 *    next (every `mutateDurableQueue` recovers first) or by the boot repair;
 *  - a retry of a finished command returns its stored result, whatever the queue looks like now;
 *  - a marker never exists without its effects: a failed effect leaves the entry `effects_pending`, retried
 *    later, never `applied`.
 */

import type { QueuedMessage } from '../../shared/types'
import type { QueueCommandRow, QueueCommands, QueueIntent } from '../run/QueueCommands'
import {
  demoteSteerItems,
  editQueuedMessage,
  normalizeQueuedMessages,
  promoteQueuedMessageToSteer,
  queueRevision,
  removeQueuedMessage,
  reorderQueuedMessages,
  sortQueue,
  QueueConflictError
} from './ThreadMessageQueue'

/** What the journal needs from the thread owner. */
export interface QueueEffects {
  /** The thread's active engine run, or null. Read when a promotion is applied. */
  activeRunId(threadId: string): string | null
  /**
   * Runs an intent's side effects (cancel `cancelRunIds` still queued, release `releaseInboxIds` still held by the
   * item). Called inside one run-database transaction: it throws to roll everything back, and it is idempotent.
   */
  applyEffects(intent: QueueIntent): void
  /** Abandons a queued workflow command. Not a database write; idempotent; runs before the effects transaction. */
  abandonWorkflow(invocationId: string, threadId: string): void
  /** The audit event of a cross-thread (or person-attributed) change, written in the intent's transaction. */
  audit(intent: QueueIntent, entry: QueueAudit): void
  /** An unfinished entry could not be finished now: try again later. */
  scheduleRepair(threadId: string): void
}

export interface QueueAudit {
  action: string
  details: Record<string, string | number | boolean | null>
}

export interface QueueJournal {
  commands: QueueCommands
  effects: QueueEffects
}

export interface QueueStoreLike {
  loadMessageQueue(threadId: string): QueuedMessage[]
  saveMessageQueue(threadId: string, queue: QueuedMessage[]): void
  getQueueJournal(): QueueJournal | undefined
}

export type QueueCommandResult = Record<string, unknown>

/**
 * Applies an intent to the queue items. Idempotent against its own effect: an edit already made, an item already
 * removed, a reorder already in force and a promotion already steering change nothing, which a recovered entry
 * relies on. `outcome` is what the command reports.
 */
export function applyIntent(items: QueuedMessage[], intent: QueueIntent, ctx: { activeRunId: string | null }): AppliedIntent {
  const done = (next: QueuedMessage[], result: QueueCommandResult, skipped = false): AppliedIntent => ({
    items: next,
    result: { ...result, itemId: intent.itemId, revision: queueRevision(next) },
    ...(skipped ? { skipped } : {})
  })
  switch (intent.op) {
    case 'enqueue': {
      // The result keeps the item's id, never its text: the text lives in the queue, and in the entry until it is applied.
      if (!intent.item) return done(items, { outcome: 'enqueued' })
      const present = items.find((item) => item.id === intent.item!.id)
      return done(present ? items : sortQueue([...items, intent.item]), { outcome: 'enqueued' })
    }
    case 'edit': {
      const present = items.find((item) => item.id === intent.itemId)
      if (!present || !intent.patch) return done(items, { outcome: 'edited' }, true)
      try {
        return done(editQueuedMessage(items, intent.itemId, intent.patch).items, { outcome: 'edited' })
      } catch {
        // The item moved on (claimed or steering) since the entry was written: nothing was edited, so the run it still
        // owns is not cancelled either.
        return done(items, { outcome: 'edited' }, true)
      }
    }
    case 'remove':
      return done(removeQueuedMessage(items, intent.itemId).items, { outcome: 'removed' })
    case 'reorder': {
      try {
        return done(reorderQueuedMessages(items, intent.orderedIds ?? []), { outcome: 'reordered' })
      } catch {
        // The pending items are not the ones the order named any more: it was applied, or can no longer be.
        return done(items, { outcome: 'reordered' })
      }
    }
    case 'promote': {
      const present = items.find((item) => item.id === intent.itemId)
      // The run the promotion was checked against is no longer the one running: the text must not reach another
      // run, so the item goes back to a pending message that runs as a turn of its own.
      if (intent.steerRunId && ctx.activeRunId !== intent.steerRunId)
        return done(present ? withoutRun(demoteSteerItems(items, [intent.itemId]), intent.itemId) : items, { outcome: 'requeued', steerRunId: intent.steerRunId })
      if (!present || (present.state !== 'pending' && present.state !== 'steering')) return done(items, { outcome: 'promoted', steerRunId: intent.steerRunId ?? null })
      const promoted = promoteQueuedMessageToSteer(items, intent.itemId, { steerRunId: intent.steerRunId, permissionMode: intent.permissionMode })
      // The steer joins the active run, so the item no longer owns a run of its own.
      const { runId: _runId, ...steer } = promoted.item
      return done(promoted.items.map((entry) => (entry.id === steer.id ? steer : entry)), { outcome: 'promoted', steerRunId: intent.steerRunId ?? null })
    }
  }
}

export interface AppliedIntent {
  items: QueuedMessage[]
  result: QueueCommandResult
  /** The change found nothing to change (an edit of an item that is gone or already started): its effects must not run. */
  skipped?: boolean
}

/** A demoted item runs as its own turn later: the run it had is cancelled with the promotion, so it gets a fresh one when it drains. */
function withoutRun(items: QueuedMessage[], id: string): QueuedMessage[] {
  return items.map((item) => {
    if (item.id !== id || !item.runId) return item
    const { runId: _runId, ...rest } = item
    return rest
  })
}

/**
 * Commits an entry's effects and marks it applied in one transaction. A failure rolls both back and moves the entry
 * to `effects_pending` (result kept, error logged), to be retried; it never throws and never marks applied.
 * Returns whether the entry is applied.
 */
function finishCommand(journal: QueueJournal, row: QueueCommandRow, result: QueueCommandResult): boolean {
  const { commands, effects } = journal
  try {
    if (row.intent.abandonWorkflowInvocationId) effects.abandonWorkflow(row.intent.abandonWorkflowInvocationId, row.intent.threadId)
    commands.db.transaction(() => {
      effects.applyEffects(row.intent)
      commands.markApplied(row, result)
    })
    return true
  } catch (error) {
    console.warn('the effects of a queue command could not be committed; they are retried', { commandKey: row.commandKey, error: error instanceof Error ? error.message : String(error) })
    try {
      commands.markEffectsPending(row, result)
      // A few tries, and then it is left alone: an entry that can never finish must not be retried by every change.
      commands.recordFailure(row.commandKey, error instanceof Error ? error.message : String(error))
    } catch (marking) {
      console.warn('a queue command could not be marked for repair', { commandKey: row.commandKey, error: marking instanceof Error ? marking.message : String(marking) })
    }
    try {
      effects.scheduleRepair(row.intent.threadId)
    } catch {
      /* The next change to the queue repairs it as well. */
    }
    return false
  }
}

/**
 * Finishes the thread's unfinished entries, oldest first, under the thread's queue lock (the caller holds it).
 * A `pending` entry's change is applied to `items` from its intent and saved; then, for `pending` and
 * `effects_pending` alike, its effects and marker commit together. One entry that cannot be finished is logged and
 * left for the next try; it never blocks the change that triggered this. Cheap when nothing is unfinished: one
 * indexed query. Returns the items as they are after recovery.
 */
export function recoverQueueJournal(store: QueueStoreLike, threadId: string, items: QueuedMessage[]): QueuedMessage[] {
  const journal = store.getQueueJournal()
  // Inside another transaction a failed effect would doom it: leave the repair to the next change.
  if (!journal || journal.commands.db.inTransaction) return items
  let unfinished: QueueCommandRow[]
  try {
    unfinished = journal.commands.listUnfinished(threadId)
  } catch (error) {
    console.warn('the queue command journal could not be read', { threadId, error: error instanceof Error ? error.message : String(error) })
    return items
  }
  let current = items
  for (const row of unfinished) {
    try {
      let result = row.result ?? {}
      let finishing = row
      if (row.status === 'pending') {
        const applied = applyIntent(current, row.intent, { activeRunId: journal.effects.activeRunId(threadId) })
        current = normalizeQueuedMessages(applied.items, threadId)
        store.saveMessageQueue(threadId, current)
        result = applied.result
        // An edit that found nothing to edit cancels no run: the item still owns the one it has.
        if (applied.skipped) finishing = { ...row, intent: { ...row.intent, cancelRunIds: [] } }
      }
      finishCommand(journal, finishing, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('an unfinished queue command could not be finished', { commandKey: row.commandKey, error: message })
      let failed = false
      try {
        failed = journal.commands.recordFailure(row.commandKey, message)
      } catch {
        /* The next change tries again. */
      }
      if (!failed) {
        try {
          journal.effects.scheduleRepair(threadId)
        } catch {
          /* Boot repairs it as well. */
        }
      }
    }
  }
  return current
}

export interface PlannedQueueCommand<R extends QueueCommandResult = QueueCommandResult> {
  intent: QueueIntent
  /** The audit event written with the entry, for a change another thread's agent (or an agent to a person's message) made. */
  audit?: QueueAudit
  /** Extra fields of the result, merged over what the applied change reports (the queue item of an enqueue, say). */
  report?: R
}

export interface QueueCommandOutcome {
  /** The command's stored result; the same on a replay. */
  result: QueueCommandResult
  /** The effects are committed (`applied`); false while the entry is `effects_pending`. */
  effectsSettled: boolean
  /** A retry of a finished command: nothing changed. */
  replayed: boolean
  items: QueuedMessage[]
}

/**
 * One agent command under the thread's queue lock (the caller holds it). Recovers unfinished entries, replays a
 * finished command's result, otherwise `plan` checks the command against the recovered items and says what it
 * does (it throws a `QueueConflictError` when the queue is not as the caller expects); the entry and its audit
 * event commit together, then the change is applied to the file and its effects commit with the marker.
 */
export function runQueueCommand(
  store: QueueStoreLike,
  threadId: string,
  commandKey: string,
  loaded: QueuedMessage[],
  plan: (items: QueuedMessage[], ctx: { activeRunId: string | null }) => PlannedQueueCommand,
  /** The agent-supplied fields of the command: a key that comes back with other fields is a mistake of the caller, not a retry. */
  fingerprint?: string
): QueueCommandOutcome {
  const journal = store.getQueueJournal()
  if (!journal) throw new Error('Agent queue commands need the run engine.')
  if (journal.commands.db.inTransaction) throw new Error('A queue command cannot run inside a transaction.')
  const items = recoverQueueJournal(store, threadId, loaded)
  const existing = journal.commands.get(commandKey)
  if (existing) {
    // The same request id for another command is a mistake of the caller, not a retry.
    if (existing.threadId !== threadId) throw new QueueConflictError('request_conflict', 'This clientRequestId was already used for a change to another thread.')
    if (fingerprint !== undefined && existing.intent.fingerprint !== undefined && existing.intent.fingerprint !== fingerprint)
      throw new QueueConflictError('request_conflict', 'This clientRequestId was already used for a different command; use a new one for a new command, and the same one only to retry.', { itemId: existing.intent.itemId })
    if (existing.status === 'pending') throw new Error('An earlier attempt of this command is still being finished; try again.')
    if (existing.status === 'failed' && !existing.result)
      throw new QueueConflictError('command_failed', 'An earlier attempt of this command could not be finished and was given up; read the queue and send it again with a new clientRequestId.', { itemId: existing.intent.itemId })
    return { result: existing.result ?? {}, effectsSettled: existing.status === 'applied', replayed: true, items }
  }
  const activeRunId = journal.effects.activeRunId(threadId)
  const planned = plan(items, { activeRunId })
  journal.commands.db.transaction(() => {
    journal.commands.insertPending(commandKey, fingerprint !== undefined ? { ...planned.intent, fingerprint } : planned.intent)
    if (planned.audit) journal.effects.audit(planned.intent, planned.audit)
  })
  const applied = applyIntent(items, planned.intent, { activeRunId })
  const next = normalizeQueuedMessages(applied.items, threadId)
  store.saveMessageQueue(threadId, next)
  const result = { ...applied.result, ...(planned.report ?? {}), ...(planned.audit ? { recorded: true } : {}) }
  const row = journal.commands.get(commandKey)!
  const effectsSettled = finishCommand(journal, row, result)
  return { result, effectsSettled, replayed: false, items: next }
}
