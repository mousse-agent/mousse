import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Cloud, Download, Folder, FolderOpen, GitBranch, Milestone, RefreshCw } from '../lib/icons'
import type { GitCommit, GitFileChange } from '../../shared/types'
import type { GitHubAvailability, GitHubRepositoryVisibility } from '../../shared/github'
import { gitScopeFor } from '../lib/activeProject'
import { useActiveProjectLocation } from '../hooks/useActiveProjectPath'
import { useActiveThreadPullRequest } from '../hooks/useActiveThreadPullRequest'
import { useTransientError } from '../hooks/useTransientError'
import { useAppStore } from '../stores/appStore'
import { useGitStatus } from '../stores/gitStatusStore'
import { ThreadComputerBadge } from './ComputerBadge'
import { DiscardConfirmDialog, type DiscardQuestion } from './git/DiscardConfirmDialog'
import { GitActionButtons, useGitActionRunner } from './git/GitActionButtons'
import { GitChangesList, type SelectedFile } from './git/GitChangesList'
import { runRowAction, runSync, whileFolder, type RowRequest, type SyncRequest } from './git/gitPanelActions'
import {
  discardConfirmLabel,
  IDLE_SYNC_ACTIVITY,
  resizeSectionPair,
  keyedSectionRatio,
  sectionPairRatio,
  sectionStyle,
  selectionAfterAction,
  type GitSectionId,
  type RowAction,
  type SectionAction,
  type SectionSizes,
  type SyncActivity
} from './git/gitPanelLogic'
import { GitOperationStatus } from './git/GitOperationStatus'
import { GitSyncBar } from './git/GitSyncBar'
import { DelayedLoader } from './ui/DelayedLoader'
import { ResizablePanelSidebar } from './ResizablePanelSidebar'
import { DiffOptionsMenu, ReviewDiffPane } from './review/ReviewDiffPane'
import { usePullRequestPushTarget } from './sideCard/usePullRequestPushTarget'
import { gitActionRowModel } from './sideCard/gitSectionLogic'
import { folderName } from '../lib/folderLabel'

/** How long a notice from Commit, Push or Create PR stays: it can carry something to act on. */
const NOTICE_MS = 15_000

