import { useEffect, useId, useRef, useState } from 'react'
import type { EditorInfo } from '../../../shared/types'
import { useActiveProjectLocation } from '../../hooks/useActiveProjectPath'
import { useTransientError } from '../../hooks/useTransientError'
import { FloatingPortal } from '../../lib/floatingLayer'
import { ChevronDown, Code2, Folder } from '../../lib/icons'
import { useAppStore } from '../../stores/appStore'
import { loadEditors, refreshEditors, useEditorsStore } from '../../stores/editorsStore'
import { UNKNOWN_COMPUTER_NAME, useComputer } from '../../lib/computers'
import {
  defaultEditor,
  hasEditorChoices,
  loadLastEditorId,
  noRemoteEditorMessage,
  noRouteMessage,
  openErrorMessage,
  openLabel,
  remoteEditors,
  remoteRefusalMessage,
  saveLastEditorId,
  splitEditors
} from './openInEditor'
import { EditorSshNotice } from './EditorSshNotice'
import { useRemoteRoute } from './useRemoteRoute'
import { SideCardMenuRow } from './SideCardMenuRow'
import { useSideCardMenu } from './useSideCardMenu'

const refreshQuietly = () => { void refreshEditors() }

/**
 * Open the thread's folder in an editor or the file manager. Nothing without a folder. A thread of
 * another computer opens in an editor installed here, over SSH (see `OpenInRemoteEditor`).
 */
export function OpenInEditor() {
  const { projectId, path } = useActiveProjectLocation()
  const profileId = useAppStore((s) => s.profileId)
  const editors = useEditorsStore((s) => s.editors)
  const thread = useAppStore((s) => s.threads.find((entry) => entry.id === s.activeThreadId))
  const node = thread?.node
  const computer = useComputer(node)
  const [lastId, setLastId] = useState<string | null>(() => loadLastEditorId(profileId))
  const local = Boolean(projectId && path) && !node
  const remote = Boolean(projectId && node && thread)

  useEffect(() => { setLastId(loadLastEditorId(profileId)) }, [profileId])
  useEffect(() => {
    if (local || remote) void loadEditors()
  }, [local, remote])

  if (node) return projectId && thread ? <OpenInRemoteEditor threadId={thread.id} computer={computer?.name ?? UNKNOWN_COMPUTER_NAME} profileId={profileId} /> : null
  if (!projectId || !path || !editors) return null
  const open = async (editor: EditorInfo) => {
    await window.mousse.editors.open(editor.id, path)
    saveLastEditorId(profileId, editor.id)
    setLastId(editor.id)
  }
  return <OpenInEditorView path={path} editors={editors} lastId={lastId} onOpen={open} onMenuOpen={refreshQuietly} />
}

/**
 * The editor item of a thread that lives on another computer: the same button, which opens the thread's
 * folder in an editor installed here, over SSH. Without an SSH route to that computer it stays and says
 * what is missing. The file manager is not offered: it would open this computer's own disk.
 */
export function OpenInRemoteEditor({ threadId, computer, profileId }: { threadId: string; computer: string; profileId: string }) {
  const editors = useEditorsStore((s) => s.editors)
  const route = useRemoteRoute(threadId)
  const [lastId, setLastId] = useState<string | null>(() => loadLastEditorId(profileId))
  const [refusal, setRefusal] = useState<string | null>(null)
  const [opens, setOpens] = useState(0)
  useEffect(() => { setLastId(loadLastEditorId(profileId)) }, [profileId])
  useEffect(() => { setRefusal(null) }, [threadId])
  if (!editors) return null
  const usable = remoteEditors(editors)
  const current = defaultEditor(usable, lastId)
  if (!current) {
    return (
      <div className="side-card-open-editor">
        <p className="side-card-open-editor-note">{noRemoteEditorMessage(computer)}</p>
      </div>
    )
  }
  const blocked = route === 'none' ? noRouteMessage(current, computer) : undefined
  const open = async (editor: EditorInfo) => {
    setLastId(editor.id)
    saveLastEditorId(profileId, editor.id)
    if (blocked !== undefined) return
    setRefusal(null)
    try {
      const result = await window.mousse.editors.openRemote(editor.id, threadId)
      if (!result.ok) setRefusal(remoteRefusalMessage(result, editor, computer))
    } finally {
      // An open may have added the Include line; the notice reads it again.
      setOpens((value) => value + 1)
    }
  }
  return (
    <>
      <OpenInEditorView path={computer} editors={usable} lastId={lastId} onOpen={open} onMenuOpen={refreshQuietly} blocked={blocked} refusal={refusal} />
      <EditorSshNotice refreshKey={opens} />
    </>
  )
}

