import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Editor, { type BeforeMount, type OnMount } from '@monaco-editor/react'
import type { Monaco } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { AlertTriangle, Eye, Pencil, X } from 'lucide-react'
import { useFilesRoot } from '../hooks/useActiveProjectPath'
import { useAppStore } from '../stores/appStore'
import { fileWorkspaceScope, useFileWorkspaceStore } from '../stores/fileWorkspaceStore'
import { SerializedAutosave, reconcileExternalContent } from '../utils/fileAutosave'
import { isAssetView, isBinaryContent, languageForPath, viewKindForPath, type FileViewKind } from '../utils/fileEditor'
import { applyEditorTheme, MOUSSE_EDITOR_THEME } from '../utils/monacoTheme'
import { MarkdownDocumentEditor } from './editors/MarkdownDocumentEditor'
import { FileTree, FileTreeToolbar } from './FileTree'
import { ResizablePanelSidebar } from './ResizablePanelSidebar'
import './FilesPanel.css'

const REVALIDATE_MS = 2_000

type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'

interface OpenFileState {
  path: string
  threadId: string | null
  kind: FileViewKind
  content: string
  savedContent: string
  binary: boolean
  loading: boolean
  saveState: SaveState
  error: string | null
  diskContent?: string
  assetUrl?: string
  assetSignature?: string
}

interface OpenFileDetail {
  path: string
  line?: number
  column?: number
  threadId?: string
  projectId?: string
}

function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assetSignature(data: ArrayLike<number>, mimeType: string): string {
  let hash = data.length
  const stride = Math.max(1, Math.floor(data.length / 64))
  for (let index = 0; index < data.length; index += stride) hash = ((hash * 31) ^ data[index]) >>> 0
  return `${mimeType}:${data.length}:${hash}`
}

