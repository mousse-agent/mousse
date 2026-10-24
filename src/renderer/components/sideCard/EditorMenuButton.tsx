import { useEffect, useRef, useState } from 'react'
import type { EditorInfo } from '../../../shared/types'
import { useActiveProjectLocation } from '../../hooks/useActiveProjectPath'
import { useTransientError } from '../../hooks/useTransientError'
import { FloatingPortal } from '../../lib/floatingLayer'
import { ChevronDown, Code2, Folder } from '../../lib/icons'
import { useAppStore } from '../../stores/appStore'
import { loadEditors, refreshEditors, useEditorsStore } from '../../stores/editorsStore'
import {
  defaultEditor,
  hasEditorChoices,
  loadLastEditorId,
  openErrorMessage,
  openLabel,
  saveLastEditorId,
  splitEditors
} from './openInEditor'
import { SideCardMenuRow } from './SideCardMenuRow'
import { useSideCardMenu } from './useSideCardMenu'

const refreshQuietly = () => { void refreshEditors() }

/** Open the thread's folder in an editor or the file manager. Nothing without a folder. */
export function OpenInEditor() {
  const { projectId, path } = useActiveProjectLocation()
  const profileId = useAppStore((s) => s.profileId)
  const editors = useEditorsStore((s) => s.editors)
  const [lastId, setLastId] = useState<string | null>(() => loadLastEditorId(profileId))
  const enabled = Boolean(projectId && path)

  useEffect(() => { setLastId(loadLastEditorId(profileId)) }, [profileId])
  useEffect(() => {
    if (enabled) void loadEditors()
  }, [enabled])

  if (!projectId || !path || !editors) return null
  const open = async (editor: EditorInfo) => {
    await window.mousse.editors.open(editor.id, path)
    saveLastEditorId(profileId, editor.id)
    setLastId(editor.id)
  }
  return <OpenInEditorView path={path} editors={editors} lastId={lastId} onOpen={open} onMenuOpen={refreshQuietly} />
}

interface OpenInEditorViewProps {
  path: string | null
  editors: readonly EditorInfo[]
  lastId: string | null
  /** Rejects when the folder cannot be opened. */
  onOpen: (editor: EditorInfo) => Promise<void>
  /** Called each time the menu opens. */
  onMenuOpen?: () => void
}

/** The split button, its menu and its inline error, given the data. `OpenInEditor` supplies it. */
export function OpenInEditorView({ path, editors, lastId, onOpen, onMenuOpen }: OpenInEditorViewProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [error, setError] = useTransientError()
  const busyRef = useRef(false)
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
          className="side-card-open-editor-main"
          onClick={() => void openEditor(current)}
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
