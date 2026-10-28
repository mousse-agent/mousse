import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { EditorInfo } from '../../../shared/types'
import type { RemoteAskResult, RemoteOpenResult } from '../../../shared/remoteEditor'
import {
  askOutcomeWords,
  editorConnectionHelp,
  helpForOpenResult,
  openedWords,
  type AskOutcome,
  type EditorHelp,
  type EditorHelpAction
} from '../../lib/editorConnection'
import { useActiveProjectLocation } from '../../hooks/useActiveProjectPath'
import { useTransientError } from '../../hooks/useTransientError'
import { FloatingPortal } from '../../lib/floatingLayer'
import { ChevronDown, Code2, Folder } from '../../lib/icons'
import { useAppStore } from '../../stores/appStore'
import { loadEditors, refreshEditors, useEditorsStore } from '../../stores/editorsStore'
import { UNKNOWN_COMPUTER_NAME, useComputer, useComputers } from '../../lib/computers'
import { openDevice } from '../../lib/settingsNavigation'
import { ApproveSshRouteDialog } from '../devices/ApproveSshRouteDialog'
import type { NodeId } from '../../../shared/net'
import {
  defaultEditor,
  hasEditorChoices,
  loadLastEditorId,
  noRemoteEditorMessage,
  noRouteHelp,
  type NoRouteHelp,
  openErrorMessage,
  openLabel,
  remoteEditors,
  remoteRefusalMessage,
  saveLastEditorId,
  splitEditors
} from './openInEditor'
import { EditorSshNotice } from './EditorSshNotice'
import { EditorStateNote, type EditorStateAction } from './EditorStateNote'
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

  if (node) return projectId && thread ? <OpenInRemoteEditor threadId={thread.id} node={node} computer={computer?.name ?? UNKNOWN_COMPUTER_NAME} profileId={profileId} /> : null
  if (!projectId || !path || !editors) return null
  const open = async (editor: EditorInfo) => {
    await window.mousse.editors.open(editor.id, path)
    saveLastEditorId(profileId, editor.id)
    setLastId(editor.id)
  }
  return <OpenInEditorView path={path} editors={editors} lastId={lastId} onOpen={open} onMenuOpen={refreshQuietly} />
}

/** What the last open or ask came to, until the next one. */
type Outcome =
  | { kind: 'refused'; result: Extract<RemoteOpenResult, { ok: false }> }
  | { kind: 'opened'; hint?: string; via?: ConnectionVia }
  | { kind: 'asked'; result: RemoteAskResult }

type ConnectionVia = NonNullable<Extract<RemoteOpenResult, { ok: true }>['via']>

/**
 * The editor item of a thread that lives on another computer: the same button, which opens the thread's
 * folder in an editor installed here, over SSH. When it cannot open, the item says why in plain words, with
 * the next step and a button for what Mousse can do (ask that computer to allow editor connections, try
 * again, open Devices). The file manager is not offered: it would open this computer's own disk.
 */
