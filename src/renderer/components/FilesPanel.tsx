import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Editor, { type BeforeMount, type OnMount } from '@monaco-editor/react'
import type { Monaco } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { AlertTriangle, Eye, Pencil, Search, X } from '../lib/icons'
import { setReferenceDragData } from '../../shared/chatReferences'
import { useCommand } from '../commands/commandRegistry'
import { useActiveProjectLocation, useFilesRoot } from '../hooks/useActiveProjectPath'
import type { FileGrepMatch } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { useMonacoCodeFont } from '../lib/monacoCodeFont'
import { fileWorkspaceScope, useFileWorkspaceStore } from '../stores/filesStore'
import { SerializedAutosave, normalizeWorkspacePath, reconcileExternalContent } from '../utils/fileWorkspace'
import { isAssetView, isBinaryContent, languageForPath, viewKindForPath, type FileViewKind } from '../utils/fileEditor'
import { applyEditorTheme, MOUSSE_EDITOR_THEME } from '../utils/monacoTheme'
import { MarkdownDocumentEditor } from './editors/MarkdownDocumentEditor'
import type { MarkdownEditorViewMode } from './editors/markdownEditorState'
import { FileTree, FileTreeToolbar } from './FileTree'
import { FileTreeMemories } from './fileTreeState'
import { FilesPathBar, type FilesPlaceItem } from './FilesPathBar'
import { fileLocation, filesBrowseRoot, isAbsolutePath, joinFolder, normalizeFolderPath, pathInside, resolveTypedPath, samePath } from '../utils/filesBrowse'
import { absoluteFilesPath } from '../utils/fileReference'
import { FilesSearchField, FilesSearchResults, useFilesSearch, type FilesSearchOpenRequest } from './FilesSearch'
import { openLineDetail, type FilesSearchMode } from './filesSearchState'
import { ResizablePanelSidebar } from './ResizablePanelSidebar'
import { ensureProjectReferenceThread } from '../utils/chatLinks'
import { filesEntryReference } from '../utils/fileReference'
import { DelayedLoader } from './ui/DelayedLoader'
import { TabBar } from './ui/TabBar'
import './filesPanel.css'

const REVALIDATE_MS = 2_000

type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'

interface OpenFileState {
  profileId: string
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
  initialLoadFailed?: boolean
  /** The last background refresh failed: `error` says so until a refresh reads the file again. */
  refreshFailed?: boolean
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

/** A refresh read the file again after one failed: its error goes, unless a failed save shows its own. */
function refreshRecovered(file: OpenFileState): Partial<OpenFileState> {
  return file.saveState === 'error' ? { refreshFailed: false } : { refreshFailed: false, error: null }
}

// A file opened while the tree shows a folder outside the thread's is named by its absolute path and read from its own folder.
function readText(path: string, threadId: string | null): Promise<string> {
  const at = fileLocation(path)
  return window.mousse.fs.readFile(at.path, undefined, threadId, at.root)
}
function readAssetAt(path: string, threadId: string | null) {
  const at = fileLocation(path)
  return window.mousse.fs.readAsset(at.path, undefined, threadId, at.root)
}
function writeText(path: string, content: string, threadId: string | null): Promise<void> {
  const at = fileLocation(path)
  return window.mousse.fs.writeFile(at.path, content, undefined, threadId, at.root)
}

/** Whether a key press belongs to a text field or the code editor, which keep their own Escape and Ctrl+L. */
function typingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"], .monaco-editor'))
}

function assetSignature(data: ArrayLike<number>, mimeType: string): string {
  let hash = data.length
  const stride = Math.max(1, Math.floor(data.length / 64))
  for (let index = 0; index < data.length; index += stride) hash = ((hash * 31) ^ data[index]) >>> 0
  return `${mimeType}:${data.length}:${hash}`
}

interface FilesPanelProps {
  /**
   * Whether the panel is on screen. While it is not, the tree and the editor unmount and the panel keeps only what
   * brings them back as they were: open files and their edits, the open folders, the scroll offsets and the selection.
   */
  showing?: boolean
}

