import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { focusInitialMenuItem, useMenuKeyboard } from '../hooks/useMenuKeyboard'
import {
  ArchiveArrowBackRegular,
  ArchiveRegular,
  ArrowSyncRegular,
  ChevronRight,
  Code2,
  Copy,
  DeleteRegular,
  EditRegular,
  FolderSearch,
  GitBranch,
  GitPullRequest,
  MessageSquarePlus,
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
  /** The computer a project or thread is on, when it is not this one. */
  node?: string
  /** That computer's name: the menu acts on the project there, and says so. An archived thread there is deleted there. */
  computerName?: string
  /** On a project of this computer: the other computers that hold the same repository. Removing leaves their projects. */
  alsoOn?: readonly string[]
  /** A project's folder, on the computer that holds it. */
  path?: string
}

/** An app the project's folder opens in: its menu label ("Open in Cursor", "Show in Finder") and how to open it. */
export interface ProjectOpener {
  label: string
  onSelect: () => void
}

interface ThreadsContextMenuProps {
  /** Where the menu opens: the pointer for a right-click, below the "…" button or the row from the keyboard. */
  x: number
  y: number
  target: ThreadsContextMenuTarget
  /** Closes the menu; the caller returns focus to the row or button it was opened from. */
  onClose: () => void
  onPin: () => void
  onArchive: () => void
  onRegenerateTitle: () => void
  onRename: () => void
  onRemove: () => void
  /** Projects only: record the repository's own Git filters as the user's again. */
  onTrustGitSettings?: () => void
  /** Projects only: start a thread in the project. */
  onNewThread?: () => void
  /** Projects only: start a thread from one of the project's pull requests. */
  onNewThreadFromPullRequest?: () => void
  /** Projects of this computer only: the editor the folder opens in, and the file manager. */
  openInEditor?: ProjectOpener
  reveal?: ProjectOpener
  /** Projects only: copy the folder's path. */
  onCopyPath?: () => void
}

const Separator = () => <div className="threads-context-menu-separator" role="separator" />

/**
 * "Git ›": rarely needed project actions, one level down. Opens on hover, click, Enter, Space or the right arrow
 * (focusing its first item); the left arrow or Escape closes it and returns to "Git".
 */
function GitSubmenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [focusFirst, setFocusFirst] = useState(false)
  const [flip, setFlip] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const submenuRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])
  const onSubmenuKeyDown = useMenuKeyboard(submenuRef, close)

  useLayoutEffect(() => {
    const submenu = submenuRef.current
    if (!open || !submenu) return
    setFlip(submenu.getBoundingClientRect().right > window.innerWidth - 8)
    if (focusFirst) {
      focusInitialMenuItem(submenu)
      setFocusFirst(false)
    }
  }, [open, focusFirst])

  const openWithKeyboard = () => {
    setOpen(true)
    setFocusFirst(true)
  }

  return (
    <div className="threads-context-submenu-anchor" role="none" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        ref={triggerRef}
        type="button"
        className="threads-context-menu-item threads-context-submenu-trigger"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={openWithKeyboard}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            event.stopPropagation()
            openWithKeyboard()
          } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') setOpen(false)
        }}
      >
        <GitBranch />
        <span>Git</span>
        <ChevronRight className="threads-context-submenu-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={submenuRef}
          className={`threads-context-menu threads-context-submenu${flip ? ' flip' : ''}`}
          role="menu"
          aria-label="Git"
          data-submenu=""
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'ArrowLeft') {
              event.preventDefault()
              close()
              return
            }
            onSubmenuKeyDown(event)
          }}
        >
          {children}
        </div>
      )}
    </div>
  )
}