export function OpenInRemoteEditor({ threadId, node, computer, profileId }: { threadId: string; node: string; computer: string; profileId: string }) {
  const editors = useEditorsStore((s) => s.editors)
  const { kind: route, reload: reloadRoute } = useRemoteRoute(threadId)
  const { devices } = useComputers(true)
  const device = devices.find((entry) => entry.node === node)
  const selfNode = devices.find((entry) => entry.self)?.node
  const [approving, setApproving] = useState(false)
  const [lastId, setLastId] = useState<string | null>(() => loadLastEditorId(profileId))
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [working, setWorking] = useState<'opening' | 'asking' | null>(null)
  const [opens, setOpens] = useState(0)
  useEffect(() => { setLastId(loadLastEditorId(profileId)) }, [profileId])
  useEffect(() => { setOutcome(null) }, [threadId])
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
  const help = route === 'none' ? noRouteHelp(current, computer, device) : undefined
  const blocked = help && {
    message: help.message,
    action: { label: help.label, onClick: () => (help.action === 'approve' ? setApproving(true) : openDevice(node)) }
  }
  const open = async (editor: EditorInfo) => {
    setLastId(editor.id)
    saveLastEditorId(profileId, editor.id)
    setOutcome(null)
    setWorking('opening')
    try {
      // Also while the note shows: the route may have been added since the window last looked.
      const result = await window.mousse.editors.openRemote(editor.id, threadId)
      if (result.ok) setOutcome({ kind: 'opened', ...(result.hint ? { hint: result.hint } : {}), ...(result.via ? { via: result.via } : {}) })
      else if (result.reason === 'no_route') reloadRoute()
      else setOutcome({ kind: 'refused', result })
    } finally {
      setWorking(null)
      // An open may have added the Include line; the notice reads it again.
      setOpens((value) => value + 1)
    }
  }
  const ask = async () => {
    setWorking('asking')
    try {
      setOutcome({ kind: 'asked', result: await window.mousse.editors.askAccess(threadId) })
    } catch (failure) {
      setOutcome({ kind: 'refused', result: { ok: false, reason: 'failed', message: openErrorMessage(failure) } })
    } finally {
      setWorking(null)
    }
  }
  const run = (action: EditorHelpAction): EditorStateAction => ({
    key: action.kind,
    label: action.label,
    onClick: () => {
      if (action.kind === 'ask') void ask()
      else if (action.kind === 'retry') void open(current).catch(() => undefined)
      else openDevice(node)
    }
  })
  // The state under the button: what the last ask or open came to, else that the computer is offline now.
  let state: { help: EditorHelp | AskOutcome; tone: 'alert' | 'status' } | undefined
  let refusal: string | null = null
  // A computer that went offline since the last answer is offline now, whatever that answer said.
  const offlineNow = route === 'mousse' && !!device && device.state !== 'open'
  if (offlineNow && outcome?.kind !== 'opened') state = { help: editorConnectionHelp({ failure: 'offline', computer }), tone: 'alert' }
  else if (outcome?.kind === 'asked') state = { help: askOutcomeWords(outcome.result, computer, selfNode), tone: 'status' }
  else if (outcome?.kind === 'refused') {
    const found = helpForOpenResult(outcome.result, computer, device?.platform)
    if (found) state = { help: found, tone: 'alert' }
    else refusal = remoteRefusalMessage(outcome.result, current, computer)
  }
  const extra = (
    <>
      {working === 'opening' && route === 'mousse' && <p className="side-card-open-editor-note" role="status">Checking the connection to {computer}…</p>}
      {working === 'asking' && <p className="side-card-open-editor-note" role="status">Asking {computer}…</p>}
      {!working && outcome?.kind === 'opened' && outcome.via && <p className="side-card-open-editor-note" role="status">{openedWords(computer, outcome.via)}</p>}
      {!working && state && <EditorStateNote help={state.help} tone={state.tone} actions={state.help.actions.map(run)} />}
    </>
  )
  return (
    <>
      <OpenInEditorView
        path={computer}
        editors={usable}
        lastId={lastId}
        onOpen={open}
        onMenuOpen={refreshQuietly}
        blocked={blocked}
        refusal={refusal}
        hint={outcome?.kind === 'opened' ? outcome.hint ?? null : null}
        extra={extra}
      />
      <EditorSshNotice refreshKey={opens} />
      {approving && help?.action === 'approve' && help.endpoint && (
        <ApproveSshRouteDialog
          node={node as NodeId}
          name={computer}
          endpoint={help.endpoint}
          title={`Approve SSH address for ${computer}`}
          intro={`${computer} offers an SSH address. Approve one that reaches it from this computer to open its folders in an editor here. Mousse checks the host key and the login first.`}
          onClose={() => setApproving(false)}
          onDone={reloadRoute}
        />
      )}
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
  /** Why the main button cannot open anything yet, with what to do about it. Shown under the button. Clicking it, or picking an editor, still tries. */
  blocked?: { message: string; action?: { label: string; onClick: () => void } }
  /** The last attempt was refused: its words, kept until the next attempt. */
  refusal?: string | null
  /** The folder was opened; the editor may still need its Remote - SSH extension. */
  hint?: string | null
  /** What an editor connection to another computer says under the button: progress, a state with its next step, an answer to an ask. */
  extra?: ReactNode
}

/** The split button, its menu and its inline error, given the data. `OpenInEditor` supplies it. */
export function OpenInEditorView({ path, editors, lastId, onOpen, onMenuOpen, blocked, refusal, hint, extra }: OpenInEditorViewProps) {
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
          aria-describedby={blocked ? noteId : undefined}
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
      {blocked && (
        <div id={noteId} className="side-card-open-editor-note" role="note">
          <p>{blocked.message}</p>
          {blocked.action && <button type="button" className="side-card-open-editor-link" onClick={blocked.action.onClick}>{blocked.action.label}</button>}
        </div>
      )}
      {hint && <p className="side-card-open-editor-note" role="note">{hint}</p>}
      {refusal && <p className="side-card-open-editor-note refusal" role="alert">{refusal}</p>}
      {extra}
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
