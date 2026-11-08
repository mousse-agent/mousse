import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { ArrowUp, Check, ChevronDown, Folder, HardDrive, House } from '../lib/icons'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import { folderErrorText, parentFolder, pathSegments, samePath } from '../utils/filesBrowse'

/** A folder the root menu offers: a quick entry (thread, project, home) or a drive. */
export interface FilesPlaceItem {
  kind: 'thread' | 'project' | 'home' | 'drive'
  label: string
  path: string
  /** A drive's volume name, shown muted after its letter when the computer gives one. */
  detail?: string
}

interface FilesPathBarProps {
  path: string
  /** False for a thread of another computer: its folder is shown, not changed. */
  canBrowse: boolean
  /** The quick entries; drives come from `loadDrives` when the menu opens. */
  quickPlaces: FilesPlaceItem[]
  loadDrives: () => Promise<FilesPlaceItem[]>
  /** Goes to the folder; resolves with an error to show, or null once it is shown. */
  onNavigate: (path: string) => Promise<string | null>
  /** Goes to a typed path; resolves with an error to show, or null once it is shown. */
  onNavigateTyped: (text: string) => Promise<string | null>
  /** Changes when Ctrl+L asks for the path as text. */
  editRequest: number
}

const PLACE_ICON = { thread: Folder, project: Folder, home: House, drive: HardDrive } as const

/** The root menu: quick entries, then the drives. Arrow keys move, Escape returns to its button. */
function PlacesMenu({ anchorRef, current, quickPlaces, loadDrives, onPick, onClose }: {
  anchorRef: RefObject<HTMLElement | null>
  current: string
  quickPlaces: FilesPlaceItem[]
  loadDrives: () => Promise<FilesPlaceItem[]>
  onPick: (path: string) => void
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const style = useFloatingPosition({ open: true, anchorRef, contentRef: panelRef, placement: 'below-start', gap: 4 })
  const placed = style.visibility !== 'hidden'
  const [drives, setDrives] = useState<FilesPlaceItem[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadDrives().then((items) => { if (!cancelled) setDrives(items) }, () => { if (!cancelled) setDrives([]) })
    return () => { cancelled = true }
  }, [loadDrives])

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
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
      const buttons = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      if (!buttons.length) return
      event.preventDefault()
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? buttons.length - 1
        : event.key === 'ArrowDown' ? (index + 1) % buttons.length
        : (index - 1 + buttons.length) % buttons.length
      buttons[next]?.focus()
    }
    document.addEventListener('mousedown', pointer)
    window.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('mousedown', pointer)
      window.removeEventListener('keydown', key, true)
    }
  }, [anchorRef, onClose])

  const item = (place: FilesPlaceItem) => {
    const Icon = PLACE_ICON[place.kind]
    const here = samePath(place.path, current)
    return <button key={`${place.kind}:${place.path}`} type="button" role="menuitem"
      className={`files-places-item${here ? ' current' : ''}`} title={place.path}
      aria-current={here ? 'location' : undefined} onClick={() => onPick(place.path)}>
      <Icon size={16} aria-hidden="true" />
      <span className="files-places-label">{place.label}</span>
      {place.detail && <span className="files-places-detail">{place.detail}</span>}
      {here && <Check size={14} className="files-places-check" aria-hidden="true" />}
    </button>
  }

  return <FloatingPortal>
    <div ref={panelRef} className="files-places-menu scrollbar-ultra-thin" role="menu" aria-label="Go to" style={style}>
      {quickPlaces.map(item)}
      {quickPlaces.length > 0 && <div className="files-places-separator" role="separator" />}
      {drives === null
        ? <div className="files-places-note">Loading drives…</div>
        : drives.length === 0 ? <div className="files-places-note">No drives found</div>
        : drives.map(item)}
    </div>
  </FloatingPortal>
}

/**
 * The folder the Files tree shows, as a path to click through: the first segment opens the drives and quick
 * entries, any other goes to that folder, Up goes to the parent, and the empty part (or Ctrl+L) edits it as text.
 */
