import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Globe, MousePointer2, Plus, TerminalSquare } from '../../lib/icons'
import Editor, { type OnMount } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { LocalChatConversation as ChatConversation } from '../../../shared/chats'
import type { ChatResourceCursor, ChatResourceMethod, ChatResourcePresence, ChatResourceSnapshot, ChatResourceTarget, ChatSharedFile, ChatSharedFileWriteResult, ChatSharedTerminal, ChatTerminalOutput } from '../../../shared/chatResources'
import type { BrowserArtifactReadResult } from '../../../shared/browser/host'
import type { BrowserViewerSnapshot } from '../../../shared/browser/viewer'
import { viewerPointToCss } from '../../../shared/browser/viewer'
import { registerNavigationGuard } from '../../services/navigationGuards'
import { XTERM_FONT, getXtermTheme, followXtermAppearance } from '../../lib/xtermTheme'
import '@xterm/xterm/css/xterm.css'

type Request = <T>(method: ChatResourceMethod, params?: Record<string, unknown>) => Promise<T>
type Presence = (target: ChatResourceTarget, cursor?: ChatResourceCursor) => void
const message = (error: unknown) => String((error as { message?: string })?.message || error)

export function ChatResourcesPanel({ chat }: { chat: ChatConversation }) {
  const [snapshot, setSnapshot] = useState<ChatResourceSnapshot>()
  const [view, setView] = useState<'browser' | 'terminal' | 'files'>('browser')
  const [error, setError] = useState('')
  const scope = useRef(true)
  const refreshing = useRef(false)
  const request: Request = useCallback((method, params = {}) => window.mousse.platformRequest.request(method, { groupId: chat.id, ...params }), [chat.id])
  const refresh = useCallback(async () => {
    if (refreshing.current) return
    refreshing.current = true
    try { const next = await request<ChatResourceSnapshot>('chatResources.snapshot'); if (scope.current) setSnapshot(next) }
    catch (error) { if (scope.current) setError(message(error)) }
    finally { refreshing.current = false }
  }, [request])
  const currentPresence = useRef<{ target: ChatResourceTarget; cursor?: ChatResourceCursor } | undefined>(undefined)
  const lastPresence = useRef(0)
  const presence: Presence = useCallback((target, cursor) => {
    currentPresence.current = { target, cursor }
    if (Date.now() - lastPresence.current < 100) return
    lastPresence.current = Date.now()
    void request('chatResources.presence.update', { target, ...(cursor ? { cursor } : {}) }).catch(() => {})
  }, [request])
  useEffect(() => {
    scope.current = true
    void refresh()
    const timer = setInterval(() => { void refresh() }, 1000)
    const heartbeat = setInterval(() => { const current = currentPresence.current; if (current) presence(current.target, current.cursor) }, 5000)
    return () => { scope.current = false; clearInterval(timer); clearInterval(heartbeat); void request('chatResources.presence.leave').catch(() => {}) }
  }, [request, refresh, presence])
  const operate = async (action: () => Promise<unknown>) => {
    setError('')
    try { await action(); if (scope.current) await refresh() }
    catch (error) { if (scope.current) setError(message(error)) }
  }
  const activePresence = snapshot?.presence.filter((entry) => entry.clientId !== snapshot.viewerClientId) || []
  return <aside className="chat-resources" aria-label="Shared group resources">
    <div className="chat-resource-header"><span>Shared workspace</span><span>{chat.projectId ? 'Project group' : 'Group'}</span></div>
    <div className="chat-resource-tabs" role="tablist" aria-label="Shared tools">{([{ id: 'browser', label: 'Browser', icon: Globe }, { id: 'terminal', label: 'Terminal', icon: TerminalSquare }, { id: 'files', label: 'Files', icon: FileText }] as const).map(({ id, label, icon: Icon }) => <button key={id} role="tab" aria-selected={view === id} onClick={() => { currentPresence.current = undefined; setView(id) }}><Icon size={14} />{label}</button>)}</div>
    {error && <p className="chat-error" role="alert">{error}</p>}
    {snapshot && <div className="chat-resource-panel" role="tabpanel">
      <div hidden={view !== 'browser'} className="chat-tool-surface"><SharedBrowser chat={chat} snapshot={snapshot} presence={presence} request={request} operate={operate} otherPresence={activePresence} /></div>
      <div hidden={view !== 'terminal'} className="chat-shared-terminals chat-tool-surface"><div className="chat-resource-actions"><span>Group terminals</span><button aria-label="New shared terminal" onClick={() => void operate(() => request('chatResources.terminal.create', { columns: 80, rows: 24 }))}><Plus size={14} /></button></div>{snapshot.terminals.length ? snapshot.terminals.map((terminal) => <SharedTerminal key={terminal.id} terminal={terminal} snapshot={snapshot} request={request} presence={presence} operate={operate} />) : <p className="chat-empty-hint">Open a terminal to share its shell and output with this group.</p>}</div>
      <div hidden={view !== 'files'} className="chat-tool-surface"><SharedFileEditor snapshot={snapshot} request={request} presence={presence} operate={operate} otherPresence={activePresence} /></div>
    </div>}
    {!snapshot && <p className="chat-empty-hint">Loading shared workspace…</p>}
  </aside>
}

