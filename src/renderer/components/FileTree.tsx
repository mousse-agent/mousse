import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from 'react'
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  MoreHorizontal,
  RefreshCw
} from '../lib/icons'
import type { FileEntry } from '../../shared/types'
import { setReferenceDragData } from '../../shared/chatReferences'
import { useAppStore } from '../stores/appStore'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import { useFixedRowWindow } from '../lib/virtualRows'
import { addReferenceToChat, filesEntryReference } from '../utils/fileReference'
import { DelayedLoader } from './ui/DelayedLoader'
import { FileTreeMemory, type FileTreeRow } from './fileTreeState'

/** Every tree row has this height (px), so the tree draws only the rows on screen. */
export const FILE_TREE_ROW_HEIGHT = 26

interface FileTreeProps {
  /** The folder the tree shows; entries are named relative to it. */
  filesRoot: string
  /** Sent with every listing when the tree shows a folder other than the thread's own (absolute). */
  listRoot?: string
  threadId: string | null
  selectedPath: string | null
  onSelectFile: (path: string) => void
  refreshKey: number
  /** Keeps the tree's folders, open folders and scroll offset after it unmounts. The tree has its own when absent. */
  memory?: FileTreeMemory
}

type EntryAction = 'add-to-chat' | 'copy-path'

interface EntryRowProps {
  row: Extract<FileTreeRow, { kind: 'entry' }>
  selectedPath: string | null
  onSelectFile: (path: string) => void
  onToggle: (path: string) => void
  onAction: (entry: FileEntry, action: EntryAction) => void
  onDragEntry: (entry: FileEntry, dataTransfer: DataTransfer) => void
}

/** Shift+F10 and the context-menu key open a row's menu, as right-click does. */
export function isMenuKey(event: Pick<KeyboardEvent, 'key' | 'shiftKey'>): boolean {
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)
}

