// The Chats sidebar's project dot (mock): the project's automations have runs that need the person. It counts the
// project group, not a computer; clicking it opens the Runs list filtered to the project.
import { needsYouCount } from './inboxModel'
import { isMockOn, openProjectRuns, useInboxMock } from './store'
import './inbox.css'

export function ProjectRunsDot({ project }: { project: string }) {
  const mode = useInboxMock((s) => s.mode)
  const resolved = useInboxMock((s) => s.resolved)
  const count = isMockOn(mode) && mode !== 'empty' ? needsYouCount(project, resolved) : 0
  if (!count) return null
  const label = `${count} run${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} you`
  return (
    <button type="button" className="inbox-project-dot" data-testid="inbox-project-dot" title={label} aria-label={label} tabIndex={-1} onClick={() => openProjectRuns(project)}>
      <span aria-hidden="true" />
    </button>
  )
}