interface Common { snapshot: ChatResourceSnapshot; request: Request; presence: Presence; operate(action: () => Promise<unknown>): Promise<void> }
function SharedBrowser({ chat, snapshot, request, presence, operate, otherPresence }: Common & { chat: ChatConversation; otherPresence: ChatResourcePresence[] }) {
  const [url, setUrl] = useState('')
  const [selected, setSelected] = useState('')
  const browser = snapshot.browsers.find((item) => item.session?.id === selected) || snapshot.browsers.find((item) => item.session?.lifecycle !== 'closed')
  const observation = browser?.observation
  const session = browser?.session
  useEffect(() => { setUrl(observation?.url || '') }, [session?.id, observation?.url])
  const sessionId = session?.id
  const artifactId = observation?.screenshot?.artifactId
  const [imageUrl, setImageUrl] = useState('')
  const control = session ? snapshot.browserControls[session.id] : undefined
  const hasControl = control?.clientId === snapshot.viewerClientId
  const [key, setKey] = useState('')
  useEffect(() => {
    let active = true
    let blobUrl = ''
    setImageUrl('')
    if (artifactId && sessionId) void window.mousse.platformRequest.request<BrowserArtifactReadResult>('browser.artifacts.read', { threadId: chat.threadId, sessionId, artifactId }).then((result) => {
      if (!active || result.mediaType !== 'image/png' || result.byteLength > 1_500_000 || result.bytesBase64.length > 2_000_000) return
      const bytes = Uint8Array.from(atob(result.bytesBase64), (character) => character.charCodeAt(0))
      blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
      setImageUrl(blobUrl)
    }).catch(() => {})
    return () => { active = false; if (blobUrl) URL.revokeObjectURL(blobUrl) }
  }, [artifactId, sessionId, chat.threadId])
  const action = (value: Record<string, unknown>) => {
    if (!session || !observation) return
    void operate(() => request<BrowserViewerSnapshot>('chatResources.browser.action', { sessionId: session.id, tabId: observation.tabId, generation: observation.generation, observationId: observation.observationId, action: value }))
  }
  const imagePoint = (event: React.MouseEvent<HTMLImageElement>) => {
    const image = event.currentTarget
    const rect = image.getBoundingClientRect()
    return { x: (event.clientX - rect.left) * (image.naturalWidth / rect.width), y: (event.clientY - rect.top) * (image.naturalHeight / rect.height) }
  }
  const cursors = otherPresence.filter((entry) => entry.target.kind === 'browser' && entry.target.id === session?.id && entry.cursor?.kind === 'browser' && entry.cursor.generation === observation?.generation)
  return <div className="chat-shared-browser">
    <form className="chat-resource-url" onSubmit={(event) => { event.preventDefault(); if (session && hasControl) action({ type: 'navigate', url }); else if (!session) void operate(() => request('chatResources.browser.open', { url })) }}><Globe size={14} /><input aria-label="Shared browser URL" value={url} onChange={(event) => setUrl(event.target.value)} /><button disabled={!url.trim() || (!!session && !hasControl)}>{session ? 'Go' : 'Open'}</button></form>
    {session ? <>
      <div className="chat-resource-actions"><select aria-label="Shared browser session" value={session.id} onChange={(event) => setSelected(event.target.value)}>{snapshot.browsers.filter((item) => item.session && item.session.lifecycle !== 'closed').map((item) => <option key={item.session!.id} value={item.session!.id}>{item.observation?.title || item.session!.id.slice(0, 8)}</option>)}</select><button onClick={() => void operate(() => request('chatResources.browser.control', { sessionId: session.id, acquire: !hasControl }))}>{hasControl ? 'Resume agents' : control ? 'Following another viewer' : 'Take control'}</button><button onClick={() => void operate(() => request('chatResources.browser.observe', { sessionId: session.id }))}>Refresh</button><button onClick={() => void operate(() => request('chatResources.browser.close', { sessionId: session.id }))}>Close</button></div>
      <div className="chat-browser-follow" role="status">{hasControl ? 'You control this browser' : control ? 'Following another viewer' : 'Following the agents'} · {observation?.title || browser?.connection}</div>
      {hasControl && <form className="chat-resource-url" onSubmit={(event) => { event.preventDefault(); action({ type: 'key', key }); setKey('') }}><input aria-label="Shared browser key" placeholder="Key (Enter, Tab, Control+L)" value={key} onChange={(event) => setKey(event.target.value)} /><button disabled={!key}>Send key</button></form>}
      <div className="chat-shared-browser-viewport">{imageUrl && observation?.screenshot ? <><img src={imageUrl} alt={observation.title || 'Shared group browser'} onMouseMove={(event) => { const css = viewerPointToCss(imagePoint(event), observation.screenshot!, observation.viewport); presence({ kind: 'browser', id: session.id }, { kind: 'browser', tabId: observation.tabId, generation: observation.generation, x: css.x, y: css.y }) }} onClick={(event) => { if (hasControl) action({ type: 'click', target: { kind: 'image-point', point: imagePoint(event) } }) }} />{cursors.map((entry) => { const cursor = entry.cursor; if (cursor?.kind !== 'browser') return null; return <span key={entry.clientId} className="chat-shared-cursor" style={{ left: `${(cursor.x - (observation.screenshot?.cropOriginCss?.x || 0)) * (observation.screenshot?.cssToImageScaleX || 1) / (observation.screenshot?.pixelWidth || observation.viewport.cssWidth) * 100}%`, top: `${(cursor.y - (observation.screenshot?.cropOriginCss?.y || 0)) * (observation.screenshot?.cssToImageScaleY || 1) / (observation.screenshot?.pixelHeight || observation.viewport.cssHeight) * 100}%`, color: entry.participant.color || '#bc96ed' }}><MousePointer2 size={15} fill="currentColor" /><span>{entry.participant.name}</span></span> })}</> : <p className="chat-empty-hint">{browser?.message || 'Waiting for a browser observation.'}</p>}</div>
    </> : <p className="chat-empty-hint">Open a browser to share the same page and see group cursors.</p>}
  </div>
}

