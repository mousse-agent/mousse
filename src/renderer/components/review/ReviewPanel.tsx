import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, MessageSquare, RefreshCw } from '../../lib/icons'
import { joinReviewPath, sameReviewFile, type ChatReference } from '../../../shared/chatReferences'
import { REVIEW_MAX_FILES, type ReviewFileEntry, type ReviewFilesResult, type ReviewScope } from '../../../shared/review'
import { useAppStore } from '../../stores/appStore'
import { useReviewStore } from '../../stores/reviewStore'
import { ResizablePanelSidebar } from '../ResizablePanelSidebar'
import { Select, type SelectOption } from '../ui/Select'
import { ReviewDiffPane, WhitespaceToggle } from './ReviewDiffPane'
import { commentCounts, commentScopeLabel, scopeKey } from './reviewComments'
import { readReviewHistory, readWorkspaceAvailability, turnReturnedToIdle, type WorkspaceAvailability } from './reviewData'
import {
  STATUS_BADGES,
  buildFileTree,
  scopeFromOptionValue,
  scopeLabel,
  scopeOptionValue,
  totalCounts,
  turnChoices,
  type TreeNode,
  type TurnChoice
} from './reviewModel'

const NO_OWN_WORKTREE = 'This thread has no worktree of its own, so turns cannot be reviewed. Showing the working tree.'
const TURN_UNDONE = 'This turn was undone; its changes are not in the working tree.'
const NO_REFERENCES: ChatReference[] = []
const NO_COMMENT_COUNTS: ReadonlyMap<string, number> = new Map()

function CountStat({ entry }: { entry: ReviewFileEntry }) {
  if (entry.binary) return <span className="review-tree-note">binary</span>
  if (!entry.countsExact) return <span className="review-tree-note" title="Lines were not counted">—</span>
  return (
    <span className="turn-edits-stat">
      {entry.additions > 0 && <span className="turn-edits-add">+{entry.additions}</span>}
      {entry.deletions > 0 && <span className="turn-edits-del">−{entry.deletions}</span>}
    </span>
  )
}

function TreeRows({
  nodes,
  depth,
  selectedPath,
  collapsed,
  comments,
  onToggle,
  onSelect
}: {
  nodes: TreeNode[]
  depth: number
  selectedPath: string | null
  collapsed: ReadonlySet<string>
  comments: ReadonlyMap<string, number>
  onToggle: (path: string) => void
  onSelect: (entry: ReviewFileEntry) => void
}) {
  return (
    <>
      {nodes.map((node) => {
        const indent = { paddingLeft: 12 + depth * 12 }
        if (node.kind === 'folder') {
          const open = !collapsed.has(node.path)
          return (
            <div key={`d:${node.path}`}>
              <button type="button" className="review-tree-row review-tree-folder" style={indent} aria-expanded={open} onClick={() => onToggle(node.path)}>
                {open ? <ChevronDown size={12} strokeWidth={2} /> : <ChevronRight size={12} strokeWidth={2} />}
                <span className="git-file-path">{node.name}</span>
              </button>
              {open && (
                <TreeRows nodes={node.children} depth={depth + 1} selectedPath={selectedPath} collapsed={collapsed} comments={comments} onToggle={onToggle} onSelect={onSelect} />
              )}
            </div>
          )
        }
        const { entry } = node
        const commentCount = comments.get(node.path) ?? 0
        return (
          <button
            key={`f:${node.path}`}
            type="button"
            className={`review-tree-row${selectedPath === node.path ? ' selected' : ''}`}
            style={indent}
            title={entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path}
            onClick={() => onSelect(entry)}
          >
            <span className={`git-status-badge status-${entry.status}`}>{STATUS_BADGES[entry.status]}</span>
            <span className="git-file-path">{node.name}</span>
            {commentCount > 0 && (
              <span className="review-tree-comments" title={`${commentCount} comment${commentCount === 1 ? '' : 's'} in the composer`}>
                <MessageSquare size={11} strokeWidth={2} />
                {commentCount}
              </span>
            )}
            <CountStat entry={entry} />
          </button>
        )
      })}
    </>
  )
}

function firstFilePath(nodes: TreeNode[]): string | null {
  for (const node of nodes) {
    if (node.kind === 'file') return node.path
    const inner = firstFilePath(node.children)
    if (inner) return inner
  }
  return null
}

