/** What choosing a slot needs to know about a running applet. */
export interface AppletSlotHolder {
  mount: { threadId: string; revisionId: string; host?: 'transcript' | 'panel' }
  /** When the page started. */
  epoch: number
  /** When its card left the screen; unset while it is on screen. */
  parkedAt?: number
}

/**
 * Which running applet gives its slot to a new one when all three are taken, or null when none may (the new card waits
 * for a slot to come free). A card out of sight goes first, the one out of sight longest. The side panel shows what the
 * person just opened, so it may also take a slot from a transcript card on screen: first from the same applet's card,
 * then from the card that started first.
 */
export function appletToRelease<T extends AppletSlotHolder>(
  running: T[],
  wanted: { threadId: string; revisionId: string; host?: 'transcript' | 'panel' }
): T | null {
  const parked = running.filter((item) => item.parkedAt !== undefined).sort((a, b) => a.parkedAt! - b.parkedAt!)
  if (parked[0]) return parked[0]
  if (wanted.host !== 'panel') return null
  const same = (item: T) =>
    item.mount.threadId === wanted.threadId && item.mount.revisionId === wanted.revisionId ? 0 : 1
  return (
    running
      .filter((item) => item.mount.host !== 'panel')
      .sort((a, b) => same(a) - same(b) || a.epoch - b.epoch)[0] ?? null
  )
}
