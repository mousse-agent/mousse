import { publishMarkdownPreviews } from '../readAloud/markdownFileSpeech'
import { registerFileTabCloser, setFileTabDirtyPaths } from '../services/fileTabs'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Editor, { type BeforeMount, type OnMount } from '@monaco-editor/react'
import type { Monaco } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { AlertTriangle, ArrowShrink, ChevronRight, Code2, Eye, Maximize, Search, WrapText, X } from '../lib/icons'
import { profilePreferenceKey } from '../lib/profilePreferences'
import { useCommand } from '../commands/commandRegistry'
import { useFilesRoot } from '../hooks/useActiveProjectPath'
import { isNewEmptyThread, localWorkspaceFor } from '../lib/newThread'
import type { FileGrepMatch, FileText } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { selectOrSettle } from '../lib/threadActions'
import { registerAutosaveFlush } from '../services/reloadWindow'
import { registerFileLinkOpener } from '../services/fileLinks'
import { useMonacoCodeFont } from '../lib/monacoCodeFont'
import { fileTabTarget, fileWorkspaceScope, useFileWorkspaceStore, type FileTabTarget } from '../stores/filesStore'
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
import { DelayedLoader } from './ui/DelayedLoader'
import { showToast } from './ui/Toast'
import './filesPanel.css'

const REVALIDATE_MS = 2_000

type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'

interface OpenFileState {
  profileId: string
  path: string
  target: FileTabTarget
  canonicalPath?: string
  threadId: string | null
  kind: FileViewKind
  content: string
  savedContent: string
  workspaceRoot?: string
  binary: boolean
  loading: boolean
  saveState: SaveState
  error: string | null
  diskContent?: string
  initialLoadFailed?: boolean
  /** The last background refresh failed: `error` says so until a refresh reads the file again. */
  refreshFailed?: boolean
  assetUrl?: string
  /** True when `assetUrl` is a streamed `mousse-media://` handle (released via IPC, not `URL.revokeObjectURL`). */
  assetIsMediaUrl?: boolean
  /** Size and write time from `fs:assetStamp` / `fs:openMediaUrl` / `fs:readAsset`, avoiding whole-file re-reads on poll. */
  assetStamp?: string
  assetSignature?: string
}

interface OpenFileDetail {
  path: string
  line?: number
  column?: number
  threadId?: string
  projectId?: string
}

function lacksWorkspaceBinding(file: OpenFileState): boolean {
  return Boolean(file.threadId && !file.workspaceRoot && !file.target.root)
}

function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path
}

function comparableFilePath(path: string): string {
  return normalizeFolderPath(path).replace(/\\/g, '/')
}

function logicalFilePath(target: FileTabTarget): string {
  return target.root ? joinFolder(target.root, target.path) : target.path
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A refresh read the file again after one failed: its error goes, unless a failed save shows its own. */
function refreshRecovered(file: OpenFileState): Partial<OpenFileState> {
  return file.saveState === 'error' ? { refreshFailed: false } : { refreshFailed: false, error: null }
}

// A thread's own file is read from the workspace it was opened in, which the service names (`workspaceRoot`): a later
// read or save names it back and is refused once the thread works in another folder. A browsed folder's file is read there.
async function readText(target: FileTabTarget, threadId: string | null, expectedRoot?: string, details = false): Promise<FileText & { workspaceRoot?: string }> {
  if (threadId && !target.root) return window.mousse.fs.readFileInWorkspace(target.path, threadId, expectedRoot)
  if (details && typeof window.mousse.fs.readFileDetails === 'function') return window.mousse.fs.readFileDetails(target.path, undefined, threadId, target.root)
  return { content: await window.mousse.fs.readFile(target.path, undefined, threadId, target.root) }
}
function readAssetAt(target: FileTabTarget, threadId: string | null, details?: boolean) {
  return details
    ? window.mousse.fs.readAsset(target.path, undefined, threadId, target.root, true)
    : window.mousse.fs.readAsset(target.path, undefined, threadId, target.root)
}
function assetStampAt(target: FileTabTarget, threadId: string | null) {
  return window.mousse.fs.assetStamp(target.path, undefined, threadId, target.root)
}
function openMediaAt(target: FileTabTarget, threadId: string | null, details?: boolean) {
  return details
    ? window.mousse.fs.openMediaUrl(target.path, undefined, threadId, target.root, true)
    : window.mousse.fs.openMediaUrl(target.path, undefined, threadId, target.root)
}
function releaseAssetUrl(url: string | undefined, isMediaUrl?: boolean): void {
  if (!url) return
  if (isMediaUrl) {
    void window.mousse.fs.releaseMediaUrl?.(url)?.catch(() => undefined)
    return
  }
  URL.revokeObjectURL(url)
}
function assetStampKey(info: { size: number; mtimeMs?: number }): string {
  return typeof info.mtimeMs === 'number' ? `${info.size}:${info.mtimeMs}` : `size:${info.size}`
}
function assetBlobUrl(data: Uint8Array | ArrayLike<number>, mimeType: string): string {
  const bytes = data instanceof Uint8Array
    ? (data.buffer instanceof ArrayBuffer
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data))
    : Uint8Array.from(data)
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }))
}
function writeText(target: FileTabTarget, content: string, threadId: string | null, expectedRoot?: string): Promise<void> {
  return window.mousse.fs.writeFile(target.path, content, undefined, threadId, target.root, expectedRoot)
}

