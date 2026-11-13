import { motionAllowed } from '../components/ui/Collapse'
import { scaleMotionMs } from './motion'

/** How long an archived row takes to go: it fades over the first part, then closes its height. */
const ARCHIVE_OUT_MS = 280

export type RowsOut = {
  /** Resolves once the rows are gone from sight (at once with motion off). */
  finished: Promise<void>
  /** Brings the rows back, for an archive that failed. */
  restore: () => void
  /** Once the list has dropped the rows: any row still on the page (a list that keeps it) shows again. */
  release: () => void
}

/**
 * Fades a thread's sidebar rows out and closes their height, so the rows below move up into their place. The rows
 * stay collapsed until the list drops them (the thread's update). With motion off, nothing moves.
 */
export function fadeOutThreadRows(threadId: string): RowsOut {
  const duration = scaleMotionMs(ARCHIVE_OUT_MS)
  if (duration <= 0 || !motionAllowed() || typeof document === 'undefined') return { finished: Promise.resolve(), restore: () => {}, release: () => {} }
  const rows = [...document.querySelectorAll<HTMLElement>(`[data-thread-id="${CSS.escape(threadId)}"]`)]
    .map((button) => button.closest<HTMLElement>('.threads-sidebar-thread-container'))
    .filter((row): row is HTMLElement => Boolean(row?.isConnected && typeof row.animate === 'function'))
  const animations = rows.map((row) => {
    const height = `${row.getBoundingClientRect().height}px`
    row.style.overflow = 'hidden'
    return row.animate(
      [
        { opacity: 1, height, easing: 'ease-out' },
        { opacity: 0, height, offset: 0.4, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
        { opacity: 0, height: '0px' },
      ],
      { duration, fill: 'forwards' },
    )
  })
  return {
    finished: Promise.all(animations.map((animation) => animation.finished.then(() => undefined, () => undefined))).then(() => undefined),
    restore: () => {
      for (const animation of animations) animation.cancel()
      for (const row of rows) row.style.overflow = ''
    },
    release: () => {
      rows.forEach((row, index) => {
        if (!row.isConnected) return
        animations[index]!.cancel()
        row.style.overflow = ''
      })
    },
  }
}
