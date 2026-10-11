/** One observer for the host document, shared by all native previews. */
const OVERLAYS =
  '[role="dialog"], [role="menu"], [aria-modal="true"], [data-state="open"][data-radix-popper-content-wrapper], .composer-mode-menu-floating, .composer-model-picker-shell-floating, .context-usage-popover-floating, .composer-workspace-menu, .modal-overlay, .image-preview-overlay'
const subscribers = new Set<() => void>()
let observer: MutationObserver | null = null
let frame = 0
let blocked = false
let initialized = false
export function appletHostBlocked(): boolean {
  return blocked
}
export function subscribeAppletHostVisibility(callback: () => void): () => void {
  subscribers.add(callback)
  if (!observer) {
    const refresh = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const next = Array.from(document.querySelectorAll<HTMLElement>(OVERLAYS)).some(
          (node) => node.getClientRects().length > 0 && node.getAttribute('aria-hidden') !== 'true'
        )
        const changed = next !== blocked || !initialized
        blocked = next
        initialized = true
        if (changed) for (const subscriber of subscribers) subscriber()
      })
    }
    observer = new MutationObserver(refresh)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'aria-hidden', 'data-state', 'open']
    })
    refresh()
  } else if (initialized) callback()
  return () => {
    subscribers.delete(callback)
    if (!subscribers.size) {
      observer?.disconnect()
      observer = null
      cancelAnimationFrame(frame)
      frame = 0
      blocked = false
      initialized = false
    }
  }
}
