/**
 * A send to a thread on another computer that was not confirmed ("<computer> did not confirm this. It may have
 * happened"). The message may or may not be there, so it is neither shown as failed nor sent again at once: the
 * thread is read again, and only then does the window say whether the message reached the other computer.
 */
export function isOutcomeUncertain(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'outcome_uncertain')
}

export interface UncertainSendDeps {
  /** Reads the thread again from the computer that runs it. */
  refresh: () => Promise<unknown>
  /** Whether the other computer now has the message (in the transcript, or in the queue for a queued one). */
  arrived: () => Promise<boolean> | boolean
  /** Drops the message this window painted before the answer came. */
  dropOptimistic: () => void
}

/**
 * Reads the thread again and says whether the message arrived. A message that did not arrive is dropped from
 * the transcript here, and the caller puts its text back; one that did is left to the transcript as read.
 */
export async function settleUncertainSend(deps: UncertainSendDeps): Promise<'arrived' | 'missing' | 'unknown'> {
  try {
    await deps.refresh()
  } catch {
    // The computer cannot be read now: nothing is known, and nothing is taken away from the person.
    return 'unknown'
  }
  let arrived: boolean
  try {
    arrived = await deps.arrived()
  } catch {
    return 'unknown'
  }
  deps.dropOptimistic()
  return arrived ? 'arrived' : 'missing'
}
