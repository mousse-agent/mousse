import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import { FloatingPortal, useFloatingPosition, type FloatingPlacement } from '../../lib/floatingLayer'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'

export interface CardPopoverProps {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  placement: FloatingPlacement
  label: string
  className?: string
  /** Focused once the popover has been positioned. */
  initialFocusRef?: RefObject<HTMLElement | null>
  /** Recompute the position when the content's size changes. */
  sizeKey?: unknown
  onClose: () => void
  children: ReactNode
}

/** A popover sized to the side card, closed by Escape or a click outside it. */
export function CardPopover({
  open,
  anchorRef,
  placement,
  label,
  className,
  initialFocusRef,
  sizeKey,
  onClose,
  children
}: CardPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const style = useFloatingPosition({
    open,
    anchorRef,
    contentRef: popoverRef,
    placement,
    gap: 4,
    deps: [sizeKey]
  })
  const dismissRefs = useMemo(() => [anchorRef, popoverRef], [anchorRef])
  useOutsideDismiss(open, dismissRefs, onClose)

  useEffect(() => {
    if (open && style.visibility === 'visible') initialFocusRef?.current?.focus()
  }, [open, style.visibility, initialFocusRef])

  if (!open) return null
  return (
    <FloatingPortal>
      <div
        ref={popoverRef}
        className={`side-card-git-popover${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-label={label}
        style={style}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          onClose()
          anchorRef.current?.focus()
        }}
      >
        {children}
      </div>
    </FloatingPortal>
  )
}
