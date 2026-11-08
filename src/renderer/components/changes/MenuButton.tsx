import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check } from '../../lib/icons'
import { useMenuKeyboard } from '../../hooks/useMenuKeyboard'
import { FloatingPortal, useFloatingPosition, type FloatingPlacement } from '../../lib/floatingLayer'
import '../../styles/composer-workspace.css'

export interface MenuItem {
  label: string
  /** Quiet text at the end of the row, such as a key. */
  hint?: string
  /** A check-mark row (an option that stays on). Picking it keeps the menu open so the mark shows. */
  checked?: boolean
  disabled?: boolean
  title?: string
  onSelect: () => void
}

interface MenuButtonProps {
  label: string
  items: readonly MenuItem[]
  children: ReactNode
  className?: string
  placement?: FloatingPlacement
  title?: string
  disabled?: boolean
}

/**
 * A button that opens the app's one dropdown style: a themed raised menu with compact rows, a neutral hover
 * and a check mark for an option that is on. Escape, Tab or a click outside close it.
 */
export function MenuButton({ label, items, children, className = 'changes-icon-btn', placement = 'below-end', title, disabled }: MenuButtonProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const style = useFloatingPosition({ open, anchorRef: triggerRef, contentRef: menuRef, placement, deps: [items.length] })
  const close = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }
  const onMenuKeyDown = useMenuKeyboard(menuRef, close)

  useEffect(() => {
    if (!open) return
    if (style.visibility === 'visible') menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus()
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, style.visibility])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`${className}${open ? ' open' : ''}`}
        title={title ?? label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          setOpen(true)
        }}
      >
        {children}
      </button>
      {open && (
        <FloatingPortal>
          <div ref={menuRef} id={menuId} className="composer-workspace-menu changes-menu" role="menu" aria-label={label} style={style} onKeyDown={onMenuKeyDown}>
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                aria-checked={item.checked}
                tabIndex={-1}
                className="composer-workspace-menu-item"
                disabled={item.disabled}
                title={item.title}
                onClick={() => {
                  if (item.checked === undefined) setOpen(false)
                  item.onSelect()
                }}
              >
                <span>{item.label}</span>
                {item.hint && <span className="composer-workspace-menu-hint">{item.hint}</span>}
                {item.checked !== undefined && (
                  <Check size={14} className="composer-workspace-menu-check" aria-hidden="true" style={item.checked ? undefined : { visibility: 'hidden' }} />
                )}
              </button>
            ))}
          </div>
        </FloatingPortal>
      )}
    </>
  )
}
