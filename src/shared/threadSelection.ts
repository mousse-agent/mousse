/**
 * Shared helpers for resolving a thread from `/threads` selection tokens
 * (exact id, short id prefix, 1-based list index, or unambiguous name).
 */

export interface SelectableThread {
  id: string
  name?: string
}

export type ThreadSelectionResult =
  | { ok: true; thread: SelectableThread }
  | { ok: false; error: string }

/**
 * Resolve a selection query against an ordered thread list.
 * Index is 1-based and refers to the same order used when listing.
 */
export function resolveThreadSelection(
  threads: SelectableThread[],
  query: string
): ThreadSelectionResult {
  const q = query.trim()
  if (!q) {
    return { ok: false, error: 'Provide a thread id, short id, index, or name.' }
  }

  const exact = threads.find((t) => t.id === q)
  if (exact) return { ok: true, thread: exact }

  if (/^\d+$/.test(q)) {
    const index = Number(q)
    if (index >= 1 && index <= threads.length) {
      return { ok: true, thread: threads[index - 1]! }
    }
    return {
      ok: false,
      error: `Index ${index} is out of range (1–${threads.length || 0}).`
    }
  }

  const qLower = q.toLowerCase()
  const shortHits = threads.filter(
    (t) => t.id.toLowerCase().startsWith(qLower) || t.id.slice(0, 8).toLowerCase() === qLower
  )
  if (shortHits.length === 1) return { ok: true, thread: shortHits[0]! }
  if (shortHits.length > 1) {
    return {
      ok: false,
      error: `Ambiguous short id \`${q}\` matches ${shortHits.length} threads. Use a longer id or index.`
    }
  }

  const nameExact = threads.filter((t) => (t.name ?? '').toLowerCase() === qLower)
  if (nameExact.length === 1) return { ok: true, thread: nameExact[0]! }
  if (nameExact.length > 1) {
    return {
      ok: false,
      error: `Ambiguous name \`${q}\` matches ${nameExact.length} threads. Use id or index.`
    }
  }

  const namePartial = threads.filter((t) => (t.name ?? '').toLowerCase().includes(qLower))
  if (namePartial.length === 1) return { ok: true, thread: namePartial[0]! }
  if (namePartial.length > 1) {
    return {
      ok: false,
      error: `Ambiguous name \`${q}\` matches ${namePartial.length} threads. Use id or index.`
    }
  }

  return { ok: false, error: `Thread not found: \`${q}\`.` }
}

/** Format a numbered thread list with optional current marker. */
export function formatThreadList(
  threads: SelectableThread[],
  currentId?: string | null,
  options?: { max?: number }
): string {
  if (threads.length === 0) {
    return 'No threads yet. Send a message or use /new to create one.'
  }

  const max = options?.max ?? 40
  const lines: string[] = ['Threads:', '']
  const shown = threads.slice(0, max)
  shown.forEach((thread, i) => {
    const marker = thread.id === currentId ? ' *' : ''
    const short = thread.id.slice(0, 8)
    const name = thread.name?.trim() || '(unnamed)'
    lines.push(`${i + 1}. ${short}  ${name}${marker}`)
  })
  if (threads.length > shown.length) {
    lines.push(`… and ${threads.length - shown.length} more`)
  }
  lines.push('')
  lines.push('Usage: /threads [id|index|name] — select without wiping history')
  if (currentId) {
    lines.push(`Current: ${currentId.slice(0, 8)}`)
  }
  return lines.join('\n')
}
