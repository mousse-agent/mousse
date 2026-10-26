import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Cloud, Download, FolderOpen, GitBranch, Milestone, RefreshCw } from '../lib/icons'
import type { GitCommit, GitFileChange } from '../../shared/types'
import type { GitHubAvailability, GitHubRepositoryVisibility } from '../../shared/github'
import { useActiveProjectLocation } from '../hooks/useActiveProjectPath'
import { useAppStore } from '../stores/appStore'
import { useGitStatus } from '../stores/gitStatusStore'
import { ResizablePanelSidebar } from './ResizablePanelSidebar'
import { ReviewDiffPane, WhitespaceToggle } from './review/ReviewDiffPane'

const STATUS_LABELS: Record<GitFileChange['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'U',
  ignored: 'I',
  conflicted: '!'
}

const MIN_SECTION_RATIO = 0.15
const MAX_SECTION_RATIO = 0.85

type GitSectionId = 'staged' | 'changes' | 'untracked' | 'commits'

function groupChanges(changes: GitFileChange[]) {
  const staged = changes.filter((c) => c.staged && c.status !== 'untracked')
  const unstaged = changes.filter((c) => !c.staged && c.status !== 'untracked' && c.status !== 'ignored')
  const untracked = changes.filter((c) => c.status === 'untracked')
  return { staged, unstaged, untracked }
}

function ChangeSection({
  title,
  items,
  selected,
  onSelect,
  flex,
  sectionRef
}: {
  title: string
  items: GitFileChange[]
  selected: { path: string; staged: boolean } | null
  onSelect: (path: string, staged: boolean) => void
  flex: number
  sectionRef?: (el: HTMLDivElement | null) => void
}) {
  return (
    <div className="git-section" style={{ flex: `${flex} 1 0` }} ref={sectionRef}>
      <div className="git-section-title">{title}</div>
      <div className="git-section-list">
        {items.map((item) => (
          <button
            key={`${item.staged}-${item.path}`}
            type="button"
            className={`git-file-row${
              selected?.path === item.path && selected.staged === item.staged ? ' selected' : ''
            }`}
            onClick={() => onSelect(item.path, item.staged)}
          >
            <span className={`git-status-badge status-${item.status}`}>
              {STATUS_LABELS[item.status]}
            </span>
            <span className="git-file-path">{item.path}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

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
  const { path: projectPath, projectId } = useActiveProjectLocation()
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
  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null)
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
    commits: 1
  })
  const sectionElsRef = useRef<Partial<Record<GitSectionId, HTMLDivElement | null>>>({})
  const draggingDivider = useRef<{ upper: GitSectionId; lower: GitSectionId } | null>(null)

  useEffect(() => {
    setSelected(null)
    setGithubError('')
    setGithubNotice('')
  }, [projectPath])

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

  const groups = useMemo(
    () => (status?.changes ? groupChanges(status.changes) : null),
    [status?.changes]
  )

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

    const nodes: ReactNode[] = []
    const fileSectionCount =
      (groups?.staged.length ? 1 : 0) +
      (groups?.unstaged.length ? 1 : 0) +
      (groups?.untracked.length ? 1 : 0)

    if (fileSectionCount === 0) {
      nodes.push(
        <div key="clean" className="git-empty git-empty-nested">
          Working tree clean
        </div>
      )
    }

    const pushDivider = (upper: GitSectionId, lower: GitSectionId, upperTitle: string, lowerTitle: string) => {
      nodes.push(
        <div
          key={`divider-${upper}-${lower}`}
          className="git-section-divider"
          onMouseDown={() => onDividerMouseDown(upper, lower)}
          role="separator"
          aria-orientation="horizontal"
          aria-label={`Resize ${upperTitle} and ${lowerTitle} sections`}
        />
      )
    }

    let previousId: GitSectionId | null = null
    let previousTitle = ''

    if (groups?.staged.length) {
      if (previousId) pushDivider(previousId, 'staged', previousTitle, 'Staged')
      nodes.push(
        <ChangeSection
          key="staged"
          title="Staged"
          items={groups.staged}
          selected={selected}
          onSelect={(path, staged) => setSelected({ path, staged })}
          flex={sectionFlex.staged}
          sectionRef={bindSectionRef('staged')}
        />
      )
      previousId = 'staged'
      previousTitle = 'Staged'
    }

    if (groups?.unstaged.length) {
      if (previousId) pushDivider(previousId, 'changes', previousTitle, 'Changes')
      nodes.push(
        <ChangeSection
          key="changes"
          title="Changes"
          items={groups.unstaged}
          selected={selected}
          onSelect={(path, staged) => setSelected({ path, staged })}
          flex={sectionFlex.changes}
          sectionRef={bindSectionRef('changes')}
        />
      )
      previousId = 'changes'
      previousTitle = 'Changes'
    }

    if (groups?.untracked.length) {
      if (previousId) pushDivider(previousId, 'untracked', previousTitle, 'Untracked')
      nodes.push(
        <ChangeSection
          key="untracked"
          title="Untracked"
          items={groups.untracked}
          selected={selected}
          onSelect={(path, staged) => setSelected({ path, staged })}
          flex={sectionFlex.untracked}
          sectionRef={bindSectionRef('untracked')}
        />
      )
      previousId = 'untracked'
      previousTitle = 'Untracked'
    }

    if (previousId) pushDivider(previousId, 'commits', previousTitle, 'Commits')
    nodes.push(
      <CommitsSection
        key="commits"
        commits={commits}
        flex={sectionFlex.commits}
        sectionRef={bindSectionRef('commits')}
      />
    )

    return nodes
  }

  return (
    <div className="git-panel">
      <ResizablePanelSidebar className="git-sidebar" defaultWidth={300}>
        <div className="panel-toolbar">
          <div className="git-toolbar-info">
            <GitBranch size={14} />
            <span>{status?.branch ?? (status?.tracking === 'detached' ? 'Detached HEAD' : '—')}</span>
            {status?.isRepo && <span className="text-secondary" title={status.upstream ?? undefined}>{status.upstream ?? (status.tracking === 'unborn' ? 'No commits yet' : status.tracking === 'detached' ? 'No branch' : 'No upstream')}</span>}
            {status?.ahead ? <span className="badge">↑{status.ahead}</span> : null}
            {status?.behind ? <span className="badge">↓{status.behind}</span> : null}
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