interface OpenInEditorViewProps {
  path: string | null
  editors: readonly EditorInfo[]
  lastId: string | null
  /** Rejects when the folder cannot be opened. */
  onOpen: (editor: EditorInfo) => Promise<void>
  /** Called each time the menu opens. */
  onMenuOpen?: () => void
  /** Why the main button cannot open anything yet. Shown under it; picking an editor from the menu still works. */
  blocked?: string
  /** The last attempt was refused: its words, kept until the next attempt. */
  refusal?: string | null
}

/** The split button, its menu and its inline error, given the data. `OpenInEditor` supplies it. */
export function OpenInEditorView({ path, editors, lastId, onOpen, onMenuOpen, blocked, refusal }: OpenInEditorViewProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [error, setError] = useTransientError()
  const busyRef = useRef(false)
  const noteId = useId()
  const groupRef = useRef<HTMLDivElement>(null)
  const chevronRef = useRef<HTMLButtonElement>(null)
  const current = defaultEditor(editors, lastId)
  const choices = hasEditorChoices(editors)
  const open = menuOpen && choices
  const { menuRef, menuId, menuStyle, closeAndFocus, menuKeyDown, triggerKeyDown } = useSideCardMenu({
    open,
    setOpen: setMenuOpen,
    anchorRef: groupRef,
    focusRef: chevronRef,
    sizeKey: editors.length
  })

  useEffect(() => {
    if (open) onMenuOpen?.()
  }, [open, onMenuOpen])

  if (!path || !current) return null

  const openEditor = async (editor: EditorInfo) => {
    if (busyRef.current) return
    busyRef.current = true
    setError(null)
    try {
      await onOpen(editor)
    } catch (failure) {
      setError(openErrorMessage(failure))
    } finally {
      busyRef.current = false
    }
  }
  const choose = (editor: EditorInfo) => {
    closeAndFocus()
    void openEditor(editor)
  }
  const { editors: apps, files } = splitEditors(editors)

  return (
    <div className="side-card-open-editor">
      <div ref={groupRef} className={`side-card-open-editor-group${choices ? '' : ' single'}`}>
        <button
          type="button"
          className={`side-card-open-editor-main${blocked ? ' blocked' : ''}`}
          aria-disabled={blocked ? true : undefined}
          aria-describedby={blocked ? noteId : undefined}
          title={blocked}
          onClick={() => { if (!blocked) void openEditor(current) }}
        >
          <EditorIcon editor={current} />
          <span className="side-card-open-editor-label">{openLabel(current)}</span>
        </button>
        {choices && (
          <button
            ref={chevronRef}
            type="button"
            className={`side-card-open-editor-chevron${open ? ' open' : ''}`}
            aria-label="Choose where to open"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            onClick={() => setMenuOpen((value) => !value)}
            onKeyDown={triggerKeyDown}
          >
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        )}
      </div>
      {blocked && <p id={noteId} className="side-card-open-editor-note" role="note">{blocked}</p>}
      {refusal && <p className="side-card-open-editor-note refusal" role="alert">{refusal}</p>}
      {error && (
        <p className="side-card-open-editor-error" role="alert" title={error}>{error}</p>
      )}
      {open && (
        <FloatingPortal>
          <div
            ref={menuRef}
            id={menuId}
            className="side-card-device-menu"
            role="menu"
            aria-label="Open in"
            style={menuStyle}
            onKeyDown={menuKeyDown}
          >
            {apps.map((editor) => (
              <EditorRow key={editor.id} editor={editor} active={editor.id === current.id} onSelect={() => choose(editor)} />
            ))}
            {apps.length > 0 && files.length > 0 && <div className="side-card-device-separator" role="separator" />}
            {files.map((editor) => (
              <EditorRow key={editor.id} editor={editor} active={editor.id === current.id} onSelect={() => choose(editor)} />
            ))}
          </div>
        </FloatingPortal>
      )}
    </div>
  )
}

function EditorIcon({ editor }: { editor: EditorInfo }) {
  if (editor.iconDataUrl) {
    return <img className="side-card-open-editor-icon" src={editor.iconDataUrl} alt="" width={14} height={14} draggable={false} />
  }
  const Fallback = editor.kind === 'files' ? Folder : Code2
  return <Fallback size={14} aria-hidden="true" />
}

function EditorRow({ editor, active, onSelect }: { editor: EditorInfo; active: boolean; onSelect: () => void }) {
  return <SideCardMenuRow icon={<EditorIcon editor={editor} />} label={editor.label} active={active} onSelect={onSelect} />
}
