import { useCallback, type KeyboardEvent, type RefObject } from 'react'

const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"]'

/**
 * Items the keyboard can reach, in document order. Rows marked `aria-disabled`
 * stay reachable so their reason can be heard; natively disabled ones are skipped.
 */
export function menuItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return []
  return Array.from(menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter((item) => !item.matches(':disabled'))
}

/** The index a key moves to, or undefined for keys that do not move. Empty menus never move. */
export function nextMenuIndex(key: string, index: number, count: number): number | undefined {
  if (count === 0) return undefined
  if (key === 'ArrowDown') return (index + 1) % count
  if (key === 'ArrowUp') return (index - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return undefined
}

/** Focuses the checked item, or the first one. */
export function focusInitialMenuItem(menu: HTMLElement | null): void {
  const items = menuItems(menu)
  const checked = items.find((item) => item.getAttribute('aria-checked') === 'true')
  ;(checked ?? items[0])?.focus()
}

/**
 * Keyboard handling for a menu: arrows, Home and End move between items,
 * Escape and Tab close it. `onClose` should return focus to the menu's button.
 */
export function useMenuKeyboard(menuRef: RefObject<HTMLElement | null>, onClose: () => void) {
  return useCallback((event: KeyboardEvent) => {
    const items = menuItems(menuRef.current)
    const index = items.indexOf(document.activeElement as HTMLElement)
    const next = nextMenuIndex(event.key, index, items.length)
    if (next !== undefined) {
      event.preventDefault()
      items[next]?.focus()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else if (event.key === 'Tab') onClose()
  }, [menuRef, onClose])
}