/** An explicit browse can name its own folder even while the checkout lookup fails. */
function pickedFileTarget(path: string, checkout: string | null, fromBrowsedFolder = false): FileTabTarget | undefined {
  if (checkout === null) return fileLocation(path)
  if (!checkout) return fromBrowsedFolder ? fileLocation(path) : undefined
  if (!isAbsolutePath(path)) return { path: joinFolder(checkout, path) }
  return pathInside(path, checkout) === null ? fileLocation(path) : { path }
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

/** An on/off choice kept in this computer's storage under `key`; a new key reads its own stored value. */
function useStoredFlag(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const [chosen, setChosen] = useState<Record<string, boolean>>({})
  const stored = window.localStorage.getItem(key)
  const value = chosen[key] ?? (stored === null ? fallback : stored === '1')
  const set = useCallback((next: boolean) => {
    window.localStorage.setItem(key, next ? '1' : '0')
    setChosen((current) => ({ ...current, [key]: next }))
  }, [key])
  return [value, set]
}

/** The folders and name of an open file, from the thread's folder name down; an absolute path is named in full. */
export function fileCrumbs(path: string, filesRoot: string): string[] {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  if (isAbsolutePath(path)) return parts
  const rootName = filesRoot ? basename(filesRoot.replace(/[\\/]+$/, '')) : ''
  return rootName ? [rootName, ...parts] : parts
}

/** A small icon button of the file bar; `pressed` makes it an on/off toggle. */
function BarButton({ label, shortcut, pressed, onClick, children }: {
  label: string
  shortcut?: string
  pressed?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return <button type="button" className="files-icon-btn" aria-label={label} title={shortcut ? `${label} (${shortcut})` : label}
    aria-pressed={pressed} onClick={onClick}>{children}</button>
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
  const thread = useAppStore((s) => s.threads.find((thread) => thread.id === s.activeThreadId))
  const projectId = thread?.projectId ?? null
  const projects = useAppStore((s) => s.projects)
  const draft = useAppStore((s) => s.composerWorkspaceDrafts[s.activeThreadId ?? '__blank__'])
  const isNew = useAppStore((s) => isNewEmptyThread(s.activeThreadId, thread, s.messages.length))
  const draftWorkspace = isNew ? localWorkspaceFor(draft, thread, projects) : undefined
  const draftProjectId = draftWorkspace?.projectId
  const draftWorktree = Boolean(draftProjectId && draftWorkspace?.worktreeEnabled)
  const projectFolder = projects.find((project) => project.id === (draftProjectId ?? projectId))?.path ?? null
  const scope = fileWorkspaceScope(profileId, activeThreadId, projectId)
  const workspace = useFileWorkspaceStore((s) => s.workspaces[scope])
  const openFile = useFileWorkspaceStore((s) => s.openFile)
  const closeFileInStore = useFileWorkspaceStore((s) => s.closeFile)
  const deactivateFile = useFileWorkspaceStore((s) => s.deactivateFile)
  const openPaths = workspace?.openPaths ?? []
  const selectedPath = workspace?.activePath ?? null
  const { root: filesRoot, loading: filesRootLoading, unavailable: filesRootUnavailable } = useFilesRoot()
  // A thread of another computer shows its own folder; so does an app whose main process cannot browse others yet.
  const remote = Boolean(thread?.node) || typeof window.mousse.fs.listDrives !== 'function'
  // Where the person went in this panel, per thread; a thread they never moved in follows its own folder.
  const navKey = `${profileId}:${activeThreadId ?? '__blank__'}`
  const [navigated, setNavigated] = useState<Record<string, string>>({})
  const [home, setHome] = useState<string | null>(null)
  const [pathEditRequest, setPathEditRequest] = useState(0)
  const draftFolder = draftProjectId && !draftWorktree ? projectFolder : null
  const threadFolder = remote ? null : draftFolder ?? (projectId && filesRoot ? filesRoot : null)
  const browseInput = { threadFolder, threadFolderLoading: draftWorktree, filesRoot, remote }
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
  /** The file tree beside an open file. Off by default: the file gets the panel's whole width. */
  const [wordWrap, setWordWrap] = useStoredFlag(profilePreferenceKey(profileId, 'mousse:files-word-wrap'), true)
  /** Images show at their own size instead of fitted to the panel. */
  const [imageActualSize, setImageActualSize] = useState(false)
  const [imageSizes, setImageSizes] = useState<Record<string, { width: number; height: number }>>({})
  useEffect(() => {
    const previews: Record<string, string> = {}
    for (const path of openPaths) {
      const key = `${scope}\0${path}`
      const file = files[key]
      if (file?.kind === 'markdown' && !file.loading && !file.binary && !file.initialLoadFailed && !positions[key] && (markdownViews[key] ?? 'preview') === 'preview') previews[path] = file.content
    }
    publishMarkdownPreviews(scope, previews)
  }, [scope, openPaths, files, markdownViews, positions])
  useEffect(() => () => publishMarkdownPreviews(scope, {}), [scope])

  const [refreshKey, setRefreshKey] = useState(0)
  const [availableLanguageIds, setAvailableLanguageIds] = useState<Set<string>>(() => new Set(['plaintext']))
  const filesRef = useRef(files)
  const queues = useRef(new Map<string, SerializedAutosave>())
  const saveBlockers = useRef(new Set<string>())
  const loadSequences = useRef(new Map<string, number>())
  const revalidating = useRef(new Set<string>())
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

  const fileKey = useCallback((path: string) => `${scope}\0${path}`, [scope])
  const tabPathFor = useCallback((file: string, root: string, targetScope: string, localProject: boolean) => {
    if (!localProject) return normalizeWorkspacePath(file, root)
    const path = normalizeWorkspacePath(file)
    if (!root && !isAbsolutePath(path)) return path
    const absolute = isAbsolutePath(path) ? path : joinFolder(root, path)
    if (!isAbsolutePath(path) && pathInside(absolute, root) === null) return path
    const comparable = comparableFilePath(absolute)
    // Older workspaces can still have a relative tab. Reuse it only if it points at this checkout.
    const workspace = useFileWorkspaceStore.getState().workspaces[targetScope]
    return workspace?.openPaths.find((openPath) => {
      const target = filesRef.current[`${targetScope}\0${openPath}`]?.target ?? fileTabTarget(workspace, openPath)
      const location = isAbsolutePath(openPath) ? openPath : target ? logicalFilePath(target) : root ? joinFolder(root, openPath) : openPath
      return comparableFilePath(location) === comparable
    }) ?? absolute
  }, [])
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

  const ensureQueue = useCallback((key: string, target: FileTabTarget, threadId: string | null, ownerProfileId = profileId) => {
    let queue = queues.current.get(key)
    if (queue) return queue
    const isCurrent = () => useAppStore.getState().profileId === ownerProfileId && Boolean(filesRef.current[key])
    // A pick from the browser can update the tab's target. Each save uses one target for both its check and its write.
    let saveTarget = target
    queue = new SerializedAutosave({
      read: () => {
        if (useAppStore.getState().profileId !== ownerProfileId) throw new Error('File save belongs to an inactive profile')
        saveTarget = filesRef.current[key]?.target ?? target
        return readText(saveTarget, threadId, filesRef.current[key]?.workspaceRoot).then((file) => file.content)
      },
      write: (content) => {
        if (useAppStore.getState().profileId !== ownerProfileId) throw new Error('File save belongs to an inactive profile')
        return writeText(saveTarget, content, threadId, filesRef.current[key]?.workspaceRoot)
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
    retryInitial = false,
    workspaceRoot: string | null = !remote && projectId ? filesRoot : null
  ) => {
    const key = `${targetScope}\0${path}`
    const existing = filesRef.current[key]
    const workspaceStore = useFileWorkspaceStore.getState()
    const savedTarget = fileTabTarget(workspaceStore.workspaces[targetScope], path)
    if (existing) {
      if (savedTarget?.root && !existing.target.root) {
        if (!existing.loading && !existing.initialLoadFailed) {
          // Keep the editor and its edits, and invalidate any refresh still using the old scope.
          loadSequences.current.set(key, (loadSequences.current.get(key) ?? 0) + 1)
          patchFile(key, { target: savedTarget })
          return
        }
      } else if (existing.loading || !(retryInitial && existing.initialLoadFailed)) return
    }
    // A checkout tab keeps its absolute path in a thread-scoped request. An older snapshot with
    // only a path cannot prove that it was browsed, so keep its access scoped to the thread too.
    if (workspaceRoot === '' && !savedTarget?.root && !existing) return
    const target = savedTarget ?? existing?.target ?? (workspaceRoot
      ? { path: isAbsolutePath(path) ? path : joinFolder(workspaceRoot, path) }
      : fileLocation(path))
    if (!savedTarget) workspaceStore.rememberTarget(targetScope, path, target)
    const kind = viewKindForPath(path)
    replaceFiles((current) => ({ ...current, [key]: {
      profileId: ownerProfileId, path, target, threadId, kind, content: '', savedContent: '', binary: false,
      loading: true, saveState: 'saved', error: null, initialLoadFailed: false
    } }))
    const sequence = (loadSequences.current.get(key) ?? 0) + 1
    loadSequences.current.set(key, sequence)
    const finish = (canonicalPath: string | undefined, patch: Partial<OpenFileState>) => {
      if (loadSequences.current.get(key) !== sequence || useAppStore.getState().profileId !== ownerProfileId) return false
      const store = useFileWorkspaceStore.getState()
      const workspace = store.workspaces[targetScope]
      const logicalPath = comparableFilePath(logicalFilePath(target)).toLowerCase()
      const alias = canonicalPath && workspace?.openPaths.find((openPath) => {
        const file = filesRef.current[`${targetScope}\0${openPath}`]
        return openPath !== path && file?.canonicalPath === canonicalPath
          && Boolean(file.target.root) === Boolean(target.root)
          && comparableFilePath(logicalFilePath(file.target)).toLowerCase() === logicalPath
      })
      if (alias) {
        const aliasKey = `${targetScope}\0${alias}`
        if (workspace?.activePath === path && pendingPosition.current?.path === path) {
          const position = { ...pendingPosition.current, path: alias }
          pendingPosition.current = position
          setPositions((current) => ({ ...current, [aliasKey]: position }))
          setPreview((current) => ({ ...current, [aliasKey]: false }))
        }
        store.mergeFileAlias(targetScope, path, alias)
        replaceFiles(({ [key]: _removed, ...rest }) => rest)
        return false
      }
      patchFile(key, { canonicalPath, ...patch })
      return true
    }
    try {
      if (kind === 'video' && typeof window.mousse.fs.openMediaUrl === 'function') {
        const media = await openMediaAt(target, threadId, true)
        if (!finish(media.canonicalPath, {
          loading: false,
          binary: true,
          assetUrl: media.url,
          assetIsMediaUrl: true,
          assetStamp: assetStampKey(media),
          initialLoadFailed: false
        })) {
          releaseAssetUrl(media.url, true)
        }
      } else if (isAssetView(kind)) {
        const asset = await readAssetAt(target, threadId, true)
        const assetUrl = assetBlobUrl(asset.data, asset.mimeType)
        if (!finish(asset.canonicalPath, {
          loading: false,
          binary: true,
          assetUrl,
          assetIsMediaUrl: false,
          assetStamp: typeof asset.size === 'number' ? assetStampKey(asset) : undefined,
          assetSignature: assetSignature(asset.data, asset.mimeType),
          initialLoadFailed: false
        })) {
          releaseAssetUrl(assetUrl, false)
        }
      } else {
        const { content, canonicalPath, workspaceRoot: boundRoot } = await readText(target, threadId, undefined, true)
        const binary = isBinaryContent(content)
        const loaded = finish(canonicalPath, { loading: false, binary, workspaceRoot: boundRoot, content: binary ? '' : content, savedContent: binary ? '' : content, initialLoadFailed: false })
        if (loaded && !binary) ensureQueue(key, target, threadId, ownerProfileId)
      }
    } catch (error) {
      if (loadSequences.current.get(key) === sequence && useAppStore.getState().profileId === ownerProfileId) {
        patchFile(key, { loading: false, error: message(error), saveState: 'error', initialLoadFailed: true })
      }
    }
  }, [activeThreadId, ensureQueue, filesRoot, patchFile, profileId, projectId, remote, replaceFiles, scope])

  useEffect(() => {
    for (const path of openPaths) void loadFile(path)
  }, [loadFile, openPaths])

  const openInPanel = useCallback((file: string, folder: string) => {
    const localProject = !remote && Boolean(projectId)
    const path = tabPathFor(file, filesRoot, scope, localProject)
    const fromBrowsedFolder = !remote && Boolean(listRootFor(folder))
    openFile(scope, path, pickedFileTarget(path, localProject ? filesRoot : null, fromBrowsedFolder), fromBrowsedFolder)
    void loadFile(path)
  }, [filesRoot, listRootFor, loadFile, openFile, projectId, remote, scope, tabPathFor])

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
    onOpenFile: (path: string) => openInPanel(joinFolder(searchRoot, path), searchRoot),
    onOpenLine: openSearchedLine,
    onClose: closeSearch
  }), [closeSearch, openInPanel, openSearchedLine, search.onAction, searchRoot])
  const searchShowsResults = searchOpen && search.state.query.trim() !== ''

  const flushPath = useCallback(async (key: string | null) => {
    if (!key) return
    const file = filesRef.current[key]
    if (!file || file.profileId !== useAppStore.getState().profileId || file.saveState === 'conflict' || file.initialLoadFailed || file.binary || file.loading) return
    const queue = queues.current.get(key) ?? ensureQueue(key, file.target, file.threadId, file.profileId)
    if (file.content !== file.savedContent) {
      saveBlockers.current.delete(key)
      patchFile(key, { saveState: 'saving', error: null })
      queue.schedule({ content: file.content, baseline: file.savedContent })
    }
    await queue.flush()
  }, [ensureQueue, patchFile])

  useEffect(() => {
    // A file being opened may resolve to the tab that is already active.
    if (selected?.loading) return
    const previous = previousActiveKey.current
    previousActiveKey.current = selectedKey
    if (previous && previous !== selectedKey) void flushPath(previous)
  }, [flushPath, selected?.loading, selectedKey])

  useEffect(() => {
    if (!showing) return
    const interval = window.setInterval(() => {
      if (document.hidden || useAppStore.getState().profileId !== profileId) return
      for (const path of openPaths) {
        const key = fileKey(path)
        if (revalidating.current.has(key)) continue
        const file = filesRef.current[key]
        const queue = queues.current.get(key)
        if (!file || file.loading || file.initialLoadFailed || file.saveState === 'saving' || file.saveState === 'conflict' || queue?.isBusy()) continue
        const sequence = loadSequences.current.get(key) ?? 0
        const pollProfileId = profileId
        const isCurrentPoll = () => loadSequences.current.get(key) === sequence && useAppStore.getState().profileId === pollProfileId
        if (isAssetView(file.kind)) {
          // Only check the active preview tab for changes; offscreen asset tabs recheck once shown.
          if (key !== selectedKeyRef.current) continue
          if (typeof window.mousse.fs.assetStamp === 'function') {
            revalidating.current.add(key)
            void assetStampAt(file.target, file.threadId).then(async (stamp) => {
              const current = filesRef.current[key]
              if (!current || !isCurrentPoll()) return
              const nextStamp = assetStampKey(stamp)
              if (current.assetStamp === nextStamp) {
                if (current.refreshFailed) patchFile(key, refreshRecovered(current))
                return
              }
              if (current.kind === 'video' && typeof window.mousse.fs.openMediaUrl === 'function') {
                const media = await openMediaAt(current.target, current.threadId)
                const latest = filesRef.current[key]
                if (!latest || !isCurrentPoll()) {
                  releaseAssetUrl(media.url, true)
                  return
                }
                releaseAssetUrl(latest.assetUrl, latest.assetIsMediaUrl)
                patchFile(key, { assetUrl: media.url, assetIsMediaUrl: true, assetStamp: assetStampKey(media), error: null, refreshFailed: false })
                return
              }
              const asset = await readAssetAt(current.target, current.threadId)
              const latest = filesRef.current[key]
              if (!latest || !isCurrentPoll()) return
              const signature = assetSignature(asset.data, asset.mimeType)
              const updatedStamp = typeof asset.size === 'number' ? assetStampKey(asset) : nextStamp
              if (latest.assetSignature === signature) {
                patchFile(key, { assetStamp: updatedStamp, ...refreshRecovered(latest) })
                return
              }
              const url = assetBlobUrl(asset.data, asset.mimeType)
              releaseAssetUrl(latest.assetUrl, latest.assetIsMediaUrl)
              patchFile(key, { assetUrl: url, assetIsMediaUrl: false, assetStamp: updatedStamp, assetSignature: signature, error: null, refreshFailed: false })
            }).catch((error) => {
              if (filesRef.current[key] && isCurrentPoll()) patchFile(key, { error: `Refresh failed: ${message(error)}`, refreshFailed: true })
            }).finally(() => {
              revalidating.current.delete(key)
            })
            continue
          }
          // Without `assetStamp`, never re-read an entire video file over IPC every 2 seconds.
          if (file.kind === 'video') continue
          revalidating.current.add(key)
          void readAssetAt(file.target, file.threadId).then((asset) => {
            const current = filesRef.current[key]
            const signature = assetSignature(asset.data, asset.mimeType)
            if (!current || !isCurrentPoll()) return
            if (current.refreshFailed) patchFile(key, refreshRecovered(current))
            if (current.assetSignature === signature) return
            const url = assetBlobUrl(asset.data, asset.mimeType)
            releaseAssetUrl(current.assetUrl, current.assetIsMediaUrl)
            patchFile(key, { assetUrl: url, assetIsMediaUrl: false, assetSignature: signature, error: null })
          }).catch((error) => {
            if (filesRef.current[key] && isCurrentPoll()) patchFile(key, { error: `Refresh failed: ${message(error)}`, refreshFailed: true })
          }).finally(() => {
            revalidating.current.delete(key)
          })
          continue
        }
        if (file.binary) continue
        const savedAtReadStart = file.savedContent
        revalidating.current.add(key)
        void readText(file.target, file.threadId, file.workspaceRoot).then(({ content: diskContent }) => {
          const current = filesRef.current[key]
          // A save completed after this read began; its result is newer than this poll.
          if (!current || !isCurrentPoll() || current.savedContent !== savedAtReadStart || queues.current.get(key)?.isBusy()) return
          if (current.refreshFailed) patchFile(key, refreshRecovered(current))
          const result = reconcileExternalContent(current.savedContent, current.content, diskContent)
          if (result.kind === 'replace') patchFile(key, { content: result.content, savedContent: result.content, error: null, saveState: 'saved' })
          if (result.kind === 'conflict') {
            queues.current.get(key)?.cancel()
            saveBlockers.current.add(key)
            patchFile(key, { diskContent: result.diskContent, saveState: 'conflict', error: 'This file changed on disk. Your edits were kept.', refreshFailed: false })
          }
        }).catch((error) => {
          if (filesRef.current[key] && isCurrentPoll()) patchFile(key, { error: `Refresh failed: ${message(error)}`, refreshFailed: true })
        }).finally(() => {
          revalidating.current.delete(key)
        })
      }
    }, REVALIDATE_MS)
    return () => window.clearInterval(interval)
  }, [fileKey, openPaths, patchFile, profileId, showing])

  useEffect(() => {
    // Resolves when this open has finished, or given way to a later one (services/fileLinks waits for it).
    const openLink = async (link: unknown): Promise<void> => {
      const detail = link as OpenFileDetail | undefined
      if (!detail?.path) return
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
      const targetThread = useAppStore.getState().threads.find((thread) => thread.id === targetThreadId)
      const targetProjectId = detail.projectId ?? targetThread?.projectId ?? null
      if (targetThreadId && targetThreadId !== store.activeThreadId) {
        expectedThreadId = targetThreadId
        useAppStore.getState().switchToThread(targetThreadId)
        await selectOrSettle(targetThreadId)
        if (!stillCurrent()) return
      }
      const targetRoot = await window.mousse.app.getFilesRoot(targetThreadId)
      if (!stillCurrent()) return
      const linkedPath = detail.path.trim()
      if (/^[\\/]{2}/.test(linkedPath) && pathInside(linkedPath, targetRoot) === null) {
        showToast({ key: 'unc-file-link', tone: 'error', message: 'Map the share to a drive letter first' })
        return
      }
      const targetScope = fileWorkspaceScope(ownerProfileId, targetThreadId, targetProjectId)
      const localProject = Boolean(targetProjectId && !targetThread?.node && typeof window.mousse.fs.listDrives === 'function')
      const path = tabPathFor(linkedPath, targetRoot, targetScope, localProject)
      const currentStore = useAppStore.getState()
      currentStore.openSurfaceKind('files')
      useFileWorkspaceStore.getState().openFile(targetScope, path, pickedFileTarget(path, localProject ? targetRoot : null))
      if (detail.line) {
        const position = { path, line: detail.line, column: detail.column ?? 1 }
        pendingPosition.current = position
        const key = `${targetScope}\0${path}`
        setPositions((current) => ({ ...current, [key]: position }))
        setPreview((current) => ({ ...current, [key]: false }))
      }
      await loadFile(path, targetScope, targetThreadId, ownerProfileId, false, localProject ? targetRoot : null)
    }
    // File links reach this tab through services/fileLinks, including the ones that arrived before it mounted (or
    // while its chunk failed to load).
    return registerFileLinkOpener(openLink)
  }, [loadFile, tabPathFor])

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
    revalidating.current.clear()
    for (const key of loadSequences.current.keys()) {
      loadSequences.current.set(key, (loadSequences.current.get(key) ?? 0) + 1)
    }
    // A file still loading holds nothing yet: drop it, and the open-files effect loads it again for whoever is
    // active next (including React's development remount, which runs this cleanup at startup).
    replaceFiles((current) => Object.fromEntries(Object.entries(current).flatMap<[string, OpenFileState]>(([key, file]) => {
      if (file.loading) return []
      if (interruptedSaves.has(key) && file.content !== file.savedContent && file.saveState !== 'conflict') {
        return [[key, { ...file, saveState: 'error', error: 'Save paused when the active profile changed.' }]]
      }
      return [[key, file]]
    })))
  }, [profileId, replaceFiles])

  useEffect(() => () => {
    for (const file of Object.values(filesRef.current)) releaseAssetUrl(file.assetUrl, file.assetIsMediaUrl)
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

  // A reload the person chooses (lib/lazyComponent) saves what autosave is holding first.
  useEffect(() => registerAutosaveFlush(() => Promise.all(Object.keys(filesRef.current).map((key) => flushPath(key)))), [flushPath])

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
    if (!current || current.loading || current.initialLoadFailed || lacksWorkspaceBinding(current) || current.profileId !== useAppStore.getState().profileId) return
    const conflicted = current.saveState === 'conflict'
    patchFile(selectedKey, conflicted
      ? { content: value }
      : { content: value, saveState: current.saveState === 'error' ? 'error' : 'dirty' })
    if (!conflicted) ensureQueue(selectedKey, current.target, current.threadId)
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
    revalidating.current.delete(key)
    releaseAssetUrl(current?.assetUrl, current?.assetIsMediaUrl)
    replaceFiles((all) => { const next = { ...all }; delete next[key]; return next })
    if (document.activeElement?.closest('.main-view-tabs')) closedFromStrip.current = path
    closeFileInStore(scope, path)
    return true
  }, [closeFileInStore, fileKey, flushPath, replaceFiles, scope])

  useEffect(() => {
    setFileTabDirtyPaths(scope, openPaths.filter((path) => {
      const file = files[fileKey(path)]
      return file && file.content !== file.savedContent
    }))
    return () => setFileTabDirtyPaths(scope, [])
  }, [scope, openPaths, files, fileKey])

  useEffect(() => registerFileTabCloser(scope, closeTab, filesRoot), [scope, closeTab, filesRoot])

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
    if (!closed) return
    const target = openPaths.length > 0
      ? document.querySelector<HTMLElement>('.main-view-tab-select[aria-current="page"]')
      : document.querySelector<HTMLElement>('.main-view-tab-select[title="Files"]')
    if (target) target.focus()
    else focusTreeRow(closed)
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

  const quickPlaces = useMemo(() => {
    const places: FilesPlaceItem[] = []
    if (threadFolder) places.push({ kind: 'thread', label: 'Thread folder', path: threadFolder })
    if (projectFolder && !samePath(projectFolder, threadFolder)) places.push({ kind: 'project', label: 'Project folder', path: projectFolder })
    // A thread without a folder shows home; the daemon names it.
    const homeFolder = home ?? (!threadFolder && !draftWorktree ? filesRoot : null)
    if (homeFolder && !places.some((place) => samePath(place.path, homeFolder))) places.push({ kind: 'home', label: 'Home', path: homeFolder })
    return places
  }, [draftWorktree, filesRoot, home, projectFolder, threadFolder])

  const beforeMount: BeforeMount = (monaco) => {
    monacoRef.current = monaco
    setAvailableLanguageIds(new Set(monaco.languages.getLanguages().map((language) => language.id)))
    applyEditorTheme(monaco)
    // The editor sees one file, not its project: every import and outside name would be marked as an error.
    // Syntax errors still show.
    const typescript = monaco.languages.typescript
    for (const defaults of [typescript?.typescriptDefaults, typescript?.javascriptDefaults]) {
      defaults?.setDiagnosticsOptions({ ...defaults.getDiagnosticsOptions(), noSemanticValidation: true })
    }
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
    if (!selected.binary && !selected.initialLoadFailed && lacksWorkspaceBinding(selected)) return 'Read-only until the service is updated'
    if (selected.saveState === 'saving') return 'Saving…'
    if (selected.saveState === 'dirty') return 'Autosave pending'
    if (selected.saveState === 'conflict') return 'Conflict'
    if (selected.saveState === 'error') return 'Save error'
    return ''
  }, [selected])

  const ready = Boolean(selected && selectedKey && !selected.loading && !selected.initialLoadFailed && !selected.binary)
  // Markdown and HTML show rendered or as source; one button switches. A Markdown file opened at a line shows source only.
  const markdownRendered = selected?.kind === 'markdown' && selectedKey && !positions[selectedKey]
    ? (markdownViews[selectedKey] ?? 'preview') === 'preview' : null
  const rendered = !ready ? null : markdownRendered ?? (selected?.kind === 'html' ? selectedPreview : null)
  const setRendered = (next: boolean) => {
    if (!selectedKey) return
    if (selected?.kind === 'markdown') setMarkdownViews((views) => ({ ...views, [selectedKey]: next ? 'preview' : 'source' }))
    else setPreview((state) => ({ ...state, [selectedKey]: next }))
  }
  const showsSource = ready && rendered !== true && !isAssetView(selected!.kind)
  const imageSize = selected?.kind === 'image' && selectedKey ? imageSizes[selectedKey] : undefined
  const selectedLocation = selected && !selected.target.root && isAbsolutePath(selected.target.path)
    ? selected.target.path : selectedPath
  const crumbPath = selectedLocation ? normalizeWorkspacePath(selectedLocation, filesRoot) : null
  const crumbs = crumbPath ? fileCrumbs(crumbPath, filesRoot) : []

  if (!showing) return null

  // The folder the tree shows, its search and its tree: the whole panel with no file open, a column beside one.
  const browser = <div className="files-sidebar-body">
    {/* The path and the search field share the row: one fades and slides out as the other comes in. */}
    <div className={`panel-toolbar files-header${searchOpen ? ' searching' : ''}`}>
      <div className="files-header-layer files-header-title" inert={searchOpen}>
        {browseRoot ? <FilesPathBar path={browseRoot} canBrowse={!remote} quickPlaces={quickPlaces} loadDrives={loadDrives}
          onNavigate={navigate} onNavigateTyped={navigateTyped} editRequest={pathEditRequest} />
          : <span className="panel-toolbar-label">Files</span>}
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
      {/* The lookup finished with no folder (another computer offline, a thread with none): say so, never load forever. */}
      {!browseRoot && filesRootUnavailable && !(draftWorktree && !remote)
        ? <div className="file-tree-empty" role="status" title={filesRootUnavailable}>The thread’s folder is unavailable.</div>
        : <FileTree key={`${navKey}|${browseRoot}`} memory={treeMemories.current.get(`${navKey}|${browseRoot}`)} filesRoot={browseRoot} listRoot={listRoot} threadId={activeThreadId}
        selectedPath={treePathOf(selectedLocation)} refreshKey={refreshKey}
        onSelectFile={(path) => openInPanel(joinFolder(browseRoot, path), browseRoot)} />}
    </div>
  </div>

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
      {/* Files is the browser tab; each picked file has its own sibling tab and fills the panel alone. */}
      {!selectedPath && <ResizablePanelSidebar className="files-sidebar" defaultWidth={240} fill>
        {browser}
      </ResizablePanelSidebar>}
      {selectedPath && <div className="files-editor" role="region" aria-label={crumbPath ?? selectedPath} onKeyDown={(event) => {
        // Escape closes the preview, except where a text field or the code editor uses it.
        if (event.key !== 'Escape' || event.defaultPrevented || typingTarget(event.target)) return
        event.preventDefault()
        closePreview()
      }}>
        {/* One row: where the file is, then its controls as small icon buttons. */}
        <div className="panel-toolbar files-editor-toolbar">
          <div className="files-crumbs" title={selectedLocation && !isAbsolutePath(selectedLocation) && filesRoot ? absoluteFilesPath(selectedLocation, filesRoot) : selectedLocation ?? undefined}>
            {crumbs.map((crumb, index) => <Fragment key={index}>
              {index > 0 && <ChevronRight size={12} className="files-crumb-sep" aria-hidden="true" />}
              <span className={`files-crumb${index === crumbs.length - 1 ? ' current' : ''}`}>{crumb}</span>
            </Fragment>)}
          </div>
          <div className="files-toolbar-actions">
            {saveLabel && selected && <span className={`files-save-status ${selected.saveState}`}>{saveLabel}</span>}
            {imageSize && <span className="files-bar-note">{imageSize.width} × {imageSize.height}</span>}
            {imageSize && <BarButton label={imageActualSize ? 'Fit to panel' : 'Actual size'} onClick={() => setImageActualSize(!imageActualSize)}>
              {imageActualSize ? <ArrowShrink size={14} strokeWidth={2} /> : <Maximize size={14} strokeWidth={2} />}
            </BarButton>}
            {rendered !== null && <BarButton label={rendered ? 'Show source' : 'Show preview'} onClick={() => setRendered(!rendered)}>
              {rendered ? <Code2 size={14} strokeWidth={2} /> : <Eye size={14} strokeWidth={2} />}
            </BarButton>}
            {showsSource && <BarButton label="Wrap lines" pressed={wordWrap} onClick={() => setWordWrap(!wordWrap)}>
              <WrapText size={14} strokeWidth={2} />
            </BarButton>}
            <BarButton label="Close preview" shortcut="Esc" onClick={closePreview}><X size={14} strokeWidth={2} /></BarButton>
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
              ensureQueue(selectedKey, selected.target, selected.threadId).schedule({ content: selected.content, baseline: disk })
            }}>Keep mine</button>
          </div>}
        </div>}
        {selected?.loading ? <DelayedLoader label={`Opening ${basename(selected.path)}`} className="files-editor-loader" />
          : selected?.initialLoadFailed ? <div className="files-editor-empty">Unable to read this file. Use Retry open above.</div>
          : selected && selected.kind === 'pdf' && selected.assetUrl ? <iframe className="files-asset-preview files-pdf-preview" src={selected.assetUrl} title={`PDF preview: ${selected.path}`} />
          : selected && selected.kind === 'image' && selected.assetUrl ? <div className={`files-asset-preview files-image-preview${imageActualSize ? ' actual-size' : ''}`}>
            <img src={selected.assetUrl} alt={selected.path} onLoad={(event) => {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget
              const key = selectedKey
              if (key && width && height) setImageSizes((sizes) => sizes[key]?.width === width && sizes[key]?.height === height ? sizes : { ...sizes, [key]: { width, height } })
            }} />
          </div>
          : selected && selected.kind === 'video' && selected.assetUrl ? <div className="files-asset-preview files-video-preview"><video key={selected.assetUrl} src={selected.assetUrl} controls playsInline preload="metadata" /></div>
          : selected?.binary ? <div className="files-editor-empty">Binary files cannot be edited.</div>
          : selected && selected.kind === 'markdown' && !(selectedKey && positions[selectedKey]) ? <MarkdownDocumentEditor key={selectedKey} path={selectedKey ?? selected.path} keepModel value={selected.content} readOnly={lacksWorkspaceBinding(selected)} onChange={updateContent} onSave={() => void flushPath(selectedKey)} onEditorMount={onMarkdownMount} showViewTabs={false} wordWrap={wordWrap} minimap={false} viewMode={(selectedKey && markdownViews[selectedKey]) || 'preview'} onViewModeChange={(mode) => selectedKey && setMarkdownViews((views) => ({ ...views, [selectedKey]: mode }))} aria-label={selected.path} />
          : selected && selected.kind === 'html' && selectedPreview ? <iframe className="files-asset-preview files-html-preview" srcDoc={selected.content} sandbox="" title={`HTML preview: ${selected.path}`} />
          : selected ? <div className="files-monaco-editor"><Editor path={selectedKey ?? selected.path} value={selected.content} language={languageForPath(selected.path, availableLanguageIds)} theme={MOUSSE_EDITOR_THEME} keepCurrentModel beforeMount={beforeMount} onMount={onMount} onChange={(value) => updateContent(value ?? '')} options={{ readOnly: lacksWorkspaceBinding(selected), automaticLayout: true, bracketPairColorization: { enabled: true }, matchBrackets: 'always', minimap: { enabled: false }, lineNumbers: 'on', scrollBeyondLastLine: false, fontFamily: codeFont, ariaLabel: selected.path, fontSize: 13, tabSize: 2, detectIndentation: true, wordWrap: wordWrap ? 'on' : 'off' }} /></div>
          : !filesRoot && !filesRootLoading && (filesRootUnavailable || (!remote && projectId)) ?<div className="files-editor-empty">The thread’s folder is unavailable.</div>
          : <DelayedLoader label={`Opening ${basename(selectedPath)}`} className="files-editor-loader" />}
      </div>}
    </div>
  )
}
