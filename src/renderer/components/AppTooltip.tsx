import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * The box a tooltip is placed against. `left` side tooltips sit to the left
 * of the box, vertically centred on it; the default sits centred above.
 */
type Anchor = {
  top: number
  left: number
  width: number
  height: number
  side?: 'left'
}

const GAP = 8
const EDGE = 8

/**
 * Opt-in: a container marked `data-tooltip-placement="outside-left"` shows
 * the tooltips of elements inside it just outside its left edge, vertically
 * centred on the hovered element. The model picker's provider rail uses this
 * so the tooltip sits beside the picker instead of over it.
 */
function anchorFor(element: HTMLElement): Anchor {
  const rect = element.getBoundingClientRect()
  const container = element.closest<HTMLElement>('[data-tooltip-placement="outside-left"]')
  if (!container) return { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
  const outer = container.getBoundingClientRect()
  return { top: rect.top, left: outer.left, width: outer.width, height: rect.height, side: 'left' }
}

/**
 * Places a tooltip of size `box` inside the viewport. By default it is
 * centred above the anchor. A `left` anchor puts it left of the anchor,
 * vertically centred, and flips it right only when the left has no room.
 */
export function placeTooltip(
  anchor: Anchor,
  box: { width: number; height: number },
  viewport: { width: number; height: number }
): { top: number; left: number } {
  const clampTop = (top: number) =>
    Math.min(Math.max(EDGE, top), Math.max(EDGE, viewport.height - box.height - EDGE))
  const clampLeft = (left: number) =>
    Math.min(Math.max(EDGE, left), Math.max(EDGE, viewport.width - box.width - EDGE))

  if (anchor.side === 'left') {
    const left = anchor.left - GAP - box.width
    const right = anchor.left + anchor.width + GAP
    const fitsLeft = left >= EDGE
    const fitsRight = right + box.width <= viewport.width - EDGE
    return {
      top: clampTop(anchor.top + anchor.height / 2 - box.height / 2),
      left: clampLeft(!fitsLeft && fitsRight ? right : left)
    }
  }

  let top = anchor.top - box.height - GAP
  if (top < EDGE) top = anchor.top + anchor.height + GAP
  return {
    top: clampTop(top),
    left: clampLeft(anchor.left + anchor.width / 2 - box.width / 2)
  }
}

const SHOW_DELAY_MS = 380

/**
 * Replaces the native title tooltip. The title is lifted off the element
 * while the pointer is over it so Windows never draws its own bubble.
 */
export function AppTooltip() {
  const tipRef = useRef<HTMLDivElement>(null)
  const pendingRef = useRef<HTMLElement | null>(null)
  const hostRef = useRef<HTMLElement | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    const tip = tipRef.current
    if (!tip || !anchor || !text) return
    const box = tip.getBoundingClientRect()
    setPlace(placeTooltip(anchor, box, { width: window.innerWidth, height: window.innerHeight }))
  }, [anchor, text])

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }

    const restore = (element: HTMLElement | null) => {
      if (!element) return
      const stored = element.dataset.appTooltip
      if (stored !== undefined && !element.getAttribute('title')) {
        element.setAttribute('title', stored)
      }
      delete element.dataset.appTooltip
    }

    const hide = () => {
      clearTimer()
      restore(pendingRef.current)
      restore(hostRef.current)
      pendingRef.current = null
      hostRef.current = null
      setText(null)
      setAnchor(null)
      setPlace(null)
    }

    const readTitle = (element: HTMLElement) => {
      const live = element.getAttribute('title')
      if (live?.trim()) return live
      const stored = element.dataset.appTooltip
      return stored?.trim() ? stored : ''
    }

    const liftTitle = (element: HTMLElement) => {
      const live = element.getAttribute('title')
      if (live !== null) {
        element.dataset.appTooltip = live
        element.removeAttribute('title')
      }
    }

    const show = (element: HTMLElement) => {
      const value = readTitle(element)
      if (!value) return
      liftTitle(element)
      hostRef.current = element
      pendingRef.current = null
      setText(value)
      setAnchor(anchorFor(element))
      setPlace(null)
    }

    const titledElement = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null
      const element = target.closest<HTMLElement>('[title], [data-app-tooltip]')
      if (!element || !readTitle(element)) return null
      return element
    }

    const arm = (element: HTMLElement) => {
      clearTimer()
      liftTitle(element)
      pendingRef.current = element
      timerRef.current = setTimeout(() => {
        if (pendingRef.current === element) show(element)
      }, SHOW_DELAY_MS)
    }

    const onOver = (event: PointerEvent) => {
      const element = titledElement(event.target)
      if (!element) return
      if (element === hostRef.current || element === pendingRef.current) return
      hide()
      arm(element)
    }

    const onOut = (event: PointerEvent) => {
      const current = hostRef.current ?? pendingRef.current
      if (!current) return
      const next = event.relatedTarget
      if (next instanceof Node && current.contains(next)) return
      hide()
    }

    const observer = new MutationObserver(() => {
      const element = hostRef.current ?? pendingRef.current
      if (!element) return
      liftTitle(element)
      if (hostRef.current === element) {
        const value = element.dataset.appTooltip?.trim()
        if (value) setText(value)
      }
    })
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['title']
    })

    const onScroll = () => {
      const current = hostRef.current ?? pendingRef.current
      hide()
      if (current?.matches(':hover')) arm(current)
    }

    document.addEventListener('pointerover', onOver)
    document.addEventListener('pointerout', onOut)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('blur', hide)
    return () => {
      hide()
      observer.disconnect()
      document.removeEventListener('pointerover', onOver)
      document.removeEventListener('pointerout', onOut)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('blur', hide)
    }
  }, [])

  if (!text || !anchor) return null

  return (
    <div
      ref={tipRef}
      className="app-tooltip"
      role="tooltip"
      style={{
        top: place?.top ?? -9999,
        left: place?.left ?? 0,
        visibility: place ? 'visible' : 'hidden'
      }}
    >
      {text}
    </div>
  )
}
