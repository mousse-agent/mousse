import type { Thread } from '../../shared/types'

/**
 * A model pick on an open chat shows at once and is saved after (`threads.setModel`). While the newest pick is
 * being saved, a thread list that was read or pushed before it must not put the previous model back, and a pick
 * that fails goes back to the thread as it was before the picks in flight. Held per thread, newest pick wins.
 */
type HeldPick = { ticket: number; override: Thread['modelOverride']; baseline: Thread }

const held = new Map<string, HeldPick>()
let lastTicket = 0

/** Starts holding a pick: `thread` is the row before it, kept for a rollback. Returns the pick's ticket. */
export function holdModelPick(thread: Thread, override: Thread['modelOverride']): number {
  lastTicket += 1
  held.set(thread.id, { ticket: lastTicket, override, baseline: held.get(thread.id)?.baseline ?? thread })
  return lastTicket
}

/** A newer pick replaced this one before it was saved: it is not sent. */
export function isSupersededModelPick(threadId: string, ticket: number): boolean {
  return held.get(threadId)?.ticket !== ticket
}

/** The daemon saved this pick: a later failure rolls back to it, not to what came before. */
export function modelPickSaved(threadId: string, saved: Thread | undefined): void {
  const entry = held.get(threadId)
  if (entry && saved) entry.baseline = saved
}

/** The pick has been answered. `latest` is true when no newer pick is waiting; its row is then the thread's to show. */
export function settleModelPick(threadId: string, ticket: number): { latest: boolean; baseline: Thread | undefined } {
  const entry = held.get(threadId)
  if (!entry || entry.ticket !== ticket) return { latest: false, baseline: undefined }
  held.delete(threadId)
  return { latest: true, baseline: entry.baseline }
}

/** `incoming` with the model of each thread whose pick is still being saved kept as picked; `incoming` itself when none is. */
export function withHeldModelPicks(incoming: Thread[]): Thread[] {
  if (held.size === 0) return incoming
  let out: Thread[] | undefined
  incoming.forEach((thread, index) => {
    const pick = held.get(thread.id)
    if (!pick) return
    out ??= incoming.slice()
    out[index] = { ...thread, modelOverride: pick.override }
  })
  return out ?? incoming
}

/**
 * The row as it is now, with the model the daemon saved and the settings revision it answered with. Nothing else
 * comes from the reply: a list pushed since may have changed the rest of the row, and the reply of another computer
 * may not say what this one lists for the thread (which computer runs it, its place).
 */
export function withSavedModel(row: Thread, saved: Pick<Thread, 'modelOverride' | 'settingsRevision'>): Thread {
  const { modelOverride: _previous, ...rest } = row
  const next: Thread = saved.modelOverride ? { ...rest, modelOverride: saved.modelOverride } : rest
  if (typeof saved.settingsRevision === 'number') next.settingsRevision = saved.settingsRevision
  return next
}
