// The Chats sidebar's project dot: the project group's automation runs that need the person (unresolved Needs you
// items assigned to them). It counts the group, not one computer; clicking it opens the Runs list filtered to it.
import { useEffect } from 'react'
import { dotLabel, projectDotCount } from './inboxModel'
import { openProjectRuns, refreshCounts, useInboxStore } from './inboxStore'
import './inbox.css'

/** The dots read their counts once per window, and again when the scheduler or the inbox changes. */
let subscribed = false
function subscribeCounts(): void {
  if (subscribed || typeof window === 'undefined' || !window.mousse?.scheduled?.onUpdated) return
  subscribed = true
  void refreshCounts()
  window.mousse.scheduled.onUpdated(() => { void refreshCounts() })
}

export function ProjectRunsDot({ name, projectIds }: { name: string; projectIds: string[] }) {
  const counts = useInboxStore((s) => s.counts)
  useEffect(subscribeCounts, [])
  const count = projectDotCount(counts, projectIds)
  if (!count) return null
  const label = dotLabel(count)
  return (
    <button
      type="button"
      className="inbox-project-dot"
      data-testid="inbox-project-dot"
      title={label}
      aria-label={`${name}: ${label}`}
      tabIndex={-1}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); openProjectRuns({ name, projectIds }) }}
    >
      <span aria-hidden="true" />
    </button>
  )
}
