import { useCallback, useEffect, useId, useMemo, useRef, type CSSProperties, type KeyboardEvent, type RefObject } from 'react'
import { focusInitialMenuItem, useMenuKeyboard } from '../../hooks/useMenuKeyboard'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'
import { useFloatingPosition } from '../../lib/floatingLayer'

interface SideCardMenuOptions {
  open: boolean
  setOpen: (open: boolean) => void
  /** The menu opens below this element, and a press inside it is not an outside press. */
  anchorRef: RefObject<HTMLElement | null>
  /** Gets focus back when the menu closes. */
  focusRef: RefObject<HTMLElement | null>
  /** Changes when the menu's size does, so it is positioned again. */
  sizeKey: number
}

export interface SideCardMenu {
  menuRef: RefObject<HTMLDivElement | null>
  menuId: string
  menuStyle: CSSProperties
  /** Close the menu and return focus to its button. */
  closeAndFocus: () => void
  /** Keyboard handling for the menu element. */
  menuKeyDown: (event: KeyboardEvent) => void
  /** Keyboard handling for the button that opens it: ArrowDown and ArrowUp open the menu. */
  triggerKeyDown: (event: KeyboardEvent) => void
}

/** Positioning, dismissal, focus and keyboard handling shared by the side card's menus. */
export function useSideCardMenu({ open, setOpen, anchorRef, focusRef, sizeKey }: SideCardMenuOptions): SideCardMenu {
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const menuStyle = useFloatingPosition({
    open,
    anchorRef,
    contentRef: menuRef,
    placement: 'below-start',
    deps: [sizeKey]
  })

  const close = useCallback(() => setOpen(false), [setOpen])
  const dismissRefs = useMemo(() => [anchorRef, menuRef], [anchorRef])
  useOutsideDismiss(open, dismissRefs, close)

  useEffect(() => {
    if (open && menuStyle.visibility === 'visible') focusInitialMenuItem(menuRef.current)
  }, [open, menuStyle.visibility])

  // Escape closes through the window-level path above when focus is outside
  // the menu; the button gets focus back either way.
  useEffect(() => {
    if (!open) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') focusRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, focusRef])

  const closeAndFocus = useCallback(() => {
    setOpen(false)
    focusRef.current?.focus()
  }, [setOpen, focusRef])
  const menuKeyDown = useMenuKeyboard(menuRef, closeAndFocus)
  const triggerKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
    }
  }, [setOpen])

  return { menuRef, menuId, menuStyle, closeAndFocus, menuKeyDown, triggerKeyDown }
}
