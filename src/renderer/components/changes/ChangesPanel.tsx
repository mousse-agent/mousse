import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown, ChevronRight, MessageSquare, MoreHorizontal } from '../../lib/icons'
import { joinReviewPath, sameReviewFile, type ChatReference } from '../../../shared/chatReferences'
import type { ReviewFileEntry, ReviewFilesResult, ReviewScope } from '../../../shared/review'
import { useAppStore } from '../../stores/appStore'
import { useChangesStore } from '../../stores/changesStore'
import { initGitRepository, refreshGitStatus } from '../../stores/gitStatusStore'
import { useActiveThreadPullRequest } from '../../hooks/useActiveThreadPullRequest'
import { gitScopeFor } from '../../lib/activeProject'
import { offlineLabel, refreshComputers, threadComputerState, UNKNOWN_COMPUTER_NAME, useComputer } from '../../lib/computers'
import { openFileInPanel } from '../../utils/chatLinks'
import { DelayedLoader } from '../ui/DelayedLoader'
import { Modal } from '../ui/Modal'
import { dismissToastByKey, showToast } from '../ui/Toast'
import { useGitActionRunner } from '../git/useGitActionRunner'
import { runSync, whileFolder, type SyncRequest } from '../git/gitSyncActions'
import { IDLE_SYNC_ACTIVITY, syncLabel, syncState, type SyncActivity } from '../git/gitSyncLogic'
import { canAmendCommit, changedFileCount, gitActionRowModel, gitChangeCounts, gitErrorMessage, pullRequestRow } from '../sideCard/gitSectionLogic'
import { commentCounts, commentScopeLabel, scopeKey } from '../review/reviewComments'
import { readReviewHistory, readWorkspaceAvailability, turnReturnedToIdle, type WorkspaceAvailability } from '../review/reviewData'
import { turnChoices, type TurnChoice } from '../review/reviewModel'
import {
  changesApi,
  changesErrorCode,
  changesErrorText,
  commitSelectionFor,
  mergeFiles,
  selectionEventMatches,
  withInclude,
  type ChangedFile,
  type ChangesResult,
  type FileChoice,
  type RevertedEntry,
  type SelectionState
} from './changesApi'
import {
  changesKeyAction,
  defaultScope,
  fileSignature,
  folderTurnRunning,
  hunkLineCounts,
  footerState,
  includeValueForLines,
  KEY_HELP,
  latestEndedTurn,
  lineChoicesFor,
  matchDaemonHunk,
  mergeUncommittedLists,
  newerTurnNotice,
  nextUnviewed,
  orderRows,
  parseScopeId,
  plural,
  revertAllowed,
  revertedWhat,
  reviewScopeFor,
  sameChanges,
  scopeEndpoints,
  scopeInSentence,
  scopeMenuOptions,
  scopeTitle,
  selectionFromChanges,
  selectionFromStatus,
  showIncludeChecks,
  SPLIT_MIN_WIDTH,
  statusWord,
  stepHunk,
  viewedKey,
  viewedMark,
  viewedState,
  type ChangesScopeId,
  type HunkRange,
  type UncommittedParts,
  type ViewedState
} from './changesModel'
import { ChangesDiff, type HunkActions, type LineRange } from './ChangesDiff'
import { ChangesFooter } from './ChangesFooter'
import { ChangesHeader, type SyncChipModel } from './ChangesHeader'
import { FileJump, type JumpRow } from './FileJump'
import { MenuButton } from './MenuButton'
import './changes.css'

const NO_REFERENCES: ChatReference[] = []
const NO_COUNTS: ReadonlyMap<string, number> = new Map()
const NO_REVERTS: string[] = []
/** Each revert's toast is keyed by this and its id, so Undo from anywhere closes it. */
const REVERT_TOAST = 'changes-revert'

/** What happened to an entry of Restore reverted…. */
type RestoreOutcome = 'pending' | 'changed' | 'expired'

interface Row extends ReviewFileEntry {
  conflict: boolean
  signature: string
  /** The daemon's hunks and include state for this file, on the uncommitted diff. */
  api?: ChangedFile
  /** On Uncommitted: which of Git's two diffs the file is in, so its card reads both ends. */
  parts?: UncommittedParts
}

interface ScopeList {
  result: ReviewFilesResult
  /** Uncommitted only: per path, whether it is staged, unstaged or both. */
  parts: Map<string, UncommittedParts> | null
}

/** Reads a scope's list. Uncommitted is HEAD → working tree, so Git's staged and unstaged diffs are read together. */
async function readScopeList(target: { threadId?: string; projectId?: string }, scope: ReviewScope): Promise<ScopeList> {
  if (scope.kind !== 'worktree') return { result: await window.mousse.review.files({ ...target, scope }), parts: null }
  const [unstaged, staged] = await Promise.all([
    window.mousse.review.files({ ...target, scope: { kind: 'worktree' } }),
    window.mousse.review.files({ ...target, scope: { kind: 'worktree', staged: true } }).catch(() => null)
  ])
  return mergeUncommittedLists(unstaged, staged)
}

/** A POSIX, drive-letter or UNC path; anything else is relative to the worktree. */
function isAbsolutePath(path: string): boolean {
  return /^(?:[\\/]|[A-Za-z]:[\\/])/.test(path)
}

function isTextInput(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  if (element.isContentEditable) return true
  const tag = element.tagName
  return tag === 'TEXTAREA' || (tag === 'INPUT' && !['checkbox', 'radio', 'button'].includes((element as HTMLInputElement).type)) || tag === 'SELECT'
}

/**
 * The element's width, followed as it resizes. A callback ref, because the panel first renders a placeholder
 * without the measured element and a ref object would never see the element arrive.
 */
