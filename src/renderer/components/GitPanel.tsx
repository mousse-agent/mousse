import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Cloud, Download, FolderOpen, GitBranch, Milestone, RefreshCw } from '../lib/icons'
import type { GitCommit, GitFileChange } from '../../shared/types'
import type { GitHubAvailability, GitHubRepositoryVisibility } from '../../shared/github'
import { gitScopeFor } from '../lib/activeProject'
import { useActiveProjectLocation } from '../hooks/useActiveProjectPath'
import { useAppStore } from '../stores/appStore'
import { useGitStatus } from '../stores/gitStatusStore'
import { GitChangesList, type SelectedFile } from './git/GitChangesList'
import { runRowAction, runSync, type RowRequest, type SyncRequest } from './git/gitPanelActions'
import {
  IDLE_SYNC_ACTIVITY,
  selectionAfterAction,
  type GitSectionId,
  type RowAction,
  type SectionAction,
  type SyncActivity
} from './git/gitPanelLogic'
import { GitOperationStatus } from './git/GitOperationStatus'
import { GitSyncBar } from './git/GitSyncBar'
import { ResizablePanelSidebar } from './ResizablePanelSidebar'
import { ReviewDiffPane, WhitespaceToggle } from './review/ReviewDiffPane'

const MIN_SECTION_RATIO = 0.15
const MAX_SECTION_RATIO = 0.85

function CommitsSection({
  commits,
  flex,
  sectionRef
}: {
  commits: GitCommit[]
  flex: number
  sectionRef?: (el: HTMLDivElement | null) => void
}) {
  return (
    <div className="git-section" style={{ flex: `${flex} 1 0` }} ref={sectionRef}>
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
  const { path: projectPath, projectId, workspaceThreadId } = location
  // Tells the daemon which folder a Git action belongs to; a thread's own worktree gets the thread's rules.
  const scope = useMemo(() => gitScopeFor({ projectId, workspaceThreadId }), [projectId, workspaceThreadId])
  const projects = useAppStore((state) => state.projects)
  const activeProject = useMemo(
    () => projects.find((project) => project.id === projectId) ?? projects.find((project) => project.path === projectPath),
    [projectId, projectPath, projects]
  )
  const { status, commits, loading, refresh } = useGitStatus(projectPath)
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
  const [activity, setActivity] = useState<SyncActivity>(IDLE_SYNC_ACTIVITY)
  const [rowError, setRowError] = useState('')
  // One Git action at a time: the ref answers a second click before the state has rendered.
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [githubStatus, setGithubStatus] = useState<GitHubAvailability | null>(null)
  const [githubBusy, setGithubBusy] = useState(false)
  const [githubError, setGithubError] = useState('')
  const [githubNotice, setGithubNotice] = useState('')
  const [repositoryName, setRepositoryName] = useState('')
  const [visibility, setVisibility] = useState<GitHubRepositoryVisibility>('private')
  const [cloneRepository, setCloneRepository] = useState('')
  const [cloneDestination, setCloneDestination] = useState('')
  const [sectionFlex, setSectionFlex] = useState<Record<GitSectionId, number>>({
    staged: 1,
    changes: 1,
    untracked: 1,
    conflicts: 1,
    commits: 1
  })
  const sectionElsRef = useRef<Partial<Record<GitSectionId, HTMLDivElement | null>>>({})
  const draggingDivider = useRef<{ upper: GitSectionId; lower: GitSectionId } | null>(null)

  useEffect(() => {
    setSelected(null)
    setGithubError('')
    setGithubNotice('')
    setActivity(IDLE_SYNC_ACTIVITY)
    setRowError('')
  }, [projectPath])

  // A file that is no longer listed (staged, discarded or committed elsewhere) has no diff to show.
  useEffect(() => {
    if (!status?.isRepo) return
    setSelected((current) =>
      current && !status.changes.some((change) => change.path === current.path && change.staged === current.staged) ? null : current
    )
  }, [status])

  const withBusy = useCallback(async (run: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await run()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [])

  const runSyncAction = useCallback((request: SyncRequest) => {
    if (!projectPath) return
    void withBusy(() => runSync(projectPath, scope, request, setActivity))
  }, [projectPath, scope, withBusy])

  const runFileRequest = useCallback((request: RowRequest) => {
    if (!projectPath) return
    setRowError('')
    // The open file as it was when the button was pressed: the refresh after the action drops a row that moved, so it is read first.
    const before = selectedRef.current
    void withBusy(async () => {
      const outcome = await runRowAction(projectPath, scope, request)
      if (outcome.kind === 'failed') {
        setRowError(outcome.message)
      } else if (outcome.kind === 'done') {
        const paths = request.files === 'all' ? 'all' : request.files.map((file) => file.path)
        const followed = selectionAfterAction(before, request.action, paths)
        // Another row opened meanwhile stays open.
        setSelected((current) => (current === null || current === before ? followed : current))
      }
    })
  }, [projectPath, scope, withBusy])

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

  const onDividerMouseDown = useCallback((upper: GitSectionId, lower: GitSectionId) => {
    draggingDivider.current = { upper, lower }
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }, [])

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

      const rawRatio = (event.clientY - upperRect.top) / totalHeight
      const ratio = Math.min(MAX_SECTION_RATIO, Math.max(MIN_SECTION_RATIO, rawRatio))

      setSectionFlex((prev) => {
        const pairTotal = prev[drag.upper] + prev[drag.lower]
        return {
          ...prev,
          [drag.upper]: pairTotal * ratio,
          [drag.lower]: pairTotal * (1 - ratio)
        }
      })
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

  const bindSectionRef = (id: GitSectionId) => (el: HTMLDivElement | null) => {
    sectionElsRef.current[id] = el
  }

  const renderSidebarBody = () => {
    if (!projectPath) return <div className="git-empty">No project open</div>
    if (loading) return <div className="git-empty">Loading…</div>
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
        />
        <CommitsSection commits={commits} flex={sectionFlex.commits} sectionRef={bindSectionRef('commits')} />
      </>
    )
  }

  return (
    <div className="git-panel">
      <ResizablePanelSidebar className="git-sidebar" defaultWidth={300}>
        <div className="panel-toolbar">
          <div className="git-toolbar-info">
            <GitBranch size={14} />
            <span>{status?.branch ?? (status?.tracking === 'detached' ? 'Detached HEAD' : '—')}</span>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void refresh()}
            disabled={loading}
            title="Refresh"
          >
            <RefreshCw size={14} strokeWidth={2} />
          </button>
        </div>

        {projectPath && !loading && (
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
        <GitOperationStatus path={projectPath} />
        {rowError && <div className="git-changes-error" role="alert">{rowError}</div>}

        <div className="git-changes">{renderSidebarBody()}</div>
      </ResizablePanelSidebar>

      <div className="git-diff">
        <div className="panel-toolbar">
          <span className="panel-toolbar-path">
            {selected ? `${selected.staged ? 'Staged' : 'Unstaged'}: ${selected.path}` : 'Diff'}
          </span>
          <WhitespaceToggle />
        </div>
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
    </div>
  )
}