function SharedTerminal({ terminal, snapshot, request, presence, operate }: Common & { terminal: ChatSharedTerminal }) {
  const container = useRef<HTMLDivElement>(null)
  const control = terminal.control?.clientId === snapshot.viewerClientId
  const controlRef = useRef(control)
  controlRef.current = control
  const [error, setError] = useState('')
  useEffect(() => {
    if (!container.current) return
    const term = new Terminal({ allowTransparency: true, fontFamily: XTERM_FONT, fontSize: 12, theme: getXtermTheme(), cursorBlink: true })
    followXtermAppearance(term)
    const fit = new FitAddon()
    term.loadAddon(fit); term.open(container.current); fit.fit()
    let active = true, busy = false, sequence = 0
    const data = term.onData((value) => { if (controlRef.current) void request('chatResources.terminal.write', { terminalId: terminal.id, data: value }).catch((error) => { if (active) setError(message(error)) }) })
    const poll = async () => {
      if (busy) return
      busy = true
      try {
        const output = await request<ChatTerminalOutput>('chatResources.terminal.output', { terminalId: terminal.id, afterSequence: sequence })
        if (!active) return
        if (output.gap && output.scrollback !== undefined) { term.reset(); term.write(output.scrollback) }
        else for (const chunk of output.chunks) if (chunk.sequence > sequence) term.write(chunk.data)
        sequence = output.sequence
      } catch (error) { if (active) setError(message(error)) }
      finally { busy = false }
    }
    void poll()
    const timer = setInterval(() => { void poll() }, 250)
    const observer = new ResizeObserver(() => { if (!container.current?.clientWidth) return; fit.fit(); if (controlRef.current) void request('chatResources.terminal.resize', { terminalId: terminal.id, columns: Math.min(500, Math.max(2, term.cols)), rows: Math.min(300, Math.max(2, term.rows)) }).catch(() => {}) })
    observer.observe(container.current)
    return () => { active = false; data.dispose(); observer.disconnect(); clearInterval(timer); term.dispose() }
  }, [request, terminal.id])
  const others = snapshot.presence.filter((entry) => entry.clientId !== snapshot.viewerClientId && entry.target.kind === 'terminal' && entry.target.id === terminal.id)
  return <section className="chat-shared-terminal"><div className="chat-resource-actions"><span>{terminal.title}{!terminal.alive && ' · exited'}</span><button onClick={() => void operate(() => request('chatResources.terminal.control', { terminalId: terminal.id, acquire: !control }))}>{control ? 'Release control' : 'Take control'}</button><button onClick={() => void operate(() => request('chatResources.terminal.close', { terminalId: terminal.id }))}>Close</button></div><div className="chat-terminal-viewport" onMouseMove={(event) => { const rect = event.currentTarget.getBoundingClientRect(); presence({ kind: 'terminal', id: terminal.id }, { kind: 'terminal', column: Math.max(0, Math.floor((event.clientX - rect.left) / rect.width * terminal.columns)), row: Math.max(0, Math.floor((event.clientY - rect.top) / rect.height * terminal.rows)) }) }}><div ref={container} className="chat-terminal-xterm" />{others.map((entry) => { const cursor = entry.cursor; if (cursor?.kind !== 'terminal') return null; return <span className="chat-shared-cursor" key={entry.clientId} style={{ left: `${cursor.column / terminal.columns * 100}%`, top: `${cursor.row / terminal.rows * 100}%`, color: entry.participant.color || '#bc96ed' }}><MousePointer2 size={15} /><span>{entry.participant.name}</span></span> })}</div>{error && <p className="chat-error">{error}</p>}</section>
}