export function FilesPanel() {
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const threads = useAppStore((s) => s.threads)
  const projectId = threads.find((thread) => thread.id === activeThreadId)?.projectId ?? null
  const scope = fileWorkspaceScope(activeThreadId, projectId)
  const workspace = useFileWorkspaceStore((s) => s.workspaces[scope])
  const openFile = useFileWorkspaceStore((s) => s.openFile)
  const activateFile = useFileWorkspaceStore((s) => s.activateFile)
  const closeFileInStore = useFileWorkspaceStore((s) => s.closeFile)
  const openPaths = workspace?.openPaths ?? []
  const selectedPath = workspace?.activePath ?? null
  const { root: filesRoot, label: rootLabel } = useFilesRoot()
  const [files, setFiles] = useState<Record<string, OpenFileState>>({})
  const [preview, setPreview] = useState<Record<string, boolean>>({})
  const [positions, setPositions] = useState<Record<string, { line: number; column: number }>>({})
  const [refreshKey, setRefreshKey] = useState(0)
  const filesRef = useRef(files)
  const queues = useRef(new Map<string, SerializedAutosave>())
  const saveBlockers = useRef(new Set<string>())
  const loadSequences = useRef(new Map<string, number>())
  const monacoRef = useRef<Monaco | null>(null)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const pendingPosition = useRef<{ path: string; line: number; column: number } | null>(null)
  const previousActiveKey = useRef<string | null>(null)
  const selectedKeyRef = useRef<string | null>(null)
  filesRef.current = files

  const fileKey = useCallback((path: string) => `${scope}\0${path}`, [scope])
  const selectedKey = selectedPath ? fileKey(selectedPath) : null
  const selected = selectedKey ? files[selectedKey] : undefined
  selectedKeyRef.current = selectedKey
  const selectedPreview = selectedKey ? (preview[selectedKey] ?? true) : true

  const patchFile = useCallback((key: string, patch: Partial<OpenFileState> | ((file: OpenFileState) => Partial<OpenFileState>)) => {
    setFiles((current) => {
      const file = current[key]
      if (!file) return current
      const update = typeof patch === 'function' ? patch(file) : patch
      return { ...current, [key]: { ...file, ...update } }
    })
  }, [])

  const ensureQueue = useCallback((key: string, path: string, threadId: string | null) => {
    let queue = queues.current.get(key)
    if (queue) return queue
    queue = new SerializedAutosave({
      read: () => window.mousse.fs.readFile(path, undefined, threadId),
      write: (content) => window.mousse.fs.writeFile(path, content, undefined, threadId),
      onSaved: (savedContent) => {
        saveBlockers.current.delete(key)
        patchFile(key, (file) => ({ savedContent, saveState: file.content === savedContent ? 'saved' : 'dirty', error: null }))
      },
      onConflict: (diskContent) => {
        saveBlockers.current.add(key)
        patchFile(key, { saveState: 'conflict', diskContent, error: 'This file changed on disk. Your edits were kept.' })
      },
      onError: (error) => {
        saveBlockers.current.add(key)
        patchFile(key, { saveState: 'error', error: `Autosave failed: ${message(error)}` })
      }
    })
    queues.current.set(key, queue)
    return queue
  }, [patchFile])

  const loadFile = useCallback(async (path: string, targetScope = scope, threadId = activeThreadId) => {
    const key = `${targetScope}\0${path}`
    if (filesRef.current[key]?.loading || (!filesRef.current[key]?.error && filesRef.current[key])) return
    const kind = viewKindForPath(path)
    setFiles((current) => ({ ...current, [key]: {
      path, threadId, kind, content: '', savedContent: '', binary: false,
      loading: true, saveState: 'saved', error: null
    } }))
    const sequence = (loadSequences.current.get(key) ?? 0) + 1
    loadSequences.current.set(key, sequence)
    try {
      if (isAssetView(kind)) {
        const asset = await window.mousse.fs.readAsset(path, undefined, threadId)
        if (loadSequences.current.get(key) !== sequence) return
        const bytes = Uint8Array.from(asset.data)
        const assetUrl = URL.createObjectURL(new Blob([bytes.buffer], { type: asset.mimeType }))
        patchFile(key, { loading: false, binary: true, assetUrl, assetSignature: assetSignature(asset.data, asset.mimeType) })
      } else {
        const content = await window.mousse.fs.readFile(path, undefined, threadId)
        if (loadSequences.current.get(key) !== sequence) return
        const binary = isBinaryContent(content)
        patchFile(key, { loading: false, binary, content: binary ? '' : content, savedContent: binary ? '' : content })
        if (!binary) ensureQueue(key, path, threadId)
      }
    } catch (error) {
      if (loadSequences.current.get(key) === sequence) patchFile(key, { loading: false, error: message(error), saveState: 'error' })
    }
  }, [activeThreadId, ensureQueue, patchFile, scope])

  useEffect(() => {
    for (const path of openPaths) void loadFile(path)
  }, [loadFile, openPaths])

  const flushPath = useCallback(async (key: string | null) => {
    if (!key) return
    const file = filesRef.current[key]
    const queue = queues.current.get(key)
    if (!file || !queue || file.saveState === 'conflict') return
    if (file.content !== file.savedContent) {
      patchFile(key, { saveState: 'saving', error: null })
      queue.schedule({ content: file.content, baseline: file.savedContent })
    }
    await queue.flush()
  }, [patchFile])

  useEffect(() => {
    const previous = previousActiveKey.current
    previousActiveKey.current = selectedKey
    if (previous && previous !== selectedKey) void flushPath(previous)
  }, [flushPath, selectedKey])

  useEffect(() => {
    const interval = window.setInterval(() => {
      for (const path of openPaths) {
        const key = fileKey(path)
        const file = filesRef.current[key]
        if (!file || file.loading || file.saveState === 'saving') continue
        if (isAssetView(file.kind)) {
          void window.mousse.fs.readAsset(path, undefined, file.threadId).then((asset) => {
            const current = filesRef.current[key]
            const signature = assetSignature(asset.data, asset.mimeType)
            if (!current || current.assetSignature === signature) return
            const bytes = Uint8Array.from(asset.data)
            const url = URL.createObjectURL(new Blob([bytes.buffer], { type: asset.mimeType }))
            if (current.assetUrl) URL.revokeObjectURL(current.assetUrl)
            patchFile(key, { assetUrl: url, assetSignature: signature, error: null })
          }).catch((error) => patchFile(key, { error: `Refresh failed: ${message(error)}` }))
          continue
        }
        if (file.binary) continue
        const savedAtReadStart = file.savedContent
        void window.mousse.fs.readFile(path, undefined, file.threadId).then((diskContent) => {
          const current = filesRef.current[key]
          // A save completed after this read began; its result is newer than this poll.
          if (!current || current.savedContent !== savedAtReadStart) return
          const result = reconcileExternalContent(current.savedContent, current.content, diskContent)
          if (result.kind === 'replace') patchFile(key, { content: result.content, savedContent: result.content, error: null, saveState: 'saved' })
          if (result.kind === 'conflict') {
            queues.current.get(key)?.cancel()
            saveBlockers.current.add(key)
            patchFile(key, { diskContent: result.diskContent, saveState: 'conflict', error: 'This file changed on disk. Your edits were kept.' })
          }
        }).catch((error) => patchFile(key, { error: `Refresh failed: ${message(error)}` }))
      }
    }, REVALIDATE_MS)
    return () => window.clearInterval(interval)
  }, [fileKey, openPaths, patchFile])

  useEffect(() => {
    const onOpenFile = (event: Event) => {
      const detail = (event as CustomEvent<OpenFileDetail>).detail
      if (!detail?.path) return
      const store = useAppStore.getState()
      const targetThreadId = detail.threadId ?? store.activeThreadId
      const targetProjectId = detail.projectId
        ?? store.threads.find((thread) => thread.id === targetThreadId)?.projectId
        ?? null
      const targetScope = fileWorkspaceScope(targetThreadId, targetProjectId)
      if (detail.threadId && detail.threadId !== store.activeThreadId) store.switchToThread(detail.threadId)
      store.setMainView('files')
      store.setMainAreaOpen(true)
      useFileWorkspaceStore.getState().openFile(targetScope, detail.path)
      if (detail.line) {
        const position = { path: detail.path, line: detail.line, column: detail.column ?? 1 }
        pendingPosition.current = position
        setPositions((current) => ({ ...current, [`${targetScope}\0${detail.path}`]: position }))
      }
      void loadFile(detail.path, targetScope, targetThreadId)
    }
    window.addEventListener('mousse:open-file', onOpenFile)
    return () => window.removeEventListener('mousse:open-file', onOpenFile)
  }, [loadFile])

  useEffect(() => {
    const pending = pendingPosition.current
    if (!pending || pending.path !== selectedPath || !editorRef.current) return
    editorRef.current.setPosition({ lineNumber: Math.max(1, pending.line), column: Math.max(1, pending.column) })
    editorRef.current.revealLineInCenter(Math.max(1, pending.line))
    editorRef.current.focus()
    pendingPosition.current = null
  }, [selectedPath, selected?.loading])

  useEffect(() => () => {
    for (const queue of queues.current.values()) void queue.flush()
    for (const file of Object.values(filesRef.current)) if (file.assetUrl) URL.revokeObjectURL(file.assetUrl)
  }, [])

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!Object.values(filesRef.current).some((file) => file.content !== file.savedContent)) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  useEffect(() => {
    const updateTheme = () => monacoRef.current && applyEditorTheme(monacoRef.current)
    const observer = new MutationObserver(updateTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] })
    const media = window.matchMedia('(prefers-color-scheme: light)')
    media.addEventListener('change', updateTheme)
    return () => { observer.disconnect(); media.removeEventListener('change', updateTheme) }
  }, [])

  const updateContent = useCallback((value: string) => {
    if (!selectedKey || !selected) return
    patchFile(selectedKey, { content: value, saveState: 'dirty', error: null, diskContent: undefined })
    ensureQueue(selectedKey, selected.path, selected.threadId).schedule({ content: value, baseline: selected.savedContent })
  }, [ensureQueue, patchFile, selected, selectedKey])

  const closeTab = useCallback(async (path: string) => {
    const key = fileKey(path)
    await flushPath(key)
    const current = filesRef.current[key]
    if (saveBlockers.current.has(key)) return
    queues.current.get(key)?.dispose()
    queues.current.delete(key)
    if (current?.assetUrl) URL.revokeObjectURL(current.assetUrl)
    setFiles((all) => { const next = { ...all }; delete next[key]; return next })
    closeFileInStore(scope, path)
  }, [closeFileInStore, fileKey, flushPath, scope])

  const beforeMount: BeforeMount = (monaco) => { monacoRef.current = monaco; applyEditorTheme(monaco) }
  const onMount: OnMount = (instance, monaco) => {
    editorRef.current = instance
    monacoRef.current = monaco
    applyEditorTheme(monaco)
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void flushPath(selectedKeyRef.current))
    const pending = pendingPosition.current
    if (pending?.path === selectedPath) {
      instance.setPosition({ lineNumber: Math.max(1, pending.line), column: Math.max(1, pending.column) })
      instance.revealLineInCenter(Math.max(1, pending.line)); instance.focus(); pendingPosition.current = null
    }
  }

  const saveLabel = useMemo(() => {
    if (!selected) return ''
    if (selected.saveState === 'saving') return 'Saving…'
    if (selected.saveState === 'dirty') return 'Autosave pending'
    if (selected.saveState === 'conflict') return 'Conflict'
    if (selected.saveState === 'error') return 'Save error'
    return 'Saved'
  }, [selected])

  const supportsPreview = selected?.kind === 'html'

  return (
    <div className="files-panel">
      <ResizablePanelSidebar className="files-sidebar" defaultWidth={260}>
        <div className="panel-toolbar"><span className="panel-toolbar-label">Explorer</span><FileTreeToolbar onRefresh={() => setRefreshKey((key) => key + 1)} /></div>
        <FileTree filesRoot={filesRoot} rootLabel={rootLabel} threadId={activeThreadId} selectedPath={selectedPath}
          onSelectFile={(path) => openFile(scope, path)} refreshKey={refreshKey} />
      </ResizablePanelSidebar>
      <div className="files-editor">
        <div className="files-tabs" role="tablist" aria-label="Open files">
          {openPaths.map((path) => {
            const key = fileKey(path)
            const file = files[key]
            const dirty = file && file.content !== file.savedContent
            return <button key={path} type="button" role="tab" aria-selected={path === selectedPath}
              className={`files-tab ${path === selectedPath ? 'active' : ''}`}
              draggable onDragStart={(event) => {
                const payload = JSON.stringify({ kind: 'file', title: basename(path), path, threadId: activeThreadId ?? undefined, projectId: projectId ?? undefined })
                event.dataTransfer.setData('application/x-mousse-reference', payload)
                event.dataTransfer.setData('text/plain', path)
              }} onClick={() => activateFile(scope, path)} title={path}>
              <span>{basename(path)}{dirty ? ' •' : ''}</span>
              <span className="files-tab-close" role="button" aria-label={`Close ${basename(path)}`} onClick={(event) => { event.stopPropagation(); void closeTab(path) }}><X size={12} /></span>
            </button>
          })}
        </div>
        <div className="panel-toolbar files-editor-toolbar">
          <span className="panel-toolbar-path" title={selectedPath ?? undefined}>{selectedPath ?? 'Select a file'}</span>
          <div className="files-toolbar-actions">
            {supportsPreview && <div className="files-view-toggle" role="group" aria-label="File view">
              <button type="button" className={`btn btn-sm ${!selectedPreview ? 'active' : ''}`} onClick={() => selectedKey && setPreview((state) => ({ ...state, [selectedKey]: false }))}><Pencil size={13} /> Edit</button>
              <button type="button" className={`btn btn-sm ${selectedPreview ? 'active' : ''}`} onClick={() => selectedKey && setPreview((state) => ({ ...state, [selectedKey]: true }))}><Eye size={13} /> Preview</button>
            </div>}
            {selected && <span className={`files-save-status ${selected.saveState}`}>{saveLabel}</span>}
          </div>
        </div>
        {selected?.error && <div className={`panel-error ${selected.saveState === 'conflict' ? 'files-conflict' : ''}`}>
          {selected.saveState === 'conflict' && <AlertTriangle size={15} />}{selected.error}
          {selected.saveState === 'conflict' && <div className="files-conflict-actions">
            <button className="btn btn-sm" type="button" onClick={() => {
              if (!selectedKey || selected.diskContent === undefined) return
              saveBlockers.current.delete(selectedKey)
              patchFile(selectedKey, { content: selected.diskContent, savedContent: selected.diskContent, diskContent: undefined, saveState: 'saved', error: null })
            }}>Use disk</button>
            <button className="btn btn-sm" type="button" onClick={() => {
              if (!selectedKey || selected.diskContent === undefined) return
              const disk = selected.diskContent
              saveBlockers.current.delete(selectedKey)
              patchFile(selectedKey, { savedContent: disk, diskContent: undefined, saveState: 'dirty', error: null })
              ensureQueue(selectedKey, selected.path, selected.threadId).schedule({ content: selected.content, baseline: disk })
            }}>Keep mine</button>
          </div>}
        </div>}
        {selected?.loading ? <div className="files-editor-empty">Loading…</div>
          : selected && selected.kind === 'pdf' && selected.assetUrl ? <iframe className="files-asset-preview files-pdf-preview" src={selected.assetUrl} title={`PDF preview: ${selected.path}`} />
          : selected && selected.kind === 'image' && selected.assetUrl ? <div className="files-asset-preview"><img src={selected.assetUrl} alt={selected.path} /></div>
          : selected && selected.kind === 'video' && selected.assetUrl ? <div className="files-asset-preview"><video src={selected.assetUrl} controls /></div>
          : selected?.binary ? <div className="files-editor-empty">Binary files cannot be edited.</div>
          : selected && selected.kind === 'markdown' ? <MarkdownDocumentEditor key={selectedKey} path={selected.path} value={selected.content} onChange={updateContent} onSave={() => void flushPath(selectedKey)} defaultViewMode="preview" revealPosition={selectedKey ? positions[selectedKey] : undefined} aria-label={selected.path} />
          : selected && selected.kind === 'html' && selectedPreview ? <iframe className="files-asset-preview files-html-preview" srcDoc={selected.content} sandbox="" title={`HTML preview: ${selected.path}`} />
          : selected ? <div className="files-monaco-editor"><Editor path={selectedKey ?? selected.path} value={selected.content} language={languageForPath(selected.path)} theme={MOUSSE_EDITOR_THEME} beforeMount={beforeMount} onMount={onMount} onChange={(value) => updateContent(value ?? '')} options={{ automaticLayout: true, bracketPairColorization: { enabled: true }, matchBrackets: 'always', minimap: { enabled: true }, lineNumbers: 'on', scrollBeyondLastLine: false, fontFamily: "Outfit, 'Segoe UI', sans-serif", fontSize: 13, tabSize: 2, detectIndentation: true, wordWrap: 'off' }} /></div>
          : <div className="files-editor-empty"><p>Select a file from the tree</p></div>}
      </div>
    </div>
  )
}
