import { useRef, type ReactNode, type RefObject } from 'react'
import { Folder, GitBranch, Monitor, Server } from '../lib/icons'
import { ProviderIcon } from '../lib/providerIcons'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import { UNKNOWN_COMPUTER_NAME, useComputer } from '../lib/computers'
import { useThreadBranch } from '../hooks/useThreadBranch'
import { useAppStore } from '../stores/appStore'
import { ProjectIcon } from './ProjectIcon'
import { ThreadPullRequestCount } from './ThreadRowExtras'
import { canonicalModelName, shortModelName } from '../../shared/modelNames'
import type { ThreadPullRequestSummary } from '../../shared/pullRequests'
import type { Project, Thread } from '../../shared/types'

type ModelThread = Pick<Thread, 'modelOverride'>

/**
 * The model a thread runs on, as a row shows it: the one picked for it, else the profile's default agent (whose model
 * the list does not know, so it has no name).
 */
export function threadModelOf(thread: ModelThread, defaultProvider: string | null | undefined): { providerId: string; name?: string } | null {
  const picked = thread.modelOverride
  if (picked) return { providerId: picked.instanceId || picked.llmProvider, name: shortModelName(canonicalModelName(picked.name, picked.model)) }
  return defaultProvider ? { providerId: defaultProvider } : null
}

function useThreadModel(thread: ModelThread) {
  const defaultProvider = useAppStore((s) => s.appInfo?.llmProvider)
  return threadModelOf(thread, defaultProvider)
}

/** The logo of the agent a thread runs on, named in its tooltip. */
export function ThreadModelIcon({ thread }: { thread: ModelThread }) {
  const model = useThreadModel(thread)
  if (!model) return null
  const label = model.name ?? 'Default model'
  return (
    <span className="threads-sidebar-model-icon" role="img" aria-label={label} title={label}>
      <ProviderIcon providerId={model.providerId} size={12} />
    </span>
  )
}

type LineThread = Pick<Thread, 'projectId' | 'node' | 'worktreeEnabled' | 'modelOverride'>

/**
 * A thread's lower line, on a Projects tree row and a Threads tab card alike: its branch (with the branch icon when the
 * thread has a worktree of its own) or what goes in its place, then its pull requests and its model's logo.
 */
export function ThreadBranchLine({ thread, threadId, pullRequests, lead, className }: {
  thread: LineThread
  threadId: string
  pullRequests: readonly ThreadPullRequestSummary[]
  /** Shown before the branch (a card's computer), or alone when there is no branch. */
  lead?: ReactNode
  className: string
}) {
  // None in a project without Git (or another computer's).
  const branch = useThreadBranch(thread, threadId)
  return (
    <span className={className}>
      <span className="threads-sidebar-branch">
        {lead}
        {branch?.worktree && <GitBranch size={11} strokeWidth={2} className="threads-sidebar-branch-icon" aria-label="Own worktree" />}
        {branch?.branch && <span className="threads-sidebar-branch-name">{branch.branch}</span>}
      </span>
      <ThreadPullRequestCount pullRequests={pullRequests} />
      <ThreadModelIcon thread={thread} />
    </span>
  )
}

/**
 * The card a Projects tree row or a Threads tab card opens when the pointer rests on it (not on its buttons): the whole
 * title, its project, the computer it runs on, its branch and its model. It only shows; the pointer passes through it.
 */
export function ThreadHoverCard({ thread, project, anchorRef }: {
  thread: Pick<Thread, 'id' | 'name' | 'projectId' | 'node' | 'worktreeEnabled' | 'modelOverride'>
  project?: Project
  anchorRef: RefObject<HTMLElement | null>
}) {
  const content = useRef<HTMLDivElement>(null)
  const style = useFloatingPosition({ open: true, anchorRef, contentRef: content, placement: 'right-start', gap: 10 })
  const computer = useComputer(thread.node)
  const deviceName = useAppStore((s) => s.appInfo?.deviceName)
  const branch = useThreadBranch(thread, thread.id)
  const model = useThreadModel(thread)
  const computerName = thread.node ? computer?.name ?? UNKNOWN_COMPUTER_NAME : deviceName || 'This computer'
  return (
    <FloatingPortal>
      <div ref={content} role="tooltip" className="threads-sidebar-hover-card" style={style}>
        <span className="threads-sidebar-hover-card-title">{thread.name}</span>
        <span className="threads-sidebar-hover-card-item">
          {project ? <ProjectIcon project={project} size={14} fallback={<Folder size={14} strokeWidth={1.8} />} /> : <Folder size={14} strokeWidth={1.8} />}
          {project?.name ?? 'No project'}
        </span>
        <span className="threads-sidebar-hover-card-item">
          {thread.node ? <Server size={14} strokeWidth={1.8} /> : <Monitor size={14} strokeWidth={1.8} />}
          {computerName}
        </span>
        {branch?.branch && (
          <span className="threads-sidebar-hover-card-item">
            <GitBranch size={14} strokeWidth={1.8} />
            {branch.branch}
            {branch.worktree && <span className="threads-sidebar-hover-card-note">own worktree</span>}
          </span>
        )}
        {model && (
          <span className="threads-sidebar-hover-card-item">
            <ProviderIcon providerId={model.providerId} size={14} />
            {model.name ?? 'Default model'}
          </span>
        )}
      </div>
    </FloatingPortal>
  )
}