function SharedFileEditor({ snapshot, request, presence, operate, otherPresence }: Common & { otherPresence: ChatResourcePresence[] }) {
  const [path, setPath] = useState('')
  const [file, setFile] = useState<ChatSharedFile>()
  const [draft, setDraft] = useState('')
  const [conflict, setConflict] = useState<ChatSharedFile>()
  const [editorReady, setEditorReady] = useState(0)
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | undefined>(undefined)
  const decoration = useRef<Monaco.editor.IEditorDecorationsCollection | undefined>(undefined)
  const fileRef = useRef(file)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const documentEpoch = useRef(0)
  fileRef.current = file
  const dirty = !!file && draft !== file.content
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  useEffect(() => registerNavigationGuard(() => !dirtyRef.current || window.confirm('Discard unsaved shared-file changes?')), [])
  const shared = snapshot.files.find((item) => item.path === file?.path)
  useEffect(() => {
    if (!shared || !file || shared.revision === file.revision) return
    if (dirty) setConflict(shared)
    else { setFile(shared); setDraft(shared.content) }
  }, [shared, file, dirty])
  const mount: OnMount = (instance) => {
    editor.current = instance
    decoration.current = instance.createDecorationsCollection()
    setEditorReady((value) => value + 1)
    const listener = instance.onDidChangeCursorSelection((event) => {
      const current = fileRef.current
      if (current) presence({ kind: 'file', id: current.path }, { kind: 'file', revision: current.revision, line: event.selection.positionLineNumber, column: event.selection.positionColumn, endLine: event.selection.selectionStartLineNumber, endColumn: event.selection.selectionStartColumn })
    })
    instance.onDidDispose(() => listener.dispose())
  }
  const cursors = useMemo(() => otherPresence.filter((entry) => entry.target.kind === 'file' && entry.target.id === file?.path && entry.cursor?.kind === 'file' && entry.cursor.revision === file?.revision), [otherPresence, file?.path, file?.revision])
  useEffect(() => {
    const model = editor.current?.getModel()
    decoration.current?.set(cursors.flatMap((entry) => {
      const cursor = entry.cursor
      if (cursor?.kind !== 'file' || !model) return []
      const line = Math.min(model.getLineCount(), cursor.line), column = Math.min(model.getLineMaxColumn(line), cursor.column)
      return [{ range: { startLineNumber: line, endLineNumber: line, startColumn: column, endColumn: column }, options: { className: 'chat-monaco-cursor', after: { content: ` ${entry.participant.name}`, inlineClassName: 'chat-monaco-cursor-label' }, stickiness: 1 } }]
    }))
  }, [cursors, file?.path, editorReady])
  const open = (selectedPath: string) => void operate(async () => {
    if (dirty && !window.confirm('Discard unsaved shared-file changes?')) return
    const epoch = ++documentEpoch.current
    const initialDraft = draftRef.current
    const next = await request<ChatSharedFile>('chatResources.file.read', { path: selectedPath })
    if (epoch !== documentEpoch.current) return
    if (draftRef.current !== initialDraft && dirtyRef.current && !window.confirm('Discard unsaved shared-file changes?')) return
    setFile(next); setDraft(next.content); setPath(next.path); setConflict(undefined)
  })
  return <div className="chat-shared-files"><form className="chat-resource-url" onSubmit={(event) => { event.preventDefault(); open(path) }}><FileText size={14} /><input aria-label="Shared file path" placeholder="Relative file path" value={path} onChange={(event) => setPath(event.target.value)} /><button disabled={!path.trim()}>Open</button></form>{snapshot.files.length > 0 && <div className="chat-resource-file-list">{snapshot.files.map((item) => <button key={item.path} className={item.path === file?.path ? 'active' : ''} onClick={() => open(item.path)}>{item.path}</button>)}</div>}{file ? <><div className="chat-resource-actions"><span title={file.path}>{file.path}{dirty ? ' · unsaved' : ''}</span><button disabled={!dirty} onClick={() => void operate(async () => { const epoch = documentEpoch.current; const submittedDraft = draftRef.current; const result = await request<ChatSharedFileWriteResult>('chatResources.file.write', { path: file.path, content: submittedDraft, expectedRevision: file.revision }); if (epoch !== documentEpoch.current || fileRef.current?.path !== file.path) return; if (result.status === 'conflict') setConflict(result.file); else { setFile(result.file); setDraft((current) => current === submittedDraft ? result.file.content : current); setConflict(undefined) } })}>Save</button></div>{conflict && <div className="chat-file-conflict" role="alert"><p>This file changed elsewhere. Your edits are preserved.</p><button onClick={() => { setFile(conflict); setDraft(conflict.content); setConflict(undefined) }}>Load latest</button><button onClick={() => { setFile(conflict); setConflict(undefined) }}>Keep my edits for review</button></div>}<div className="chat-monaco-editor"><Editor path={`mousse-shared/${snapshot.profileId}/${snapshot.groupId}/${file.path}`} value={draft} onChange={(value) => setDraft(value ?? '')} onMount={mount} theme="vs-dark" options={{ minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, automaticLayout: true }} /></div></> : <p className="chat-empty-hint">Open a group workspace file to edit together. Saves check its revision, and cursors show other viewers.</p>}</div>
}
