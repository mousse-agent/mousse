/**
 * The window's shell (the page, #root, .app, .app-content and the panes the workspaces sit in) never scrolls.
 * `scrollIntoView` and focus scroll every ancestor that can, and Chromium scrolls an `overflow: hidden` box too: "Pick a
 * model" on a bot's error card once moved the whole app up and left, leaving an empty band at the bottom and right until
 * Mousse restarted. The shell's CSS uses `overflow: clip`, which nothing can scroll; this puts back the page itself, and
 * any shell box a theme turns back to `hidden`, the moment it scrolls.
 */
const SHELL = '#root, .app, .app-content, .main-area, .keep-mounted-pane'

/** Keeps the shell at its origin from now on; returns the undo. */
export function keepShellUnscrolled(doc: Document = document): () => void {
  const reset = (event: Event) => {
    const target = event.target
    const box = target === doc ? doc.scrollingElement
      : target instanceof Element && (target === doc.documentElement || target === doc.body || target.matches(SHELL)) ? target
        : null
    if (box && (box.scrollTop || box.scrollLeft)) {
      box.scrollTop = 0
      box.scrollLeft = 0
    }
  }
  // Scroll events don't bubble: listening in the capture phase sees every box's.
  doc.addEventListener('scroll', reset, { capture: true, passive: true })
  return () => doc.removeEventListener('scroll', reset, { capture: true })
}

/**
 * Brings `target` to the middle of `scroller` by scrolling that box alone, never its ancestors (`scrollIntoView`
 * scrolls them all). Nothing moves when the scroller has no room to scroll.
 */
export function centerWithin(scroller: Element, target: Element): void {
  const view = scroller.getBoundingClientRect()
  const box = target.getBoundingClientRect()
  scroller.scrollTop += (box.top + box.height / 2) - (view.top + view.height / 2)
}
