import type { WorkflowLibraryItem } from './client'
import { publicationState } from './libraryFilter'

export function WorkflowCard({
  item,
  selected,
  onOpen,
  onRun,
  runDisabledReason
}: {
  item: WorkflowLibraryItem
  selected?: boolean
  onOpen: (id: string) => void
  onRun?: (id: string) => void
  runDisabledReason?: string
}) {
  const state = publicationState(item)
  const issueCount = item.issues?.filter((issue) => issue.severity === 'error').length ?? 0
  const canRun = Boolean(onRun) && !runDisabledReason && (item.runnable ?? Boolean(item.headRevisionId))
  return (
    <article className="wf-card" data-workflow-card={item.id} aria-pressed={selected}>
      <button type="button" className="wf-card__open" onClick={() => onOpen(item.id)}>
        <h3>{item.name}</h3>
        <p>{item.description || 'No description yet'}</p>
        <div className="wf-meta">
          <span className="wf-chip">{item.slug}</span>
          <span className="wf-chip">
            {state === 'published' ? 'Published' : state === 'unpublished-changes' ? 'Draft changes' : 'Draft'}
          </span>
          {item.source === 'project' ? <span className="wf-chip">Project</span> : <span className="wf-chip">Profile</span>}
          {item.unsupportedNodes?.length ? (
            <span className="wf-chip wf-chip--warn">Unsupported nodes</span>
          ) : null}
          {issueCount > 0 ? (
            <span className="wf-chip wf-chip--warn">
              {issueCount} {issueCount === 1 ? 'issue' : 'issues'}
            </span>
          ) : null}
          {item.lastRunAt ? (
            <span className="wf-chip">Last run {item.lastRunStatus ?? item.lastRunAt}</span>
          ) : (
            <span className="wf-chip">Never run</span>
          )}
          {(item.tags ?? []).map((tag) => (
            <span key={tag} className="wf-chip">
              {tag}
            </span>
          ))}
        </div>
      </button>
      {onRun ? (
        <button
          type="button"
          className="btn btn-sm"
          data-action="run-workflow"
          disabled={!canRun}
          title={runDisabledReason ?? (canRun ? 'Run published revision' : 'Publish before running, or use Run draft in the editor.')}
          onClick={() => onRun(item.id)}
        >
          Run
        </button>
      ) : null}
    </article>
  )
}
