interface Preview {
  active(): boolean
  suspend(): Promise<void>
  resume(): void
}
interface ScrollPresentation {
  previews: Set<Preview>
  dispose(): void
}
const scrollers = new WeakMap<HTMLElement, ScrollPresentation>()

/** Keep native guest surfaces stationary/hidden while Chromium scrolls the host DOM. */
export function subscribeAppletScroll(scroller: HTMLElement, preview: Preview): () => void {
  let shared = scrollers.get(scroller)
  if (!shared) {
    const previews = new Set<Preview>()
    let scrolling = false
    let settle: ReturnType<typeof setTimeout> | undefined
    const idle = () => {
      clearTimeout(settle)
      settle = setTimeout(() => {
        scrolling = false
        for (const item of previews) item.resume()
      }, 300)
    }
    const begin = () => {
      if (scrolling) return
      scrolling = true
      // Guest hiding starts synchronously; browser scrolling never waits for IPC.
      // Suspend every subscriber so offscreen applets defer mounting as well.
      for (const item of previews) {
        try {
          void Promise.resolve(item.suspend()).catch(() => {})
        } catch {
          // One failed guest must not prevent the remaining previews hiding.
        }
      }
    }
    const nestedScroll = (event: WheelEvent) => {
      for (
        let node = event.target instanceof Element ? event.target : null;
        node && node !== scroller;
        node = node.parentElement
      ) {
        const style = getComputedStyle(node)
        if (
          /(auto|scroll)/.test(style.overflowY) &&
          node.scrollHeight > node.clientHeight &&
          (event.deltaY < 0
            ? node.scrollTop > 0
            : node.scrollTop + node.clientHeight < node.scrollHeight)
        )
          return true
      }
      return false
    }
    const wheel = (event: WheelEvent) => {
      if (
        event.ctrlKey ||
        event.defaultPrevented ||
        ![...previews].some((item) => item.active()) ||
        nestedScroll(event)
      )
        return
      begin()
      idle()
    }
    const scroll = () => {
      begin()
      idle()
    }
    scroller.addEventListener('wheel', wheel, { passive: true })
    scroller.addEventListener('scroll', scroll, { passive: true })
    shared = {
      previews,
      dispose: () => {
        clearTimeout(settle)
        scroller.removeEventListener('wheel', wheel)
        scroller.removeEventListener('scroll', scroll)
        scrollers.delete(scroller)
      }
    }
    scrollers.set(scroller, shared)
  }
  shared.previews.add(preview)
  return () => {
    shared!.previews.delete(preview)
    if (!shared!.previews.size) shared!.dispose()
  }
}
