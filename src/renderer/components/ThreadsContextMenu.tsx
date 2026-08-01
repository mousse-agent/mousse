import { useEffect, useRef } from 'react'
import {
  ArchiveArrowBackRegular,
  ArchiveRegular,
  ArrowSyncRegular,
  DeleteRegular,
  EditRegular,
  PinOffRegular,
  PinRegular
} from '@fluentui/react-icons'
import { FloatingPortal, FLOATING_LAYER_Z_INDEX } from '../lib/floatingLayer'

export interface ThreadsContextMenuTarget {
  type: 'thread' | 'project'
  id: string
  name: string
  pinned: boolean
  settled?: boolean
}

interface ThreadsContextMenuProps {
  x: number
  y: number
  target: ThreadsContextMenuTarget
  onClose: () => void
  onPin: () => void
  onSettle: () => void
  onRegenerateTitle: () => void
  onRename: () => void
  onRemove: () => void
}

export function ThreadsContextMenu({
  x,
  y,
  target,
  onClose,
  onPin,
  onSettle,
  onRegenerateTitle,
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
    <FloatingPortal>
      <div
        ref={menuRef}
        className="threads-context-menu"
        style={{ left: x, top: y, zIndex: FLOATING_LAYER_Z_INDEX }}
        role="menu"
      >
        {!target.settled && (
          <button type="button" className="threads-context-menu-item" role="menuitem" onClick={onPin}>
            {target.pinned ? <PinOffRegular /> : <PinRegular />}
            <span>{target.pinned ? 'Unpin' : 'Pin'}</span>
          </button>
        )}
        {target.type === 'thread' && (
          <button type="button" className="threads-context-menu-item" role="menuitem" onClick={onSettle}>
            {target.settled ? <ArchiveArrowBackRegular /> : <ArchiveRegular />}
            <span>{target.settled ? 'Unsettle' : 'Settle'}</span>
          </button>
        )}
        {target.type === 'thread' && (
          <button type="button" className="threads-context-menu-item" role="menuitem" onClick={onRegenerateTitle}>
            <ArrowSyncRegular />
            <span>Regenerate title</span>
          </button>
        )}
        <button type="button" className="threads-context-menu-item" role="menuitem" onClick={onRename}>
          <EditRegular />
          <span>Rename</span>
        </button>
        <button
          type="button"
          className="threads-context-menu-item threads-context-menu-item-danger"
          role="menuitem"
          onClick={onRemove}
        >
          <DeleteRegular />
          <span>Remove</span>
        </button>
      </div>
    </FloatingPortal>
  )
}