/** A row's "…" menu: the app's one dropdown look, arrow keys between items, Escape back to the row. */
function EntryMenu({ label, anchorRef, onPick, onClose }: {
  label: string
  anchorRef: RefObject<HTMLElement | null>
  onPick: (action: EntryAction) => void
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const style = useFloatingPosition({ open: true, anchorRef, contentRef: panelRef, placement: 'below-end', gap: 4 })
  const placed = style.visibility !== 'hidden'

  // The layer starts hidden until it is placed, and a hidden item cannot take focus: wait for it.
  const focused = useRef(false)
  useEffect(() => {
    if (!placed || focused.current) return
    focused.current = true
    panelRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [placed])

  useEffect(() => {
    const pointer = (event: MouseEvent) => {
      const target = event.target as Node
      if (!anchorRef.current?.contains(target) && !panelRef.current?.contains(target)) onClose()
    }
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation() }
        onClose()
        return
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const buttons = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
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
  }, [anchorRef, onClose])

  return <FloatingPortal>
    <div ref={panelRef} className="row-menu file-tree-menu" role="menu" aria-label={label} style={style}>
      <button type="button" role="menuitem" className="row-menu-item" onClick={() => onPick('add-to-chat')}>Add to chat</button>
      <button type="button" role="menuitem" className="row-menu-item" onClick={() => onPick('copy-path')}>Copy path</button>
    </div>
  </FloatingPortal>
}

/** One file or folder row of the flattened tree. */
function EntryRow({ row, selectedPath, onSelectFile, onToggle, onAction, onDragEntry }: EntryRowProps) {
  const { entry, depth, expanded } = row
  const [menuOpen, setMenuOpen] = useState(false)
  const rowRef = useRef<HTMLButtonElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const isDir = entry.kind === 'directory'

  const handleClick = () => {
    if (isDir) onToggle(entry.path)
    else onSelectFile(entry.path)
  }

  const closeMenu = useCallback(() => {
    setMenuOpen(false)
    rowRef.current?.focus()
  }, [])

  return (
    <div className={`file-tree-item${selectedPath === entry.path ? ' selected' : ''}${menuOpen ? ' menu-open' : ''}`}
      style={{ height: FILE_TREE_ROW_HEIGHT }}>
      <button
        ref={rowRef}
        type="button"
        className="file-tree-row"
        data-path={entry.path}
        style={{ paddingLeft: 8 + depth * 14 }}
        aria-expanded={isDir ? expanded : undefined}
        aria-keyshortcuts="Shift+F10"
        onClick={handleClick}
        onContextMenu={(event) => { event.preventDefault(); setMenuOpen(true) }}
        onKeyDown={(event) => {
          if (!isMenuKey(event)) return
          event.preventDefault()
          setMenuOpen(true)
        }}
        draggable
        onDragStart={(event) => onDragEntry(entry, event.dataTransfer)}
      >
        {isDir ? (
          expanded ? (
            <ChevronDown size={14} className="file-tree-chevron" />
          ) : (
            <ChevronRight size={14} className="file-tree-chevron" />
          )
        ) : (
          <span className="file-tree-chevron-spacer" />
        )}
        {isDir ? (
          expanded ? (
            <FolderOpen size={14} className="file-tree-icon" />
          ) : (
            <Folder size={14} className="file-tree-icon" />
          )
        ) : (
          <File size={14} className="file-tree-icon" />
        )}
        <span className="file-tree-name">{entry.name}</span>
      </button>
      <button
        ref={moreRef}
        type="button"
        className="file-tree-more"
        tabIndex={-1}
        aria-label={`Actions for ${entry.name}`}
        title="More actions (Shift+F10)"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
      >
        <MoreHorizontal size={14} aria-hidden="true" />
      </button>
      {menuOpen && <EntryMenu
        label={`Actions for ${entry.name}`}
        anchorRef={moreRef}
        onClose={closeMenu}
        onPick={(action) => { closeMenu(); onAction(entry, action) }}
      />}
    </div>
  )
}

export function FileTree({
  filesRoot,
  listRoot,
  threadId,
  selectedPath,
  onSelectFile,
  refreshKey,
  memory: givenMemory
}: FileTreeProps) {
  const projectId = useAppStore((s) => s.threads.find((thread) => thread.id === threadId)?.projectId)
  const [ownMemory] = useState(() => (givenMemory ? null : new FileTreeMemory()))
  const memory = givenMemory ?? ownMemory!
  useSyncExternalStore(memory.subscribe, memory.getVersion)
  const rows = memory.rows()
  const root = memory.root()
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const list = useCallback(
    async (dirPath: string) => window.mousse.fs.listDir(dirPath, undefined, threadId, listRoot),
    [listRoot, threadId]
  )

  // A tree that comes back shows what it had at once and reads its folders again behind it.
  useEffect(() => {
    if (!filesRoot) return
    void (memory.root()?.entries ? memory.refresh(list) : memory.load('', list))
  }, [filesRoot, list, memory, refreshKey])

  useEffect(() => setNotice(null), [threadId])

  // Back to where it was scrolled. Declared before the row window, so that measures the restored offset.
  const scrollRestored = useRef(false)
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (scrollRestored.current || !scroller || rows.length === 0) return
    scrollRestored.current = true
    scroller.scrollTop = memory.scrollTop
  }, [memory, rows.length])
  const { start, end, sync } = useFixedRowWindow(scrollRef, listRef, rows.length, FILE_TREE_ROW_HEIGHT)

  // A row asked for focus (the preview of its file closed) may be outside the drawn rows: scroll it into them,
  // then focus it once it is drawn.
  useLayoutEffect(() => {
    const path = memory.focusRequest
    const scroller = scrollRef.current
    if (path === null || !scroller) return
    const drawn = [...scroller.querySelectorAll<HTMLElement>('.file-tree-row')].find((row) => row.dataset.path === path)
    if (drawn) {
      memory.focusRequest = null
      drawn.focus()
      return
    }
    const index = memory.indexOf(path)
    // Gone from the tree, or in the drawn rows yet not found: give up rather than retry on every render.
    if (index < 0 || (index >= start && index < end)) {
      memory.focusRequest = null
      return
    }
    const top = (listRef.current?.offsetTop ?? 0) + index * FILE_TREE_ROW_HEIGHT
    scroller.scrollTop = Math.max(0, top - Math.max(0, scroller.clientHeight - FILE_TREE_ROW_HEIGHT) / 2)
    sync()
  })

  const toggleExpand = useCallback((path: string) => memory.toggle(path, list), [list, memory])

  const referenceOf = useCallback((entry: FileEntry) => filesEntryReference({
    path: entry.path, name: entry.name, kind: entry.kind === 'directory' ? 'folder' : 'file', filesRoot, threadId, projectId
  }), [filesRoot, projectId, threadId])

  const onDragEntry = useCallback((entry: FileEntry, dataTransfer: DataTransfer) => {
    setReferenceDragData(dataTransfer, referenceOf(entry))
  }, [referenceOf])

  const onAction = useCallback((entry: FileEntry, action: EntryAction) => {
    const reference = referenceOf(entry)
    if (action === 'add-to-chat') {
      setNotice(addReferenceToChat(reference)
        ? { error: false, text: `Added ${entry.name} to chat` }
        : { error: true, text: `Couldn’t add ${entry.name} to chat` })
      return
    }
    void navigator.clipboard.writeText(reference.path ?? entry.path).then(
      () => setNotice({ error: false, text: 'Path copied' }),
      () => setNotice({ error: true, text: 'Couldn’t copy the path' })
    )
  }, [referenceOf])

  if (!filesRoot) {
    return <DelayedLoader size="small" label="Loading files" className="file-tree-loader" />
  }

  return (
    <div className="file-tree" ref={scrollRef} onScroll={(event) => { memory.scrollTop = event.currentTarget.scrollTop }}>
      <div className="sr-only" role="status">{notice && !notice.error ? notice.text : ''}</div>
      {notice?.error && <div className="file-tree-error" role="alert">{notice.text}</div>}
      {!root || root.loading ? (
        <DelayedLoader size="small" label="Loading files" className="file-tree-loader" />
      ) : root.error !== null ? (
        <div className="file-tree-error" role="alert">
          <span title={root.error}>Couldn’t read this folder</span>
          <button type="button" className="file-tree-retry" onClick={() => void memory.load('', list)}>Retry</button>
        </div>
      ) : rows.length === 0 ? (
        <div className="file-tree-note">Empty folder</div>
      ) : (
        // Only the rows on screen are drawn; the list keeps its full height so the scrollbar stays true.
        <div ref={listRef} className="file-tree-list"
          style={{ height: rows.length * FILE_TREE_ROW_HEIGHT, paddingTop: start * FILE_TREE_ROW_HEIGHT }}>
          {rows.slice(start, end).map((row) => row.kind === 'entry' ? (
            <EntryRow
              key={row.key}
              row={row}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
              onToggle={toggleExpand}
              onAction={onAction}
              onDragEntry={onDragEntry}
            />
          ) : row.kind === 'loading' ? (
            <div key={row.key} className="file-tree-pending" style={{ height: FILE_TREE_ROW_HEIGHT }}>
              <DelayedLoader size="small" label={`Loading ${row.name}`} className="file-tree-loader" />
            </div>
          ) : (
            <div key={row.key} className="file-tree-error file-tree-folder-error" role="alert"
              style={{ height: FILE_TREE_ROW_HEIGHT, paddingLeft: 8 + row.depth * 14 }}>
              <span title={row.message}>Couldn’t read this folder</span>
              <button type="button" className="file-tree-retry" onClick={() => void memory.load(row.path, list)}>Retry</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function FileTreeToolbar({ onRefresh }: { onRefresh: () => void }) {
  return (
    <button type="button" className="files-icon-btn" onClick={onRefresh} aria-label="Refresh files" title="Refresh">
      <RefreshCw size={14} strokeWidth={2} />
    </button>
  )
}
