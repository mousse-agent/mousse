import {
  useLayoutEffect,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'

/** Above settings/channel overlays (1100–1200) and other UI chrome. */
export const FLOATING_LAYER_Z_INDEX = 50_000

export function FloatingPortal({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return null
  return createPortal(children, document.body)
}

export type FloatingPlacement = 'above-start' | 'above-end' | 'below-start' | 'below-end'

export interface FloatingPositionOptions {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  contentRef: RefObject<HTMLElement | null>
  placement?: FloatingPlacement
  gap?: number
  padding?: number
  /** Recompute when these values change (menu content size, etc.). */
  deps?: unknown[]
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
  deps = []
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
      const contentRect = content.getBoundingClientRect()
      const preferAbove = placement.startsWith('above')
      const preferEnd = placement.endsWith('end')

      let top = preferAbove
        ? anchorRect.top - contentRect.height - gap
        : anchorRect.bottom + gap
      let left = preferEnd
        ? anchorRect.right - contentRect.width
        : anchorRect.left

      // Flip vertically if the preferred side doesn't fit.
      if (preferAbove && top < padding) {
        top = anchorRect.bottom + gap
      } else if (!preferAbove && top + contentRect.height > window.innerHeight - padding) {
        top = anchorRect.top - contentRect.height - gap
      }

      // Clamp into viewport.
      top = Math.max(padding, Math.min(top, window.innerHeight - contentRect.height - padding))
      left = Math.max(padding, Math.min(left, window.innerWidth - contentRect.width - padding))

      setStyle({
        position: 'fixed',
        top,
        left,
        zIndex: FLOATING_LAYER_Z_INDEX,
        visibility: 'visible'
      })
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
  }, [open, placement, gap, padding, anchorRef, contentRef, ...deps])

  return style
}