export function FilesPathBar({ path, canBrowse, quickPlaces, loadDrives, onNavigate, onNavigateTyped, editRequest }: FilesPathBarProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<{ text: string; detail?: string } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLButtonElement>(null)
  const crumbsRef = useRef<HTMLDivElement>(null)
  const segments = pathSegments(path)
  const parent = parentFolder(path)

  const startEditing = useCallback(() => {
    if (!canBrowse) return
    setDraft(path)
    setError(null)
    setEditing(true)
  }, [canBrowse, path])

  const lastRequest = useRef(editRequest)
  useEffect(() => {
    if (editRequest === lastRequest.current) return
    lastRequest.current = editRequest
    startEditing()
  }, [editRequest, startEditing])

  useLayoutEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  // The deepest folder stays in view when the path is longer than the bar.
  useLayoutEffect(() => {
    const crumbs = crumbsRef.current
    if (!crumbs) return
    const toEnd = () => { crumbs.scrollLeft = crumbs.scrollWidth }
    toEnd()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(toEnd)
    observer.observe(crumbs)
    return () => observer.disconnect()
  }, [path, editing])

  useEffect(() => { setError(null) }, [path])

  const go = async (run: () => Promise<string | null>) => {
    setBusy(true)
    try {
      const failed = await run()
      if (failed) setError(folderErrorText(failed))
      else { setError(null); setEditing(false) }
      return !failed
    } finally {
      setBusy(false)
    }
  }

  const closeMenu = useCallback(() => {
    setMenuOpen(false)
    rootRef.current?.focus()
  }, [])

  const onEditKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setEditing(false)
      setError(null)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      void go(() => onNavigateTyped(draft))
    }
  }

  return (
    <div className="files-path">
      <div className="files-path-bar">
        <button type="button" className="files-icon-btn files-path-up" disabled={!canBrowse || !parent || busy}
          aria-label="Up one folder" title="Up"
          onClick={() => parent && void go(() => onNavigate(parent))}><ArrowUp size={14} strokeWidth={2} /></button>
        {editing ? (
          <input ref={inputRef} className={`files-path-input${error ? ' invalid' : ''}`} value={draft} spellCheck={false}
            aria-label="Folder path" aria-invalid={Boolean(error)} title="Enter to go, Esc to cancel"
            onChange={(event) => { setDraft(event.target.value); setError(null) }}
            onKeyDown={onEditKey}
            onBlur={() => { if (!busy && !error) setEditing(false) }} />
        ) : (
          <div ref={crumbsRef} className="files-path-crumbs" title={canBrowse ? `${path}\nClick empty space or press Ctrl+L to type a path` : path}
            onClick={(event) => { if (event.target === event.currentTarget) startEditing() }}>
            {segments.length === 0 && <span className="files-path-crumb static">{path || '…'}</span>}
            {segments.map((segment, index) => {
              const last = index === segments.length - 1
              const first = index === 0
              return <span key={segment.path} className="files-path-step">
                {!first && <span className="files-path-sep" aria-hidden="true">›</span>}
                {first && canBrowse ? (
                  <button ref={rootRef} type="button" className={`files-path-crumb root${menuOpen ? ' open' : ''}`}
                    aria-haspopup="menu" aria-expanded={menuOpen} title="Drives and places"
                    onClick={() => setMenuOpen((open) => !open)}>
                    {segment.label}<ChevronDown size={11} aria-hidden="true" />
                  </button>
                ) : (
                  <button type="button" className={`files-path-crumb${last ? ' current' : ''}`} disabled={!canBrowse}
                    aria-current={last ? 'location' : undefined} title={segment.path}
                    onClick={() => !last && void go(() => onNavigate(segment.path))}>{segment.label}</button>
                )}
              </span>
            })}
          </div>
        )}
      </div>
      {error && <div className="files-path-error" role="alert" title={error.detail}>{error.text}</div>}
      {menuOpen && <PlacesMenu anchorRef={rootRef} current={path} quickPlaces={quickPlaces} loadDrives={loadDrives}
        onClose={closeMenu}
        onPick={(target) => { setMenuOpen(false); void go(() => onNavigate(target)).then(() => rootRef.current?.focus()) }} />}
    </div>
  )
}
