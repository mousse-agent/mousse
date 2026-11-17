/**
 * The last height each inline applet revision measured, so a card that mounts again (the transcript window scrolled
 * it away and back, another thread was opened and this one reopened) starts at that height instead of jumping.
 * In memory for this window only, and bounded: the oldest entry goes first.
 */
const LIMIT = 256
const heights = new Map<string, number>()

export function appletHeightKey(profileId: string | null, threadId: string | null, revisionId: string): string {
  return JSON.stringify([profileId, threadId, revisionId])
}

export function rememberedAppletHeight(key: string): number | null {
  return heights.get(key) ?? null
}

export function rememberAppletHeight(key: string, height: number): void {
  heights.delete(key)
  heights.set(key, height)
  if (heights.size > LIMIT) heights.delete(heights.keys().next().value!)
}
