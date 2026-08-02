import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  GitBranch,
  GitCommitHorizontal,
  SquarePlus
} from 'lucide-react'
import type { Agent, GitBranchInfo, GitDiffStats, GitStatusSnapshot } from '../../shared/types'

interface WorktreeOption {
  id: string
  label: string
  cwd: string
  branch: string
  kind: 'local' | 'agent'
}

interface EnvironmentSectionProps {
  agents: Agent[]
}

export function EnvironmentSection({ agents }: EnvironmentSectionProps) {
  const [localCwd, setLocalCwd] = useState<string | null>(null)
  const [localBranches, setLocalBranches] = useState<GitBranchInfo | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [status, setStatus] = useState<GitStatusSnapshot | null>(null)
  const [diffStats, setDiffStats] = useState<GitDiffStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)

  useEffect(() => {
    void Promise.all([
      window.mousse.app.getActiveProjectPath(),
      window.mousse.app.getInfo()
    ]).then(async ([projectPath, info]) => {
      const cwd = projectPath ?? info.repoRoot
      setLocalCwd(cwd)
      const branches = await window.mousse.git.branches(undefined, cwd)
      setLocalBranches(branches)
      if (branches.current) {
        setSelectedId(`local:${branches.current}`)
      }
    })
  }, [])

  const worktreeOptions = useMemo<WorktreeOption[]>(() => {
    const options: WorktreeOption[] = []

    if (localCwd && localBranches) {
      for (const branch of localBranches.branches) {
        options.push({
          id: `local:${branch}`,
          label: branch,
          cwd: localCwd,
          branch,
          kind: 'local'
        })
      }
    }

    for (const agent of agents) {
      // Successful integration removes the isolated worktree. Do not retain a selector
      // option whose cwd can no longer exist; failed/cancelled agents remain recoverable.
      if (agent.status === 'completed') continue
      options.push({
        id: `agent:${agent.id}`,
        label: agent.branch,
        cwd: agent.worktreePath,
        branch: agent.branch,
        kind: 'agent'
      })
    }

    return options
  }, [agents, localBranches, localCwd])

  const selectedWorktree =
    worktreeOptions.find((option) => option.id === selectedId) ?? worktreeOptions[0] ?? null

  useEffect(() => {
    if (worktreeOptions.length === 0) return
    if (!selectedId || !worktreeOptions.some((option) => option.id === selectedId)) {
      const currentLocal = localBranches?.current
      const fallback =
        (currentLocal ? worktreeOptions.find((o) => o.id === `local:${currentLocal}`) : null) ??
        worktreeOptions[0]
      setSelectedId(fallback.id)
    }
  }, [worktreeOptions, selectedId, localBranches?.current])

  const refresh = useCallback(async () => {
    if (!selectedWorktree) {
      setStatus(null)
      setDiffStats(null)
      return
    }

    setLoading(true)
    try {
      const [nextStatus, nextDiffStats] = await Promise.all([
        window.mousse.git.status(undefined, selectedWorktree.cwd),
        window.mousse.git.diffStats(undefined, selectedWorktree.cwd)
      ])
      setStatus(nextStatus)
      setDiffStats(nextDiffStats)
    } finally {
      setLoading(false)
    }
  }, [selectedWorktree])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openGitView = () => {
    void window.mousse.window.focusMain()
    void window.mousse.app.navigateMainView('git')
  }

  const handleWorktreeChange = async (id: string) => {
    const option = worktreeOptions.find((entry) => entry.id === id)
    if (!option || id === selectedId) return

    setLoading(true)
    try {
      if (option.kind === 'local' && option.branch !== localBranches?.current) {
        await window.mousse.git.checkout(option.branch, undefined, option.cwd)
        const branches = await window.mousse.git.branches(undefined, option.cwd)
        setLocalBranches(branches)
      }
      setSelectedId(id)
    } finally {
      setLoading(false)
    }
  }

  const handleCommitOrPush = async () => {
    if (!selectedWorktree || actionBusy) return

    const hasChanges = (diffStats?.filesChanged ?? 0) > 0
    const ahead = status?.ahead ?? 0

    if (!hasChanges && ahead === 0) return

    setActionBusy(true)
    try {
      if (hasChanges) {
        const defaultMessage = `Update ${selectedWorktree.branch}`
        const message = window.prompt('Commit message', defaultMessage)?.trim()
        if (!message) return
        await window.mousse.git.commit(message, undefined, selectedWorktree.cwd)
      }
      if (hasChanges || ahead > 0) {
        await window.mousse.git.push(undefined, selectedWorktree.cwd)
      }
      await refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      window.alert(msg)
    } finally {
      setActionBusy(false)
    }
  }

  const canCommitOrPush =
    (diffStats?.filesChanged ?? 0) > 0 || (status?.ahead ?? 0) > 0

  return (
    <section className="agents-tasks-section agents-tasks-environment">
      <h3 className="agents-tasks-section-title">Environment</h3>

      <ul className="agents-tasks-environment-list">
        <li>
          <button
            type="button"
            className="agents-tasks-environment-row"
            onClick={openGitView}
            disabled={!selectedWorktree || loading}
          >
            <span className="agents-tasks-environment-icon">
              <SquarePlus size={14} strokeWidth={2} />
            </span>
            <span className="agents-tasks-environment-label">Changes</span>
            <span className="agents-tasks-environment-stats">
              <span className="agents-tasks-environment-stat-add">
                +{diffStats?.additions ?? 0}
              </span>
              <span className="agents-tasks-environment-stat-del">
                -{diffStats?.deletions ?? 0}
              </span>
            </span>
          </button>
        </li>

        <li className="agents-tasks-environment-select-row">
          <span className="agents-tasks-environment-icon">
            <GitBranch size={14} strokeWidth={2} />
          </span>
          <label className="agents-tasks-environment-select-label">
            <span className="agents-tasks-environment-label">
              {selectedWorktree?.label ?? '—'}
            </span>
            <select
              className="agents-tasks-environment-select"
              value={selectedId ?? ''}
              disabled={worktreeOptions.length === 0 || loading}
              onChange={(event) => void handleWorktreeChange(event.target.value)}
              aria-label="Branch or worktree"
            >
              {worktreeOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.kind === 'agent' ? `${option.label} (worktree)` : option.label}
                </option>
              ))}
            </select>
            <ChevronDown size={12} strokeWidth={2} className="agents-tasks-environment-chevron" />
          </label>
        </li>

        <li>
          <button
            type="button"
            className="agents-tasks-environment-row"
            disabled={!canCommitOrPush || actionBusy || !selectedWorktree}
            onClick={() => void handleCommitOrPush()}
          >
            <span className="agents-tasks-environment-icon">
              <GitCommitHorizontal size={14} strokeWidth={2} />
            </span>
            <span className="agents-tasks-environment-label">
              {actionBusy ? 'Working…' : 'Commit or push'}
            </span>
          </button>
        </li>
      </ul>
    </section>
  )
}
