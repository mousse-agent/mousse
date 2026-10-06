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
    let preparing = false
    let disposed = false
    let deltaX = 0
    let deltaY = 0
    let settle: ReturnType<typeof setTimeout> | undefined
    const idle = () => {
      clearTimeout(settle)
      settle = setTimeout(() => {
        if (preparing) {
          idle()
          return
        }
        scrolling = false
        for (const item of previews) item.resume()
      }, 140)
    }
    const begin = () => {
      if (scrolling) return
      scrolling = true
      preparing = true
      void Promise.allSettled(
        [...previews].filter((item) => item.active()).map((item) => item.suspend())
      ).then(() => {
        preparing = false
        if (disposed) return
        if (deltaX || deltaY) {
          scroller.scrollBy({ left: deltaX, top: deltaY, behavior: 'instant' })
          deltaX = deltaY = 0
        }
        idle()
      })
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
        nestedScroll(event) ||
        ![...previews].some((item) => item.active())
      )
        return
      begin()
      if (preparing) {
        event.preventDefault()
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1
        deltaX += event.deltaX * unit
        deltaY += event.deltaY * unit
      }
      idle()
    }
    const scroll = () => {
      begin()
      idle()
    }
    scroller.addEventListener('wheel', wheel, { passive: false })
    scroller.addEventListener('scroll', scroll, { passive: true })
    shared = {
      previews,
      dispose: () => {
        disposed = true
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