function useWidth(): [(element: HTMLElement | null) => void, number] {
  const [element, setElement] = useState<HTMLElement | null>(null)
  const [width, setWidth] = useState(800)
  useLayoutEffect(() => {
    if (!element) return
    setWidth(Math.round(element.getBoundingClientRect().width) || 800)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return [setElement, width]
}

/**
 * The Changes tab: what changed, and what's next. A one-line header (scope, counts, sync chip, "…"), one accordion of
 * file cards (only the open card renders a diff) and a footer with one next step.
 */
export function ChangesPanel() {
  const threadId = useAppStore((s) => s.activeThreadId)
  const thread = useAppStore((s) => s.threads.find((item) => item.id === s.activeThreadId))
  const phase = useAppStore((s) => (s.activeThreadId ? s.turnStates[s.activeThreadId]?.phase : undefined))
  const ignoreWhitespace = useAppStore((s) => s.reviewIgnoreWhitespace)
  const setIgnoreWhitespace = useAppStore((s) => s.setReviewIgnoreWhitespace)
  const references = useAppStore((s) => s.composerReferences[s.activeThreadId ?? '__blank__'] ?? NO_REFERENCES)
  const platform = useAppStore((s) => s.appInfo?.platform ?? '')
  const source = useActiveThreadPullRequest(threadId)
  const { location, git, path: folderId, projectId, ownThreadId } = source
  // By its ids: `location` is a new object on most renders, and every read and listener below hangs off this scope.
  const scopeProjectId = location.projectId
  const scopeThreadId = location.workspaceThreadId
  const gitScope = useMemo(() => gitScopeFor({ projectId: scopeProjectId, workspaceThreadId: scopeThreadId }), [scopeProjectId, scopeThreadId])
  const stateKey = threadId ?? (folderId ? `folder:${folderId}` : null)
  const threadState = useChangesStore((s) => (stateKey ? s.byThread[stateKey] : undefined))
  const viewed = useChangesStore((s) => s.viewed)
  const computer = useComputer(thread?.node)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [rootRef, width] = useWidth()
  const turnRunning = phase !== undefined && phase !== 'idle'
  // Git writes are refused (`thread_busy`) while a turn runs where they would land: this worktree, or any thread in the project folder.
  const folderBusy = useAppStore((s) => folderTurnRunning(gitScope, s.threads, (id) => s.turnStates[id]?.phase))
  const reverts = useChangesStore((s) => (folderId ? s.reverts[folderId] ?? NO_REVERTS : NO_REVERTS))

  const [availability, setAvailability] = useState<{ threadId: string; value: WorkspaceAvailability } | null>(null)
  const [choices, setChoices] = useState<{ threadId: string; list: TurnChoice[] } | null>(null)
  const [list, setList] = useState<{ key: string; list: ScopeList } | null>(null)
  const [listError, setListError] = useState<{ key: string; message: string } | null>(null)
  const [uncommittedList, setUncommittedList] = useState<{ key: string; files: ReviewFileEntry[] } | null>(null)
  const [apiResult, setApiResult] = useState<{ key: string; result: ChangesResult } | null>(null)
  /** The folder whose hunks could not be read (an older computer, a failed read): Choose what to commit says so. */
  const [apiFailed, setApiFailed] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const [hunks, setHunks] = useState<{ path: string; list: HunkRange[] }>({ path: '', list: [] })
  const [focusedHunk, setFocusedHunk] = useState<number | null>(null)
  const [openHash, setOpenHash] = useState<{ path: string; hash: string | null }>({ path: '', hash: null })
  const [commentRequest, setCommentRequest] = useState(0)
  const [choosing, setChoosing] = useState(false)
  const [split, setSplit] = useState(false)
  const [jumpOpen, setJumpOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [reverted, setReverted] = useState<RevertedEntry[] | null>(null)
  const [restoreOutcomes, setRestoreOutcomes] = useState<Record<string, RestoreOutcome>>({})
  const [reverting, setReverting] = useState<string | null>(null)
  const [activity, setActivity] = useState<SyncActivity>(IDLE_SYNC_ACTIVITY)
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'notice' } | null>(null)
  /** Each file's version as the newest read or write left it, and the selection's state: what the next queued write sends. */
  const versions = useRef(new Map<string, string>())
  const selectionState = useRef<SelectionState['state'] | null>(null)
  /** The selection writes in flight, one after another. */
  const writes = useRef<Promise<unknown>>(Promise.resolve())
  /** Orders reads against writes: a read lands unless a write started after it or a newer read already landed. */
  const apiOrder = useRef({ next: 0, write: 0, landed: 0 })
  /** Starts a read; its `lands()` says whether its answer may still be shown, and claims the slot when it may. */
  const startRead = () => {
    const order = apiOrder.current
    const seq = ++order.next
    const write = order.write
    return () => {
      if (order.write !== write || order.landed > seq) return false
      order.landed = seq
      return true
    }
  }
  /** A write began: answers of reads started before it are out of date. */
  const startWrite = () => {
    apiOrder.current.write++
  }
  const selectionRef = useRef<LineRange | null>(null)
  const folderRef = useRef(folderId)
  folderRef.current = folderId
  const { running, begin, end } = useGitActionRunner()

  // ---- Where the thread works, and its turns
  const ownWorktree = threadId ? (availability?.threadId === threadId ? availability.value === 'own' : null) : false
  useEffect(() => {
    if (!threadId) return
    let cancelled = false
    void readWorkspaceAvailability(threadId).then((value) => {
      if (!cancelled) setAvailability({ threadId, value })
    })
    return () => {
      cancelled = true
    }
  }, [threadId])

  const loadChoices = useCallback(async (fresh: boolean) => {
    if (!threadId) return
    try {
      const history = await readReviewHistory(threadId, { fresh })
      if (useAppStore.getState().activeThreadId === threadId) setChoices({ threadId, list: turnChoices(history.actions ?? [], useAppStore.getState().messages) })
    } catch {
      if (useAppStore.getState().activeThreadId === threadId) setChoices({ threadId, list: [] })
    }
  }, [threadId])
  useEffect(() => {
    if (ownWorktree) void loadChoices(false)
  }, [ownWorktree, loadChoices])
  const turnList = useMemo(() => (choices?.threadId === threadId ? choices.list : []), [choices, threadId])
  const choicesLoaded = !ownWorktree || choices?.threadId === threadId

  // ---- The scope: a request from a chat edit line or a comment pill, else the default for a fresh open
  const status = git.status
  const uncommitted = changedFileCount(status)
  const resolvedFor = useRef<string | null>(null)
  const requested = threadState?.requested
  useEffect(() => {
    if (!stateKey || ownWorktree === null) return
    const store = useChangesStore.getState()
    const latest = latestEndedTurn(turnList)
    if (requested !== undefined) {
      store.takeRequest(stateKey)
      store.show(stateKey, requested, requested === 'last' ? store.byThread[stateKey]?.pinnedTurnId ?? latest?.turnId ?? null : undefined)
      resolvedFor.current = stateKey
      return
    }
    if (resolvedFor.current === stateKey || !choicesLoaded || !git.loaded) return
    const saved = store.byThread[stateKey]
    const id = defaultScope({
      saved: saved?.chosen ?? null,
      lastOpenedAt: saved?.lastOpenedAt ?? null,
      lastTurn: latest ? { turnId: latest.turnId, endedAt: latest.endedAt } : null,
      hasUncommitted: uncommitted > 0,
      ownWorktree,
      hasTurns: turnList.length > 0
    })
    const newer = latest && latest.endedAt !== null && (saved?.lastOpenedAt ?? 0) < latest.endedAt
    store.show(stateKey, id, id === 'last' ? (newer || !saved?.pinnedTurnId ? latest?.turnId ?? null : saved.pinnedTurnId) : undefined)
    store.markOpened(stateKey, Date.now())
    resolvedFor.current = stateKey
  }, [stateKey, ownWorktree, requested, choicesLoaded, git.loaded, turnList, uncommitted])
  // When the tab closes or moves to another thread, it was last open now.
  useEffect(() => {
    if (!stateKey) return
    return () => useChangesStore.getState().markOpened(stateKey, Date.now())
  }, [stateKey])

  const scopeId: ChangesScopeId = threadState?.scopeId ?? 'uncommitted'
  const pinnedTurnId = threadState?.pinnedTurnId ?? null
  const reviewScope: ReviewScope = reviewScopeFor(scopeId, { pinnedTurnId, ownWorktree: Boolean(ownWorktree) })
  const scopeJson = JSON.stringify(reviewScope)
  const target = useMemo(
    () => (threadId && ownThreadId ? { threadId } : projectId ? { projectId } : threadId ? { threadId } : null),
    [threadId, ownThreadId, projectId]
  )
  const targetJson = target ? JSON.stringify(target) : null
  const scopeReady = stateKey !== null && threadState?.scopeId !== undefined && threadState.scopeId !== null
  const listKey = `${targetJson ?? ''}\0${scopeJson}`
  const isRepo = status?.isRepo === true

  // ---- Reads
  const requestId = useRef(0)
  const loadList = useCallback(async () => {
    if (!targetJson || !scopeReady || !isRepo) return
    const id = ++requestId.current
    const key = listKey
    try {
      const read = await readScopeList(JSON.parse(targetJson) as object, JSON.parse(scopeJson) as ReviewScope)
      if (id !== requestId.current) return
      setList({ key, list: read })
      setListError(null)
      setVersion((value) => value + 1)
    } catch (error) {
      if (id === requestId.current) setListError({ key, message: error instanceof Error ? error.message : String(error) })
    }
  }, [targetJson, scopeReady, isRepo, listKey, scopeJson])

  const showsWorktree = reviewScope.kind === 'worktree'
  const uncommittedKey = `${targetJson ?? ''}\0uncommitted`
  const loadUncommitted = useCallback(async () => {
    if (!targetJson || showsWorktree || uncommitted === 0 || !isRepo) return
    try {
      const read = await readScopeList(JSON.parse(targetJson) as object, { kind: 'worktree' })
      setUncommittedList({ key: uncommittedKey, files: read.result.files })
    } catch {
      setUncommittedList(null)
    }
  }, [targetJson, showsWorktree, uncommitted, isRepo, uncommittedKey])

  const apiKey = `${folderId ?? ''}\0${gitScope.projectId ?? ''}\0${gitScope.workspaceThreadId ?? ''}`
  const hasFolder = gitScope.projectId !== null || gitScope.workspaceThreadId !== null
  const loadApi = useCallback(async () => {
    if (!hasFolder || !folderId || !isRepo || uncommitted === 0) return
    const lands = startRead()
    try {
      const result = await changesApi.changes(gitScope)
      if (!lands()) return
      for (const file of result.files) versions.current.set(file.path, file.version)
      selectionState.current = result.selection.state
      setApiResult({ key: apiKey, result })
      setApiFailed(null)
    } catch {
      // Without hunks (an older computer, a read that failed) the tab still shows the diff; Include and Revert stay off.
      if (!lands()) return
      setApiResult((current) => (current?.key === apiKey ? null : current))
      setApiFailed(apiKey)
    }
  }, [hasFolder, gitScope, folderId, isRepo, uncommitted, apiKey])
  // Another window, computer or view changed the selection of this folder.
  useEffect(() => changesApi.onSelectionChanged((event) => {
    if (selectionEventMatches(gitScope, event)) void loadApi()
  }), [gitScope, loadApi])

  // Every status change (a commit, a stage, files written by a turn) re-reads what is shown, in place.
  useEffect(() => {
    void loadList()
    void loadUncommitted()
    void loadApi()
  }, [loadList, loadUncommitted, loadApi, status])

  const previousPhase = useRef<{ threadId: string | null; phase: typeof phase } | null>(null)
  useEffect(() => {
    const before = previousPhase.current
    previousPhase.current = { threadId, phase }
    if (before?.threadId === threadId && turnReturnedToIdle(before.phase, phase)) {
      if (ownWorktree) void loadChoices(true)
      void loadList()
    }
  }, [threadId, phase, ownWorktree, loadChoices, loadList])

  useEffect(() => {
    setActivity(IDLE_SYNC_ACTIVITY)
    setMessage(null)
    setChoosing(false)
  }, [folderId])

  const result = list?.key === listKey ? list.list.result : null
  const listParts = list?.key === listKey ? list.list.parts : null
  const error = listError?.key === listKey ? listError.message : null
  const api = apiResult?.key === apiKey ? apiResult.result : null

  // ---- Rows
  const conflicted = useMemo(() => new Set((status?.changes ?? []).filter((change) => change.status === 'conflicted').map((change) => change.path)), [status])
  const rows: Row[] = useMemo(() => {
    if (!result) return []
    const apiByPath = new Map((showsWorktree ? api?.files ?? [] : []).map((file) => [file.path, file]))
    return orderRows(
      result.files.map((entry) => {
        const apiFile = apiByPath.get(entry.path)
        const conflict = showsWorktree && (conflicted.has(entry.path) || apiFile?.change === 'conflict')
        const parts = listParts?.get(entry.path)
        // Staged and unstaged counts only add up; the daemon's hunks are HEAD → working tree.
        const counts = apiFile && parts?.staged && parts.unstaged ? hunkLineCounts(apiFile) : null
        return {
          ...entry,
          ...(counts ? { ...counts, countsExact: true } : {}),
          conflict,
          signature: fileSignature({ ...entry, version: apiFile?.version }),
          ...(apiFile ? { api: apiFile } : {}),
          ...(parts ? { parts } : {})
        }
      })
    )
  }, [result, listParts, api, showsWorktree, conflicted])
  const paths = useMemo(() => rows.map((row) => row.path), [rows])
  const endpoints = result ? scopeEndpoints(result) : ''
  const markKey = useCallback((path: string) => viewedKey(stateKey ?? '', endpoints, path), [stateKey, endpoints])
  const openPath = threadState?.openPath ?? null
  const viewedOf = useCallback(
    (row: Row): ViewedState => viewedState(viewed[markKey(row.path)], row.signature, openHash.path === row.path ? openHash.hash : null),
    [viewed, markKey, openHash]
  )
  const viewedCount = rows.filter((row) => viewedOf(row) === 'viewed').length
  const reviewScopeKey = scopeKey(reviewScope)
  const commentsPerFile = useMemo(
    () => (result ? commentCounts(references, { reviewScope: reviewScopeKey, root: result.root, files: result.files, platform }) : NO_COUNTS),
    [references, reviewScopeKey, result, platform]
  )
  const pendingComments = references.filter((reference) => reference.kind === 'review-comment').length

  // A clicked comment pill or chat edit line names its file by absolute path (or relative to the worktree).
  const pendingFile = threadState?.pendingFile
  useEffect(() => {
    if (!stateKey || !pendingFile || !result) return
    const wanted = isAbsolutePath(pendingFile.path) ? pendingFile.path : joinReviewPath(result.root, pendingFile.path)
    const match = result.files.find((file) => sameReviewFile(joinReviewPath(result.root, file.path), wanted, platform))
    useChangesStore.getState().resolvePendingFile(stateKey, match?.path ?? null)
  }, [stateKey, pendingFile, result, platform])

  // ---- Footer and Git actions
  const counts = gitChangeCounts(status)
  const inThread = gitScope.workspaceThreadId !== null
  const showsUncommitted = showsWorktree || (uncommittedList?.key === uncommittedKey && result !== null && sameChanges(result.files, uncommittedList.files))
  const model = folderId && isRepo
    ? gitActionRowModel({ path: folderId, scope: gitScope, projectId, ownThreadId, status, commitCount: git.commits.length, pullRequest: source.lookup })
    : null
  const prRow = pullRequestRow(source.lookup, status, source.detail, source.link, inThread)
  const computerState = thread?.node ? threadComputerState(thread, computer) : null
  const computerName = thread?.node ? computer?.name ?? UNKNOWN_COMPUTER_NAME : null
  const selection = api ? selectionFromChanges(api) : selectionFromStatus(counts, inThread)
  const footer = footerState({
    pendingComments,
    offlineComputer: computerState === 'offline' ? computerName : null,
    conflicts: counts.conflictedCount,
    uncommitted,
    showsUncommitted,
    selection,
    branch: status?.branch ?? null,
    onDefaultBranch: (source.lookup as { isDefaultBranch?: boolean } | null)?.isDefaultBranch === true,
    push: model?.pushButton ? { label: model.pushButton.label, count: model.pushButton.count, enabled: model.pushButton.disabledReason === undefined } : null,
    canCreatePullRequest: model?.createRow != null,
    pullRequest: prRow?.kind === 'found' ? { number: prRow.value, checks: prRow.checks } : null
  })
  // Hunks are computed with whitespace changes, so Include and Revert wait while the tab ignores whitespace.
  const revertScope = revertAllowed({ scopeId, showsUncommitted, turnRunning: false, apiAvailable: api !== null })
  const canRevert = revertScope && !folderBusy && !ignoreWhitespace
  const canInclude = api !== null && showsUncommitted && !folderBusy && !ignoreWhitespace
  /** Why Include and Revert are off where the scope would allow them; a tooltip says it. */
  const offReason = folderBusy ? 'Off while a turn runs' : ignoreWhitespace ? 'Off while ignoring whitespace' : null
  // The boxes show what a partial selection holds even while Include is off; they are disabled then.
  const showChecks = showIncludeChecks({ canInclude: api !== null && showsUncommitted, choosing, selection })

  // ---- Actions
  const refreshAll = useCallback(() => {
    if (folderId) void refreshGitStatus(folderId, { scope: gitScope, force: true })
    void loadList()
    void loadApi()
  }, [folderId, gitScope, loadList, loadApi])

  const setOpen = useCallback((path: string | null) => {
    if (!stateKey) return
    const body = bodyRef.current
    const current = useChangesStore.getState().byThread[stateKey]?.openPath ?? null
    // Remember where the closing card was scrolled to.
    if (body && current) {
      const card = body.querySelector<HTMLElement>(`[data-path="${CSS.escape(current)}"]`)
      if (card) useChangesStore.getState().saveFileView(markKey(current), { scrollTop: body.scrollTop - card.offsetTop })
    }
    setFocusedHunk(null)
    selectionRef.current = null
    useChangesStore.getState().setOpenPath(stateKey, path)
  }, [stateKey, markKey])

  // An opened card comes back where it was left, else its header goes to the top when it is out of view.
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body || !openPath) return
    const frame = requestAnimationFrame(() => {
      const card = body.querySelector<HTMLElement>(`[data-path="${CSS.escape(openPath)}"]`)
      if (!card) return
      const saved = useChangesStore.getState().fileViews[markKey(openPath)]?.scrollTop
      if (saved !== undefined) body.scrollTop = card.offsetTop + saved
      else if (card.offsetTop < body.scrollTop || card.offsetTop > body.scrollTop + body.clientHeight - 40) body.scrollTop = card.offsetTop
    })
    return () => cancelAnimationFrame(frame)
  }, [openPath, markKey])

  const markViewed = useCallback((row: Row) => {
    useChangesStore.getState().markViewed(markKey(row.path), viewedMark(row.signature, openHash.path === row.path ? openHash.hash : null))
  }, [markKey, openHash])

  const viewedAndNext = useCallback(() => {
    const row = rows.find((item) => item.path === openPath)
    if (!row) return setOpen(nextUnviewed(paths, null, (path) => viewedOf(rows.find((item) => item.path === path)!) === 'viewed'))
    markViewed(row)
    setOpen(nextUnviewed(paths, row.path, (path) => path === row.path || viewedOf(rows.find((item) => item.path === path)!) === 'viewed'))
  }, [rows, openPath, paths, markViewed, setOpen, viewedOf])

  const openInFiles = useCallback((path: string) => {
    if (!result) return
    openFileInPanel({ path: joinReviewPath(result.root, path), ...(threadId ? { threadId } : {}) })
  }, [result, threadId])

  /** A write the daemon refused: `stale` re-reads quietly, the rest say why in a few words and re-read too. */
  const writeFailed = useCallback((writeError: unknown) => {
    const code = changesErrorCode(writeError)
    if (code !== 'stale') setMessage({ text: changesErrorText(writeError, gitErrorMessage), tone: code === 'thread_busy' ? 'notice' : 'error' })
    void loadApi()
  }, [loadApi])

  /**
   * Re-reads after a write and shows it unless a newer choice is already on screen: the given paths in place, or
   * everything. Notes each file's version either way, so the next queued write sends the current one.
   */
  const reread = useCallback(async (paths?: string[]) => {
    const lands = startRead()
    try {
      const fresh = await changesApi.changes(gitScope, paths)
      for (const file of fresh.files) versions.current.set(file.path, file.version)
      if (!paths) selectionState.current = fresh.selection.state
      if (!lands()) return
      setApiResult((current) => {
        if (!paths) return { key: apiKey, result: fresh }
        if (!current || current.key !== apiKey) return current
        return { ...current, result: { ...current.result, selection: fresh.selection, files: mergeFiles(current.result.files, paths, fresh.files) } }
      })
    } catch {
      void loadApi()
    }
  }, [gitScope, apiKey, loadApi])

  /**
   * Selection writes run one at a time, each with the file's version as the last write left it: a quick second click on
   * the same file is never refused as `stale` because the first one's answer had not been read yet.
   */
  const queueWrite = useCallback((task: () => Promise<void>): Promise<void> => {
    const next = writes.current.then(task, task)
    writes.current = next.catch(() => undefined)
    return next
  }, [])
  const latest = useCallback((file: ChangedFile): ChangedFile => ({ ...file, version: versions.current.get(file.path) ?? file.version }), [])

  /** Applies a change to the shown files at once (the next frame), before Git confirms it. */
  const showAtOnce = useCallback((change: (result: ChangesResult) => ChangesResult) => {
    startWrite()
    setApiResult((current) => (current && current.key === apiKey ? { ...current, result: change(current.result) } : current))
  }, [apiKey])

  const include = useCallback((file: ChangedFile, value: boolean, choice: FileChoice = {}) => {
    setChoosing(true)
    showAtOnce((current) => ({
      ...current,
      selection: { ...current.selection, state: 'chosen' },
      files: current.files.map((item) => (item.path === file.path ? withInclude(item, value, choice) : item))
    }))
    return queueWrite(async () => {
      const before = selectionState.current
      try {
        const outcome = await changesApi.include(gitScope, latest(file), value, choice)
        selectionState.current = outcome.selection.state
        // The first choice changes every file's version (everything gets staged first in a project folder): read them all.
        await reread(before !== outcome.selection.state ? undefined : [file.path, ...(file.oldPath ? [file.oldPath] : [])])
      } catch (includeError) {
        writeFailed(includeError)
      }
    })
  }, [gitScope, showAtOnce, queueWrite, latest, reread, writeFailed])

  const includeAll = useCallback((value: boolean) => {
    setChoosing(true)
    showAtOnce((current) => ({ ...current, selection: { ...current.selection, state: 'chosen' }, files: current.files.map((item) => withInclude(item, value)) }))
    return queueWrite(async () => {
      try {
        const selection = await changesApi.includeAll(gitScope, value)
        selectionState.current = selection.state
      } catch (includeError) {
        if (changesErrorCode(includeError) !== 'stale') setMessage({ text: changesErrorText(includeError, gitErrorMessage), tone: 'error' })
      }
      await reread()
    })
  }, [gitScope, showAtOnce, queueWrite, reread])

  /** Puts a revert back. Reports what happened so Restore reverted… can say it on the entry. */
  const restore = useCallback(async (revertId: string): Promise<RestoreOutcome | 'restored' | 'failed'> => {
    try {
      const outcome = await changesApi.restoreReverted(gitScope, revertId)
      if (folderId) useChangesStore.getState().dropRevert(folderId, revertId)
      dismissToastByKey(`${REVERT_TOAST}:${revertId}`)
      if (outcome.restored) {
        refreshAll()
        return 'restored'
      }
      return outcome.reason
    } catch (restoreError) {
      setMessage({ text: changesErrorText(restoreError, gitErrorMessage), tone: changesErrorCode(restoreError) === 'thread_busy' ? 'notice' : 'error' })
      return 'failed'
    }
  }, [gitScope, folderId, refreshAll])

  /** Undo of the toast and Ctrl/Cmd+Z: a revert that can't come back says why. */
  const undoRevert = useCallback(async (revertId: string) => {
    const outcome = await restore(revertId)
    if (outcome === 'changed') setMessage({ text: 'Changed since the revert · nothing restored', tone: 'notice' })
    else if (outcome === 'expired') setMessage({ text: 'The kept copy is gone', tone: 'notice' })
  }, [restore])

  const revert = useCallback((file: ChangedFile, choice: FileChoice = {}) => queueWrite(async () => {
    setReverting(file.path)
    startWrite()
    try {
      const outcome = await changesApi.revert(gitScope, latest(file), choice)
      versions.current.set(outcome.path, outcome.version)
      if (folderId) useChangesStore.getState().pushRevert(folderId, outcome.revertId)
      showToast({ message: 'Reverted', action: { label: 'Undo', run: () => void undoRevert(outcome.revertId) }, key: `${REVERT_TOAST}:${outcome.revertId}` })
      if (outcome.left) setMessage({ text: outcome.left, tone: 'notice' })
      refreshAll()
    } catch (revertError) {
      writeFailed(revertError)
    } finally {
      setReverting(null)
    }
  }), [queueWrite, gitScope, latest, folderId, undoRevert, refreshAll, writeFailed])

  const undoLastCommit = useCallback(async () => {
    const head = git.commits[0]
    if (!head || !begin('commit')) return
    try {
      await changesApi.undoLastCommit(gitScope, head.hash)
      showToast({ message: 'Last commit undone', key: 'changes-undo-commit' })
      refreshAll()
    } catch (undoError) {
      writeFailed(undoError)
    } finally {
      end()
    }
  }, [git.commits, gitScope, begin, end, refreshAll, writeFailed])

  const openRow = rows.find((row) => row.path === openPath)
  const openHunks = hunks.path === openPath ? hunks.list : []
  // A whole-file-only file (binary, rename, filters, a diverged selection…) has no hunk or line choices.
  const hunkChoices = Boolean(openRow?.api && !openRow.api.wholeFileOnly)
  const daemonHunk = useCallback((hunk: HunkRange) => (openRow?.api ? matchDaemonHunk(hunk, openRow.api.hunks) : null), [openRow])
  const hunkActions: HunkActions = {
    canRevert: canRevert && hunkChoices,
    revertOff: revertScope && hunkChoices && !canRevert ? offReason : null,
    canInclude: showChecks && hunkChoices,
    includeOff: canInclude ? null : offReason,
    includedOf: (hunk) => daemonHunk(hunk)?.included ?? null,
    onRevert: (hunk) => {
      const match = daemonHunk(hunk)
      if (openRow?.api && match) void revert(openRow.api, { hunks: [match.id] })
    },
    onInclude: (hunk, value) => {
      const match = daemonHunk(hunk)
      if (openRow?.api && match) void include(openRow.api, value, { hunks: [match.id] })
    }
  }

  const syncNow = useCallback((request: SyncRequest) => {
    if (!folderId || !begin('sync')) return
    void runSync(folderId, gitScope, request, whileFolder(folderRef, folderId, setActivity)).finally(end)
  }, [folderId, gitScope, begin, end])

  const openRestore = useCallback(async () => {
    setRestoreOutcomes({})
    try {
      setReverted(await changesApi.revertedList(gitScope))
    } catch (listError) {
      setMessage({ text: changesErrorText(listError, gitErrorMessage), tone: 'error' })
    }
  }, [gitScope])

  const restoreFromList = useCallback(async (entry: RevertedEntry) => {
    setRestoreOutcomes((current) => ({ ...current, [entry.revertId]: 'pending' }))
    const outcome = await restore(entry.revertId)
    if (outcome === 'restored') setReverted((current) => current?.filter((item) => item.revertId !== entry.revertId) ?? null)
    setRestoreOutcomes((current) => {
      const { [entry.revertId]: _pending, ...rest } = current
      return outcome === 'changed' || outcome === 'expired' ? { ...rest, [entry.revertId]: outcome } : rest
    })
  }, [restore])

  /** What Space and X act on: the selected lines, else the focused hunk, else the focused row's whole file. */
  const keyTarget = (target: EventTarget | null): { file: ChangedFile; choice: FileChoice } | null => {
    const rowPath = (target as HTMLElement | null)?.closest?.<HTMLElement>('.changes-row')?.closest<HTMLElement>('[data-path]')?.dataset.path
    if (rowPath) {
      const file = rows.find((row) => row.path === rowPath)?.api
      return file ? { file, choice: {} } : null
    }
    const file = openRow?.api
    if (!file || !hunkChoices) return null
    const selected = selectionRef.current
    if (selected) {
      const lines = lineChoicesFor(file.hunks, selected)
      return lines.length > 0 ? { file, choice: { lines } } : null
    }
    if (focusedHunk !== null && openHunks[focusedHunk]) {
      const match = daemonHunk(openHunks[focusedHunk])
      return match ? { file, choice: { hunks: [match.id] } } : null
    }
    return null
  }

  // ---- Keys
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const action = changesKeyAction(event, isTextInput(event.target))
    if (!action) return
    const onButton = (event.target as HTMLElement).closest('button, [role="button"], input[type="checkbox"]') !== null
    switch (action) {
      case 'toggle':
        if (onButton) return
        setOpen(openPath ? null : paths[0] ?? null)
        break
      case 'open-in-files':
        if (!openPath) return
        openInFiles(openPath)
        break
      case 'viewed-next':
        viewedAndNext()
        break
      case 'previous': {
        if (paths.length === 0) return
        const index = openPath ? paths.indexOf(openPath) : paths.length
        setOpen(paths[Math.max(0, index - 1)] ?? null)
        break
      }
      case 'next-hunk':
      case 'previous-hunk':
        if (!openPath) return
        setFocusedHunk(stepHunk(openHunks.length, focusedHunk, action === 'next-hunk' ? 1 : -1))
        break
      case 'include': {
        // A checkbox toggles itself; Space elsewhere includes or leaves out what is focused, else starts choosing.
        if (!canInclude || (event.target as HTMLElement).closest('button, input[type="checkbox"]')) return
        const found = keyTarget(event.target)
        if (found) {
          const { file, choice } = found
          const value = choice.lines
            ? includeValueForLines(file.hunks, choice.lines)
            : choice.hunks
              ? file.hunks.find((hunk) => hunk.id === choice.hunks![0])?.included !== 'yes'
              : file.included !== 'yes'
          void include(file, value, choice)
        } else setChoosing(true)
        break
      }
      case 'revert': {
        if (!canRevert) return
        const found = keyTarget(event.target)
        if (!found) return
        void revert(found.file, found.choice)
        break
      }
      case 'comment':
        if (!openPath) return
        setCommentRequest((value) => value + 1)
        break
      case 'file-jump':
        setJumpOpen(true)
        break
      case 'undo-revert': {
        const last = reverts[reverts.length - 1]
        if (!last) return
        void undoRevert(last)
        break
      }
      case 'leave-selection':
        if (!choosing && focusedHunk === null) return
        setChoosing(false)
        setFocusedHunk(null)
        break
      case 'help':
        setHelpOpen(true)
        break
    }
    event.preventDefault()
  }

  // ---- Header
  const ownTurns = Boolean(ownWorktree)
  const title = scopeTitle(scopeId, { pinnedTurnId, choices: turnList, ownWorktree: ownTurns })
  const totals = rows.reduce((sum, row) => ({ additions: sum.additions + row.additions, deletions: sum.deletions + row.deletions }), { additions: 0, deletions: 0 })
  const sync = syncState(status)
  const chip: SyncChipModel | null = (() => {
    if (!isRepo || !sync) return null
    const core = [sync.ahead > 0 ? `↑${sync.ahead}` : '', sync.behind > 0 ? `↓${sync.behind}` : ''].filter(Boolean).join(' ') || null
    const word = sync.kind === 'conflicted' ? 'conflict' : sync.kind === 'in-progress' ? sync.what ?? 'merge' : sync.noUpstream === 'detached' ? 'detached' : null
    const offline = computerState === 'offline'
    const text = computerName ? (offline ? `${computerName} offline` : computerName) : word
    if (!core && !text) return null
    const tone = sync.kind === 'conflicted' || offline ? 'danger' : word ? 'warning' : 'neutral'
    const where = computerName ? `${computerName}${offline ? ` · ${offlineLabel(computer, Date.now())}` : ''}` : null
    return { core, text, computer: computerName !== null, tone, title: [syncLabel(sync), where].filter(Boolean).join(' · ') }
  })()
  const newer = newerTurnNotice({ scopeId, pinnedTurnId, choices: turnList })
  const menu = [
    // Choosing needs every whitespace change on screen, so it turns Ignore whitespace off.
    // Shown from the start and enabled once the hunks are read, so the menu does not change under the pointer.
    ...(showsUncommitted && uncommitted > 0
      ? [{
        label: 'Choose what to commit',
        hint: 'Space',
        checked: showChecks,
        disabled: folderBusy || api === null,
        title: folderBusy ? 'Off while a turn runs' : api !== null ? undefined : apiFailed === apiKey ? 'Not available for this folder' : 'Reading the changes…',
        onSelect: () => {
          if (ignoreWhitespace) setIgnoreWhitespace(false)
          setChoosing(!showChecks)
        }
      }]
      : []),
    { label: 'Ignore whitespace', checked: ignoreWhitespace, onSelect: () => setIgnoreWhitespace(!ignoreWhitespace) },
    ...(width >= SPLIT_MIN_WIDTH ? [{ label: 'Split', checked: split, onSelect: () => setSplit((value) => !value) }] : []),
    ...(!inThread && projectId && canAmendCommit(git.commits)
      ? [{ label: 'Undo last commit', title: folderBusy ? 'Off while a turn runs' : git.commits[0]?.message, disabled: running !== null || folderBusy, onSelect: () => void undoLastCommit() }]
      : []),
    ...(isRepo ? [{ label: 'Restore reverted…', onSelect: () => void openRestore() }] : []),
    { label: 'Keyboard shortcuts', hint: '?', onSelect: () => setHelpOpen(true) }
  ]

  // ---- Render
  if (!folderId) {
    return <div className="changes-panel"><p className="changes-empty">{location.loading ? '' : 'No project open'}</p></div>
  }
  if (git.loaded && status && !status.isRepo) {
    const initialize = async () => {
      if (!begin('init')) return
      try {
        await initGitRepository(folderId, gitScope)
      } catch (initError) {
        setMessage({ text: gitErrorMessage(initError), tone: 'error' })
      } finally {
        end()
      }
    }
    return (
      <div className="changes-panel">
        <p className="changes-empty">
          Not a Git repository · <button type="button" className="changes-link" disabled={running !== null} onClick={() => void initialize()}>Initialize</button>
        </p>
        {message && <p className="changes-message" data-tone={message.tone} role="alert">{message.text}</p>}
      </div>
    )
  }

  const lastTurn = latestEndedTurn(turnList)
  const scopeOptions = scopeMenuOptions({ choices: turnList, ownWorktree: ownTurns, current: scopeId })
  const showEmpty = result !== null && rows.length === 0 && !error

  return (
    <div className="changes-panel" ref={rootRef} onKeyDown={onKeyDown} tabIndex={-1}>
      <ChangesHeader
        width={width}
        scopeValue={scopeId}
        scopeTitle={title}
        scopeOptions={scopeOptions}
        scopeDisabled={!scopeReady || scopeOptions.length <= 1}
        onScope={(value) => {
          const id = parseScopeId(value)
          if (!id || !stateKey) return
          setOpen(null)
          useChangesStore.getState().choose(stateKey, id, id === 'last' ? lastTurn?.turnId ?? null : undefined)
        }}
        live={turnRunning}
        content={{
          scopeTitle: title,
          count: rows.length > 0 ? plural(rows.length, 'file') : null,
          left: viewedCount > 0 ? `${rows.length - viewedCount} left` : null,
          totals: [totals.additions > 0 ? `+${totals.additions}` : '', totals.deletions > 0 ? `−${totals.deletions}` : ''].filter(Boolean).join(' ') || null,
          chipText: chip?.text ?? null,
          chipCore: chip?.core ?? null
        }}
        chip={chip}
        onCounts={() => setJumpOpen(true)}
        menu={menu}
        git={{ path: folderId, scope: gitScope, view: git, fileCount: uncommitted }}
        running={running}
        begin={begin}
        end={end}
        activity={activity}
        onSync={syncNow}
        onError={(text) => setMessage(text ? { text, tone: 'error' } : null)}
        onNotice={(text) => setMessage(text ? { text, tone: 'notice' } : null)}
      />
      {newer && stateKey && (
        <button type="button" className="changes-newer" onClick={() => { setOpen(null); useChangesStore.getState().show(stateKey, 'last', newer.turnId) }}>
          Turn {newer.number} finished · <span className="changes-link">Show</span>
        </button>
      )}
      {message && (
        <p className="changes-message" data-tone={message.tone} role={message.tone === 'error' ? 'alert' : 'status'} title={message.text}>
          {message.text}
          <button type="button" className="changes-link" onClick={() => setMessage(null)} aria-label="Dismiss">×</button>
        </p>
      )}
      <div className="changes-body" ref={bodyRef}>
        {error && !result && (
          <p className="changes-empty" role="alert" title={error}>
            Couldn't load changes · <button type="button" className="changes-link" onClick={() => void loadList()}>Retry</button>
          </p>
        )}
        {result?.unavailable && <p className="changes-empty">{result.unavailable}</p>}
        {!result && !error && <div className="changes-empty"><DelayedLoader size="small" label="Loading changes" /></div>}
        {showEmpty && !result?.unavailable && (
          <p className="changes-empty">
            {showsWorktree ? 'No uncommitted changes' : `No changes in ${scopeInSentence(title)}`}
            {showsWorktree && lastTurn && lastTurn.files > 0 && stateKey && (
              <>
                {' · '}
                <button type="button" className="changes-link" onClick={() => useChangesStore.getState().choose(stateKey, 'last', lastTurn.turnId)}>
                  Last turn: {plural(lastTurn.files, 'file')}
                </button>
              </>
            )}
          </p>
        )}
        {rows.map((row) => {
          const open = row.path === openPath
          const viewState = viewedOf(row)
          const comments = commentsPerFile.get(row.path) ?? 0
          const word = row.conflict ? 'conflict' : statusWord(row.status)
          const included = row.api?.included ?? null
          return (
            <div key={row.path} className="changes-card" data-path={row.path} data-open={open || undefined} data-pending={reverting === row.path || undefined}>
              <div
                className="changes-row"
                role="button"
                tabIndex={0}
                aria-expanded={open}
                title={row.oldPath ? `${row.oldPath} → ${row.path}` : row.path}
                onClick={() => setOpen(open ? null : row.path)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && event.target === event.currentTarget) {
                    event.preventDefault()
                    event.stopPropagation()
                    setOpen(open ? null : row.path)
                  }
                }}
              >
                {showChecks && included !== null && row.api && (
                  <input
                    type="checkbox"
                    className="changes-row-check"
                    aria-label={`Include ${row.path}`}
                    checked={included === 'yes'}
                    disabled={!canInclude}
                    title={canInclude ? undefined : offReason ?? undefined}
                    ref={(element) => {
                      if (element) element.indeterminate = included === 'partial'
                    }}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => row.api && void include(row.api, event.target.checked)}
                  />
                )}
                {open ? <ChevronDown size={13} strokeWidth={2} className="changes-chevron" aria-hidden="true" /> : <ChevronRight size={13} strokeWidth={2} className="changes-chevron" aria-hidden="true" />}
                <span className="changes-path">{row.path}</span>
                {word && <span className="changes-word" data-word={word}>{word}</span>}
                {/* Takes room from the path only on hover or focus, so the counts stay on the row's right edge. */}
                <span className="changes-row-menu" onClick={(event) => event.stopPropagation()}>
                  <MenuButton
                    label={`Actions for ${row.path}`}
                    className="changes-icon-btn changes-row-more"
                    items={[
                      ...(revertScope && row.api
                        ? [{ label: 'Revert file', hint: 'X', disabled: !canRevert, title: canRevert ? undefined : offReason ?? undefined, onSelect: () => row.api && void revert(row.api) }]
                        : []),
                      { label: 'Open in Files', hint: 'O', onSelect: () => openInFiles(row.path) }
                    ]}
                  >
                    <MoreHorizontal size={13} strokeWidth={2} aria-hidden="true" />
                  </MenuButton>
                </span>
                <span className="changes-row-end">
                  {row.countsExact && !row.binary && (
                    <span className="changes-stat">
                      {row.additions > 0 && <span className="turn-edits-add">+{row.additions}</span>}
                      {row.deletions > 0 && <span className="turn-edits-del">−{row.deletions}</span>}
                    </span>
                  )}
                  {comments > 0 && (
                    <span className="changes-comments" title={plural(comments, 'comment')}>
                      <MessageSquare size={11} strokeWidth={2} aria-hidden="true" />
                      {comments}
                    </span>
                  )}
                  {open ? (
                    <button
                      type="button"
                      className="changes-viewed-btn"
                      data-viewed={viewState === 'viewed' || undefined}
                      title="Viewed, open the next (N)"
                      aria-label="Mark viewed and open the next file"
                      onClick={(event) => {
                        event.stopPropagation()
                        viewedAndNext()
                      }}
                    >
                      <Check size={13} strokeWidth={2} aria-hidden="true" />
                    </button>
                  ) : viewState === 'viewed' ? (
                    <Check size={12} strokeWidth={2} className="changes-viewed" aria-label="Viewed" />
                  ) : viewState === 'changed' ? (
                    <span className="changes-changed-dot" title="Changed since viewed" aria-label="Changed since viewed" />
                  ) : null}
                </span>
              </div>
              {open && target && (
                <div className="changes-card-body">
                  <ChangesDiff
                    target={{ ...target, scope: reviewScope }}
                    path={row.path}
                    oldPath={row.oldPath}
                    parts={row.parts}
                    version={version}
                    ignoreWhitespace={ignoreWhitespace}
                    split={split && width >= SPLIT_MIN_WIDTH}
                    scopeLabel={commentScopeLabel(reviewScope, turnList)}
                    reviewScope={reviewScopeKey}
                    focusedHunk={focusedHunk}
                    onFocusHunk={setFocusedHunk}
                    onHunks={(list) => setHunks({ path: row.path, list })}
                    onContent={(hash) => setOpenHash({ path: row.path, hash })}
                    commentRequest={commentRequest}
                    selectionRef={selectionRef}
                    actions={hunkActions}
                  />
                </div>
              )}
            </div>
          )
        })}
        {result?.truncated && <p className="changes-empty">Showing the first {rows.length.toLocaleString('en-US')} files</p>}
      </div>
      {model && (
        <ChangesFooter
          state={footer}
          path={folderId}
          scope={gitScope}
          commits={git.commits}
          model={model}
          running={running}
          begin={begin}
          end={end}
          onReviewUncommitted={() => {
            if (!stateKey) return
            setOpen(null)
            useChangesStore.getState().choose(stateKey, 'uncommitted')
          }}
          onResolveConflicts={() => {
            const first = rows.find((row) => row.conflict)
            if (first) setOpen(first.path)
            else if (stateKey) useChangesStore.getState().choose(stateKey, 'uncommitted')
          }}
          onRetry={() => {
            void refreshComputers()
            refreshAll()
          }}
          onIncludeAll={canInclude ? () => void includeAll(true) : undefined}
          commitSelection={showsUncommitted ? commitSelectionFor(api?.selection) : undefined}
          onSelectionStale={() => void loadApi()}
        />
      )}
      <FileJump
        open={jumpOpen}
        rows={rows.map<JumpRow>((row) => ({
          path: row.path,
          additions: row.additions,
          deletions: row.deletions,
          viewed: viewedOf(row) === 'viewed',
          comments: commentsPerFile.get(row.path) ?? 0,
          included: row.api ? row.api.included !== 'no' : null
        }))}
        showIncluded={api !== null && showsUncommitted}
        onPick={(path) => setOpen(path)}
        onClose={() => setJumpOpen(false)}
      />
      <Modal open={helpOpen} title="Keyboard shortcuts" onClose={() => setHelpOpen(false)} className="changes-help">
        <dl className="changes-help-list">
          {KEY_HELP.map(([key, text]) => (
            <div key={key} className="changes-help-row">
              <dt><kbd>{key}</kbd></dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      </Modal>
      <Modal open={reverted !== null} title="Restore reverted" onClose={() => setReverted(null)} className="changes-restore">
        {reverted && reverted.length === 0 ? (
          <p className="changes-empty">Nothing to restore</p>
        ) : (
          <div className="changes-restore-list">
            {reverted?.map((entry) => {
              const outcome = restoreOutcomes[entry.revertId]
              return (
                <div key={entry.revertId} className="changes-restore-row">
                  <span className="changes-restore-what">
                    <span className="changes-path" title={`${entry.oldPath ? `${entry.oldPath} → ` : ''}${entry.path} · kept until ${new Date(entry.keptUntil).toLocaleDateString()}`}>{entry.path}</span>
                    <span className="changes-faint">
                      {outcome === 'changed' ? 'Changed since' : outcome === 'expired' ? 'Expired' : `${revertedWhat(entry)} · ${new Date(entry.at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}`}
                    </span>
                  </span>
                  {outcome === 'changed' ? (
                    // Nothing was written: the file as it is now opens in Files; the kept copy stays listed.
                    <button type="button" className="changes-link" title="The file changed after the revert" onClick={() => { setReverted(null); openInFiles(entry.path) }}>
                      Open file
                    </button>
                  ) : outcome !== 'expired' && (
                    <button type="button" className="changes-secondary" disabled={outcome === 'pending'} onClick={() => void restoreFromList(entry)}>
                      Restore
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Modal>
    </div>
  )
}
