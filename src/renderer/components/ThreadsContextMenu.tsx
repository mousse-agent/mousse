import { useEffect, useRef } from 'react'
import {
  ArchiveArrowBackRegular,
  ArchiveRegular,
  ArrowSyncRegular,
  DeleteRegular,
  EditRegular,
  PinOffRegular,
  PinRegular,
  ShieldCheck
} from '../lib/icons'
import { FloatingPortal, FLOATING_LAYER_Z_INDEX } from '../lib/floatingLayer'

export interface ThreadsContextMenuTarget {
  type: 'thread' | 'project'
  id: string
  name: string
  pinned: boolean
  settled?: boolean
  /** The computer a project is on, when it is not this one. */
  node?: string
  /** That computer's name: the menu acts on the project there, and says so. */
  computerName?: string
  /** On a project of this computer: the other computers that hold the same repository. Removing leaves their projects. */
  alsoOn?: readonly string[]
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
  /** Projects only: record the repository's own Git filters as the user's again. */
  onTrustGitSettings?: () => void
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
  onRemove,
  onTrustGitSettings
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
        {target.type === 'project' && target.computerName && (
          <div className="threads-context-menu-label" role="presentation">On {target.computerName}</div>
        )}
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
        {target.type === 'project' && onTrustGitSettings && !target.node && (
          <button
            type="button"
            className="threads-context-menu-item"
            role="menuitem"
            title="Mousse runs this repository's own Git filters (git-crypt, a local Git LFS) only as they were when you added it. Use this after you changed one yourself."
            onClick={onTrustGitSettings}
          >
            <ShieldCheck />
            <span>Trust Git settings again</span>
          </button>
        )}
        <button
          type="button"
          className="threads-context-menu-item threads-context-menu-item-danger"
          role="menuitem"
          title={
            target.type === 'project' && target.alsoOn?.length
              ? `Removes the project from this computer only. ${target.alsoOn.join(' and ')} keep${target.alsoOn.length === 1 ? 's' : ''} theirs.`
              : undefined
          }
          onClick={onRemove}
        >
          <DeleteRegular />
          <span>Remove</span>
        </button>
      </div>
    </FloatingPortal>
  )
}