export function ReviewPanel() {
  const threadId = useAppStore((s) => s.activeThreadId)
  const phase = useAppStore((s) => (s.activeThreadId ? s.turnStates[s.activeThreadId]?.phase : undefined))
  const ignoreWhitespace = useAppStore((s) => s.reviewIgnoreWhitespace)
  const threadState = useReviewStore((s) => (threadId ? s.byThread[threadId] : undefined))
  const references = useAppStore((s) => s.composerReferences[s.activeThreadId ?? '__blank__'] ?? NO_REFERENCES)
  const platform = useAppStore((s) => s.appInfo?.platform ?? '')
  const { setScope, selectFile, saveViewState, resolveCommentReveal } = useReviewStore.getState()

  const [availability, setAvailability] = useState<{ threadId: string; value: WorkspaceAvailability } | null>(null)
  const [choices, setChoices] = useState<TurnChoice[]>([])
  const [list, setList] = useState<{ key: string; result: ReviewFilesResult } | null>(null)
  const [listError, setListError] = useState<{ key: string; message: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [version, setVersion] = useState(0)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const requestId = useRef(0)
  const previousPhase = useRef<{ threadId: string | null; phase: typeof phase } | null>(null)

  const ownWorktree = availability?.threadId === threadId ? availability.value === 'own' : null
  // Turns and the thread's base exist only for a thread with its own worktree; without one, the working
  // tree (staged or not, as a comment made in the Git panel asked for).
  const savedScope = threadState?.scope ?? null
  const scope: ReviewScope | null =
    ownWorktree === null
      ? null
      : ownWorktree
        ? savedScope ?? { kind: 'thread' }
        : savedScope?.kind === 'worktree' ? savedScope : { kind: 'worktree' }
  const scopeJson = scope ? JSON.stringify(scope) : null
  const listKey = `${threadId ?? ''}\0${scopeJson ?? ''}`

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
      if (useAppStore.getState().activeThreadId === threadId) {
        setChoices(turnChoices(history.actions ?? [], useAppStore.getState().messages))
      }
    } catch {
      // The picker keeps the working tree and whole-thread entries when history cannot be read.
    }
  }, [threadId])

  const loadFiles = useCallback(async () => {
    if (!threadId || !scopeJson) return
    const id = ++requestId.current
    const key = listKey
    setLoading(true)
    try {
      const result = await window.mousse.review.files({ threadId, scope: JSON.parse(scopeJson) as ReviewScope })
      if (id !== requestId.current) return
      setList({ key, result })
      setListError(null)
      setVersion((value) => value + 1)
    } catch (error) {
      if (id === requestId.current) setListError({ key, message: error instanceof Error ? error.message : String(error) })
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [threadId, scopeJson, listKey])

  // A new thread or scope loads its list; the previous list stays on screen until the new one arrives.
  useEffect(() => {
    void loadFiles()
  }, [loadFiles])

  useEffect(() => {
    if (ownWorktree) void loadChoices(false)
  }, [ownWorktree, loadChoices])

  /** The refresh button and a turn that just finished: drop the cached history, then read it again. */
  const refresh = useCallback(() => {
    if (ownWorktree) void loadChoices(true)
    void loadFiles()
  }, [ownWorktree, loadChoices, loadFiles])

  useEffect(() => {
    const before = previousPhase.current
    previousPhase.current = { threadId, phase }
    if (before?.threadId === threadId && turnReturnedToIdle(before.phase, phase)) refresh()
  }, [threadId, phase, refresh])

  const result = list?.key === listKey ? list.result : null
  const files = result?.files
  const tree = useMemo(() => (files ? buildFileTree(files) : []), [files])
  const totals = useMemo(() => totalCounts(files ?? []), [files])

  // A clicked comment pill names its file by absolute path; once its scope's list is here, open that file.
  const pendingComment = threadState?.pendingComment
  const root = result?.root
  useEffect(() => {
    if (!threadId || !pendingComment || !files || !root) return
    const match = files.find((file) => sameReviewFile(joinReviewPath(root, file.path), pendingComment.absolutePath, platform))
    resolveCommentReveal(threadId, match?.path ?? null)
  }, [threadId, pendingComment, files, root, platform, resolveCommentReveal])

  const commentsPerFile = useMemo(
    () =>
      scope && files && root
        ? commentCounts(references, { reviewScope: scopeKey(scope), root, files, platform })
        : NO_COMMENT_COUNTS,
    // `scope` is derived from `scopeJson`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [references, scopeJson, files, root, platform]
  )

  // Keep the selected file when it is still listed; otherwise open the first one.
  const selectedPath = threadState?.selectedPath ?? null
  useEffect(() => {
    if (!threadId || !files || list?.key !== listKey || pendingComment) return
    if (selectedPath && files.some((file) => file.path === selectedPath)) return
    const next = firstFilePath(tree)
    if (next !== selectedPath) selectFile(threadId, next)
  }, [threadId, files, list?.key, listKey, selectedPath, pendingComment, tree, selectFile])

  const toggleFolder = useCallback((path: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (!next.delete(path)) next.add(path)
      return next
    })
  }, [])

  if (!threadId) {
    return (
      <div className="review-panel">
        <div className="git-empty">Open a thread to review its changes.</div>
      </div>
    )
  }

  const options: SelectOption[] = [{ value: 'worktree', label: 'Working tree' }]
  if (ownWorktree) {
    options.push({ value: 'thread', label: 'Whole thread' })
    for (const choice of choices) options.push({ value: `turn:${choice.turnId}`, label: choice.label, group: 'Turns' })
    if (scope?.kind === 'turn' && !choices.some((choice) => choice.turnId === scope.turnId)) {
      options.push({ value: scopeOptionValue(scope), label: scopeLabel(scope, choices), group: 'Turns' })
    }
  }
  // Reached from a comment made on the Git panel's staged side.
  if (scope?.kind === 'worktree' && scope.staged) options.push({ value: scopeOptionValue(scope), label: scopeLabel(scope, choices) })
  const currentChoice = scope?.kind === 'turn' ? choices.find((choice) => choice.turnId === scope.turnId) : undefined
  const reason =
    result?.unavailable ??
    (ownWorktree === false ? NO_OWN_WORKTREE : currentChoice?.undone ? TURN_UNDONE : null)
  const selectedEntry = files?.find((file) => file.path === selectedPath)
  const currentList = result !== null
  const error = listError?.key === listKey ? listError.message : null

  return (
    <div className="review-panel">
      <ResizablePanelSidebar className="git-sidebar review-sidebar" defaultWidth={300}>
        <div className="panel-toolbar review-toolbar">
          <Select
            size="small"
            ariaLabel="Review scope"
            value={scope ? scopeOptionValue(scope) : ''}
            options={options}
            disabled={scope === null}
            onChange={(value) => setScope(threadId, scopeFromOptionValue(value))}
          />
          <button type="button" className="btn btn-ghost btn-sm" onClick={refresh} disabled={loading} title="Refresh">
            <RefreshCw size={14} strokeWidth={2} />
          </button>
        </div>
        <div className="review-toggle-row">
          <WhitespaceToggle />
        </div>
        {reason && <div className="review-banner" role="status">{reason}</div>}
        {error && (
          <div className="review-banner review-banner-error" role="alert">
            Could not load changes: {error}
          </div>
        )}
        {result && !result.unavailable && result.truncated && (
          <div className="review-banner" role="status">
            Showing the first {REVIEW_MAX_FILES.toLocaleString('en-US')} files. Counts include all changes.
          </div>
        )}
        {result && !result.unavailable && result.mergeCommits > 0 && (
          <div className="review-banner" role="status">This turn merged or pulled other commits; their files are included.</div>
        )}
        <div className="review-tree">
          {files && files.length > 0 && (
            <div className="review-tree-header">
              <span>{files.length} changed file{files.length === 1 ? '' : 's'}</span>
              <span className="turn-edits-stat">
                {totals.additions > 0 && <span className="turn-edits-add">+{totals.additions}</span>}
                {totals.deletions > 0 && <span className="turn-edits-del">−{totals.deletions}</span>}
              </span>
              <span className="review-tree-hint">Counts include whitespace changes</span>
            </div>
          )}
          <div className="review-tree-list">
            {files && files.length > 0 ? (
              <TreeRows
                nodes={tree}
                depth={0}
                selectedPath={selectedPath}
                collapsed={collapsed}
                comments={commentsPerFile}
                onToggle={toggleFolder}
                onSelect={(entry) => selectFile(threadId, entry.path)}
              />
            ) : currentList && !result?.unavailable && !error ? (
              <div className="git-empty git-empty-nested">No changes in {scope ? scopeLabel(scope, choices) : 'this scope'}</div>
            ) : !result && !error ? (
              <div className="git-empty git-empty-nested">Loading…</div>
            ) : null}
          </div>
        </div>
      </ResizablePanelSidebar>

      <div className="git-diff">
        {scope && (
          <ReviewDiffPane
            target={{ threadId, scope }}
            path={selectedEntry?.path ?? null}
            oldPath={selectedEntry?.oldPath}
            version={version}
            ignoreWhitespace={ignoreWhitespace}
            scopeLabel={commentScopeLabel(scope, choices)}
            viewState={selectedPath ? threadState?.viewState[selectedPath] : undefined}
            onSaveViewState={(path, state) => saveViewState(threadId, path, state)}
            emptyLabel={result?.unavailable ? 'Nothing to show' : 'Select a changed file to view its diff'}
          />
        )}
      </div>
    </div>
  )
}
