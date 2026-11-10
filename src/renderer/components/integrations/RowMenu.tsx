import { useEffect, useRef, useState, type ReactNode } from 'react'
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
  /** `data-testid` on the item. */
  testId?: string
  /** A second, quieter line under the label: what the item does, or what it needs first. */
  detail?: string
}

/**
 * Overflow menu for a row's secondary actions. Choosing an item puts focus back on the button first, so a dialog the
 * item opens returns focus there when it closes. `buttonClassName` replaces the settings icon button's look, and
 * `trigger` replaces the "more" icon with visible content (a text button such as "Add device").
 */
export function RowMenu({ label, items, disabled, buttonClassName = 'settings-icon-btn', iconSize = 14, trigger }: {
  label: string
  items: RowMenuItem[]
  disabled?: boolean
  buttonClassName?: string
  iconSize?: number
  trigger?: ReactNode
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
      aria-label={trigger ? undefined : label}
      title={trigger ? undefined : 'More actions'}
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={disabled}
      onClick={() => setOpen((value) => !value)}
    >
      {trigger ?? <MoreHorizontal size={iconSize} aria-hidden="true" />}
    </button>
    {open && <FloatingPortal>
      <div ref={panelRef} className="row-menu" role="menu" aria-label={label} style={style}>
        {items.map((item) => <button
          key={item.label}
          type="button"
          role="menuitem"
          className={`row-menu-item${item.danger ? ' danger' : ''}${item.detail ? ' has-detail' : ''}`}
          // An item with a detail line stays focusable while unavailable, so its need is read out.
          disabled={item.disabled && !item.detail}
          aria-disabled={item.disabled && item.detail ? true : undefined}
          title={item.title}
          data-action={item.action}
          data-testid={item.testId}
          aria-label={item.ariaLabel}
          onClick={() => { if (item.disabled) return; setOpen(false); buttonRef.current?.focus(); item.onSelect() }}
        >{item.detail ? <><span className="row-menu-item-label">{item.label}</span><span className="row-menu-item-detail">{item.detail}</span></> : item.label}</button>)}
      </div>
    </FloatingPortal>}
  </>
}