export function CommitsSection({
  commits,
  flex,
  sectionRef
}: {
  commits: GitCommit[]
  /** The weight a dragged divider gave the list; none until then, so it takes the rest of the panel. */
  flex: number | undefined
  sectionRef?: (el: HTMLDivElement | null) => void
}) {
  return (
    <div className="git-section" data-section="commits" style={sectionStyle('commits', commits.length, flex)} ref={sectionRef}>
      <div className="git-section-title">Commits</div>
      <div className="git-section-list">
        {commits.length === 0 ? (
          <div className="git-empty git-empty-nested">No commits</div>
        ) : (
          commits.map((commit) => (
            <div
              key={commit.hash}
              className="git-commit-row"
              title={`${commit.shortHash} · ${commit.author} · ${commit.date}${
                commit.pushed ? ' · on upstream' : ' · not on configured upstream'
              }`}
            >
              <span
                className={`git-commit-icon${commit.pushed ? ' pushed' : ' local'}`}
                aria-label={commit.pushed ? 'On upstream' : 'Not on configured upstream'}
              >
                {commit.pushed ? (
                  <Cloud size={14} strokeWidth={2} />
                ) : (
                  <Milestone size={14} strokeWidth={2} />
                )}
              </span>
              <span className="git-commit-message">{commit.message}</span>
              <span className="git-commit-hash">{commit.shortHash}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export function GitPanel() {
  const location = useActiveProjectLocation()
  // `projectPath` is the folder as shown; `folderId` is what its Git state and running actions are cached under.
  const { path: projectPath, key: folderId, projectId, workspaceThreadId } = location
  // The folder on screen now: a Git action that finishes after the panel moved on reports nothing here.
  const folderRef = useRef(folderId)
  folderRef.current = folderId
  // Tells the daemon which folder a Git action belongs to; a thread's own worktree gets the thread's rules.
  const scope = useMemo(() => gitScopeFor({ projectId, workspaceThreadId }), [projectId, workspaceThreadId])
  const projects = useAppStore((state) => state.projects)
  const activeProject = useMemo(
    () => projects.find((project) => project.id === projectId) ?? projects.find((project) => project.path === projectPath),
    [projectId, projectPath, projects]
  )
  const { status, commits, loading, refresh } = useGitStatus(folderId, scope)
  const reviewIgnoreWhitespace = useAppStore((state) => state.reviewIgnoreWhitespace)
  // The daemon resolves the folder the status came from: a thread's worktree through the thread,
  // any other project folder through the project.
  const threadInProject = useAppStore((state) => {
    const thread = state.threads.find((item) => item.id === state.activeThreadId)
    return thread && thread.projectId && thread.projectId === projectId ? thread.id : null
  })
  const reviewTarget = useMemo(
    () => (threadInProject ? { threadId: threadInProject } : projectId ? { projectId } : null),
    [threadInProject, projectId]
  )
  // Reload the open diff in place whenever the status refreshes.
  const [diffVersion, setDiffVersion] = useState(0)
  useEffect(() => setDiffVersion((value) => value + 1), [status])
  const [selected, setSelected] = useState<SelectedFile | null>(null)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  // The pull request and branch actions of the thread in view: the same reads the side card makes.
  const activeThreadId = useAppStore((state) => state.activeThreadId)
  const activeThread = useAppStore((state) => state.threads.find((item) => item.id === state.activeThreadId))
  const source = useActiveThreadPullRequest(activeThreadId)
  const pullRequestPushTarget = usePullRequestPushTarget(source.location.workspaceThreadId, source.link)
  const [actionError, setActionError] = useTransientError()
  const [actionNotice, setActionNotice] = useTransientError(NOTICE_MS)
  // The question a discard is waiting on, answered in the app's own dialog, and how to give the answer back.
  const [discardQuestion, setDiscardQuestion] = useState<DiscardQuestion | null>(null)
  const discardAnswerRef = useRef<((confirmed: boolean) => void) | null>(null)
  const [activity, setActivity] = useState<SyncActivity>(IDLE_SYNC_ACTIVITY)
  const [rowError, setRowError] = useState('')
  // What the last discard kept, and how to bring a file back.
  const [rowNotice, setRowNotice] = useState('')
  // Paths the last discard left as they are, because they changed after Discard was pressed.
  const [rowLeft, setRowLeft] = useState('')
  // One Git action at a time across the file rows, Fetch and Pull, and Commit, Push and Create PR.
  const { running, begin, end } = useGitActionRunner()
  const busy = running !== null
  const [githubStatus, setGithubStatus] = useState<GitHubAvailability | null>(null)
  const [githubBusy, setGithubBusy] = useState(false)
  const [githubError, setGithubError] = useState('')
  const [githubNotice, setGithubNotice] = useState('')
  const [repositoryName, setRepositoryName] = useState('')
  const [visibility, setVisibility] = useState<GitHubRepositoryVisibility>('private')
  const [cloneRepository, setCloneRepository] = useState('')
  const [cloneDestination, setCloneDestination] = useState('')
  // Empty until a divider is dragged: every section fits its content.
  const [sectionFlex, setSectionFlex] = useState<SectionSizes>({})
  const sectionElsRef = useRef<Partial<Record<GitSectionId, HTMLDivElement | null>>>({})
  const draggingDivider = useRef<{ upper: GitSectionId; lower: GitSectionId } | null>(null)

  // Resolves once the person answers; the file action holds the lock until then, so nothing else starts meanwhile.
  const askDiscard = useCallback((message: string, action: DiscardQuestion['action']) => new Promise<boolean>((resolve) => {
    discardAnswerRef.current = resolve
    setDiscardQuestion({ message, action })
  }), [])
  const answerDiscard = useCallback((confirmed: boolean) => {
    const answer = discardAnswerRef.current
    discardAnswerRef.current = null
    setDiscardQuestion(null)
    answer?.(confirmed)
  }, [])

  useEffect(() => {
    setSelected(null)
    setGithubError('')
    setGithubNotice('')
    setActivity(IDLE_SYNC_ACTIVITY)
    setRowError('')
    setRowNotice('')
    setRowLeft('')
    setActionError(null)
    setActionNotice(null)
    // A question about the files of another folder is no longer the one on screen.
    answerDiscard(false)
    // Heights dragged for one folder's lists say nothing about another's.
    setSectionFlex({})
  }, [answerDiscard, folderId, setActionError, setActionNotice])

  // A file that is no longer listed (staged, discarded or committed elsewhere) has no diff to show.
  useEffect(() => {
    if (!status?.isRepo) return
    setSelected((current) =>
      current && !status.changes.some((change) => change.path === current.path && change.staged === current.staged) ? null : current
    )
  }, [status])

  const withBusy = useCallback(async (action: 'files' | 'sync', run: () => Promise<void>) => {
    if (!begin(action)) return
    try {
      await run()
    } finally {
      end()
    }
  }, [begin, end])

  const runSyncAction = useCallback((request: SyncRequest) => {
    if (!folderId) return
    void withBusy('sync', () => runSync(folderId, scope, request, whileFolder(folderRef, folderId, setActivity)))
  }, [folderId, scope, withBusy])

  const runFileRequest = useCallback((request: RowRequest) => {
    if (!folderId) return
    setRowError('')
    setRowNotice('')
    setRowLeft('')
    // The open file as it was when the button was pressed: the refresh after the action drops a row that moved, so it is read first.
    const before = selectedRef.current
    void withBusy('files', async () => {
      const outcome = await runRowAction(folderId, scope, request, {
        discardKeptForMs: status?.discardKeptForMs,
        confirm: (message) => askDiscard(message, discardConfirmLabel(request.files === 'all' ? [] : request.files))
      })
      if (folderRef.current !== folderId) return
      if (outcome.kind === 'failed') {
        setRowError(outcome.message)
      } else if (outcome.kind === 'done') {
        if (outcome.notice) setRowNotice(outcome.notice)
        if (outcome.left) setRowLeft(outcome.left)
        const paths = request.files === 'all' ? 'all' : request.files.map((file) => file.path)
        const followed = selectionAfterAction(before, request.action, paths)
        // Another row opened meanwhile stays open.
        setSelected((current) => (current === null || current === before ? followed : current))
      }
    })
  }, [askDiscard, folderId, scope, status?.discardKeptForMs, withBusy])

  const onRowAction = useCallback((action: RowAction, file: GitFileChange) => {
    runFileRequest({ action, files: [file] })
  }, [runFileRequest])

  const onSectionAction = useCallback((action: SectionAction, files: GitFileChange[]) => {
    runFileRequest(action === 'unstage-all' ? { action: 'unstage', files: 'all' } : { action: 'stage', files })
  }, [runFileRequest])

  useEffect(() => {
    setRepositoryName(activeProject?.name.replace(/[^A-Za-z0-9._-]/g, '-') ?? '')
  }, [activeProject?.id, activeProject?.name])

  const refreshGitHubStatus = useCallback(async () => {
    try {
      setGithubStatus(await window.mousse.github.status())
    } catch (error) {
      setGithubStatus({ state: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  const notRepo = status !== null && !status.isRepo
  useEffect(() => {
    if (projectPath && notRepo) void refreshGitHubStatus()
  }, [projectPath, refreshGitHubStatus, notRepo])

  const createGitHubRepository = useCallback(async () => {
    if (!activeProject) {
      setGithubError('The selected folder is not associated with a project.')
      return
    }
    setGithubBusy(true)
    setGithubError('')
    setGithubNotice('')
    try {
      const result = await window.mousse.github.createRepository({
        projectId: activeProject.id,
        name: repositoryName.trim(),
        visibility
      })
      setGithubNotice(result.repositoryUrl
        ? `Created ${result.repositoryUrl}. No commits were pushed.`
        : 'GitHub repository created and connected as origin. No commits were pushed.')
      await refresh()
    } catch (error) {
      setGithubError(error instanceof Error ? error.message : String(error))
    } finally {
      setGithubBusy(false)
      void refreshGitHubStatus()
    }
  }, [activeProject, refresh, refreshGitHubStatus, repositoryName, visibility])

  const chooseCloneDestination = useCallback(async () => {
    const selectedPath = await window.mousse.github.chooseCloneDestination()
    if (selectedPath) setCloneDestination(selectedPath)
  }, [])

  const cloneGitHubRepository = useCallback(async () => {
    setGithubBusy(true)
    setGithubError('')
    setGithubNotice('')
    try {
      const result = await window.mousse.github.cloneRepository({
        repository: cloneRepository.trim(),
        destination: cloneDestination.trim()
      })
      setGithubNotice(`Cloned to ${result.project.path} and added it as a Mousse project.`)
      await window.mousse.threads.createAndSelect('New Chat', result.project.id)
    } catch (error) {
      setGithubError(error instanceof Error ? error.message : String(error))
    } finally {
      setGithubBusy(false)
      void refreshGitHubStatus()
    }
  }, [cloneDestination, cloneRepository, refreshGitHubStatus])

  // The first drag or key press takes each shown section's current height as its weight, so nothing
  // jumps when the sections stop fitting their content.
  const withMeasuredSizes = useCallback((prev: SectionSizes): SectionSizes => {
    const next: SectionSizes = { ...prev }
    for (const [id, el] of Object.entries(sectionElsRef.current) as [GitSectionId, HTMLDivElement | null][]) {
      if (el && next[id] === undefined) next[id] = el.getBoundingClientRect().height
    }
    return next
  }, [])

  const onDividerMouseDown = useCallback((upper: GitSectionId, lower: GitSectionId) => {
    setSectionFlex(withMeasuredSizes)
    draggingDivider.current = { upper, lower }
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }, [withMeasuredSizes])

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      const drag = draggingDivider.current
      if (!drag) return
      const upperEl = sectionElsRef.current[drag.upper]
      const lowerEl = sectionElsRef.current[drag.lower]
      if (!upperEl || !lowerEl) return

      const upperRect = upperEl.getBoundingClientRect()
      const lowerRect = lowerEl.getBoundingClientRect()
      const totalHeight = upperRect.height + lowerRect.height
      if (totalHeight <= 0) return

      const ratio = (event.clientY - upperRect.top) / totalHeight
      setSectionFlex((prev) => resizeSectionPair(prev, drag.upper, drag.lower, ratio))
    }

    const onMouseUp = () => {
      if (!draggingDivider.current) return
      draggingDivider.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  // Arrow keys, Home and End on a divider: measure first (as a drag does), then move the pair.
  const onDividerResize = useCallback((upper: GitSectionId, lower: GitSectionId, key: string) => {
    setSectionFlex((prev) => {
      const measured = withMeasuredSizes(prev)
      const ratio = keyedSectionRatio(sectionPairRatio(measured, upper, lower), key)
      return ratio === null ? prev : resizeSectionPair(measured, upper, lower, ratio)
    })
  }, [withMeasuredSizes])

  const bindSectionRef = (id: GitSectionId) => (el: HTMLDivElement | null) => {
    sectionElsRef.current[id] = el
  }

  const renderSidebarBody = () => {
    if (!folderId) return <div className="git-empty">No project open</div>
    if (loading) return <div className="git-empty"><DelayedLoader label="Loading Git status" /></div>
    if (!status?.isRepo) return (
      <div className="github-setup">
        <div className="github-setup-heading"><Cloud size={16} /> Not a Git repository</div>
        <p>Create a GitHub repository for this project, or clone into a separate empty folder.</p>
        <div className={`github-status github-status-${githubStatus?.state ?? 'busy'}`}>
          {githubStatus?.message ?? 'Checking GitHub CLI…'}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void refreshGitHubStatus()} disabled={githubBusy}>Check again</button>
        </div>
        {githubError ? <div className="github-message github-error" role="alert">{githubError}</div> : null}
        {githubNotice ? <div className="github-message github-notice" role="status">{githubNotice}</div> : null}

        <section className="github-flow">
          <h3>Create GitHub repository</h3>
          <p>Initializes Git locally, creates the remote, and adds <code>origin</code>. Existing files and commits are not pushed.</p>
          <label>Repository name<input value={repositoryName} onChange={(event) => setRepositoryName(event.target.value)} disabled={githubBusy} /></label>
          <label>Visibility<select value={visibility} onChange={(event) => setVisibility(event.target.value as GitHubRepositoryVisibility)} disabled={githubBusy}><option value="private">Private</option><option value="public">Public</option></select></label>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void createGitHubRepository()} disabled={githubBusy || githubStatus?.state !== 'ready' || !repositoryName.trim() || !activeProject}>
            <Cloud size={14} /> {githubBusy ? 'Working…' : 'Create repository'}
          </button>
        </section>

        <section className="github-flow">
          <h3>Clone repository</h3>
          <p>Choose a new or empty folder. Mousse will never overwrite nonempty project content and will add the clone as a project.</p>
          <label>GitHub repository<input placeholder="owner/repository" value={cloneRepository} onChange={(event) => setCloneRepository(event.target.value)} disabled={githubBusy} /></label>
          <label>Destination<div className="github-destination"><input value={cloneDestination} readOnly placeholder="Choose an empty folder" /><button type="button" className="btn btn-ghost btn-sm" onClick={() => void chooseCloneDestination()} disabled={githubBusy} title="Choose destination"><FolderOpen size={14} /></button></div></label>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void cloneGitHubRepository()} disabled={githubBusy || githubStatus?.state !== 'ready' || !cloneRepository.trim() || !cloneDestination.trim()}>
            <Download size={14} /> {githubBusy ? 'Working…' : 'Clone and open project'}
          </button>
        </section>
      </div>
    )

    return (
      <>
        <GitChangesList
          changes={status.changes}
          selected={selected}
          onSelect={(path, staged) => setSelected({ path, staged })}
          scope={scope}
          busy={busy}
          onRowAction={onRowAction}
          onSectionAction={onSectionAction}
          flex={sectionFlex}
          bindSectionRef={bindSectionRef}
          onDividerMouseDown={onDividerMouseDown}
          onDividerResize={onDividerResize}
        />
        <CommitsSection commits={commits} flex={sectionFlex.commits} sectionRef={bindSectionRef('commits')} />
      </>
    )
  }

  // Commit, Push and Create PR act on the folder the side card shows; a folder of no project has none of them.
  const actionsReady = folderId !== null && source.path === folderId && status?.isRepo === true
  const actionModel = actionsReady
    ? gitActionRowModel({
      path: folderId,
      scope,
      projectId,
      ownThreadId: source.ownThreadId,
      status,
      commitCount: source.git.commits.length,
      pullRequest: source.lookup,
      pullRequestPushTarget
    })
    : null
  const branchName = status?.branch ?? (status?.tracking === 'detached' ? 'Detached HEAD' : '—')
  // The folder the branch is in stays named beside it, so two folders on the same branch are told apart.
  const folder = folderName(projectPath)
  // Where the actions run: the branch, the folder, the thread's own worktree when it is one; the computer's badge follows.
  const where = [branchName, projectPath, workspaceThreadId ? "Thread's worktree" : null].filter(Boolean).join(' · ')

  return (
    <div className="git-panel">
      <ResizablePanelSidebar className="git-sidebar" defaultWidth={300}>
        <div className="panel-toolbar">
          <div className="git-toolbar-info" title={where}>
            <GitBranch size={14} aria-hidden="true" />
            <span className="git-toolbar-branch">{branchName}</span>
            {folder && (
              <span className="git-toolbar-folder">
                <Folder size={12} strokeWidth={2} aria-hidden="true" />
                <span className="git-toolbar-folder-name">{folder}</span>
              </span>
            )}
            {activeThread?.node && <ThreadComputerBadge thread={activeThread} withName className="git-toolbar-computer" />}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void refresh()}
            disabled={loading}
            title="Refresh"
            aria-label="Refresh Git status"
          >
            <RefreshCw size={14} strokeWidth={2} />
          </button>
        </div>

        {folderId && !loading && (
          <GitSyncBar
            status={status}
            scope={scope}
            activity={activity}
            busy={busy}
            onFetch={() => runSyncAction({ action: 'fetch' })}
            onPull={(strategy) => runSyncAction({ action: 'pull', strategy })}
            onAbort={(kind) => runSyncAction({ action: 'abort', kind })}
          />
        )}
        <GitOperationStatus path={folderId} />
        {rowError && <div className="git-changes-error" role="alert">{rowError}</div>}
        {rowLeft && <div className="git-changes-left" role="status">{rowLeft}</div>}
        {rowNotice && <div className="git-changes-notice" role="status">{rowNotice}</div>}

        <div className="git-changes">{renderSidebarBody()}</div>
      </ResizablePanelSidebar>

      <div className="git-diff">
        <div className="panel-toolbar git-diff-toolbar">
          <span className="panel-toolbar-path">
            {selected ? `${selected.staged ? 'Staged' : 'Unstaged'}: ${selected.path}` : 'Diff'}
          </span>
          <DiffOptionsMenu />
          {actionModel && folderId && (
            <GitActionButtons
              host="git-panel"
              path={folderId}
              scope={scope}
              git={source.git}
              model={actionModel}
              running={running}
              begin={begin}
              end={end}
              onActionError={setActionError}
              onNotice={setActionNotice}
              className="git-diff-actions"
              label={`Git actions for ${where}`}
            />
          )}
        </div>
        {actionModel?.pushButton?.note && <p className="git-diff-message">{actionModel.pushButton.note}</p>}
        {actionError && <p className="git-diff-message git-diff-error" role="alert" title={actionError}>{actionError}</p>}
        {actionNotice && <p className="git-diff-message" role="status" title={actionNotice}>{actionNotice}</p>}
        {selected && !reviewTarget ? (
          <div className="git-diff-empty">This folder does not belong to a project, so its diff is not available.</div>
        ) : (
          <ReviewDiffPane
            target={{ ...reviewTarget, scope: { kind: 'worktree', staged: selected?.staged } }}
            path={selected?.path ?? null}
            version={diffVersion}
            ignoreWhitespace={reviewIgnoreWhitespace}
          />
        )}
      </div>
      <DiscardConfirmDialog question={discardQuestion} onAnswer={answerDiscard} />
    </div>
  )
}
