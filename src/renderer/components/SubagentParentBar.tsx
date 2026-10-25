import { ChevronLeft } from '../lib/icons'
import { isSubagentThread } from '../../shared/threadLineage'
import { openThread } from '../lib/openThread'
import { useAppStore } from '../stores/appStore'
import './subagentParentBar.css'

interface SubagentParentBarViewProps {
  parentName: string
  childName: string
  onOpenParent: () => void
}

/**
 * Top of a subagent's thread: a breadcrumb back to the parent, and a divider that says whose
 * subagent this is. Messages typed here continue the subagent, so the divider is the cue that
 * this is not the main thread.
 */
export function SubagentParentBarView({ parentName, childName, onOpenParent }: SubagentParentBarViewProps) {
  return (
    <div className="subagent-parent-bar">
      <nav className="subagent-breadcrumb" aria-label="Subagent location">
        <button type="button" className="subagent-breadcrumb-parent" title={`Open ${parentName}`} onClick={onOpenParent}>
          <ChevronLeft size={13} strokeWidth={2} aria-hidden="true" />
          <span className="subagent-breadcrumb-name">{parentName}</span>
        </button>
        <span className="subagent-breadcrumb-separator" aria-hidden="true">/</span>
        <span className="subagent-breadcrumb-current" aria-current="page" title={childName}>{childName}</span>
      </nav>
      <div className="subagent-divider" role="separator">
        <span className="subagent-divider-label">Subagent of {parentName}</span>
      </div>
    </div>
  )
}

/** Shown above the selected thread when it is a subagent whose parent is still around. */
export function SubagentParentBar() {
  const child = useAppStore((s) => {
    const active = s.threads.find((thread) => thread.id === s.activeThreadId)
    return active && isSubagentThread(active) ? active : undefined
  })
  const parent = useAppStore((s) => (child ? s.threads.find((thread) => thread.id === child.lineage?.parentThreadId) : undefined))
  // A subagent whose parent is gone is listed as a normal thread, so it gets no link to one.
  if (!child || !parent) return null
  return (
    <SubagentParentBarView
      parentName={parent.name.trim() || 'Untitled thread'}
      childName={child.name.trim() || 'Subagent'}
      onOpenParent={() => void openThread(parent.id)}
    />
  )
}
