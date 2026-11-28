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
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  FolderSearch,
  GitBranch,
  GitPullRequest,
  Image,
  MessageSquarePlus,
  PinOffRegular,
  PinRegular,
  RotateCcw,
  ShieldCheck,
  Clock,
  Bell,
  BellOff,
  Info,
  Lock,
  Mail,
  MailOpen,
  Pause,
  Play
} from '../lib/icons'
import { EXPIRY_PRESETS } from '../../shared/threadExpiry'
import { FloatingPortal, FLOATING_LAYER_Z_INDEX } from '../lib/floatingLayer'

export interface ThreadsContextMenuTarget {
  type: 'thread' | 'project'
  id: string
  name: string
  pinned: boolean
  archived?: boolean
  /** The computer a project or thread is on, when it is not this one. */
  node?: string
  /** That computer's name: the menu acts on the project there, and says so. An archived thread there is deleted there. */
  computerName?: string
  /** On a project of this computer: the other computers that hold the same repository. Removing leaves their projects. */
  alsoOn?: readonly string[]
  /** A project's folder, on the computer that holds it. */
  path?: string
  /** Threads only: when it archives itself (`Thread.expiresAt`). */
  expiresAt?: string
  /** Threads only: its expiry can be set here (a thread of this computer that is not a subagent). */
  canExpire?: boolean
  /** Threads only: at expiry a running turn is stopped (`Thread.expiryStopsRun`); kept when the time changes. */
  expiryStopsRun?: boolean
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
  /** Projects of this computer only: point the project at another folder. */
  onChangeFolder?: () => void
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
  /** Threads only: copy the thread's reference (its link), which a chat it is pasted into turns into a thread pill. */
  onCopyReference?: () => void
  /** Threads only: delete the thread `ms` from now, or null to keep it. */
  onSetExpiry?: (ms: number | null) => void
  /** Archived threads only: delete every archived thread of this computer, after a confirmation. */
  onDeleteAllArchived?: () => void
  /** Projects of this computer only: choose an image file as the project's icon. */
  onChangeIcon?: () => void
  /** Set when the project has a chosen icon or icons off: go back to the icon found in its folder. */
  onResetIcon?: () => void
  /** Set when the project shows an image icon: show the folder glyph instead. */
  onUseFolderIcon?: () => void
  /** Projects with bot threads in the sidebar: hide them all (`Thread.hidden`). */
  onHideBotThreads?: () => void
  /** Threads a bot started: hide this one from the sidebar (`Thread.hidden`). */
  onHideThread?: () => void
}

const Separator = () => <div className="threads-context-menu-separator" role="separator" />

/**
 * "Git ›", "Archive after ›" (threads not archived): rarely needed actions, one level down. Opens on hover, click, Enter, Space or the right
 * arrow (focusing its first item); the left arrow or Escape closes it and returns to its item.
 */