export function ThreadsContextMenu({
  x,
  y,
  target,
  onClose,
  onPin,
  onArchive,
  onRegenerateTitle,
  onRename,
  onRemove,
  onTrustGitSettings,
  onNewThread,
  onNewThreadFromPullRequest,
  openInEditor,
  reveal,
  onCopyPath
}: ThreadsContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const onMenuKeyDown = useMenuKeyboard(menuRef, onClose)

  // Opening the menu, by mouse or keyboard, puts focus on its first item so arrows, Enter and Escape work at once.
  useEffect(() => { focusInitialMenuItem(menuRef.current) }, [])

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
        aria-label={target.type === 'project' ? `Project ${target.name}` : `Thread ${target.name}`}
        onKeyDown={onMenuKeyDown}
      >
        {target.type === 'project' && target.computerName && (
          <div className="threads-context-menu-label" role="presentation">On {target.computerName}</div>
        )}
        {target.type === 'project' && (onNewThread || onNewThreadFromPullRequest) && (
          <>
            {onNewThread && (
              <button type="button" className="threads-context-menu-item" role="menuitem" onClick={onNewThread}>
                <MessageSquarePlus />
                <span>New thread</span>
              </button>
            )}
            {onNewThreadFromPullRequest && (
              <button type="button" className="threads-context-menu-item" role="menuitem" onClick={onNewThreadFromPullRequest}>
                <GitPullRequest />
                <span>New thread from a pull request</span>
              </button>
            )}
            <Separator />
          </>
        )}
        {target.type === 'project' && (openInEditor || reveal || onCopyPath) && (
          <>
            {openInEditor && (
              <button type="button" className="threads-context-menu-item" role="menuitem" onClick={openInEditor.onSelect}>
                <Code2 />
                <span>{openInEditor.label}</span>
              </button>
            )}
            {reveal && (
              <button type="button" className="threads-context-menu-item" role="menuitem" onClick={reveal.onSelect}>
                <FolderSearch />
                <span>{reveal.label}</span>
              </button>
            )}
            {onCopyPath && (
              <button type="button" className="threads-context-menu-item" role="menuitem" title={target.path} onClick={onCopyPath}>
                <Copy />
                <span>Copy path</span>
              </button>
            )}
            <Separator />
          </>
        )}
        {!target.settled && (
          <button type="button" className="threads-context-menu-item" role="menuitem" onClick={onPin}>
            {target.pinned ? <PinOffRegular /> : <PinRegular />}
            <span>{target.pinned ? 'Unpin' : 'Pin'}</span>
          </button>
        )}
        {target.type === 'thread' && (
          <button type="button" className="threads-context-menu-item" role="menuitem" onClick={onArchive}>
            {target.settled ? <ArchiveArrowBackRegular /> : <ArchiveRegular />}
            <span>{target.settled ? 'Unarchive' : 'Archive'}</span>
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
          <GitSubmenu>
            <button
              type="button"
              className="threads-context-menu-item"
              role="menuitem"
              title="Mousse runs this repository's own Git filters (git-crypt, a local Git LFS) only as they were when you added it. Use this after you changed one yourself."
              onClick={onTrustGitSettings}
            >
              <ShieldCheck />
              <span>Trust this repository's Git settings</span>
            </button>
          </GitSubmenu>
        )}
        {target.type === 'project' && <Separator />}
        {target.type === 'project' && (
          <button
            type="button"
            className="threads-context-menu-item threads-context-menu-item-danger"
            role="menuitem"
            title={
              target.alsoOn?.length
                ? `Removes the project from this computer only. ${target.alsoOn.join(' and ')} keep${target.alsoOn.length === 1 ? 's' : ''} theirs.`
                : undefined
            }
            onClick={onRemove}
          >
            <DeleteRegular />
            <span>Remove project…</span>
          </button>
        )}
        {/* A thread is archived before it can be deleted; deleting is permanent and stays on the thread's computer. */}
        {target.type === 'thread' && target.settled && (
          <button
            type="button"
            className="threads-context-menu-item threads-context-menu-item-danger"
            role="menuitem"
            disabled={Boolean(target.node)}
            title={target.node ? `Delete on ${target.computerName ?? 'its computer'}` : undefined}
            onClick={onRemove}
          >
            <DeleteRegular />
            <span>Delete…</span>
          </button>
        )}
      </div>
    </FloatingPortal>
  )
}
