/**
 * Whether an applet's host element is really on screen. The applet itself is a native view drawn above the whole page,
 * so it may show only while its host is: anything that hides, replaces or covers the host must hide the view too.
 */
const OVERLAYS =
  '[role="dialog"], [role="menu"], [aria-modal="true"], [data-state="open"][data-radix-popper-content-wrapper], .composer-mode-menu-floating, .composer-model-picker-shell-floating, .context-usage-popover-floating, .composer-workspace-menu, .modal-overlay, .image-preview-overlay'
/** Attribute changes that can show, hide or cover a host: pages and panes toggle these. */
const WATCHED_ATTRIBUTES = ['class', 'style', 'hidden', 'inert', 'aria-hidden', 'aria-modal', 'data-state', 'open']
const subscribers = new Set<() => void>()
let observer: MutationObserver | null = null
let frame = 0
let blocked = false
export function appletHostBlocked(): boolean {
  return blocked
}

/**
 * Calls `callback` (once per frame at most) whenever the page changes in a way that may show, hide or cover a host:
 * a page or pane opening, a dialog or menu appearing, an element being added or removed.
 */
export function subscribeAppletHostVisibility(callback: () => void): () => void {
  subscribers.add(callback)
  if (!observer) {
    const refresh = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        blocked = Array.from(document.querySelectorAll<HTMLElement>(OVERLAYS)).some(
          (node) => node.getClientRects().length > 0 && node.getAttribute('aria-hidden') !== 'true'
        )
        for (const subscriber of subscribers) subscriber()
      })
    }
    observer = new MutationObserver(refresh)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: WATCHED_ATTRIBUTES
    })
    refresh()
  } else callback()
  return () => {
    subscribers.delete(callback)
    if (!subscribers.size) {
      observer?.disconnect()
      observer = null
      cancelAnimationFrame(frame)
      frame = 0
      blocked = false
    }
  }
}

export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

/** Rendered: not `display: none`, `visibility: hidden` or fully transparent through any ancestor. */
function rendered(node: HTMLElement): boolean {
  const check = (node as HTMLElement & { checkVisibility?: (options?: object) => boolean }).checkVisibility
  if (typeof check === 'function')
    return check.call(node, { opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })
  return node.getClientRects().length > 0
}

/** Something else is topmost at one of a few points across the visible part of the host. */
function covered(node: HTMLElement, area: ScreenRect): boolean {
  if (typeof document.elementFromPoint !== 'function' || area.width <= 0 || area.height <= 0) return false
  const inset = (size: number) => Math.min(12, size / 2)
  const left = area.x + inset(area.width), right = area.x + area.width - inset(area.width)
  const top = area.y + inset(area.height), bottom = area.y + area.height - inset(area.height)
  const points: Array<[number, number]> = [
    [(left + right) / 2, (top + bottom) / 2],
    [left, top], [right, top], [left, bottom], [right, bottom]
  ]
  return points.some(([x, y]) => {
    const hit = document.elementFromPoint(x, y)
    return !!hit && hit !== node && !node.contains(hit)
  })
}

/**
 * True while the host may show its native view: it is in the page, the window is visible, the host is rendered and
 * not inside an inert (replaced or covered) part of the app, no dialog or menu is open, and nothing else is drawn over
 * `area`, the part of the host inside its clip.
 */
export function appletHostShown(node: HTMLElement, area: ScreenRect): boolean {
  if (!node.isConnected || document.visibilityState === 'hidden') return false
  if (blocked || node.closest('[inert]')) return false
  if (!rendered(node)) return false
  return !covered(node, area)
}
