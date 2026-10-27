import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { FloatingPortal, useFloatingPosition } from '../../lib/floatingLayer'

export interface ProfileRowMenuItem {
  id: string
  label: string
  icon: ReactNode
  danger?: boolean
  onSelect: () => void
}

interface ProfileRowMenuProps {
  /** The kebab button that opened the menu; focus returns to it when the menu closes by keyboard. */
  anchor: HTMLElement
  /** Names the menu, for example "Studio profile actions". */
  label: string
  items: ProfileRowMenuItem[]
  onClose: () => void
}

/** The small actions menu of one profile row. Opens beside its kebab and keeps its own keyboard model. */
export function ProfileRowMenu({ anchor, label, items, onClose }: ProfileRowMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef(anchor)
  anchorRef.current = anchor
  const style = useFloatingPosition({ open: true, anchorRef, contentRef: menuRef, placement: 'right-start', gap: 4 })

  useEffect(() => {
    if (style.visibility !== 'visible') return
    if (!menuRef.current?.contains(document.activeElement)) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [style.visibility])

  useEffect(() => {
    const outside = (event: MouseEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !anchor.contains(target)) onClose()
    }
    window.addEventListener('mousedown', outside)
    return () => window.removeEventListener('mousedown', outside)
  }, [anchor, onClose])

  const close = () => {
    anchor.focus()
    onClose()
  }

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...menuRef.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
    const index = rows.indexOf(document.activeElement as HTMLButtonElement)
    const move = (to: number) => { event.preventDefault(); rows[(to + rows.length) % rows.length]?.focus() }
    switch (event.key) {
      case 'ArrowDown': return move(index + 1)
      case 'ArrowUp': return move(index < 0 ? -1 : index - 1)
      case 'Home': return move(0)
      case 'End': return move(-1)
      case 'Escape':
      case 'ArrowLeft':
      case 'Tab':
        // The popover behind this menu must not also see the key: Escape closes one layer at a time.
        event.preventDefault()
        event.stopPropagation()
        return close()
    }
  }

  return (
    <FloatingPortal>
      <div ref={menuRef} className="profile-row-menu" data-profile-row-menu="" role="menu" aria-label={label} style={style} onKeyDown={keyDown}>
        {items.map((item) => (
          <button key={item.id} className={`profile-menu-row${item.danger ? ' profile-menu-row-danger' : ''}`} type="button" role="menuitem" onClick={item.onSelect}>
            {item.icon}<span>{item.label}</span>
          </button>
        ))}
      </div>
    </FloatingPortal>
  )
}
