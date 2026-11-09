import {
  useLayoutEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'

/** Above settings overlays (1100–1200) and other UI chrome. */
export const FLOATING_LAYER_Z_INDEX = 50_000

export function FloatingPortal({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return null
  return createPortal(children, document.body)
}

export type FloatingPlacement =
  | 'above-start'
  | 'above-end'
  | 'below-start'
  | 'below-end'
  | 'right-start'
  | 'right-end'
  | 'left-start'
  | 'left-end'

export interface FloatingPositionOptions {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  contentRef: RefObject<HTMLElement | null>
  placement?: FloatingPlacement
  gap?: number
  padding?: number
  /** Recompute when these values change (menu content size, etc.). */
  deps?: unknown[]
  /** Give the layer the anchor's width, so a menu never spills past the control that opened it. */
  matchAnchorWidth?: boolean
}

/**
 * Fixed viewport coordinates for a floating layer anchored to an element.
 * Clamps within the viewport so the menu is never clipped off-screen.
 */
export function useFloatingPosition({
  open,
  anchorRef,
  contentRef,
  placement = 'above-start',
  gap = 8,
  padding = 8,
  deps = [],
  matchAnchorWidth = false
}: FloatingPositionOptions): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({
    position: 'fixed',
    top: 0,
    left: 0,
    zIndex: FLOATING_LAYER_Z_INDEX,
    visibility: 'hidden'
  })

  useLayoutEffect(() => {
    if (!open) {
      setStyle({
        position: 'fixed',
        top: 0,
        left: 0,
        zIndex: FLOATING_LAYER_Z_INDEX,
        visibility: 'hidden'
      })
      return
    }

    const update = () => {
      const anchor = anchorRef.current
      const content = contentRef.current
      if (!anchor || !content) return

      const anchorRect = anchor.getBoundingClientRect()
      // Set before measuring: the height depends on the width (wrapping, stacked columns).
      const width = matchAnchorWidth ? anchorRect.width : undefined
      if (width !== undefined) content.style.width = `${width}px`
      const contentRect = content.getBoundingClientRect()
      const preferAbove = placement.startsWith('above')
      const preferBelow = placement.startsWith('below')
      const preferRight = placement.startsWith('right')
      const preferLeft = placement.startsWith('left')
      const preferEnd = placement.endsWith('end')
      const horizontal = preferRight || preferLeft

      let top: number
      let left: number

      if (horizontal) {
        left = preferRight
          ? anchorRect.right + gap
          : anchorRect.left - contentRect.width - gap
        top = preferEnd
          ? anchorRect.bottom - contentRect.height
          : anchorRect.top

        // Flip horizontally if the preferred side doesn't fit.
        if (preferRight && left + contentRect.width > window.innerWidth - padding) {
          left = anchorRect.left - contentRect.width - gap
        } else if (preferLeft && left < padding) {
          left = anchorRect.right + gap
        }
      } else {
        top = preferAbove
          ? anchorRect.top - contentRect.height - gap
          : anchorRect.bottom + gap
        left = preferEnd
          ? anchorRect.right - contentRect.width
          : anchorRect.left

        // Flip vertically if the preferred side doesn't fit.
        if (preferAbove && top < padding) {
          top = anchorRect.bottom + gap
        } else if (preferBelow && top + contentRect.height > window.innerHeight - padding) {
          top = anchorRect.top - contentRect.height - gap
        }
      }

      // Clamp into viewport.
      top = Math.max(padding, Math.min(top, window.innerHeight - contentRect.height - padding))
      left = Math.max(padding, Math.min(left, window.innerWidth - contentRect.width - padding))

      setStyle({
        position: 'fixed',
        top,
        left,
        ...(width !== undefined ? { width } : {}),
        zIndex: FLOATING_LAYER_Z_INDEX,
        visibility: 'visible',
        // A layer that should be no wider than its anchor reads this in its CSS.
        '--floating-anchor-width': `${anchorRect.width}px`
      } as CSSProperties)
    }

    update()
    const frame = window.requestAnimationFrame(update)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, placement, gap, padding, anchorRef, contentRef, matchAnchorWidth, ...deps])

  return style
}

export interface PinnedPopoverOptions {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  contentRef: RefObject<HTMLElement | null>
  /** The tallest the layer may be; less where the window has less room. */
  maxHeight: number
  /** Below this much room on its side (and more on the other), the layer opens on the other side instead. */
  minHeight?: number
  gap?: number
  padding?: number
  /**
   * `above` (the default) or `below` the anchor, flipping only when `minHeight` does not fit there and the
   * other side has more room. `right`: beside the anchor, bottom edges aligned, growing upward (a rail item's menu).
   */
  side?: 'above' | 'below' | 'right'
  /** Above or below the anchor: `end` lines the layer's right edge up with the anchor's (a row's "…" at its end). */
  align?: 'start' | 'end'
}

/**
 * Fixed coordinates for a popover pinned above its anchor, start-aligned to it. The edge next to the
 * anchor is set (`bottom`), not the far one, so the layer grows and shrinks away from the anchor as
 * its content changes and never moves or covers it. The room it has is `--floating-max-height`; it
 * opens below only when even `minHeight` does not fit above. Positioned before the first paint, from
 * layout sizes (a scale animation on the layer does not skew them).
 */
export function usePinnedPopover({
  open,
  anchorRef,
  contentRef,
  maxHeight,
  minHeight = 220,
  gap = 6,
  padding = 8,
  side = 'above',
  align = 'start'
}: PinnedPopoverOptions): CSSProperties {
  const hidden: CSSProperties = { position: 'fixed', top: 0, left: 0, zIndex: FLOATING_LAYER_Z_INDEX, visibility: 'hidden' }
  const [style, setStyle] = useState<CSSProperties>(hidden)

  useLayoutEffect(() => {
    if (!open) {
      setStyle(hidden)
      return
    }
    let last = ''
    const update = () => {
      const anchor = anchorRef.current
      const content = contentRef.current
      if (!anchor || !content) return
      const rect = anchor.getBoundingClientRect()
      const viewportHeight = window.innerHeight
      const viewportWidth = window.innerWidth
      if (side === 'right') {
        const width = content.offsetWidth
        const bottom = Math.round(Math.max(padding, viewportHeight - rect.bottom))
        const next: CSSProperties & Record<'--floating-max-height', string> = {
          position: 'fixed',
          left: Math.round(Math.max(padding, Math.min(rect.right + gap, viewportWidth - width - padding))),
          bottom,
          zIndex: FLOATING_LAYER_Z_INDEX,
          transformOrigin: '0 100%',
          '--floating-max-height': `${Math.max(0, Math.floor(Math.min(maxHeight, viewportHeight - bottom - padding)))}px`
        }
        const key = JSON.stringify(next)
        if (key !== last) { last = key; setStyle(next) }
        return
      }
      const roomAbove = rect.top - gap - padding
      const roomBelow = viewportHeight - rect.bottom - gap - padding
      const needed = Math.min(minHeight, maxHeight)
      const above = side === 'below'
        ? roomBelow < needed && roomAbove > roomBelow
        : roomAbove >= needed || roomAbove >= roomBelow
      const room = Math.max(0, Math.floor(Math.min(maxHeight, above ? roomAbove : roomBelow)))
      const width = content.offsetWidth
      const start = align === 'end' ? rect.right - width : rect.left
      const left = Math.round(Math.max(padding, Math.min(start, viewportWidth - width - padding)))
      const originX = Math.round(Math.max(0, Math.min(width, rect.left + Math.min(rect.width, 40) / 2 - left)))
      const next: CSSProperties & Record<'--floating-max-height', string> = {
        position: 'fixed',
        left,
        ...(above ? { bottom: Math.round(viewportHeight - rect.top + gap) } : { top: Math.round(rect.bottom + gap) }),
        zIndex: FLOATING_LAYER_Z_INDEX,
        transformOrigin: `${originX}px ${above ? '100%' : '0'}`,
        '--floating-max-height': `${room}px`
      }
      const key = JSON.stringify(next)
      if (key === last) return
      last = key
      setStyle(next)
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    // The anchor moves when the composer around it changes size (a new thread's rows, a taller draft).
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    const anchor = anchorRef.current
    for (const frame of new Set([anchor?.closest<HTMLElement>('.composer'), anchor?.closest<HTMLElement>('.chat-input-area'), anchor?.parentElement])) {
      if (observer && frame) observer.observe(frame)
    }
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      observer?.disconnect()
    }
  }, [open, anchorRef, contentRef, maxHeight, minHeight, gap, padding, side, align])

  return style
}

/**
 * A ref to the closest element around `ref`'s that matches `selector`, or `ref`'s own element when
 * none does; read when used. A composer's menus anchor to the whole composer so they open above it,
 * off the draft, however deep their button sits.
 */
export function useClosestAnchor(ref: RefObject<HTMLElement | null>, selector: string): RefObject<HTMLElement | null> {
  return useMemo(() => ({
    get current() {
      return ref.current?.closest<HTMLElement>(selector) ?? ref.current
    }
  }), [ref, selector])
}
