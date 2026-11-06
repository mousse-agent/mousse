import { useEffect, useRef, useState } from 'react'
import { MoreHorizontal } from '../../lib/icons'
import { FloatingPortal, useFloatingPosition } from '../../lib/floatingLayer'
import './rowMenu.css'

export interface RowMenuItem {
  label: string
  onSelect: () => void
  disabled?: boolean
  danger?: boolean
  /** Tooltip, e.g. why the item is disabled. */
  title?: string
  /** `data-action` on the item, for tests and scripted checks. */
  action?: string
  /** A fuller name for assistive tech, when the label leaves out what the item acts on. */
  ariaLabel?: string
}

/**
 * Overflow menu for a row's secondary actions. Choosing an item puts focus back on the button first, so a dialog the
 * item opens returns focus there when it closes. `buttonClassName` replaces the settings icon button's look.
 */
export function RowMenu({ label, items, disabled, buttonClassName = 'settings-icon-btn', iconSize = 14 }: {
  label: string
  items: RowMenuItem[]
  disabled?: boolean
  buttonClassName?: string
  iconSize?: number
}) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const style = useFloatingPosition({ open, anchorRef: buttonRef, contentRef: panelRef, placement: 'below-end', gap: 4 })

  useEffect(() => {
    if (!open) return
    panelRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const pointer = (event: MouseEvent) => {
      const target = event.target as Node
      if (!buttonRef.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false)
    }
    // Capture so a surrounding dialog does not also treat Escape as "close".
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation()
        setOpen(false); buttonRef.current?.focus()
        return
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const buttons = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
      if (!buttons.length) return
      event.preventDefault()
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length
      buttons[next]?.focus()
    }
    document.addEventListener('mousedown', pointer)
    window.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('mousedown', pointer)
      window.removeEventListener('keydown', key, true)
    }
  }, [open])

  return <>
    <button
      ref={buttonRef}
      type="button"
      className={`${buttonClassName} row-menu-btn`}
      aria-label={label}
      title="More actions"
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={disabled}
      onClick={() => setOpen((value) => !value)}
    >
      <MoreHorizontal size={iconSize} aria-hidden="true" />
    </button>
    {open && <FloatingPortal>
      <div ref={panelRef} className="row-menu" role="menu" aria-label={label} style={style}>
        {items.map((item) => <button
          key={item.label}
          type="button"
          role="menuitem"
          className={`row-menu-item${item.danger ? ' danger' : ''}`}
          disabled={item.disabled}
          title={item.title}
          data-action={item.action}
          aria-label={item.ariaLabel}
          onClick={() => { setOpen(false); buttonRef.current?.focus(); item.onSelect() }}
        >{item.label}</button>)}
      </div>
    </FloatingPortal>}
  </>
}
