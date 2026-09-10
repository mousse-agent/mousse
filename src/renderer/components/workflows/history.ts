export interface BoundedHistory<T> {
  push(current: T): BoundedHistory<T>
  undo(current: T): { next: T; history: BoundedHistory<T> } | null
  redo(current: T): { next: T; history: BoundedHistory<T> } | null
  clear(): BoundedHistory<T>
  readonly canUndo: boolean
  readonly canRedo: boolean
}

const DEFAULT_LIMIT = 50

export function createBoundedHistory<T>(limit = DEFAULT_LIMIT): BoundedHistory<T> {
  return makeHistory<T>([], [], limit)
}

function makeHistory<T>(past: T[], future: T[], limit: number): BoundedHistory<T> {
  return {
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    push(current: T) {
      return makeHistory([...past, current].slice(-limit), [], limit)
    },
    undo(current: T) {
      if (!past.length) return null
      const prev = past[past.length - 1]!
      return {
        next: prev,
        history: makeHistory(past.slice(0, -1), [current, ...future].slice(0, limit), limit)
      }
    },
    redo(current: T) {
      if (!future.length) return null
      const next = future[0]!
      return {
        next,
        history: makeHistory([...past, current].slice(-limit), future.slice(1), limit)
      }
    },
    clear() {
      return makeHistory<T>([], [], limit)
    }
  }
}
