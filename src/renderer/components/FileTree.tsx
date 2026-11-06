import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
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
import { addReferenceToChat, filesEntryReference } from '../utils/fileReference'
import { DelayedLoader } from './ui/DelayedLoader'

interface FileTreeProps {
  filesRoot: string
  rootLabel: string
  threadId: string | null
  selectedPath: string | null
  onSelectFile: (path: string) => void
  refreshKey: number
}

type EntryAction = 'add-to-chat' | 'copy-path'

interface TreeNodeProps {
  entry: FileEntry
  depth: number
  selectedPath: string | null
  onSelectFile: (path: string) => void
  expandedPaths: Set<string>
  toggleExpand: (path: string) => void
  loadChildren: (path: string) => Promise<FileEntry[]>
  onAction: (entry: FileEntry, action: EntryAction) => void
  onDragEntry: (entry: FileEntry, dataTransfer: DataTransfer) => void
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

function TreeNode({
  entry,
  depth,
  selectedPath,
  onSelectFile,
  expandedPaths,
  toggleExpand,
  loadChildren,
  onAction,
  onDragEntry
}: TreeNodeProps) {
  const [children, setChildren] = useState<FileEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const rowRef = useRef<HTMLButtonElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const isDir = entry.kind === 'directory'
  const expanded = isDir && expandedPaths.has(entry.path)

  const load = useCallback(() => {
    setLoading(true)
    setLoadError(null)
    void loadChildren(entry.path)
      .then(setChildren, (error: unknown) => setLoadError(errorText(error)))
      .finally(() => setLoading(false))
  }, [entry.path, loadChildren])

  useEffect(() => {
    if (!expanded || children !== null || loading || loadError !== null) return
    load()
  }, [expanded, children, loading, loadError, load])

  const handleClick = () => {
    if (isDir) {
      toggleExpand(entry.path)
    } else {
      onSelectFile(entry.path)
    }
  }

  const closeMenu = useCallback(() => {
    setMenuOpen(false)
    rowRef.current?.focus()
  }, [])

  return (
    <div className="file-tree-node">
      <div className={`file-tree-item${selectedPath === entry.path ? ' selected' : ''}${menuOpen ? ' menu-open' : ''}`}>
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
      {expanded && (
        <div className="file-tree-children">
          {loading && <DelayedLoader size="small" label={`Loading ${entry.name}`} className="file-tree-loader" />}
          {loadError !== null && !loading && (
            <div className="file-tree-error" role="alert" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
              <span title={loadError}>Couldn’t read this folder</span>
              <button type="button" className="file-tree-retry" onClick={load}>Retry</button>
            </div>
          )}
          {children?.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
              expandedPaths={expandedPaths}
              toggleExpand={toggleExpand}
              loadChildren={loadChildren}
              onAction={onAction}
              onDragEntry={onDragEntry}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function FileTree({
  filesRoot,
  rootLabel,
  threadId,
  selectedPath,
  onSelectFile,
  refreshKey
}: FileTreeProps) {
  const projectId = useAppStore((s) => s.threads.find((thread) => thread.id === threadId)?.projectId)
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([])
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(['']))
  const [loading, setLoading] = useState(false)
  const [rootError, setRootError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)

  const loadChildren = useCallback(
    async (dirPath: string) => window.mousse.fs.listDir(dirPath, undefined, threadId),
    [threadId]
  )

  const refreshRoot = useCallback(async () => {
    if (!filesRoot) return
    setLoading(true)
    setRootError(null)
    try {
      const entries = await window.mousse.fs.listDir('', undefined, threadId)
      setRootEntries(entries)
    } catch (error) {
      setRootEntries([])
      setRootError(errorText(error))
    } finally {
      setLoading(false)
    }
  }, [filesRoot, threadId])

  useEffect(() => {
    void refreshRoot()
  }, [refreshRoot, refreshKey])

  useEffect(() => setNotice(null), [threadId])

  const toggleExpand = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

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
    <div className="file-tree">
      <div className="file-tree-root-label" title={filesRoot}>
        {rootLabel}
      </div>
      <div className="sr-only" role="status">{notice && !notice.error ? notice.text : ''}</div>
      {notice?.error && <div className="file-tree-error" role="alert">{notice.text}</div>}
      {loading ? (
        <DelayedLoader size="small" label="Loading files" className="file-tree-loader" />
      ) : rootError !== null ? (
        <div className="file-tree-error" role="alert">
          <span title={rootError}>Couldn’t read this folder</span>
          <button type="button" className="file-tree-retry" onClick={() => void refreshRoot()}>Retry</button>
        </div>
      ) : (
        rootEntries.map((entry) => (
          <TreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
            expandedPaths={expandedPaths}
            toggleExpand={toggleExpand}
            loadChildren={loadChildren}
            onAction={onAction}
            onDragEntry={onDragEntry}
          />
        ))
      )}
    </div>
  )
}

export function FileTreeToolbar({ onRefresh }: { onRefresh: () => void }) {
  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={onRefresh} aria-label="Refresh files" title="Refresh">
      <RefreshCw size={14} strokeWidth={2} />
    </button>
  )
}
