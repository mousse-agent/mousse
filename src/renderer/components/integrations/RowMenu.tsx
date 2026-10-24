import { useEffect, useRef, useState } from 'react'
import { MoreHorizontal } from '../../lib/icons'
import { FloatingPortal, useFloatingPosition } from '../../lib/floatingLayer'

export interface RowMenuItem {
  label: string
  onSelect: () => void
  disabled?: boolean
  danger?: boolean
}

/** Overflow menu for a settings row's secondary actions. */
export function RowMenu({ label, items, disabled }: { label: string; items: RowMenuItem[]; disabled?: boolean }) {
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
      className="settings-icon-btn row-menu-btn"
      aria-label={label}
      title="More actions"
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={disabled}
      onClick={() => setOpen((value) => !value)}
    >
      <MoreHorizontal size={14} aria-hidden="true" />
    </button>
    {open && <FloatingPortal>
      <div ref={panelRef} className="row-menu" role="menu" aria-label={label} style={style}>
        {items.map((item) => <button
          key={item.label}
          type="button"
          role="menuitem"
          className={`row-menu-item${item.danger ? ' danger' : ''}`}
          disabled={item.disabled}
          onClick={() => { setOpen(false); item.onSelect() }}
        >{item.label}</button>)}
      </div>
    </FloatingPortal>}
  </>
}
