import { useEffect, useRef } from 'react'

export interface ThreadsContextMenuTarget {
  type: 'thread' | 'project'
  id: string
  name: string
  pinned: boolean
}

interface ThreadsContextMenuProps {
  x: number
  y: number
  target: ThreadsContextMenuTarget
  onClose: () => void
  onPin: () => void
  onRename: () => void
  onRemove: () => void
}

export function ThreadsContextMenu({
  x,
  y,
  target,
  onClose,
  onPin,
  onRename,
  onRemove
}: ThreadsContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      onClose()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    const handleContextMenu = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      onClose()
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('contextmenu', handleContextMenu)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('contextmenu', handleContextMenu)
    }
  }, [onClose])

  useEffect(() => {
    const menu = menuRef.current
    if (!menu) return

    const rect = menu.getBoundingClientRect()
    const padding = 8
    let left = x
    let top = y

    if (left + rect.width > window.innerWidth - padding) {
      left = window.innerWidth - rect.width - padding
    }
    if (top + rect.height > window.innerHeight - padding) {
      top = window.innerHeight - rect.height - padding
    }

    menu.style.left = `${Math.max(padding, left)}px`
    menu.style.top = `${Math.max(padding, top)}px`
  }, [x, y])

  return (
    <div
      ref={menuRef}
      className="threads-context-menu"
      style={{ left: x, top: y }}
      role="menu"
    >
      <button type="button" className="threads-context-menu-item" role="menuitem" onClick={onPin}>
        {target.pinned ? 'Unpin' : 'Pin'}
      </button>
      <button type="button" className="threads-context-menu-item" role="menuitem" onClick={onRename}>
        Rename
      </button>
      <button
        type="button"
        className="threads-context-menu-item threads-context-menu-item-danger"
        role="menuitem"
        onClick={onRemove}
      >
        Remove
      </button>
    </div>
  )
}