function Submenu({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
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
        {icon}
        <span>{label}</span>
        <ChevronRight className="threads-context-submenu-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={submenuRef}
          className={`threads-context-menu threads-context-submenu${flip ? ' flip' : ''}`}
          role="menu"
          aria-label={label}
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
  onChangeFolder,
  onTrustGitSettings,
  onNewThread,
  onNewThreadFromPullRequest,
  openInEditor,
  reveal,
  onCopyPath,
  onCopyReference,
  onSetExpiry,
  onDeleteAllArchived,
  onChangeIcon,
  onResetIcon,
  onUseFolderIcon,
  onHideBotThreads,
  onHideThread
}: ThreadsContextMenuProps) {
  return (
    <MenuFrame x={x} y={y} label={target.type === 'project' ? `Project ${target.name}` : `Thread ${target.name}`} onClose={onClose}>
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
      {!target.archived && (
        <button type="button" className="threads-context-menu-item" role="menuitem" onClick={onPin}>
          {target.pinned ? <PinOffRegular /> : <PinRegular />}
          <span>{target.pinned ? 'Unpin' : 'Pin'}</span>
        </button>
      )}
      {target.type === 'thread' && (
        <button type="button" className="threads-context-menu-item" role="menuitem" onClick={onArchive}>
          {target.archived ? <ArchiveArrowBackRegular /> : <ArchiveRegular />}
          <span>{target.archived ? 'Unarchive' : 'Archive'}</span>
        </button>
      )}
      {target.type === 'thread' && onHideThread && (
        <button type="button" className="threads-context-menu-item" role="menuitem" title={BOT_THREADS_HIDE_HINT} onClick={onHideThread}>
          <EyeOff />
          <span>Hide</span>
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
      {target.type === 'project' && onChangeFolder && (
        <button type="button" className="threads-context-menu-item" role="menuitem" title={target.path} onClick={onChangeFolder}>
          <FolderOpen />
          <span>Change folder…</span>
        </button>
      )}
      {target.type === 'thread' && onCopyReference && (
        <button type="button" className="threads-context-menu-item" role="menuitem" title="Paste it into a chat to point its agent at this thread" onClick={onCopyReference}>
          <Copy />
          <span>Copy reference</span>
        </button>
      )}
      {target.type === 'project' && onChangeIcon && (
        <button type="button" className="threads-context-menu-item" role="menuitem" onClick={onChangeIcon}>
          <Image />
          <span>Change icon…</span>
        </button>
      )}
      {target.type === 'project' && onResetIcon && (
        <button type="button" className="threads-context-menu-item" role="menuitem" title="Use the icon found in the project folder" onClick={onResetIcon}>
          <RotateCcw />
          <span>Reset icon</span>
        </button>
      )}
      {target.type === 'project' && onUseFolderIcon && (
        <button type="button" className="threads-context-menu-item" role="menuitem" onClick={onUseFolderIcon}>
          <Folder />
          <span>Use folder icon</span>
        </button>
      )}
      {target.type === 'project' && onHideBotThreads && (
        <button type="button" className="threads-context-menu-item" role="menuitem" title={BOT_THREADS_HIDE_HINT} onClick={onHideBotThreads}>
          <EyeOff />
          <span>Hide bot threads</span>
        </button>
      )}
      {target.type === 'thread' && !target.archived && target.canExpire && onSetExpiry && (
        <Submenu icon={<Clock />} label="Archive after">
          {EXPIRY_PRESETS.map((preset) => (
            <button key={preset.id} type="button" className="threads-context-menu-item" role="menuitem" onClick={() => onSetExpiry(preset.ms)}>
              <span>After {preset.label}</span>
            </button>
          ))}
          {target.expiresAt && (
            <button type="button" className="threads-context-menu-item" role="menuitem" onClick={() => onSetExpiry(null)}>
              <span>Never</span>
            </button>
          )}
        </Submenu>
      )}
      {target.type === 'project' && onTrustGitSettings && !target.node && (
        <Submenu icon={<GitBranch />} label="Git">
          <button
            type="button"
            className="threads-context-menu-item"
            role="menuitem"
            title="Mousse runs this repository's own Git filters (git-crypt, a local Git LFS) only as they were when you added it. Use this after you changed one yourself."
            data-mousse-decision=""
            onClick={onTrustGitSettings}
          >
            <ShieldCheck />
            <span>Trust this repository's Git settings</span>
          </button>
        </Submenu>
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
      {target.type === 'thread' && target.archived && (
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
      {target.type === 'thread' && target.archived && onDeleteAllArchived && (
        <button type="button" className="threads-context-menu-item threads-context-menu-item-danger" role="menuitem" onClick={onDeleteAllArchived}>
          <DeleteRegular />
          <span>Delete all archived…</span>
        </button>
      )}
    </MenuFrame>
  )
}

/** Hiding is undone from the bot's chat, where each one stays listed with Show in sidebar. */
const BOT_THREADS_HIDE_HINT = 'Your bots’ chats still list them'

/** The Threads tab's menu: hide every bot thread listed in the sidebar. */
export function ThreadsTabMenu({ x, y, onClose, onHideAllBotThreads }: { x: number; y: number; onClose: () => void; onHideAllBotThreads: () => void }) {
  return (
    <MenuFrame x={x} y={y} label="Threads" onClose={onClose}>
      <button type="button" className="threads-context-menu-item" role="menuitem" title={BOT_THREADS_HIDE_HINT} onClick={onHideAllBotThreads}>
        <EyeOff />
        <span>Hide all bot threads</span>
      </button>
    </MenuFrame>
  )
}

/** What a bot's row menu does: its marks on this computer, its checklist, and (this computer's bots) its setup. */
export type BotRowAction = 'pin' | 'read' | 'unread' | 'mute' | 'hide' | 'checklist' | 'about' | 'rename' | 'look' | 'pause' | 'private' | 'delete'

export interface BotRowMenuTarget {
  name: string
  pinned: boolean
  /** It has unread messages or is marked unread: the menu offers Mark as read. */
  unread: boolean
  /** Mark as read needs the bot's computer: its unread messages are counted there. */
  readNeedsComputer: boolean
  muted: boolean
  hidden: boolean
  checklistHidden: boolean
  /** The bot's computer, when it is another one and offline now: what needs it is greyed out and says so. */
  offlineComputer?: string
  /**
   * What is set up on the bot itself. `off`: why it can't be from here (a bot of another computer that is offline, or
   * where this computer has only Use bot access); the items show greyed with it as their tooltip.
   */
  setup?: { paused: boolean; canWall: boolean; off?: string; wallTitle?: string }
}

/**
 * A bot's menu in the Bots list (right-click or the menu key): Pin, Mark as read or unread, Mute and Hide, kept on this
 * computer and working while the bot's computer is offline (except Mark as read of messages counted there); its
 * checklist; and for this computer's bots, About, Rename, Change look, Pause or Resume, Make private and Delete.
 */
export function BotRowMenu({ x, y, target, onClose, onAction }: { x: number; y: number; target: BotRowMenuTarget; onClose: () => void; onAction: (action: BotRowAction) => void }) {
  const item = (action: BotRowAction, icon: ReactNode, label: string, options: { title?: string; off?: string; danger?: boolean } = {}) => (
    <button
      type="button"
      className={`threads-context-menu-item${options.danger ? ' threads-context-menu-item-danger' : ''}`}
      role="menuitem"
      aria-disabled={options.off ? true : undefined}
      title={options.off ?? options.title}
      onClick={() => { if (!options.off) onAction(action) }}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
  const away = target.offlineComputer ? `${target.offlineComputer} is offline` : undefined
  const setup = target.setup
  return (
    <MenuFrame x={x} y={y} label={`${target.name} menu`} onClose={onClose}>
      {item('pin', target.pinned ? <PinOffRegular /> : <PinRegular />, target.pinned ? 'Unpin' : 'Pin')}
      {target.unread
        ? item('read', <MailOpen />, 'Mark as read', { off: target.readNeedsComputer ? away : undefined })
        : item('unread', <Mail />, 'Mark as unread')}
      {item('mute', target.muted ? <Bell /> : <BellOff />, target.muted ? 'Unmute notifications' : 'Mute notifications')}
      {item('hide', target.hidden ? <Eye /> : <EyeOff />, target.hidden ? 'Unhide' : 'Hide', { title: target.hidden ? undefined : 'Filter → Show hidden brings it back' })}
      {item('checklist', target.checklistHidden ? <Eye /> : <EyeOff />, target.checklistHidden ? 'Show checklist' : 'Hide checklist')}
      {setup && (
        <>
          <Separator />
          {item('about', <Info />, 'About this bot', { off: setup.off })}
          {item('rename', <EditRegular />, 'Rename', { off: setup.off })}
          {item('look', <Image />, 'Change look', { off: setup.off })}
          {item('pause', setup.paused ? <Play /> : <Pause />, setup.paused ? 'Resume' : 'Pause', { off: setup.off })}
          {setup.canWall && item('private', <Lock />, 'Make private', { title: setup.wallTitle ?? 'Only this computer reaches it. Change it in About.', off: setup.off })}
          <Separator />
          {item('delete', <DeleteRegular />, 'Delete bot', { danger: true, off: setup.off })}
        </>
      )}
    </MenuFrame>
  )
}

/** A sidebar menu at a point: focus starts on its first item; a click or right-click outside, or Escape, closes it. */
function MenuFrame({ x, y, label, onClose, children }: { x: number; y: number; label: string; onClose: () => void; children: ReactNode }) {
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
        aria-label={label}
        onKeyDown={onMenuKeyDown}
      >
        {children}
      </div>
    </FloatingPortal>
  )
}
