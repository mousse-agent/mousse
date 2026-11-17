import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { Thread } from '../../shared/types'
import { motionAllowed } from '../components/ui/Collapse'
import { scaleMotionMs } from './motion'

/**
 * How long a row takes to leave its list: it fades over the first part, then closes its height. The row under
 * Archived (or back in its project) opens as the old one closes, then fades in, so the whole move takes 1.4 times this.
 */
const ARCHIVE_MOVE_MS = 280
const FADE_PART = 0.4

/** A thread archived or unarchived a moment ago, whose row is still moving. `before` is the thread as it was. */
export type ArchiveMove = { toArchived: boolean; before: Thread }
export type ArchiveMoves = ReadonlyMap<string, ArchiveMove>

const NO_MOVES: ArchiveMoves = new Map()

/**
 * The threads whose archived state just changed, however it changed: the sidebar's menu, the shortcut, a bot or
 * agent, another device. While a move lasts the list keeps the old row in its old place (`threadsForList`) so it
 * can fade and close, and the new row opens in its new place. With motion off (reduced motion, Animation speed Off)
 * nothing is recorded and rows move at once. A failed archive changes nothing, so nothing moves.
 */
export function useArchiveMoves(threads: readonly Thread[]): ArchiveMoves {
  const seen = useRef<ReadonlyMap<string, Thread> | null>(null)
  const timers = useRef(new Map<ArchiveMove, ReturnType<typeof setTimeout>>())
  const [moves, setMoves] = useState<ArchiveMoves>(NO_MOVES)

  // After the commit and before the paint: the frame that drops the old row never shows, as the old row is back
  // (from this update) in the same frame.
  useLayoutEffect(() => {
    const previous = seen.current
    seen.current = new Map(threads.map((thread) => [thread.id, thread]))
    if (!previous) return
    const duration = scaleMotionMs(ARCHIVE_MOVE_MS)
    if (duration <= 0 || !motionAllowed()) return
    const started: [string, ArchiveMove][] = []
    for (const thread of threads) {
      const before = previous.get(thread.id)
      if (before && Boolean(before.settledAt) !== Boolean(thread.settledAt)) started.push([thread.id, { toArchived: Boolean(thread.settledAt), before }])
    }
    if (started.length === 0) return
    for (const [id, move] of started) {
      timers.current.set(move, setTimeout(() => {
        timers.current.delete(move)
        setMoves((current) => {
          if (current.get(id) !== move) return current
          const next = new Map(current)
          next.delete(id)
          return next
        })
      }, duration * (1 + FADE_PART) + 40))
    }
    setMoves((current) => new Map([...current, ...started]))
  }, [threads])

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer)
  }, [])

  return moves
}

/**
 * The threads one list is built from while rows move: a thread leaving this list is shown as it was, so it keeps its
 * place in it; `archivedList` says which list this is.
 */
export function threadsForList(threads: readonly Thread[], moves: ArchiveMoves, archivedList: boolean): readonly Thread[] {
  if (moves.size === 0) return threads
  return threads.map((thread) => {
    const move = moves.get(thread.id)
    // A thread moving to Archived leaves the other lists; one moving out of Archived leaves Archived.
    return move && move.toArchived !== archivedList ? move.before : thread
  })
}

/** Whether a row is the one leaving its list or the one arriving in its new place, while its thread moves. */
export function archiveMotionOf(moves: ArchiveMoves, thread: Thread): 'leave' | 'enter' | undefined {
  const move = moves.get(thread.id)
  if (!move) return undefined
  return Boolean(thread.settledAt) === move.toArchived ? 'enter' : 'leave'
}

/**
 * Plays the moves on the rows under `root` marked `data-archive-motion`: a leaving row fades, then closes its height
 * so the rows below move up; an arriving row opens its height as the leaving one closes, then fades in. Rows that are
 * not on the page (a collapsed project, Archived closed) do not move; Archived's count changes at once.
 */
export function useArchiveMotion(root: RefObject<HTMLElement | null>, moves: ArchiveMoves): void {
  // The move each row last played, and its animation: a row plays each move once, and a new move (an archive undone
  // at once) stops the old animation first, so a closed row never stays closed.
  const played = useRef(new WeakMap<Element, { move: ArchiveMove; animation: Animation }>())
  useLayoutEffect(() => {
    if (moves.size === 0 || !root.current) return
    const duration = scaleMotionMs(ARCHIVE_MOVE_MS)
    for (const row of root.current.querySelectorAll<HTMLElement>('[data-archive-motion]')) {
      const move = moves.get(row.dataset.archiveThread ?? '')
      const last = played.current.get(row)
      if (!move || last?.move === move || typeof row.animate !== 'function') continue
      last?.animation.cancel()
      row.style.overflow = ''
      const height = `${row.getBoundingClientRect().height}px`
      row.style.overflow = 'hidden'
      const animation = row.dataset.archiveMotion === 'leave'
        // Stays closed (`fill`) until the move ends and the row is dropped.
        ? row.animate(
          [
            { opacity: 1, height, easing: 'ease-out' },
            { opacity: 0, height, offset: FADE_PART, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
            { opacity: 0, height: '0px' },
          ],
          { duration, fill: 'forwards' },
        )
        : row.animate(
          [
            { opacity: 0, height: '0px', easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
            { opacity: 0, height, offset: 1 - FADE_PART, easing: 'ease-in' },
            { opacity: 1, height },
          ],
          { duration, delay: duration * FADE_PART, fill: 'backwards' },
        )
      played.current.set(row, { move, animation })
      if (row.dataset.archiveMotion === 'enter') {
        const done = () => { if (played.current.get(row)?.animation === animation) row.style.overflow = '' }
        animation.finished.then(done, done)
      }
    }
  })
}

/** The move's rows, for the sidebar: the leaving row cannot be clicked or focused and is hidden from screen readers. */
export function useArchiveMotionRows(root: RefObject<HTMLElement | null>, threads: readonly Thread[]) {
  const moves = useArchiveMoves(threads)
  useArchiveMotion(root, moves)
  const motionOf = useCallback((thread: Thread) => archiveMotionOf(moves, thread), [moves])
  return { moves, motionOf }
}
