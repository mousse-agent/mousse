/**
 * Polled data that did not change keeps the objects already held. Stores that list something again
 * every second or two pass the fresh result through these, so components that compare by identity
 * (selectors, `memo`) do not render again for a poll that brought nothing new.
 */

/** `previous` when `next` holds the same JSON data, else `next`. */
export function keepEqual<T>(previous: T, next: T): T {
  return previous === next || JSON.stringify(previous) === JSON.stringify(next) ? previous : next
}

/**
 * `next`, with each entry equal to the held entry of the same id kept as that entry, so one changed
 * entry leaves the others' identity alone. `previous` itself when nothing changed.
 */
export function keepEqualById<T extends { id: string }>(previous: readonly T[], next: T[]): T[] {
  const held = new Map(previous.map((entry) => [entry.id, entry]))
  const kept = next.map((entry) => {
    const before = held.get(entry.id)
    return before ? keepEqual(before, entry) : entry
  })
  return kept.length === previous.length && kept.every((entry, at) => entry === previous[at]) ? (previous as T[]) : kept
}