export function FilesPanel({ showing = true }: FilesPanelProps) {
  const codeFont = useMonacoCodeFont()
  const profileId = useAppStore((s) => s.profileId)
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const threads = useAppStore((s) => s.threads)
  const projectId = threads.find((thread) => thread.id === activeThreadId)?.projectId ?? null
  const scope = fileWorkspaceScope(profileId, activeThreadId, projectId)
  const workspace = useFileWorkspaceStore((s) => s.workspaces[scope])
  const openFile = useFileWorkspaceStore((s) => s.openFile)
  const activateFile = useFileWorkspaceStore((s) => s.activateFile)
  const closeFileInStore = useFileWorkspaceStore((s) => s.closeFile)
  const deactivateFile = useFileWorkspaceStore((s) => s.deactivateFile)
  const openPaths = workspace?.openPaths ?? []
  const selectedPath = workspace?.activePath ?? null
  const { root: filesRoot } = useFilesRoot()
  const location = useActiveProjectLocation()
  const projects = useAppStore((s) => s.projects)
  // A thread of another computer shows its own folder; so does an app whose main process cannot browse others yet.
  const remote = Boolean(threads.find((thread) => thread.id === activeThreadId)?.node) || typeof window.mousse.fs.listDrives !== 'function'
  // Where the person went in this panel, per thread; a thread they never moved in follows its own folder.
  const navKey = `${profileId}:${activeThreadId ?? '__blank__'}`
  const [navigated, setNavigated] = useState<Record<string, string>>({})
  const [home, setHome] = useState<string | null>(null)
  const [pathEditRequest, setPathEditRequest] = useState(0)
  const threadFolder = remote ? null : location.path
  const browseInput = { threadFolder, threadFolderLoading: location.loading, filesRoot, remote }
  const defaultFolder = filesBrowseRoot({ ...browseInput, navigated: undefined })
  const browseRoot = filesBrowseRoot({ ...browseInput, navigated: navigated[navKey] })
  // The folder the daemon gives the thread is listed by the thread; any other folder is named to it.
  const listRootFor = useCallback((folder: string) => (!folder || samePath(folder, filesRoot) ? undefined : folder), [filesRoot])
  const listRoot = listRootFor(browseRoot)
  /** A workspace path (relative to the thread's folder, or absolute) as the tree names it, or null outside the tree's folder. */
  const treePathOf = useCallback((path: string | null) => {
    if (!path || !browseRoot) return null
    if (!isAbsolutePath(path) && !filesRoot) return null
    return pathInside(isAbsolutePath(path) ? path : absoluteFilesPath(path, filesRoot), browseRoot)
  }, [browseRoot, filesRoot])
  const [files, setFiles] = useState<Record<string, OpenFileState>>({})
  const [preview, setPreview] = useState<Record<string, boolean>>({})
  const [positions, setPositions] = useState<Record<string, { line: number; column: number }>>({})
  /** Source or preview, per Markdown file; it outlives the editor, which unmounts while the panel is hidden. */
  const [markdownViews, setMarkdownViews] = useState<Record<string, MarkdownEditorViewMode>>({})
  const [refreshKey, setRefreshKey] = useState(0)
  const [availableLanguageIds, setAvailableLanguageIds] = useState<Set<string>>(() => new Set(['plaintext']))
  const filesRef = useRef(files)
  const queues = useRef(new Map<string, SerializedAutosave>())
  const saveBlockers = useRef(new Set<string>())
  const loadSequences = useRef(new Map<string, number>())
  const monacoRef = useRef<Monaco | null>(null)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const pendingPosition = useRef<{ path: string; line: number; column: number } | null>(null)
  const previousActiveKey = useRef<string | null>(null)
  const selectedKeyRef = useRef<string | null>(null)
  const openRequestSequence = useRef(0)
  const panelRef = useRef<HTMLDivElement>(null)
  /** A file closed from the tab strip while focus was in it; if it was the last one, the strip goes away too. */
  const closedFromStrip = useRef<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchRequest, setSearchRequest] = useState<FilesSearchOpenRequest>({ mode: 'files', nonce: 0 })
  const searchReturnFocus = useRef<HTMLElement | null>(null)
  const treeMemories = useRef(new FileTreeMemories())
  /** Editor models kept while the editor unmounts (with their undo and view state), by file key. */
  const editorModels = useRef(new Set<string>())

  const openSearch = useCallback((mode: FilesSearchMode) => {
    const active = document.activeElement
    if (active instanceof HTMLElement && !active.closest('.files-search-field')) searchReturnFocus.current = active
    setSearchOpen(true)
    setSearchRequest((current) => ({ mode, nonce: current.nonce + 1 }))
  }, [])
  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    const previous = searchReturnFocus.current
    searchReturnFocus.current = null
    if (previous?.isConnected && !previous.closest('[inert]')) previous.focus()
    else panelRef.current?.querySelector<HTMLElement>('.files-header-title .files-icon-btn')?.focus()
  }, [])
  // Ctrl/Cmd+P and Ctrl/Cmd+Shift+F come through the command registry, which only lets a key typed inside this
  // panel through. The panel stays mounted while another surface shows, so it must also be on screen.
  const panelShowing = useCallback(() => {
    const panel = panelRef.current
    return Boolean(panel) && (typeof panel!.checkVisibility === 'function' ? panel!.checkVisibility() : true)
  }, [])
  useCommand('files.quickOpen', () => openSearch('files'), panelShowing)
  useCommand('files.textSearch', () => openSearch('text'), panelShowing)

  const openSearchedFile = useCallback((path: string, closeAfter: boolean) => {
    openFile(scope, normalizeWorkspacePath(path, filesRoot))
    if (closeAfter) closeSearch()
  }, [closeSearch, filesRoot, openFile, scope])
  const openSearchedLine = useCallback((match: FileGrepMatch) => {
    // The listener below turns the position into a Monaco reveal; the column is UTF-16, as Monaco counts.
    window.dispatchEvent(new CustomEvent('mousse:open-file', { detail: openLineDetail(match, activeThreadId) }))
  }, [activeThreadId])
  // Search looks in the folder the path bar shows: through the project's index when that folder is in it, else by walking it.
  const search = useFilesSearch({
    open: searchOpen, openRequest: searchRequest, scopeKey: scope, projectId, threadId: activeThreadId,
    browseRoot, listRoot, indexRoot: projectId && filesRoot ? filesRoot : null
  })
  const searchRoot = search.state.meta?.root || filesRoot
  // A picked result opens beside the results, which stay for the next pick. Its path is relative to the folder searched.
  const searchHandlers = useMemo(() => ({
    onAction: search.onAction,
    onOpenFile: (path: string) => openSearchedFile(joinFolder(searchRoot, path), false),
    onOpenLine: openSearchedLine,
    onClose: closeSearch
  }), [closeSearch, openSearchedFile, openSearchedLine, search.onAction, searchRoot])
  const searchShowsResults = searchOpen && search.state.query.trim() !== ''

  const fileKey = useCallback((path: string) => `${scope}\0${path}`, [scope])
  const selectedKey = selectedPath ? fileKey(selectedPath) : null
  const selected = selectedKey ? files[selectedKey] : undefined
  selectedKeyRef.current = selectedKey
  const selectedPreview = selectedKey ? (preview[selectedKey] ?? true) : true

  const replaceFiles = useCallback((update: (current: Record<string, OpenFileState>) => Record<string, OpenFileState>) => {
    const next = update(filesRef.current)
    filesRef.current = next
    setFiles(next)
  }, [])

  const patchFile = useCallback((key: string, patch: Partial<OpenFileState> | ((file: OpenFileState) => Partial<OpenFileState>)) => {
    replaceFiles((current) => {
      const file = current[key]
      if (!file) return current
      const update = typeof patch === 'function' ? patch(file) : patch
      return { ...current, [key]: { ...file, ...update } }
    })
  }, [replaceFiles])

  const ensureQueue = useCallback((key: string, path: string, threadId: string | null, ownerProfileId = profileId) => {
    let queue = queues.current.get(key)
    if (queue) return queue
    const isCurrent = () => useAppStore.getState().profileId === ownerProfileId && Boolean(filesRef.current[key])
    queue = new SerializedAutosave({
      read: () => {
        if (useAppStore.getState().profileId !== ownerProfileId) throw new Error('File save belongs to an inactive profile')
        return readText(path, threadId)
      },
      write: (content) => {
        if (useAppStore.getState().profileId !== ownerProfileId) throw new Error('File save belongs to an inactive profile')
        return writeText(path, content, threadId)
      },
      onSaved: (savedContent) => {
        if (!isCurrent()) return
        saveBlockers.current.delete(key)
        patchFile(key, (file) => ({ savedContent, saveState: file.content === savedContent ? 'saved' : 'dirty', error: null }))
      },
      onConflict: (diskContent) => {
        if (!isCurrent()) return
        saveBlockers.current.add(key)
        patchFile(key, { saveState: 'conflict', diskContent, error: 'This file changed on disk. Your edits were kept.' })
      },
      onError: (error) => {
        if (!isCurrent()) return
        saveBlockers.current.add(key)
        patchFile(key, { saveState: 'error', error: `Autosave failed: ${message(error)}` })
      }
    })
    queues.current.set(key, queue)
    return queue
  }, [patchFile, profileId])

  const loadFile = useCallback(async (
    path: string,
    targetScope = scope,
    threadId = activeThreadId,
    ownerProfileId = profileId,
    retryInitial = false
  ) => {
    const key = `${targetScope}\0${path}`
    const existing = filesRef.current[key]
    if (existing?.loading || (existing && !(retryInitial && existing.initialLoadFailed))) return
    const kind = viewKindForPath(path)
    replaceFiles((current) => ({ ...current, [key]: {
      profileId: ownerProfileId, path, threadId, kind, content: '', savedContent: '', binary: false,
      loading: true, saveState: 'saved', error: null, initialLoadFailed: false
    } }))
    const sequence = (loadSequences.current.get(key) ?? 0) + 1
    loadSequences.current.set(key, sequence)
    try {
      if (isAssetView(kind)) {
        const asset = await readAssetAt(path, threadId)
        if (loadSequences.current.get(key) !== sequence) return
        const bytes = Uint8Array.from(asset.data)
        const assetUrl = URL.createObjectURL(new Blob([bytes.buffer], { type: asset.mimeType }))
        if (useAppStore.getState().profileId !== ownerProfileId) { URL.revokeObjectURL(assetUrl); return }
        patchFile(key, { loading: false, binary: true, assetUrl, assetSignature: assetSignature(asset.data, asset.mimeType), initialLoadFailed: false })
      } else {
        const content = await readText(path, threadId)
        if (loadSequences.current.get(key) !== sequence) return
        const binary = isBinaryContent(content)
        if (useAppStore.getState().profileId !== ownerProfileId) return
        patchFile(key, { loading: false, binary, content: binary ? '' : content, savedContent: binary ? '' : content, initialLoadFailed: false })
        if (!binary) ensureQueue(key, path, threadId, ownerProfileId)
      }
    } catch (error) {
      if (loadSequences.current.get(key) === sequence && useAppStore.getState().profileId === ownerProfileId) {
        patchFile(key, { loading: false, error: message(error), saveState: 'error', initialLoadFailed: true })
      }
    }
  }, [activeThreadId, ensureQueue, patchFile, profileId, replaceFiles, scope])

  useEffect(() => {
    for (const path of openPaths) void loadFile(path)
  }, [loadFile, openPaths])

  const flushPath = useCallback(async (key: string | null) => {
    if (!key) return
    const file = filesRef.current[key]
    if (!file || file.profileId !== useAppStore.getState().profileId || file.saveState === 'conflict' || file.initialLoadFailed || file.binary || file.loading) return
    const queue = queues.current.get(key) ?? ensureQueue(key, file.path, file.threadId, file.profileId)
    if (file.content !== file.savedContent) {
      saveBlockers.current.delete(key)
      patchFile(key, { saveState: 'saving', error: null })
      queue.schedule({ content: file.content, baseline: file.savedContent })
    }
    await queue.flush()
  }, [ensureQueue, patchFile])

  useEffect(() => {
    const previous = previousActiveKey.current
    previousActiveKey.current = selectedKey
    if (previous && previous !== selectedKey) void flushPath(previous)
  }, [flushPath, selectedKey])

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (useAppStore.getState().profileId !== profileId) return
      for (const path of openPaths) {
        const key = fileKey(path)
        const file = filesRef.current[key]
        const queue = queues.current.get(key)
        if (!file || file.loading || file.initialLoadFailed || file.saveState === 'saving' || file.saveState === 'conflict' || queue?.isBusy()) continue
        const sequence = loadSequences.current.get(key) ?? 0
        const pollProfileId = profileId
        if (isAssetView(file.kind)) {
          void readAssetAt(path, file.threadId).then((asset) => {
            const current = filesRef.current[key]
            const signature = assetSignature(asset.data, asset.mimeType)
            if (!current || loadSequences.current.get(key) !== sequence || useAppStore.getState().profileId !== pollProfileId) return
            if (current.refreshFailed) patchFile(key, refreshRecovered(current))
            if (current.assetSignature === signature) return
            const bytes = Uint8Array.from(asset.data)
            const url = URL.createObjectURL(new Blob([bytes.buffer], { type: asset.mimeType }))
            if (current.assetUrl) URL.revokeObjectURL(current.assetUrl)
            patchFile(key, { assetUrl: url, assetSignature: signature, error: null })
          }).catch((error) => {
            if (filesRef.current[key] && useAppStore.getState().profileId === pollProfileId) patchFile(key, { error: `Refresh failed: ${message(error)}`, refreshFailed: true })
          })
          continue
        }
        if (file.binary) continue
        const savedAtReadStart = file.savedContent
        void readText(path, file.threadId).then((diskContent) => {
          const current = filesRef.current[key]
          // A save completed after this read began; its result is newer than this poll.
          if (!current || loadSequences.current.get(key) !== sequence || useAppStore.getState().profileId !== pollProfileId || current.savedContent !== savedAtReadStart || queues.current.get(key)?.isBusy()) return
          if (current.refreshFailed) patchFile(key, refreshRecovered(current))
          const result = reconcileExternalContent(current.savedContent, current.content, diskContent)
          if (result.kind === 'replace') patchFile(key, { content: result.content, savedContent: result.content, error: null, saveState: 'saved' })
          if (result.kind === 'conflict') {
            queues.current.get(key)?.cancel()
            saveBlockers.current.add(key)
            patchFile(key, { diskContent: result.diskContent, saveState: 'conflict', error: 'This file changed on disk. Your edits were kept.', refreshFailed: false })
          }
        }).catch((error) => {
          if (filesRef.current[key] && useAppStore.getState().profileId === pollProfileId) patchFile(key, { error: `Refresh failed: ${message(error)}`, refreshFailed: true })
        })
      }
    }, REVALIDATE_MS)
    return () => window.clearInterval(interval)
  }, [fileKey, openPaths, patchFile, profileId])

  useEffect(() => {
    const onOpenFile = (event: Event) => {
      const detail = (event as CustomEvent<OpenFileDetail>).detail
      if (!detail?.path) return
      void (async () => {
        const store = useAppStore.getState()
        const ownerProfileId = store.profileId
        const requestSequence = ++openRequestSequence.current
        let expectedThreadId = store.activeThreadId
        const stillCurrent = () => {
          const current = useAppStore.getState()
          return current.profileId === ownerProfileId && current.activeThreadId === expectedThreadId && openRequestSequence.current === requestSequence
        }
        const currentProjectId = store.threads.find((thread) => thread.id === store.activeThreadId)?.projectId
        let projectThreadId: string | undefined
        if (!detail.threadId && detail.projectId && detail.projectId !== currentProjectId) {
          const thread = await ensureProjectReferenceThread(detail.projectId, stillCurrent)
          if (!thread || !stillCurrent()) return
          projectThreadId = thread.id
        }
        const targetThreadId = detail.threadId ?? projectThreadId ?? store.activeThreadId
        const targetProjectId = detail.projectId
          ?? useAppStore.getState().threads.find((thread) => thread.id === targetThreadId)?.projectId
          ?? null
        if (targetThreadId && targetThreadId !== store.activeThreadId) {
          expectedThreadId = targetThreadId
          useAppStore.getState().switchToThread(targetThreadId)
          await window.mousse.threads.select(targetThreadId)
          if (!stillCurrent()) return
        }
        const targetRoot = await window.mousse.app.getFilesRoot(targetThreadId)
        if (!stillCurrent()) return
        const path = normalizeWorkspacePath(detail.path, targetRoot)
        const targetScope = fileWorkspaceScope(ownerProfileId, targetThreadId, targetProjectId)
        const currentStore = useAppStore.getState()
        currentStore.openSurfaceKind('files')
        useFileWorkspaceStore.getState().openFile(targetScope, path)
        if (detail.line) {
          const position = { path, line: detail.line, column: detail.column ?? 1 }
          pendingPosition.current = position
          const key = `${targetScope}\0${path}`
          setPositions((current) => ({ ...current, [key]: position }))
          setPreview((current) => ({ ...current, [key]: false }))
        }
        await loadFile(path, targetScope, targetThreadId, ownerProfileId)
      })().catch((error) => console.error('Failed to open file link', error))
    }
    window.addEventListener('mousse:open-file', onOpenFile)
    return () => window.removeEventListener('mousse:open-file', onOpenFile)
  }, [filesRoot, loadFile])

  useEffect(() => {
    const pending = pendingPosition.current
    if (!pending || pending.path !== selectedPath || !editorRef.current) return
    editorRef.current.setPosition({ lineNumber: Math.max(1, pending.line), column: Math.max(1, pending.column) })
    editorRef.current.revealLineInCenter(Math.max(1, pending.line))
    editorRef.current.focus()
    pendingPosition.current = null
  }, [selectedPath, selected?.loading])

  useEffect(() => () => {
    // Profile changes swap the backend behind IPC. Never let a timer created by the
    // previous profile begin a write against the newly active backend.
    const interruptedSaves = new Set(queues.current.keys())
    for (const queue of queues.current.values()) queue.dispose()
    queues.current.clear()
    saveBlockers.current.clear()
    for (const key of loadSequences.current.keys()) {
      loadSequences.current.set(key, (loadSequences.current.get(key) ?? 0) + 1)
    }
    replaceFiles((current) => Object.fromEntries(Object.entries(current).map(([key, file]) => {
      if (file.loading) return [key, { ...file, loading: false, saveState: 'error', error: 'File load was interrupted. Retry to open it.', initialLoadFailed: true }]
      if (interruptedSaves.has(key) && file.content !== file.savedContent && file.saveState !== 'conflict') {
        return [key, { ...file, saveState: 'error', error: 'Save paused when the active profile changed.' }]
      }
      return [key, file]
    })))
  }, [profileId, replaceFiles])

  useEffect(() => () => {
    for (const file of Object.values(filesRef.current)) if (file.assetUrl) URL.revokeObjectURL(file.assetUrl)
  }, [])

  // The editor keeps a file's model when it unmounts; a closed file's model goes with it.
  useEffect(() => {
    setMarkdownViews((views) => {
      const closed = Object.keys(views).filter((key) => !files[key])
      if (closed.length === 0) return views
      const next = { ...views }
      for (const key of closed) delete next[key]
      return next
    })
    const monaco = monacoRef.current
    if (!monaco) return
    if (selectedKey && editorRef.current?.getModel()) editorModels.current.add(selectedKey)
    for (const key of editorModels.current) {
      if (files[key]) continue
      editorModels.current.delete(key)
      monaco.editor.getModel(monaco.Uri.parse(key))?.dispose()
    }
  }, [files, selectedKey])

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
    if (!selectedKey) return
    const current = filesRef.current[selectedKey]
    if (!current || current.loading || current.initialLoadFailed || current.profileId !== useAppStore.getState().profileId) return
    const conflicted = current.saveState === 'conflict'
    patchFile(selectedKey, conflicted
      ? { content: value }
      : { content: value, saveState: current.saveState === 'error' ? 'error' : 'dirty' })
    if (!conflicted) ensureQueue(selectedKey, current.path, current.threadId)
      .schedule({ content: value, baseline: current.savedContent })
  }, [ensureQueue, patchFile, selectedKey])

  /** Closes a file once its edits are saved. Resolves false, leaving it open, while it has unsaved edits or a conflict. */
  const closeTab = useCallback(async (path: string): Promise<boolean> => {
    const key = fileKey(path)
    await flushPath(key)
    const current = filesRef.current[key]
    if (saveBlockers.current.has(key) || (current && (current.content !== current.savedContent || current.saveState === 'conflict'))) return false
    loadSequences.current.set(key, (loadSequences.current.get(key) ?? 0) + 1)
    queues.current.get(key)?.dispose()
    queues.current.delete(key)
    saveBlockers.current.delete(key)
    if (current?.assetUrl) URL.revokeObjectURL(current.assetUrl)
    replaceFiles((all) => { const next = { ...all }; delete next[key]; return next })
    if (panelRef.current?.querySelector('.files-editor-toolbar > .ui-tabs')?.contains(document.activeElement)) closedFromStrip.current = path
    closeFileInStore(scope, path)
    return true
  }, [closeFileInStore, fileKey, flushPath, replaceFiles, scope])

  /**
   * Puts focus on the file's row in the tree, or on the first drawn row when the tree does not show it. The tree draws
   * only the rows on screen, so a row scrolled away is brought back first.
   */
  const focusTreeRow = useCallback((path: string) => {
    const panel = panelRef.current
    const treePath = treePathOf(path)
    const rows = [...(panel?.querySelectorAll<HTMLElement>('.file-tree-row') ?? [])]
    const drawn = rows.find((element) => element.dataset.path === treePath)
    if (drawn) { drawn.focus(); return }
    if (treePath && treeMemories.current.get(`${navKey}|${browseRoot}`).requestFocus(treePath)) return
    rows[0]?.focus()
  }, [browseRoot, navKey, treePathOf])

  // With other files open the strip moves focus to the next tab. Closing the last one removes the strip and
  // the preview, so focus goes to the closed file's row in the tree.
  useLayoutEffect(() => {
    const closed = closedFromStrip.current
    closedFromStrip.current = null
    if (!closed || openPaths.length > 0) return
    focusTreeRow(closed)
  }, [focusTreeRow, openPaths.length])

  /** Hides the preview; the tree takes the width back and its row of the file takes focus. */
  const previewClosedFrom = useRef<string | null>(null)
  const closePreview = useCallback(() => {
    previewClosedFrom.current = selectedPath
    deactivateFile(scope)
  }, [deactivateFile, scope, selectedPath])
  useLayoutEffect(() => {
    const closed = previewClosedFrom.current
    if (!closed || selectedPath) return
    previewClosedFrom.current = null
    focusTreeRow(closed)
  }, [focusTreeRow, selectedPath])

  const navigate = useCallback(async (target: string): Promise<string | null> => {
    const folder = normalizeFolderPath(target)
    try {
      await window.mousse.fs.listDir('', undefined, activeThreadId, listRootFor(folder))
    } catch (error) {
      return message(error)
    }
    setNavigated((current) => {
      const next = { ...current }
      if (samePath(folder, defaultFolder)) delete next[navKey]
      else next[navKey] = folder
      return next
    })
    return null
  }, [activeThreadId, defaultFolder, listRootFor, navKey])

  const loadDrives = useCallback(async (): Promise<FilesPlaceItem[]> => {
    const places = await window.mousse.fs.listDrives()
    setHome(places.home)
    // A volume name is shown when the service sends one (`volume`); the letter alone otherwise.
    return places.drives.map((drive) => {
      const { volume } = drive
      return { kind: 'drive', label: drive.label, path: drive.path, ...(typeof volume === 'string' && volume ? { detail: volume } : {}) }
    })
  }, [])

  const navigateTyped = useCallback(async (text: string): Promise<string | null> => {
    let homeFolder = home
    if (!homeFolder && text.trim().startsWith('~')) {
      homeFolder = (await window.mousse.fs.listDrives().catch(() => null))?.home ?? null
      if (homeFolder) setHome(homeFolder)
    }
    const target = resolveTypedPath(text, browseRoot, homeFolder)
    return target ? navigate(target) : 'Type a folder path'
  }, [browseRoot, home, navigate])

  const projectFolder = projects.find((project) => project.id === (location.projectId ?? projectId))?.path ?? null
  const quickPlaces = useMemo(() => {
    const places: FilesPlaceItem[] = []
    if (threadFolder) places.push({ kind: 'thread', label: 'Thread folder', path: threadFolder })
    if (projectFolder && !samePath(projectFolder, threadFolder)) places.push({ kind: 'project', label: 'Project folder', path: projectFolder })
    // A thread without a folder shows home; the daemon names it.
    const homeFolder = home ?? (!threadFolder && !location.loading ? filesRoot : null)
    if (homeFolder && !places.some((place) => samePath(place.path, homeFolder))) places.push({ kind: 'home', label: 'Home', path: homeFolder })
    return places
  }, [filesRoot, home, location.loading, projectFolder, threadFolder])

  const beforeMount: BeforeMount = (monaco) => {
    monacoRef.current = monaco
    setAvailableLanguageIds(new Set(monaco.languages.getLanguages().map((language) => language.id)))
    applyEditorTheme(monaco)
  }
  const onMount: OnMount = (instance, monaco) => {
    editorRef.current = instance
    monacoRef.current = monaco
    applyEditorTheme(monaco)
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void flushPath(selectedKeyRef.current))
    // A kept model missed changes read from disk while the editor was away: take them, as one undoable edit.
    const key = selectedKeyRef.current
    const model = instance.getModel()
    const content = key ? filesRef.current[key]?.content : undefined
    if (key) editorModels.current.add(key)
    if (model && content !== undefined && model.getValue() !== content) {
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null)
    }
    const pending = pendingPosition.current
    if (pending?.path === selectedPath) {
      instance.setPosition({ lineNumber: Math.max(1, pending.line), column: Math.max(1, pending.column) })
      instance.revealLineInCenter(Math.max(1, pending.line)); instance.focus(); pendingPosition.current = null
    }
  }

  const onMarkdownMount: OnMount = (_instance, monaco) => {
    monacoRef.current = monaco
    if (selectedKeyRef.current) editorModels.current.add(selectedKeyRef.current)
  }

  // A saved file says nothing; only a state that needs attention or is in progress shows.
  const saveLabel = useMemo(() => {
    if (!selected || selected.loading) return ''
    if (selected.saveState === 'saving') return 'Saving…'
    if (selected.saveState === 'dirty') return 'Autosave pending'
    if (selected.saveState === 'conflict') return 'Conflict'
    if (selected.saveState === 'error') return 'Save error'
    return ''
  }, [selected])

  const supportsPreview = selected?.kind === 'html'

  if (!showing) return null

  return (
    <div className="files-panel" ref={panelRef} onKeyDown={(event) => {
      if (event.altKey || typingTarget(event.target)) return
      const command = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      // Ctrl+F, or `/` in the tree, searches file names, as in a file manager.
      if ((command && !event.shiftKey && key === 'f') || (!command && event.key === '/' && (event.target as HTMLElement).closest?.('.file-tree'))) {
        event.preventDefault()
        openSearch('files')
        return
      }
      // Ctrl+L edits the folder path as text, as a file manager's address bar does.
      if (remote || event.shiftKey || !command || key !== 'l') return
      event.preventDefault()
      setPathEditRequest((request) => request + 1)
    }}>
      {/* Until a file is picked the tree has the whole panel; the preview takes the saved split width back. */}
      <ResizablePanelSidebar className="files-sidebar" defaultWidth={260} fill={!selectedPath}>
        <div className="files-sidebar-body">
        {/* The title and the search field share the row: one fades and slides out as the other comes in. */}
        <div className={`panel-toolbar files-header${searchOpen ? ' searching' : ''}`}>
          <div className="files-header-layer files-header-title" inert={searchOpen}>
            <span className="panel-toolbar-label">Explorer</span>
            <div className="files-toolbar-actions">
              <button type="button" className="files-icon-btn" aria-label="Search files" title="Search files (Ctrl+F)"
                onClick={() => openSearch('files')}><Search size={14} strokeWidth={2} /></button>
              <FileTreeToolbar onRefresh={() => setRefreshKey((key) => key + 1)} />
            </div>
          </div>
          <div className="files-header-layer files-header-search" inert={!searchOpen}>
            <FilesSearchField state={search.state} inputRef={search.inputRef} {...searchHandlers} />
            <button type="button" className="files-icon-btn" aria-label="Close search" title="Close search (Esc)"
              onClick={closeSearch}><X size={14} strokeWidth={2} /></button>
          </div>
        </div>
        {searchShowsResults && <FilesSearchResults state={search.state} onAction={searchHandlers.onAction}
          onOpenFile={searchHandlers.onOpenFile} onOpenLine={searchHandlers.onOpenLine} />}
        {/* Hidden, not unmounted, while results show: the tree keeps its open folders. */}
        <div className="files-browse" hidden={searchShowsResults}>
          {browseRoot && <FilesPathBar path={browseRoot} canBrowse={!remote} quickPlaces={quickPlaces} loadDrives={loadDrives}
            onNavigate={navigate} onNavigateTyped={navigateTyped} editRequest={pathEditRequest} />}
          <FileTree key={`${navKey}|${browseRoot}`} memory={treeMemories.current.get(`${navKey}|${browseRoot}`)} filesRoot={browseRoot} listRoot={listRoot} threadId={activeThreadId}
            selectedPath={treePathOf(selectedPath)} refreshKey={refreshKey}
            onSelectFile={(path) => openFile(scope, normalizeWorkspacePath(joinFolder(browseRoot, path), filesRoot))} />
        </div>
        </div>
      </ResizablePanelSidebar>
      {selectedPath && <div className="files-editor" role="region" aria-label={selectedPath} onKeyDown={(event) => {
        // Escape closes the preview, except where a text field or the code editor uses it.
        if (event.key !== 'Escape' || event.defaultPrevented || typingTarget(event.target)) return
        event.preventDefault()
        closePreview()
      }}>
        {/* The tab names the file (its tooltip has the full path), so the file's controls sit at the end of the tab row. */}
        <div className="files-editor-toolbar">
        {openPaths.length > 0 && <TabBar
          label="Open files"
          activeId={selectedPath}
          tabs={openPaths.map((path) => {
            const file = files[fileKey(path)]
            const dirty = Boolean(file && file.content !== file.savedContent)
            return { id: path, name: basename(path), title: dirty ? `${path} (unsaved)` : path, label: `${basename(path)}${dirty ? ' •' : ''}` }
          })}
          onSelect={(path) => activateFile(scope, path)}
          onClose={closeTab}
          onDragStart={(path, event) => {
            setReferenceDragData(event.dataTransfer, filesEntryReference({ path, name: basename(path), kind: 'file', filesRoot, threadId: activeThreadId, projectId }))
            event.dataTransfer.setData('text/plain', path)
          }}
        />}
          <div className="files-toolbar-actions">
            {supportsPreview && <div className="files-view-toggle" role="group" aria-label="File view">
              <button type="button" className={`btn btn-sm ${!selectedPreview ? 'active' : ''}`} onClick={() => selectedKey && setPreview((state) => ({ ...state, [selectedKey]: false }))}><Pencil size={13} /> Edit</button>
              <button type="button" className={`btn btn-sm ${selectedPreview ? 'active' : ''}`} onClick={() => selectedKey && setPreview((state) => ({ ...state, [selectedKey]: true }))}><Eye size={13} /> Preview</button>
            </div>}
            {saveLabel && selected && <span className={`files-save-status ${selected.saveState}`}>{saveLabel}</span>}
            <button type="button" className="files-icon-btn" aria-label="Close preview" title="Close preview (Esc)"
              onClick={closePreview}><X size={14} strokeWidth={2} /></button>
          </div>
        </div>
        {selected?.error && <div className={`panel-error ${selected.saveState === 'conflict' ? 'files-conflict' : ''}`}>
          {selected.saveState === 'conflict' && <AlertTriangle size={15} />}{selected.error}
          {selected.initialLoadFailed && selectedKey && <div className="files-conflict-actions">
            <button className="btn btn-sm" type="button" onClick={() => void loadFile(selected.path, scope, selected.threadId, profileId, true)}>Retry open</button>
          </div>}
          {selected.saveState === 'error' && !selected.initialLoadFailed && selectedKey && <div className="files-conflict-actions">
            <button className="btn btn-sm" type="button" onClick={() => void flushPath(selectedKey)}>Retry save</button>
          </div>}
          {selected.saveState === 'conflict' && <div className="files-conflict-actions">
            <button className="btn btn-sm" type="button" onClick={() => {
              if (!selectedKey || selected.diskContent === undefined) return
              saveBlockers.current.delete(selectedKey)
              queues.current.get(selectedKey)?.cancel()
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
        {selected?.loading ? <DelayedLoader label={`Opening ${basename(selected.path)}`} className="files-editor-loader" />
          : selected?.initialLoadFailed ? <div className="files-editor-empty">Unable to read this file. Use Retry open above.</div>
          : selected && selected.kind === 'pdf' && selected.assetUrl ? <iframe className="files-asset-preview files-pdf-preview" src={selected.assetUrl} title={`PDF preview: ${selected.path}`} />
          : selected && selected.kind === 'image' && selected.assetUrl ? <div className="files-asset-preview"><img src={selected.assetUrl} alt={selected.path} /></div>
          : selected && selected.kind === 'video' && selected.assetUrl ? <div className="files-asset-preview"><video src={selected.assetUrl} controls /></div>
          : selected?.binary ? <div className="files-editor-empty">Binary files cannot be edited.</div>
          : selected && selected.kind === 'markdown' && !(selectedKey && positions[selectedKey]) ? <MarkdownDocumentEditor key={selectedKey} path={selectedKey ?? selected.path} keepModel value={selected.content} onChange={updateContent} onSave={() => void flushPath(selectedKey)} onEditorMount={onMarkdownMount} viewMode={(selectedKey && markdownViews[selectedKey]) || 'preview'} onViewModeChange={(mode) => selectedKey && setMarkdownViews((views) => ({ ...views, [selectedKey]: mode }))} aria-label={selected.path} />
          : selected && selected.kind === 'html' && selectedPreview ? <iframe className="files-asset-preview files-html-preview" srcDoc={selected.content} sandbox="" title={`HTML preview: ${selected.path}`} />
          : selected ? <div className="files-monaco-editor"><Editor path={selectedKey ?? selected.path} value={selected.content} language={languageForPath(selected.path, availableLanguageIds)} theme={MOUSSE_EDITOR_THEME} keepCurrentModel beforeMount={beforeMount} onMount={onMount} onChange={(value) => updateContent(value ?? '')} options={{ automaticLayout: true, bracketPairColorization: { enabled: true }, matchBrackets: 'always', minimap: { enabled: true }, lineNumbers: 'on', scrollBeyondLastLine: false, fontFamily: codeFont, ariaLabel: selected.path, fontSize: 13, tabSize: 2, detectIndentation: true, wordWrap: 'off' }} /></div>
          : <DelayedLoader label={`Opening ${basename(selectedPath)}`} className="files-editor-loader" />}
      </div>}
    </div>
  )
}
