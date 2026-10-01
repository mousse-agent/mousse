import { useState } from 'react'
import { ChevronDown, Folder, Laptop } from 'lucide-react'
import type { Project } from '../../shared/types'
import '../styles/composer-workspace.css'

export function ComposerWorkspaceToolbar({ projects, workspace, disabled, onChange, onOpenProject, onError }: {
  projects: Project[]
  workspace: { projectId?: string; worktreeEnabled: boolean }
  disabled: boolean
  onChange: (workspace: { projectId?: string; worktreeEnabled: boolean }) => void
  onOpenProject: () => Promise<void>
  onError: (message: string) => void
}) {
  const [opening, setOpening] = useState(false)
  const project = projects.find((entry) => entry.id === workspace.projectId)
  return (
    <div className="composer-workspace-toolbar" role="group" aria-label="New chat workspace">
      <label className="composer-workspace-project" title={project?.path}>
        <Folder size={16} aria-hidden="true" />
        <select
          aria-label="Project"
          value={workspace.projectId ?? ''}
          disabled={disabled || opening}
          onChange={(event) => {
            const projectId = event.target.value
            if (projectId === '__open_project__') {
              setOpening(true)
              void onOpenProject().catch((error) => onError(error instanceof Error ? error.message : String(error)))
                .finally(() => setOpening(false))
            } else {
              onChange({ projectId: projectId || undefined, worktreeEnabled: Boolean(projectId && workspace.worktreeEnabled) })
            }
          }}
        >
          <option value="">No project</option>
          {workspace.projectId && !project && <option value={workspace.projectId}>Unavailable project</option>}
          {projects.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          <option value="__open_project__">Open project…</option>
        </select>
        <ChevronDown size={12} aria-hidden="true" />
      </label>
      <span className="composer-workspace-device"><Laptop size={16} aria-hidden="true" />This computer</span>
      <label className="composer-workspace-worktree" title={!workspace.projectId ? 'Select a project to start in a worktree' : 'Start in an isolated Git worktree'}>
        Worktree
        <input
          type="checkbox"
          aria-label="Start in a worktree"
          checked={Boolean(workspace.projectId && workspace.worktreeEnabled)}
          disabled={disabled || opening || !workspace.projectId}
          onChange={(event) => onChange({ ...workspace, worktreeEnabled: event.target.checked })}
        />
      </label>
    </div>
  )
}
