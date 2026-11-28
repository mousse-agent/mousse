import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronRight, Folder, FolderOpen, FolderPlus, HardDrive, House, Monitor, Pencil } from '../lib/icons'
import {
  checkDestination,
  goesThroughHidden,
  isFullPath,
  isWindowsPath,
  leafName,
  newFolderProblem,
  pathCrumbs,
  typedDestination,
  type FolderCheck,
  type PathCrumb
} from '../lib/addToMachine'
import { remoteReason } from '../lib/remoteComputers'
import type { BrowsedFolders } from '../lib/sourceControl'
import { joinFolder } from './newProjectLogic'
import { Spinner } from './ui/Spinner'

/** How long typing pauses before that computer is asked about the path typed. */
const TYPING_PAUSE_MS = 300

/**
 * Where a clone goes on another computer. A path bar shows the folders down to the clone's own folder: click one to go
 * there, or the pencil to type a full path. The folders under it open below it, with New folder first. Folders that
 * are not there yet are made by the clone, so a typed path or a new folder costs nothing until Add.
 */
export function CloneFolderField({ computer, destination, cloneName, disabled = false, browse, onChange, onProblem }: {
  computer: string
  /** The full path of the clone's own folder on that computer; empty until one is picked. */
  destination: string
  /** The clone's folder name when none was typed: the repository's. */
  cloneName: string
  disabled?: boolean
  /** That computer's folders (`folders.browse`): its places without a path, else the folders in one. */
  browse: (path?: string) => Promise<BrowsedFolders>
  onChange: (destination: string) => void
  /** Why the clone cannot go to `destination` (nothing when it can), for the dialog's Add button. */
  onProblem: (problem: string | undefined) => void
}) {
  const [editing, setEditing] = useState<{ text: string; select?: [number, number] } | null>(null)
  const [open, setOpen] = useState(!destination)
  const [showPlaces, setShowPlaces] = useState(!destination)
  const [places, setPlaces] = useState<BrowsedFolders | null>(null)
  const [naming, setNaming] = useState<string | null>(null)
  const [check, setCheck] = useState<{ path: string; result?: FolderCheck; error?: string } | null>(null)
  const cache = useRef(new Map<string, BrowsedFolders>())
  const input = useRef<HTMLInputElement>(null)
  // Set by Escape: the field leaving the page then is not a blur that takes the typed path.
  const dropped = useRef(false)

  const leaf = leafName(destination) || cloneName
  const home = places?.folders.find((place) => place.name === 'Home')?.path
  const typing = editing !== null
  const target = editing ? typedDestination(editing.text, cloneName, home) : destination
  const windows = isWindowsPath(target || home || '')

  // Its places (the home folder and the disks), for the computer crumb and to show the home folder as a house.
  useEffect(() => {
    let live = true
    browse().then((view) => { if (live) setPlaces(view) }, () => undefined)
    return () => { live = false }
  }, [browse])

  // What that computer says of the path: the folder it goes in, or which of its folders the clone makes.
  useEffect(() => {
    if (!target || !isFullPath(target) || goesThroughHidden(target)) return setCheck(null)
    let live = true
    const cached = (path: string) => {
      const known = cache.current.get(path)
      return known ? Promise.resolve(known) : browse(path).then((view) => { cache.current.set(path, view); return view })
    }
    const timer = setTimeout(() => {
      checkDestination(target, cached).then(
        (result) => { if (live) setCheck({ path: target, result }) },
        (failure) => { if (live) setCheck({ path: target, error: remoteReason(failure, computer) }) }
      )
    }, typing ? TYPING_PAUSE_MS : 0)
    return () => { live = false; clearTimeout(timer) }
  }, [target, typing, browse, computer])

  const current = check?.path === target ? check : null
  const problem = !destination || !isFullPath(destination) ? 'Pick a folder there'
    : goesThroughHidden(destination) ? 'Hidden folders can’t be used from another computer'
    : check?.path === destination && check.error ? check.error
    : undefined
  useEffect(() => { onProblem(problem) }, [problem, onProblem])

  const go = (folder: string) => {
    setShowPlaces(false)
    setNaming(null)
    onChange(joinFolder(folder, leaf))
  }
  const startEditing = (select?: 'leaf') => {
    if (disabled) return
    dropped.current = false
    const text = destination
    setEditing({ text, select: select === 'leaf' && text ? [text.length - leaf.length, text.length] : [0, text.length] })
  }
  /** Takes the typed path; one that is not a full path stays to be fixed (Enter), or is dropped (leaving the field). */
  const commit = (leaving: boolean) => {
    if (!editing) return
    const next = typedDestination(editing.text, cloneName, home)
    if (!isFullPath(next)) {
      if (leaving || !next) setEditing(null)
      return
    }
    setEditing(null)
    if (next !== destination) {
      setShowPlaces(false)
      onChange(next)
    }
  }
  useLayoutEffect(() => {
    if (!editing?.select || !input.current) return
    input.current.focus()
    input.current.setSelectionRange(...editing.select)
  }, [editing?.select])

  const onTyping = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); commit(false) }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dropped.current = true; setEditing(null) }
  }

  // The folders down to the one the clone goes in; the ones under the last one that is there are new.
  const parentCrumbs = useMemo(() => (destination && isFullPath(destination) ? pathCrumbs(destination).slice(0, -1) : []), [destination])
  const missing = current && !editing ? current.result?.missing.length ?? 0 : 0
  const shown = shortenHome(parentCrumbs, home, windows)

  const hint = editing && editing.text.trim() && !isFullPath(target)
    ? { warn: true, text: `Type a full path, like ${home ? joinFolder(home, 'code') : windows ? 'C:\\code' : '/Users/you/code'}` }
    : target && goesThroughHidden(target) ? { warn: true, text: 'Hidden folders can’t be used from another computer' }
    : current?.error ? { warn: true, text: current.error }
    : current?.result?.taken ? { warn: true, text: `${leafName(target)} is already there; the clone needs it empty` }
    : current?.result && current.result.missing.length > 0
      ? { warn: false, text: `Also creates ${current.result.missing.join(windows ? '\\' : '/')}` }
      : null

  return (
    <div className="clone-folder">
      <div className={`clone-folder-bar${open ? ' open' : ''}${editing ? ' editing' : ''}`}>
        {editing ? (
          <input
            ref={input}
            className="clone-folder-input"
            aria-label={`Folder on ${computer}`}
            placeholder={`Full path on ${computer}`}
            value={editing.text}
            spellCheck={false}
            autoFocus
            onChange={(event) => setEditing({ text: event.target.value })}
            onKeyDown={onTyping}
            onBlur={() => { if (!dropped.current) commit(true) }}
          />
        ) : (
          <Crumbs onEmptyClick={() => startEditing()}>
            <button
              type="button"
              className={`clone-folder-crumb computer${showPlaces && open ? ' current' : ''}`}
              title={`${computer}: its disks and home folder`}
              disabled={disabled}
              onClick={() => { setShowPlaces(true); setOpen(true) }}
            >
              <Monitor size={14} aria-hidden="true" />
              {computer}
            </button>
            {shown.map((crumb, index) => {
              const isNew = index >= shown.length - missing
              return (
                <Crumb key={crumb.path}>
                  <button
                    type="button"
                    className={`clone-folder-crumb${isNew ? ' new' : ''}`}
                    title={isNew ? `${crumb.path} (new: made when you clone)` : crumb.path}
                    aria-label={crumb.home ? 'Home' : undefined}
                    disabled={disabled}
                    onClick={() => { go(crumb.path); setOpen(true) }}
                  >
                    {crumb.home ? <House size={14} aria-hidden="true" /> : crumb.name}
                  </button>
                </Crumb>
              )
            })}
            {destination && (
              <Crumb>
                <button
                  type="button"
                  className={`clone-folder-crumb leaf${current?.result?.taken ? ' taken' : ''}`}
                  title="The clone’s folder: click to rename"
                  disabled={disabled}
                  onClick={() => startEditing('leaf')}
                >
                  {leaf}
                </button>
              </Crumb>
            )}
            {!destination && <span className="clone-folder-placeholder">Pick a folder</span>}
          </Crumbs>
        )}
        {!editing && (
          <button type="button" className="settings-icon-btn" title="Type a path" aria-label="Type a path" disabled={disabled} onClick={() => startEditing()}>
            <Pencil size={14} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="settings-icon-btn"
          title={open ? 'Hide folders' : `Browse ${computer}`}
          aria-label={open ? 'Hide folders' : `Browse ${computer}`}
          aria-expanded={open}
          disabled={disabled}
          // Keeps the typed path from committing on blur before the list opens on it.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setOpen(!open)}
        >
          <FolderOpen size={14} aria-hidden="true" />
        </button>
      </div>

      {open && !disabled && (
        <FolderList
          computer={computer}
          places={showPlaces ? places : null}
          check={current?.result ?? check?.result ?? null}
          loading={!current && Boolean(target) && isFullPath(target)}
          failed={Boolean(current?.error)}
          naming={naming}
          windows={windows}
          onNaming={setNaming}
          onCreate={(name) => {
            setNaming(null)
            const folder = parentOf(target || destination)
            if (folder) onChange(joinFolder(joinFolder(folder, name), leaf))
          }}
          onOpen={go}
        />
      )}

      {hint && (
        <p className={`clone-folder-hint${hint.warn ? ' warn' : ''}`} role="status">
          {!hint.warn && <FolderPlus size={13} aria-hidden="true" />}
          {hint.text}
        </p>
      )}
    </div>
  )
}

/** The crumbs in one line that scrolls to its end, so the clone's folder stays in view; a click beside them types. */
function Crumbs({ children, onEmptyClick }: { children: ReactNode; onEmptyClick: () => void }) {
  const line = useRef<HTMLDivElement>(null)
  const [cut, setCut] = useState(false)
  useLayoutEffect(() => {
    const element = line.current
    if (!element) return
    element.scrollLeft = element.scrollWidth
    setCut(element.scrollWidth > element.clientWidth + 1)
  })
  return (
    <div
      ref={line}
      className={`clone-folder-crumbs${cut ? ' cut' : ''}`}
      onClick={(event) => { if (event.target === event.currentTarget) onEmptyClick() }}
    >
      {children}
    </div>
  )
}

function Crumb({ children }: { children: ReactNode }) {
  return (
    <>
      <ChevronRight size={12} className="clone-folder-sep" aria-hidden="true" />
      {children}
    </>
  )
}

/** The folders of the one the clone goes in (or that computer's places), New folder first. */
function FolderList({ computer, places, check, loading, failed, naming, windows, onNaming, onCreate, onOpen }: {
  computer: string
  places: BrowsedFolders | null
  check: FolderCheck | null
  loading: boolean
  failed: boolean
  naming: string | null
  windows: boolean
  onNaming: (name: string | null) => void
  onCreate: (name: string) => void
  onOpen: (path: string) => void
}) {
  const problem = naming === null ? undefined : newFolderProblem(naming, windows)
  // Set once Enter or Escape answered: the name field leaving the page then is not a blur that answers again.
  const answered = useRef(false)
  const create = () => {
    if (naming === null || problem) return
    answered.current = true
    if (naming.trim()) onCreate(naming.trim())
    else onNaming(null)
  }
  const folders = places ? places.folders : check && check.missing.length === 0 ? check.view.folders : []
  return (
    <div className="clone-folder-list scrollbar-ultra-thin" role="list" aria-label={places ? `${computer}’s places` : `Folders on ${computer}`} aria-busy={loading}>
      {!places && (naming === null ? (
        <button type="button" role="listitem" className="clone-folder-row create" disabled={failed} onClick={() => { answered.current = false; onNaming('') }}>
          <FolderPlus size={14} aria-hidden="true" />
          New folder
        </button>
      ) : (
        <div role="listitem" className={`clone-folder-row naming${problem ? ' invalid' : ''}`}>
          <FolderPlus size={14} aria-hidden="true" />
          <input
            aria-label="New folder name"
            placeholder="New folder name"
            value={naming}
            spellCheck={false}
            autoFocus
            onChange={(event) => onNaming(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); create() }
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); answered.current = true; onNaming(null) }
            }}
            onBlur={() => {
              if (answered.current) return
              if (!naming.trim() || problem) onNaming(null)
              else create()
            }}
          />
          {problem && <span className="clone-folder-row-note">{problem}</span>}
        </div>
      ))}
      {folders.map((entry) => (
        <button key={entry.path} type="button" role="listitem" className="clone-folder-row" title={entry.path} onClick={() => onOpen(entry.path)}>
          {places ? (entry.name === 'Home' ? <House size={14} aria-hidden="true" /> : <HardDrive size={14} aria-hidden="true" />) : <Folder size={14} aria-hidden="true" />}
          <span className="clone-folder-row-name">{entry.name}</span>
          <ChevronRight size={12} className="clone-folder-row-go" aria-hidden="true" />
        </button>
      ))}
      {loading && folders.length === 0 && <div className="clone-folder-note"><Spinner size={13} /></div>}
      {!loading && !places && check && check.missing.length > 0 && <div className="clone-folder-note">A new folder: nothing in it yet</div>}
      {!loading && !places && check && check.missing.length === 0 && folders.length === 0 && <div className="clone-folder-note">No folders here</div>}
      {check?.view.truncated && !places && <div className="clone-folder-note">Only the first {check.view.folders.length} are listed</div>}
    </div>
  )
}

/** The folder a path is in, or nothing for a disk or the root. */
function parentOf(path: string): string | null {
  const crumbs = isFullPath(path) ? pathCrumbs(path) : []
  return crumbs.length >= 2 ? crumbs[crumbs.length - 2]!.path : null
}

/**
 * The crumbs as the bar shows them: the root left out (the computer crumb stands for the top), and the home folder
 * and everything above it as one house.
 */
function shortenHome(crumbs: readonly PathCrumb[], home: string | undefined, windows: boolean): (PathCrumb & { home?: boolean })[] {
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b)
  const homeAt = home ? crumbs.findIndex((crumb) => same(crumb.path, home.replace(/[\\/]+$/, '') || home)) : -1
  if (homeAt >= 0) return [{ ...crumbs[homeAt]!, home: true }, ...crumbs.slice(homeAt + 1)]
  return windows ? [...crumbs] : crumbs.slice(1)
}
