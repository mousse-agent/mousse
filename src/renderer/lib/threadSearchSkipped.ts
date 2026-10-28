import type { ThreadSearchSkipped } from '../../shared/types'

/** How long typing pauses before a search runs; the answer of a search that is not the newest is dropped. */
export const THREAD_SEARCH_DEBOUNCE_MS = 250

const WHY: Record<ThreadSearchSkipped['reason'], string> = {
  offline: 'offline',
  slow: 'did not answer in time',
  unavailable: 'not available',
  refused: 'stopped sharing threads',
  replaced: 'a newer search replaced this one'
}

/** A line naming the computers a search (or a list) could not ask, or an empty string when every one answered. */
export function skippedLine(skipped: readonly ThreadSearchSkipped[] | undefined, lead = 'Not searched'): string {
  if (!skipped?.length) return ''
  return `${lead}: ${skipped.map((entry) => `${entry.name} (${WHY[entry.reason]})`).join(', ')}`
}
