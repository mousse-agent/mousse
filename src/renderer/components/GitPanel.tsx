import { useCallback, useEffect, useMemo, useState } from 'react'
import { GitBranch, RefreshCw } from 'lucide-react'
import type { GitFileChange, GitStatusSnapshot } from '../../shared/types'
import { useActiveProjectPath } from '../hooks/useActiveProjectPath'

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
  onSelect
}: {
  title: string
  items: GitFileChange[]
  selected: { path: string; staged: boolean } | null
  onSelect: (path: string, staged: boolean) => void
}) {
  if (items.length === 0) return null
  return (
    <div className="git-section">
      <div className="git-section-title">{title}</div>
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
  )
}

export function GitPanel() {
  const projectPath = useActiveProjectPath()
  const [status, setStatus] = useState<GitStatusSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null)
  const [diff, setDiff] = useState('')
  const [diffLoading, setDiffLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!projectPath) {
      setStatus(null)
      return
    }
    setLoading(true)
    try {
      const snapshot = await window.mousse.git.status()
      setStatus(snapshot)
    } finally {
      setLoading(false)
    }
  }, [projectPath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const loadDiff = useCallback(async (path: string, staged: boolean) => {
    setSelected({ path, staged })
    setDiffLoading(true)
    try {
      const text = await window.mousse.git.diff(path, staged)
      setDiff(text || '(No diff)')
    } finally {
      setDiffLoading(false)
    }
  }, [])

  const groups = useMemo(
    () => (status?.changes ? groupChanges(status.changes) : null),
    [status?.changes]
  )

  return (
    <div className="git-panel">
      <div className="git-sidebar">
        <div className="panel-toolbar">
          <div className="git-toolbar-info">
            <GitBranch size={14} />
            <span>{status?.branch ?? '—'}</span>
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

        <div className="git-changes">
          {!projectPath ? (
            <div className="git-empty">No project open</div>
          ) : loading ? (
            <div className="git-empty">Loading…</div>
          ) : !status?.isRepo ? (
            <div className="git-empty">Not a git repository</div>
          ) : groups &&
            groups.staged.length === 0 &&
            groups.unstaged.length === 0 &&
            groups.untracked.length === 0 ? (
            <div className="git-empty">Working tree clean</div>
          ) : (
            <>
              <ChangeSection
                title="Staged"
                items={groups?.staged ?? []}
                selected={selected}
                onSelect={(path, staged) => void loadDiff(path, staged)}
              />
              <ChangeSection
                title="Changes"
                items={groups?.unstaged ?? []}
                selected={selected}
                onSelect={(path, staged) => void loadDiff(path, staged)}
              />
              <ChangeSection
                title="Untracked"
                items={groups?.untracked ?? []}
                selected={selected}
                onSelect={(path, staged) => void loadDiff(path, staged)}
              />
            </>
          )}
        </div>
      </div>

      <div className="git-diff">
        <div className="panel-toolbar">
          <span className="panel-toolbar-path">
            {selected ? `${selected.staged ? 'Staged' : 'Unstaged'}: ${selected.path}` : 'Diff'}
          </span>
        </div>
        {diffLoading ? (
          <div className="git-diff-empty">Loading diff…</div>
        ) : selected ? (
          <pre className="git-diff-content">{diff}</pre>
        ) : (
          <div className="git-diff-empty">Select a changed file to view its diff</div>
        )}
      </div>
    </div>
  )
}
