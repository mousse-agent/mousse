import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

import { expiresAtAfter, expiresInLabel } from '../../shared/threadExpiry'
import type { CSSProperties, KeyboardEvent } from 'react'

import { Archive, ChevronRight, CircleCheck, CircleDotDashed, Folder, FolderOpen, FolderPlus, FolderKanban, GitBranch, Clock, ListTree, Loader2, Lock, MessageQuestion, MessagesSquare, MessageSquarePlus, MoreHorizontal, Pause, Pin, Shield, Trash2 } from '../lib/icons'
import '../styles/private-threads.css'
import { useThreadsAwaitingApproval } from '../hooks/useThreadsAwaitingApproval'

import { isThreadActivityActive, type Thread, type ThreadActivityState, type TurnPause } from '../../shared/types'
import { pausedStatusLabel } from '../lib/pausedRun'
import { worktreeMark } from '../lib/worktreeMark'
import { isDefaultThreadName, isThreadStarted } from '../../shared/threadTitle'
import { arrangeThreadFeed, sortSidebarThreads, sortThreadFeed } from '../../shared/threadSidebarSort'
import { openSubagentParentRow, rollUpActivities, visibleThreads } from '../../shared/threadLineage'
import { needsMeLabel, threadAttention, threadStatus, worstOf, type ThreadAttention } from '../../shared/threadAttention'
import { needsMeThreads } from '../lib/needsMe'
import { hasMoreBelow, revealDelta } from '../lib/sidebarScroll'
import { setReferenceDragData } from '../../shared/chatReferences'
import { useAppStore } from '../stores/appStore'
import { confirmNavigation } from '../services/navigationGuards'
import { useChatsStore } from '../stores/chatsStore'
import { createAndSelectProjectThread, selectThread } from '../lib/threadActions'
import { runWithToast, showUndoToast } from '../lib/actionToast'
import { Modal } from './ui/Modal'
import { ChatsSidebar } from './chats/ChatsSidebar'
import { ProfileSwitcher } from './profiles/ProfileSwitcher'
import { DeleteArchivedDialog } from './sidebar/DeleteArchivedDialog'
import { clearAllRequest, deleteThreads, type DeleteRequest } from '../lib/archivedThreads'
import { Collapse } from './ui/Collapse'

import {
  ThreadsContextMenu,

  type ProjectOpener,

  type ThreadsContextMenuTarget

} from './ThreadsContextMenu'
import { defaultEditor, loadLastEditorId, openLabel, splitEditors } from './sideCard/openInEditor'
import { loadEditors, useEditorsStore } from '../stores/editorsStore'

import { StartFromPullRequestDialog } from './StartFromPullRequestDialog'
import { ThreadComputerBadge } from './ComputerBadge'
import { UNKNOWN_COMPUTER_NAME, useComputers } from '../lib/computers'
import { groupComputers, groupProjects } from '../lib/projectGroups'
import { projectHues } from '../lib/projectHues'
import { projectTooltip, thisHomeFolder } from '../lib/projectTooltip'
import { useThreadProjectColors } from '../lib/threadProjectColorsSetting'
import { ThreadSpeechIndicator, useSpeakingThreadId } from '../readAloud/ThreadSpeechIndicator'

import '../styles/threads-sidebar.css'



interface RenamingTarget {

  type: 'thread' | 'project'

  id: string

  name: string

  /** Started from the row's copy in the "Needs me" group: that copy shows the input, not the one in the list. */
  inNeedsMe?: boolean

  /** The row or button to give focus back to when the rename ends from the keyboard. */
  returnFocus?: HTMLElement | null

}

interface DraggedSidebarItem {
  type: 'thread' | 'project'
  id: string
  projectId?: string
  /** A thread drops only among threads of the same kind: pinned ones always list first. */
  pinned?: boolean
  /** A row of the Threads tab, which can go anywhere in that tab's one list, across projects. */
  feed?: boolean
}

const PROJECT_THREAD_PREVIEW_LIMIT = 5
const PROJECT_ATTENTION_TITLE: Record<Exclude<ThreadAttention, 'quiet' | 'needs-me'>, string> = {
  working: 'Working',
  paused: 'Paused',
  done: 'Done'
}
const SIDEBAR_VIEWS = ['projects', 'threads', 'chats'] as const
type SidebarView = (typeof SIDEBAR_VIEWS)[number]

/** Shift+F10 or the context-menu key: open a row's menu from the keyboard. */
const isMenuKey = (event: KeyboardEvent) => event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)

function threadAge(iso?: string): string {
  if (!iso) return ''
  const delta = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(delta) || delta < 45_000) return 'now'
  const minutes = Math.round(delta / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 36) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function projectInitials(name: string): string {
  const parts = name.split(/[\s/._-]+/).filter(Boolean)
  const letters = `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? parts[0]?.[1] ?? ''}`
  return letters.toUpperCase() || '•'
}

/** On hover, a title cut off by an ellipsis gets the full text as its native tooltip; one that fits gets none. */
const tooltipIfTruncated = (fullTitle: string) => (event: React.MouseEvent<HTMLElement>) => {
  const element = event.currentTarget
  if (element.scrollWidth > element.clientWidth) element.title = fullTitle
  else element.removeAttribute('title')
}

/** A row's title: it ends in an ellipsis where it does not fit and stays still on hover, the full text in its tooltip. */
function ThreadTitle({ name, fullTitle, onDoubleClick }: { name: string; fullTitle?: string; onDoubleClick?: (event: React.MouseEvent<HTMLElement>) => void }) {
  return (
    <span className="threads-sidebar-thread-name" onMouseEnter={tooltipIfTruncated(fullTitle ?? name)} onDoubleClick={onDoubleClick}>
      {name}
    </span>
  )
}



interface SidebarRenameInputProps {

  initialName: string

  className?: string

  onSubmit: (name: string) => void

  onCancel: () => void

}



function SidebarRenameInput({

  initialName,

  className = '',

  onSubmit,

  onCancel

}: SidebarRenameInputProps) {

  const [value, setValue] = useState(initialName)

  const inputRef = useRef<HTMLInputElement>(null)

  // Enter ends the rename, and the blur that can follow must not send it twice.
  const done = useRef(false)



  useEffect(() => {

    inputRef.current?.focus()

    inputRef.current?.select()

  }, [])



  const submit = () => {

    if (done.current) return
    done.current = true

    const trimmed = value.trim()

    if (trimmed) {

      onSubmit(trimmed)

    } else {

      onCancel()

    }

  }



  return (

    <input

      ref={inputRef}

      className={`threads-sidebar-rename-input ${className}`.trim()}

      value={value}

      onChange={(event) => setValue(event.target.value)}

      onKeyDown={(event) => {

        event.stopPropagation()

        if (event.key === 'Enter') {

          event.preventDefault()

          submit()

        }

        if (event.key === 'Escape') {

          event.preventDefault()

          done.current = true

          onCancel()

        }

      }}

      onBlur={submit}

      onClick={(event) => event.stopPropagation()}

    />

  )

}



function ThreadCardBody({
  thread,
  projectName,
  hue,
  activity,
  awaitsApproval,
  startedAt,
  pause,
  isRenaming,
  renamingName,
  isGeneratingTitle,
  worktree,
  fullTitle,
  onRename,
  onCancelRename,
  onStartRename
}: {
  thread: Pick<Thread, 'name' | 'projectId' | 'updatedAt' | 'pinnedAt' | 'node' | 'offline' | 'notShared' | 'localOnly' | 'expiresAt'>
  projectName?: string
  /** The project's hue (`--hue-N`), shared with the row's tint. */
  hue?: number
  activity?: ThreadActivityState
  /** The input it waits for is a permission request. */
  awaitsApproval?: boolean
  startedAt?: string
  /** This thread's own pause (not one a subagent below it is in): when its limit resets. */
  pause?: Pick<TurnPause, 'until' | 'estimated'>

  isRenaming: boolean
  renamingName: string
  isGeneratingTitle: boolean
  /** Set only where the thread's checkout differs from the default for new threads. */
  worktree?: 'Worktree' | 'Primary checkout'
  /** The tooltip of a title that does not fit. */
  fullTitle: string
  onRename: (name: string) => void
  onCancelRename: () => void
  /** Double-click on the title starts a rename. */
  onStartRename?: (event: React.MouseEvent<HTMLElement>) => void
}) {
  const age = threadAge(isThreadActivityActive(activity) ? startedAt ?? thread.updatedAt : thread.updatedAt)
  const status = threadStatus(activity, awaitsApproval)
  return (
    <>
      {projectName ? (
        <span className="threads-sidebar-card-mark" style={hue ? { color: `var(--hue-${hue})` } : undefined} aria-hidden="true">{projectInitials(projectName)}</span>
      ) : (
        <span className="threads-sidebar-card-mark threads-sidebar-card-mark-empty" aria-hidden="true">
          <Folder size={13} strokeWidth={1.8} />
        </span>
      )}
      <span className="threads-sidebar-card-body">
        <span className="threads-sidebar-card-meta">
          <span className="threads-sidebar-card-project">{projectName ?? 'No project'}</span>
          {thread.pinnedAt && <Pin size={11} strokeWidth={2} className="threads-sidebar-card-pin" aria-label="Pinned" />}
          {status === 'working' ? (
            <span className="threads-sidebar-card-status threads-sidebar-card-status-working">
              <Loader2 size={12} strokeWidth={2} className="icon-spin" aria-hidden="true" />
              Working{age && age !== 'now' ? ` ${age}` : ''}
            </span>
          ) : status === 'waiting' ? (
            <span className="threads-sidebar-card-status threads-sidebar-card-status-waiting">
              <CircleDotDashed size={12} strokeWidth={2} aria-hidden="true" />
              Waiting{age && age !== 'now' ? ` ${age}` : ''}
            </span>
          ) : status === 'approval' ? (
            <span className="threads-sidebar-card-status threads-sidebar-card-status-input" title="Needs your approval">
              <Shield size={12} strokeWidth={2} aria-hidden="true" />
              Approval
            </span>
          ) : status === 'question' ? (
            <span className="threads-sidebar-card-status threads-sidebar-card-status-input">
              <MessageQuestion size={12} strokeWidth={2} aria-hidden="true" />
              Input
            </span>
          ) : status === 'paused' ? (
            <span className="threads-sidebar-card-status threads-sidebar-card-status-paused">
              <Pause size={12} strokeWidth={2} aria-hidden="true" />
              {pausedStatusLabel(pause, Date.now())}
            </span>
          ) : status === 'done' ? (
            <span className="threads-sidebar-card-status threads-sidebar-card-status-done">
              <CircleCheck size={12} strokeWidth={2} aria-hidden="true" />
              Done
            </span>
          ) : (
            <span className="threads-sidebar-card-age">{age}</span>
          )}
        </span>
        {isRenaming ? (
          <SidebarRenameInput initialName={renamingName} onSubmit={onRename} onCancel={onCancelRename} />
        ) : isGeneratingTitle ? (
          <span className="threads-sidebar-skeleton" aria-label="Generating title" />
        ) : (
          <span className="threads-sidebar-card-title" onDoubleClick={onStartRename} onMouseEnter={tooltipIfTruncated(fullTitle)}>
            {thread.localOnly && <Lock size={11} strokeWidth={2} className="thread-private-icon" aria-label="Private" />}
            {thread.expiresAt && <span className="thread-expiry-icon" title={`Deletes ${expiresInLabel(thread.expiresAt)}`}><Clock size={11} strokeWidth={2} aria-label="Deletes itself" /></span>}
            {thread.name}
          </span>
        )}
        {(worktree || thread.node) && (
          <span className="threads-sidebar-card-sub">
            <ThreadComputerBadge thread={thread} withName className="threads-sidebar-card-device" />
            {worktree && (
              <>
                <GitBranch size={11} strokeWidth={2} aria-hidden="true" />
                {worktree}
              </>
            )}
          </span>
        )}
      </span>
    </>
  )
}

export function ThreadsSidebar({ className = '' }: { className?: string }) {

  const tabsId = useId()
  const projects = useAppStore((s) => s.projects)

  const threads = useAppStore((s) => s.threads)
  const agentChats = useChatsStore((s) => s.snapshot.chats)
  const agentThreadIds = useMemo(() => new Set(agentChats.map((chat) => chat.threadId)), [agentChats])

  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const speakingThreadId = useSpeakingThreadId()

  const threadActivity = useAppStore((s) => s.threadActivity)
  const turnStates = useAppStore((s) => s.turnStates)
  const approvalThreads = useThreadsAwaitingApproval()

  const upsertThread = useAppStore((s) => s.upsertThread)
  const worktreeByDefault = useAppStore((s) => s.worktreeByDefault)

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  // The project the user last opened or closed. Only that group animates; one revealed for the thread
  // being opened (or a project just added) appears at once.
  const toggledProjectRef = useRef<string | null>(null)

  const [expandedProjectThreadLists, setExpandedProjectThreadLists] = useState<Set<string>>(new Set())

  const [archivedExpanded, setArchivedExpanded] = useState(false)
  // The archived threads waiting on a delete confirmation, and how that delete is going.
  const [deleteRequest, setDeleteRequest] = useState<DeleteRequest | null>(null)
  const [deleteState, setDeleteState] = useState<{ busy: boolean; error?: string }>({ busy: false })
  const archivedHeadingRef = useRef<HTMLButtonElement>(null)
  const [noProjectExpanded, setNoProjectExpanded] = useState(false)
  // The row of the Projects or "No project" tree that last had focus (`project:<id>` or `thread:<id>`): its tree's Tab stop.
  const [treeFocus, setTreeFocus] = useState<string | null>(null)
  // The list above the footer. `moreBelow` marks it while rows sit below its fold; `revealProject` is the project
  // just opened by the person, scrolled into view once its rows render.
  const scrollRef = useRef<HTMLDivElement>(null)
  const [moreBelow, setMoreBelow] = useState(false)
  const revealProject = useRef<string | null>(null)
  // The project whose "start from a pull request" dialog is open.
  const [pullRequestProject, setPullRequestProject] = useState<{ id: string; name: string } | null>(null)

  const sidebarView = useAppStore((s) => s.threadsSidebarView)
  const workspaceMode = useAppStore((s) => s.sidebarMode)
  const setSidebarView = async (view: SidebarView) => {
    const state = useAppStore.getState()
    const nextMode = view === 'chats' ? 'chats' : 'projects'
    if (state.sidebarMode !== nextMode && !await confirmNavigation()) return
    state.setThreadsSidebarView(view)
    if (state.sidebarMode !== nextMode) state.setSidebarMode(nextMode)
  }

  const [contextMenu, setContextMenu] = useState<{

    x: number

    y: number

    target: ThreadsContextMenuTarget

    inNeedsMe?: boolean

    /** The row or "…" button the menu was opened from: focus goes back to it when the menu closes. */
    returnFocus?: HTMLElement | null

    /** Set when a "…" button opened the menu, so that button reports itself expanded. */
    anchorKey?: string

  } | null>(null)

  // The project whose "Remove project…" confirmation is open.
  const [removingProject, setRemovingProject] = useState<ThreadsContextMenuTarget | null>(null)

  const [renaming, setRenaming] = useState<RenamingTarget | null>(null)
  const [pendingTitleIds, setPendingTitleIds] = useState<Set<string>>(new Set())
  const pendingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const draggedItem = useRef<DraggedSidebarItem | null>(null)
  const suppressClick = useRef(false)
  // Where a row dragged in the Threads tab would land: before or after this thread.
  const [feedDrop, setFeedDrop] = useState<{ id: string; after: boolean } | null>(null)
  const threadFeedOrder = useAppStore((s) => s.threadFeedOrder)
  const setThreadFeedOrder = useAppStore((s) => s.setThreadFeedOrder)

  const threadsSidebarWidth = useAppStore((s) => s.threadsSidebarWidth)



  // Subagent threads sit under their parent, not beside it: the list holds the threads people started.
  const listedThreads = useMemo(() => visibleThreads(threads), [threads])
  // A parent row shows what its subagents are doing, however deep they are nested.
  const rolledUpActivity = useMemo(() => rollUpActivities(threads, threadActivity), [threads, threadActivity])
  // While a subagent's thread is open, the row it sits under is highlighted instead.
  const openSubagentParentId = useMemo(
    () => (activeThreadId ? openSubagentParentRow(activeThreadId, threads) : null),
    [activeThreadId, threads]
  )

  // Empty drafts are composer state, not conversations. They become visible
  // only when the first message is committed.
  const availableThreads = useMemo(
    () => sortSidebarThreads(listedThreads.filter((thread) => !thread.settledAt && isThreadStarted(thread) && !agentThreadIds.has(thread.id))),
    [listedThreads, agentThreadIds]
  )
  // The Threads tab: in the order its rows were dragged into, with threads started since on top, newest
  // first. Later messages do not move a row.
  const feedThreads = useMemo(() => sortThreadFeed(availableThreads, threadFeedOrder), [availableThreads, threadFeedOrder])
  const archivedThreads = useMemo(
    () => sortThreadFeed(listedThreads.filter((thread) => Boolean(thread.settledAt) && isThreadStarted(thread) && !agentThreadIds.has(thread.id))),
    [listedThreads, agentThreadIds]
  )
  const attentionOf = (threadId: string) => threadAttention(rolledUpActivity[threadId] ?? threadActivity[threadId])
  // Threads that wait for an answer or an approval, from every project and computer, at the top of the list.
  const needsMe = useMemo(() => needsMeThreads(threads, threadActivity, agentThreadIds), [threads, threadActivity, agentThreadIds])
  // With one thread in all, its own row already says it: a group of it would only repeat it.
  const showNeedsMe = needsMe.length > 0 && availableThreads.length > 1

  // A project that several computers hold for the same repository is one group; the others' projects that
  // match none of this computer's stay groups of their own, named with their computer.
  const { groups: projectGroups, groupOf } = useMemo(() => groupProjects(projects), [projects])
  const groupById = useMemo(() => new Map(projectGroups.map((group) => [group.id, group])), [projectGroups])
  const threadProjectColors = useThreadProjectColors()
  const hueByGroup = useMemo(
    () => projectHues(projectGroups.map((group) => ({ id: group.id, createdAt: group.project.createdAt }))),
    [projectGroups]
  )
  const hasRemoteProjects = projects.some((project) => project.node)
  const { byNode: computers, devices } = useComputers(hasRemoteProjects || archivedThreads.some((thread) => thread.node))
  const nameOfComputer = (node: string): string => computers[node]?.name ?? UNKNOWN_COMPUTER_NAME
  const localArchivedCount = archivedThreads.filter((thread) => !thread.node).length
  // With projects of several computers, a project's tooltip names this one too.
  const selfName = hasRemoteProjects ? devices.find((device) => device.self)?.name : undefined
  // This computer's home folder: its projects' paths read `~/…` in their tooltip.
  const homeFolder = thisHomeFolder()
  // The editors and file manager this computer has, for the project menu's "Open in" and "Show in" items.
  const profileId = useAppStore((s) => s.profileId)
  const editors = useEditorsStore((s) => s.editors)
  const hasLocalProjects = projects.some((project) => !project.node)
  useEffect(() => {
    if (hasLocalProjects) void loadEditors()
  }, [hasLocalProjects])
  const groupIdOf = (projectId: string | undefined): string | undefined => (projectId ? groupOf.get(projectId) ?? projectId : undefined)
  // "No project": threads without one, and threads whose project was removed from the sidebar.
  const orphanThreads = availableThreads.filter((thread) => !groupById.has(groupIdOf(thread.projectId) ?? ''))

  // Reveal the highlighted row once per thread: open its project, show its project's whole list when it is past
  // the first 5, or open "No project" or "Archived". A draft is revealed when it is started and gets its row.
  const revealedRow = useRef<string | null>(null)
  useEffect(() => {
    // The row to reveal is the highlighted one, which for a subagent is its parent's.
    const shownId = openSubagentParentId ?? activeThreadId
    if (!shownId || revealedRow.current === shownId) return
    const shown = threads.find((thread) => thread.id === shownId)
    if (!shown || !isThreadStarted(shown) || agentThreadIds.has(shown.id)) return
    revealedRow.current = shownId
    if (shown.settledAt) {
      setArchivedExpanded(true)
      return
    }
    const groupId = groupIdOf(shown.projectId)
    if (!groupId || !groupById.has(groupId)) {
      setNoProjectExpanded(true)
      return
    }
    setExpandedProjects((prev) => {
      if (prev.has(groupId)) return prev
      // A group opened for the thread being shown appears at once; only a group the user toggles animates.
      if (toggledProjectRef.current === groupId) toggledProjectRef.current = null
      return new Set(prev).add(groupId)
    })
    const position = availableThreads.filter((thread) => groupIdOf(thread.projectId) === groupId).findIndex((thread) => thread.id === shownId)
    if (position >= PROJECT_THREAD_PREVIEW_LIMIT) {
      setExpandedProjectThreadLists((prev) => (prev.has(groupId) ? prev : new Set(prev).add(groupId)))
    }
    // groupIdOf reads groupOf, which is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId, openSubagentParentId, threads, availableThreads, agentThreadIds, groupOf, groupById])

  const toggleProject = (projectId: string) => {
    toggledProjectRef.current = projectId

    setExpandedProjects((prev) => {

      const next = new Set(prev)

      if (next.has(projectId)) {

        next.delete(projectId)

      } else {

        next.add(projectId)
        revealProject.current = projectId

      }

      return next

    })

  }

  // A project opened by the person shows its first rows, even under a tall "Needs me".
  useEffect(() => {
    const id = revealProject.current
    revealProject.current = null
    const scroller = scrollRef.current
    const target = id ? [...scroller?.querySelectorAll<HTMLElement>('[data-project-id]') ?? []].find((item) => item.dataset.projectId === id) : undefined
    if (!scroller || !target) return
    const delta = revealDelta(scroller.getBoundingClientRect(), target.getBoundingClientRect())
    if (delta) scroller.scrollTop += delta
  }, [expandedProjects])

  // Marks the list while rows sit below its fold, for the fade and the drawn scrollbar.
  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    const update = () => setMoreBelow(hasMoreBelow(scroller))
    update()
    scroller.addEventListener('scroll', update, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(scroller)
    for (const section of scroller.children) observer?.observe(section)
    return () => {
      scroller.removeEventListener('scroll', update)
      observer?.disconnect()
    }
  }, [])



  const openProject = () => runWithToast('add the project', async () => {
    const project = await window.mousse.projects.open()
    if (!project) return
    const thread = await window.mousse.threads.create(undefined, project.id)
    // Keep the project relationship available synchronously. The daemon also
    // broadcasts the full list, but that event can arrive after the user sends
    // the first message from the newly selected composer.
    upsertThread(thread)
    setExpandedProjects((prev) => new Set(prev).add(project.id))
    await selectThread(thread.id)
  })

  // `projectId` is the project that names its group, so it is also the group's id. A retry reuses the draft a
  // failed attempt may have made.
  const createProjectThread = (projectId: string) => runWithToast('start a thread', async () => {
    setExpandedProjects((prev) => new Set(prev).add(projectId))
    await createAndSelectProjectThread(projectId)
  }, { retry: true })

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const index = SIDEBAR_VIEWS.indexOf(sidebarView)
    const nextView = event.key === 'Home'
      ? SIDEBAR_VIEWS[0]
      : event.key === 'End'
        ? SIDEBAR_VIEWS[2]
        : event.key === 'ArrowRight'
          ? SIDEBAR_VIEWS[(index + 1) % SIDEBAR_VIEWS.length]
          : SIDEBAR_VIEWS[(index + SIDEBAR_VIEWS.length - 1) % SIDEBAR_VIEWS.length]
    void setSidebarView(nextView)
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    buttons[SIDEBAR_VIEWS.indexOf(nextView)]?.focus()
  }

  // The Projects tree's rows in order, as the keyboard walks them: each project, and the shown threads of an open one.
  const projectThreadsOf = (groupId: string) => availableThreads.filter((thread) => groupIdOf(thread.projectId) === groupId)
  const treeKeys = projectGroups.flatMap((group) => {
    const key = `project:${group.project.id}`
    if (!expandedProjects.has(group.project.id)) return [key]
    const shown = projectThreadsOf(group.id)
    const visible = expandedProjectThreadLists.has(group.project.id) ? shown : shown.slice(0, PROJECT_THREAD_PREVIEW_LIMIT)
    return [key, ...visible.map((thread) => `thread:${thread.id}`)]
  })
  const highlightedKey = `thread:${openSubagentParentId ?? activeThreadId}`
  // Each tree is one Tab stop: the row last focused in it, else the open thread's row, else its first row.
  const tabStopOf = (keys: string[]) => treeFocus && keys.includes(treeFocus)
    ? treeFocus
    : keys.includes(highlightedKey) ? highlightedKey : keys[0]
  const treeTabStop = tabStopOf(treeKeys)
  // "No project" under the lists is a tree of its own, its threads one level deep, walked with the same keys.
  const noProjectTabStop = tabStopOf(noProjectExpanded ? orphanThreads.map((thread) => `thread:${thread.id}`) : [])

  /** Up and Down move between the tree's shown rows, Home and End to its ends, Right and Left open and close a project. */
  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const row = event.target as HTMLElement
    const key = row.dataset.treeKey
    if (!key || event.altKey || event.ctrlKey || event.metaKey) return
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')].filter((item) => !item.closest('[inert]'))
    const index = rows.indexOf(row)
    const isProject = key.startsWith('project:')
    const id = key.slice(key.indexOf(':') + 1)
    const focusRow = (target: HTMLElement | undefined) => target?.focus()
    switch (event.key) {
      case 'ArrowDown': {
        // Past the 5 shown threads of a project, the rest of its list opens.
        const next = row.closest('.threads-sidebar-thread-container')?.nextElementSibling
        if (!isProject && next?.hasAttribute('inert')) {
          const groupId = groupIdOf(threads.find((thread) => thread.id === id)?.projectId)
          if (groupId) {
            flushSync(() => setExpandedProjectThreadLists((prev) => new Set(prev).add(groupId)))
            focusRow(next.querySelector<HTMLElement>('[role="treeitem"]') ?? undefined)
            break
          }
        }
        focusRow(rows[index + 1])
        break
      }
      case 'ArrowUp':
        focusRow(rows[index - 1])
        break
      case 'Home':
        focusRow(rows[0])
        break
      case 'End':
        focusRow(rows[rows.length - 1])
        break
      case 'ArrowRight':
        if (!isProject) break
        if (!expandedProjects.has(id)) toggleProject(id)
        else if (rows[index + 1]?.getAttribute('aria-level') === '2') focusRow(rows[index + 1])
        break
      case 'ArrowLeft':
        if (isProject) {
          if (expandedProjects.has(id)) toggleProject(id)
        } else if (row.getAttribute('aria-level') === '2') {
          focusRow(rows.slice(0, index).reverse().find((item) => item.getAttribute('aria-level') === '1'))
        }
        break
      default:
        return
    }
    event.preventDefault()
  }

  const startDrag = (event: React.DragEvent, item: DraggedSidebarItem) => {
    if (renaming) {
      event.preventDefault()
      return
    }
    draggedItem.current = item
    event.dataTransfer.effectAllowed = 'copyMove'
    event.dataTransfer.setData('text/plain', item.id)
    if (item.type === 'project') {
      const project = projects.find((entry) => entry.id === item.id)
      if (project) setReferenceDragData(event.dataTransfer, {
        kind: 'project', title: project.name, projectId: project.id
      })
    } else {
      const thread = threads.find((entry) => entry.id === item.id)
      if (thread) setReferenceDragData(event.dataTransfer, {
        kind: 'thread', title: thread.name, threadId: thread.id,
        projectId: thread.projectId
      })
    }
  }

  const canDropOn = (target: DraggedSidebarItem) => {
    const dragged = draggedItem.current
    return Boolean(
      dragged &&
        dragged.type === target.type &&
        dragged.id !== target.id &&
        Boolean(dragged.feed) === Boolean(target.feed) &&
        // Threads drop only among threads of the same kind (pinned ones list first); a Threads tab row may cross projects.
        (dragged.type === 'project' || (Boolean(dragged.pinned) === Boolean(target.pinned) && (dragged.feed || dragged.projectId === target.projectId)))
    )
  }

  /** Moves the row dragged in the Threads tab before or after `target`, or to the end without one. */
  const dropFeedThread = (target?: string, after = false) => {
    const dragged = draggedItem.current
    setFeedDrop(null)
    if (!dragged?.feed || dragged.id === target) return
    suppressClick.current = true
    window.setTimeout(() => { suppressClick.current = false }, 0)
    setThreadFeedOrder(arrangeThreadFeed(feedThreads.map((thread) => thread.id), dragged.id, target, after))
  }

  const reorderBefore = async (target: DraggedSidebarItem) => {
    const dragged = draggedItem.current
    if (!dragged || !canDropOn(target)) return
    suppressClick.current = true
    window.setTimeout(() => { suppressClick.current = false }, 0)
    if (dragged.type === 'project') {
      // One entry per group: a project on several computers is dragged as one.
      const ids = projectGroups.map((group) => group.id)
      ids.splice(ids.indexOf(dragged.id), 1)
      ids.splice(ids.indexOf(target.id), 0, dragged.id)
      await window.mousse.projects.reorder(ids)
      return
    }
    // Reorder must include every thread in the group (including hidden drafts), the other computers' threads
    // of the same repository among them; the project is the one that names the group.
    const group = threads.filter((thread) => groupIdOf(thread.projectId) === dragged.projectId)
    const ids = group.map((thread) => thread.id)
    ids.splice(ids.indexOf(dragged.id), 1)
    ids.splice(ids.indexOf(target.id), 0, dragged.id)
    await window.mousse.threads.reorder(dragged.projectId, ids)
  }

  const endDrag = () => {
    draggedItem.current = null
    setFeedDrop(null)
  }



  const openContextMenu = (event: React.MouseEvent<HTMLElement>, target: ThreadsContextMenuTarget, inNeedsMe = false) => {
    if (window.getSelection()?.toString()) return
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({ x: event.clientX, y: event.clientY, target, inNeedsMe, returnFocus: event.currentTarget })
  }

  /** Opens the menu below an element: a "…" button, or a row from the keyboard. */
  const openMenuBelow = (anchor: HTMLElement, target: ThreadsContextMenuTarget, inNeedsMe = false, anchorKey?: string) => {
    const rect = anchor.getBoundingClientRect()
    setContextMenu({ x: rect.left, y: rect.bottom + 4, target, inNeedsMe, returnFocus: anchor, anchorKey })
  }

  /** A "…" button: opens the menu, or closes it when this button opened it. */
  const toggleMenuFrom = (event: React.MouseEvent<HTMLElement>, target: ThreadsContextMenuTarget, anchorKey: string, inNeedsMe = false) => {
    event.stopPropagation()
    if (contextMenu?.anchorKey === anchorKey) closeContextMenu()
    else openMenuBelow(event.currentTarget, target, inNeedsMe, anchorKey)
  }

  /** Closes the menu and gives focus back to the row or button it was opened from. */
  const closeContextMenu = () => {
    const returnTo = contextMenu?.returnFocus
    setContextMenu(null)
    if (returnTo?.isConnected) returnTo.focus({ preventScroll: true })
  }

  const startRename = (target: RenamingTarget) => setRenaming(target)

  /** After a rename ends, focus goes back to its row, unless the person already moved it somewhere else. */
  const endRename = () => {
    const returnTo = renaming?.returnFocus
    setRenaming(null)
    if (!returnTo) return
    window.setTimeout(() => {
      const active = document.activeElement
      if (returnTo.isConnected && (!active || active === document.body)) returnTo.focus({ preventScroll: true })
    }, 0)
  }

  const setPinned = (type: 'thread' | 'project', id: string, pinned: boolean) =>
    runWithToast(pinned ? 'pin' : 'unpin', () => (type === 'thread' ? window.mousse.threads.pin(id, pinned) : window.mousse.projects.pin(id, pinned)), { retry: true })

  const setArchived = async (threadId: string, archived: boolean) => {
    const done = await runWithToast(archived ? 'archive' : 'unarchive', () => window.mousse.threads.settle(threadId, archived), { retry: true })
    if (done && archived) showUndoToast('Archived', 'unarchive', () => window.mousse.threads.settle(threadId, false))
  }

  // A thread is archived first; deleting an archived thread is permanent, so it asks first and has no Undo.
  const askDelete = (request: DeleteRequest) => {
    setDeleteState({ busy: false })
    setDeleteRequest(request)
  }

  const cancelDelete = () => {
    if (deleteState.busy) return
    setDeleteRequest(null)
    setDeleteState({ busy: false })
  }

  const confirmDelete = async () => {
    if (!deleteRequest || deleteState.busy) return
    const targets = deleteRequest.kind === 'one' ? [deleteRequest.thread] : deleteRequest.threads
    setDeleteState({ busy: true })
    const { deleted, error } = await deleteThreads(targets, (threadId) => window.mousse.threads.delete(threadId))
    if (error) {
      // What is still there stays in the dialog; what went is gone from it.
      const left = targets.filter((thread) => !deleted.includes(thread.id))
      setDeleteRequest(deleteRequest.kind === 'one' ? deleteRequest : { ...deleteRequest, threads: left })
      setDeleteState({ busy: false, error })
      return
    }
    setDeleteRequest(null)
    setDeleteState({ busy: false })
    // The row the delete started from is gone; keyboard focus goes to the Archived heading, not the page.
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (!active || active === document.body || !active.isConnected) archivedHeadingRef.current?.focus()
    })
  }

  const handlePin = () => {
    if (!contextMenu) return
    const { target } = contextMenu
    closeContextMenu()
    void setPinned(target.type, target.id, !target.pinned)
  }

  const handleSetExpiry = async (ms: number | null) => {
    if (!contextMenu || contextMenu.target.type !== 'thread') return
    const { target } = contextMenu
    closeContextMenu()
    try {
      await window.mousse.threads.setExpiry(target.id, ms === null ? null : expiresAtAfter(ms))
    } catch (error) {
      console.error('Setting when the thread is deleted failed', error)
    }
  }

  const handleArchive = () => {
    if (!contextMenu || contextMenu.target.type !== 'thread') return
    const { target } = contextMenu
    closeContextMenu()
    void setArchived(target.id, !target.settled)
  }

  const handleRegenerateTitle = async () => {
    if (!contextMenu || contextMenu.target.type !== 'thread') return
    const threadId = contextMenu.target.id
    closeContextMenu()
    setPendingTitleIds((prev) => new Set(prev).add(threadId))
    await runWithToast('regenerate the title', () => window.mousse.threads.regenerateTitle(threadId), { retry: true })
    setPendingTitleIds((prev) => {
      const next = new Set(prev)
      next.delete(threadId)
      return next
    })
  }

  const handleNewProjectThread = () => {
    if (!contextMenu || contextMenu.target.type !== 'project') return
    const projectId = contextMenu.target.id
    closeContextMenu()
    void createProjectThread(projectId)
  }

  const handleNewThreadFromPullRequest = () => {
    if (!contextMenu || contextMenu.target.type !== 'project') return
    const { id, name } = contextMenu.target
    closeContextMenu()
    setPullRequestProject({ id, name })
  }

  const handleTrustGitSettings = () => {
    if (!contextMenu || contextMenu.target.type !== 'project') return
    const projectId = contextMenu.target.id
    closeContextMenu()
    void runWithToast('trust Git settings', () => window.mousse.projects.trustGitSettings(projectId), { retry: true })
  }

  /** The apps a project of this computer opens in: the editor last chosen (or the first found) and the file manager. */
  const projectOpeners = (target: ThreadsContextMenuTarget): { openInEditor?: ProjectOpener; reveal?: ProjectOpener } => {
    const path = target.path
    if (target.type !== 'project' || target.node || !path || !editors) return {}
    const { editors: apps, files } = splitEditors(editors)
    const opener = (editor: (typeof editors)[number] | null | undefined): ProjectOpener | undefined => editor
      ? {
          label: openLabel(editor),
          onSelect: () => {
            closeContextMenu()
            void runWithToast('open the folder', () => window.mousse.editors.open(editor.id, path))
          }
        }
      : undefined
    return { openInEditor: opener(defaultEditor(apps, loadLastEditorId(profileId))), reveal: opener(files[0]) }
  }

  const handleCopyPath = () => {
    if (!contextMenu?.target.path) return
    const { path } = contextMenu.target
    closeContextMenu()
    void runWithToast('copy the path', () => navigator.clipboard.writeText(path))
  }

  const handleRename = () => {
    if (!contextMenu) return
    const { target, inNeedsMe, returnFocus } = contextMenu
    closeContextMenu()
    startRename({ type: target.type, id: target.id, name: target.name, inNeedsMe, returnFocus })
  }

  // Only an archived thread of this computer is deleted, after its confirmation; a project asks first too.
  const handleRemove = () => {
    if (!contextMenu) return
    const { target } = contextMenu
    closeContextMenu()
    if (target.type === 'thread') {
      if (target.settled && !target.node) askDelete({ kind: 'one', thread: { id: target.id, name: target.name } })
    } else setRemovingProject(target)
  }

  const confirmRemoveProject = () => {
    if (!removingProject) return
    const projectId = removingProject.id
    setRemovingProject(null)
    void runWithToast('remove the project', () => window.mousse.projects.remove(projectId), { retry: true })
  }

  const submitRename = (name: string) => {
    if (!renaming) return
    const { type, id } = renaming
    endRename()
    return runWithToast('rename', () => (type === 'thread' ? window.mousse.threads.rename(id, name) : window.mousse.projects.rename(id, name)), { retry: true })
  }

  const renderThreadStatus = (threadId: string) => {
    const status = threadStatus(rolledUpActivity[threadId] ?? threadActivity[threadId], approvalThreads.has(threadId))
    switch (status) {
      case 'working':
        return (
          <Loader2
            size={14}
            strokeWidth={2}
            className="threads-sidebar-status-spinner icon-spin"
            aria-hidden="true"
          />
        )
      case 'done':
        return (
          <CircleCheck
            size={14}
            strokeWidth={2}
            className="threads-sidebar-status-icon threads-sidebar-status-icon--completed"
            aria-label="Agent finished"
          />
        )
      case 'approval':
        return (
          <Shield
            size={14}
            strokeWidth={2}
            className="threads-sidebar-status-icon threads-sidebar-status-icon--question"
            aria-label="Agent needs approval"
          />
        )
      case 'question':
        return (
          <MessageQuestion
            size={14}
            strokeWidth={2}
            className="threads-sidebar-status-icon threads-sidebar-status-icon--question"
            aria-label="Agent needs input"
          />
        )
      case 'waiting':
        return (
          <CircleDotDashed
            size={14}
            strokeWidth={2}
            className="threads-sidebar-status-icon threads-sidebar-status-icon--waiting"
            aria-label="Agent is waiting"
          />
        )
      case 'paused': {
        const turn = turnStates[threadId]
        const own = turn?.phase === 'paused' ? turn.pause : undefined
        const label = pausedStatusLabel(own, Date.now())
        return (
          <Pause
            size={14}
            strokeWidth={2}
            className="threads-sidebar-status-icon threads-sidebar-status-icon--paused"
            aria-label={label}
          />
        )
      }
      case 'quiet':
        return null
    }
  }

  useEffect(() => {
    if (pendingTitleIds.size === 0) return
    const stillPending = threads.filter((t) => pendingTitleIds.has(t.id) && !isDefaultThreadName(t.name))
    if (stillPending.length === 0) return
    setPendingTitleIds((prev) => {
      const next = new Set(prev)
      let changed = false
      for (const t of stillPending) {
        if (next.delete(t.id)) {
          changed = true
          const timer = pendingTimers.current.get(t.id)
          if (timer) {
            clearTimeout(timer)
            pendingTimers.current.delete(t.id)
          }
        }
      }
      return changed ? next : prev
    })
  }, [threads, pendingTitleIds])

  useEffect(() => {
    const now = Date.now()
    for (const thread of threads) {
      if (pendingTitleIds.has(thread.id)) continue
      if (!isDefaultThreadName(thread.name) || !thread.startedAt) continue
      const age = now - new Date(thread.startedAt).getTime()
      if (Number.isNaN(age) || age < 0 || age > 15000) continue
      if (pendingTimers.current.has(thread.id)) continue
      setPendingTitleIds((prev) => new Set(prev).add(thread.id))
      const remaining = Math.max(1000, 15000 - age)
      const timer = setTimeout(() => {
        setPendingTitleIds((prev) => {
          const next = new Set(prev)
          next.delete(thread.id)
          return next
        })
        pendingTimers.current.delete(thread.id)
      }, remaining)
      pendingTimers.current.set(thread.id, timer)
    }
    return () => {}
  }, [threads, pendingTitleIds])

  useEffect(() => {
    return () => {
      for (const timer of pendingTimers.current.values()) clearTimeout(timer)
      pendingTimers.current.clear()
    }
  }, [])

  // The composer's `/rename` with no title: rename the thread in its row, when the row is on screen.
  // Handling it cancels the event, so the composer knows not to show its hint instead.
  useEffect(() => {
    const onRename = (event: Event) => {
      const threadId = (event as CustomEvent<{ threadId?: string }>).detail?.threadId
      const thread = threadId ? threads.find((entry) => entry.id === threadId) : undefined
      if (!thread) return
      // Other panels mark elements with the thread id too: only a sidebar row on screen counts.
      const rows = document.querySelectorAll<HTMLElement>(`.threads-sidebar-thread[data-thread-id="${CSS.escape(thread.id)}"]`)
      const visible = [...rows].filter((row) => row.offsetParent !== null)
      if (visible.length === 0) return
      // The thread's own row first; its copy in "Needs me" only when that is the one on screen.
      const row = visible.find((entry) => !entry.closest('.threads-sidebar-needs-me')) ?? visible[0]
      event.preventDefault()
      startRename({ type: 'thread', id: thread.id, name: thread.name, inNeedsMe: Boolean(row.closest('.threads-sidebar-needs-me')), returnFocus: row.closest('button') ?? row })
    }
    window.addEventListener('mousse:rename-thread', onRename)
    return () => window.removeEventListener('mousse:rename-thread', onRename)
  }, [threads])

  /**
   * `inNeedsMe`: a copy of the row in the "Needs me" group, which filters rows and so does not reorder them.
   * `inTree`: a thread row of the Projects tree (or, with `treeLevel` 1 and `treeTabStop` of its own, of the
   * "No project" tree), a tree item with a roving tab stop; `clipped` marks one past a project's preview of 5
   * that is not shown, which keyboard and screen readers skip until it is.
   */
  const renderThreadRow = (thread: (typeof threads)[number], { root = false, layout = 'row', inNeedsMe = false, inTree = false, treeLevel = 2, tabStop = treeTabStop, clipped = false }: {
    root?: boolean
    layout?: 'row' | 'card'
    inNeedsMe?: boolean
    inTree?: boolean
    treeLevel?: 1 | 2
    tabStop?: string
    clipped?: boolean
  } = {}) => {

    const isArchived = Boolean(thread.settledAt)
    const isRenaming = renaming?.type === 'thread' && renaming.id === thread.id && Boolean(renaming.inNeedsMe) === inNeedsMe
    const isGeneratingTitle = pendingTitleIds.has(thread.id)
    const statusNode = renderThreadStatus(thread.id)
    const worktree = worktreeMark(thread, worktreeByDefault)
    const showTrailing = Boolean(statusNode || worktree || thread.node)
    const groupId = groupIdOf(thread.projectId)
    const group = groupId ? groupById.get(groupId) : undefined
    // Only the Threads tab's cards carry the project's tint, unless Appearance turns it off; a thread without a
    // project has none.
    const hue = layout === 'card' && threadProjectColors && group ? hueByGroup.get(group.id) : undefined
    const menuTarget: ThreadsContextMenuTarget = {
      type: 'thread', id: thread.id, name: thread.name, pinned: Boolean(thread.pinnedAt), settled: isArchived,
      ...(thread.node ? { node: thread.node, computerName: nameOfComputer(thread.node) } : {}),
      ...(thread.expiresAt ? { expiresAt: thread.expiresAt } : {}),
      canExpire: !thread.node && !thread.lineage
    }
    const menuKey = `thread:${thread.id}${inNeedsMe ? ':needs-me' : ''}`
    // The tooltip of a title that does not fit. The project is the row's parent or on the card; a row names its
    // computer only by icon, so the tooltip adds the name.
    const computerName = layout === 'row' && thread.node ? computers[thread.node]?.name ?? UNKNOWN_COMPUTER_NAME : undefined
    const fullTitle = computerName ? `${thread.name} · ${computerName}` : thread.name
    const isActive = activeThreadId === thread.id
    // Double-click on the title renames; focus goes back to the row afterwards.
    const renameFromTitle = (event: React.MouseEvent<HTMLElement>) => {
      event.stopPropagation()
      startRename({ type: 'thread', id: thread.id, name: thread.name, inNeedsMe, returnFocus: event.currentTarget.closest('button') })
    }
    // In the tree the row's own buttons leave the Tab order: the tree is one stop, and the row menu has them all.
    const actionTabIndex = inTree ? -1 : undefined
    // Cards in the Threads tab can be dragged into an order of their own (archived and Needs me rows cannot).
    const feed = layout === 'card' && !isArchived && !inNeedsMe
    const dragItem: DraggedSidebarItem = { type: 'thread', id: thread.id, projectId: groupIdOf(thread.projectId), pinned: Boolean(thread.pinnedAt), ...(feed ? { feed } : {}) }
    const dropLine = !inNeedsMe && feedDrop?.id === thread.id ? (feedDrop.after ? ' drop-after' : ' drop-before') : ''
    // The lower half of a row drops after it, so a row can also go last.
    const dropsAfter = (event: React.DragEvent) => {
      const rect = event.currentTarget.getBoundingClientRect()
      return event.clientY > rect.top + rect.height / 2
    }

    return (

      <div
        key={thread.id}
        className={`threads-sidebar-thread-container${speakingThreadId === thread.id ? ' speaking' : ''}${dropLine}`}
        inert={clipped || undefined}
      >

      <button

        type="button"

        className={`threads-sidebar-thread${layout === 'card' ? ' threads-sidebar-card' : ''}${root ? ' threads-sidebar-thread-root' : ''}${

          isActive ? ' active' : openSubagentParentId === thread.id ? ' has-open-subagent' : ''

        }${thread.pinnedAt ? ' pinned' : ''}${isArchived ? ' settled' : ''}${hue ? ' project-tinted' : ''}`}

        style={hue ? ({ '--project-tint': `var(--hue-${hue})` } as CSSProperties) : undefined}

        aria-current={isActive ? 'page' : undefined}

        {...(inTree ? {
          role: 'treeitem',
          'aria-level': treeLevel,
          'aria-selected': isActive || openSubagentParentId === thread.id,
          tabIndex: tabStop === `thread:${thread.id}` ? 0 : -1,
          'data-tree-key': `thread:${thread.id}`,
          onFocus: () => setTreeFocus(`thread:${thread.id}`)
        } : {})}

        data-thread-id={thread.id}

        draggable={!isRenaming && !isArchived && !inNeedsMe}

        onDragStart={(event) => {
          event.stopPropagation()
          startDrag(event, dragItem)
        }}

        onDragOver={(event) => {
          if (inNeedsMe || !canDropOn(dragItem)) return
          event.preventDefault()
          if (!feed) return
          event.stopPropagation()
          const after = dropsAfter(event)
          if (feedDrop?.id !== thread.id || feedDrop.after !== after) setFeedDrop({ id: thread.id, after })
        }}

        onDrop={(event) => {
          event.stopPropagation()
          event.preventDefault()
          if (inNeedsMe) return
          if (feed) dropFeedThread(thread.id, dropsAfter(event))
          else void reorderBefore(dragItem)
        }}

        onDragEnd={endDrag}

        onClick={() => {

          if (!isRenaming && !suppressClick.current) void selectThread(thread.id)

        }}

        onKeyDown={(event) => {
          if (isRenaming) return
          if (event.key === 'F2') {
            event.preventDefault()
            startRename({ type: 'thread', id: thread.id, name: thread.name, inNeedsMe, returnFocus: event.currentTarget })
          } else if (isMenuKey(event)) {
            event.preventDefault()
            openMenuBelow(event.currentTarget, menuTarget, inNeedsMe)
          } else if (event.key === 'Delete' && isArchived && !thread.node) {
            // Delete on an archived row asks first, like its Delete…; a thread in use is archived first.
            event.preventDefault()
            askDelete({ kind: 'one', thread: { id: thread.id, name: thread.name } })
          }
        }}

        onContextMenu={(event) => openContextMenu(event, menuTarget, inNeedsMe)}

      >

        {layout === 'card' ? (
          <ThreadCardBody
            thread={thread}
            projectName={group?.project.name}
            hue={hue}
            activity={rolledUpActivity[thread.id] ?? threadActivity[thread.id]}
            awaitsApproval={approvalThreads.has(thread.id)}
            startedAt={turnStates[thread.id]?.startedAt}
            pause={turnStates[thread.id]?.phase === 'paused' ? turnStates[thread.id]?.pause : undefined}
            isRenaming={isRenaming}
            renamingName={renaming?.name ?? ''}
            isGeneratingTitle={isGeneratingTitle}
            worktree={worktree}
            fullTitle={fullTitle}
            onRename={(name) => void submitRename(name)}
            onCancelRename={endRename}
            onStartRename={renameFromTitle}
          />
        ) : (
          <>
        {thread.pinnedAt && (

          <Pin size={12} strokeWidth={2} className="threads-sidebar-pin-icon" aria-hidden="true" />

        )}

        {thread.localOnly && (
          <span className="thread-private-icon" title="Private: stays on this computer">
            <Lock size={12} strokeWidth={2} aria-label="Private" />
          </span>
        )}

        {thread.expiresAt && (
          <span className="thread-expiry-icon" title={`Deletes ${expiresInLabel(thread.expiresAt)}`}>
            <Clock size={12} strokeWidth={2} aria-label="Deletes itself" />
          </span>
        )}

        {isRenaming ? (

          <SidebarRenameInput

            initialName={renaming.name}

            onSubmit={(name) => void submitRename(name)}

            onCancel={endRename}

          />

        ) : isGeneratingTitle ? (

          <span className="threads-sidebar-skeleton" aria-label="Generating title" />

        ) : (

          <ThreadTitle name={thread.name} fullTitle={fullTitle} onDoubleClick={renameFromTitle} />

        )}

        {showTrailing && (
          <span className="threads-sidebar-thread-trailing">
            {statusNode}
            <ThreadComputerBadge thread={thread} className="threads-sidebar-device-icon" />
            {worktree && (
              <span className="threads-sidebar-worktree-icon" role="img" aria-label={worktree} title={worktree}>
                <GitBranch size={12} strokeWidth={2} aria-hidden="true" />
              </span>
            )}
          </span>
        )}
          </>
        )}

      </button>

      {speakingThreadId === thread.id && <ThreadSpeechIndicator />}

      {!isRenaming && (
        <span className="threads-sidebar-thread-actions">
          <button
            type="button"
            className={`threads-sidebar-thread-action${thread.pinnedAt ? ' active' : ''}`}
            aria-label={thread.pinnedAt ? `Unpin ${thread.name}` : `Pin ${thread.name}`}
            title={thread.pinnedAt ? 'Unpin' : 'Pin'}
            tabIndex={actionTabIndex}
            onClick={(event) => {
              event.stopPropagation()
              void setPinned('thread', thread.id, !thread.pinnedAt)
            }}
          >
            <Pin size={13} strokeWidth={2} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="threads-sidebar-thread-action"
            aria-label={isArchived ? `Unarchive ${thread.name}` : `Archive ${thread.name}`}
            title={isArchived ? 'Unarchive' : 'Archive'}
            tabIndex={actionTabIndex}
            onClick={(event) => {
              event.stopPropagation()
              void setArchived(thread.id, !isArchived)
            }}
          >
            <Archive size={13} strokeWidth={2} aria-hidden="true" />
          </button>
          {isArchived && (
            <button
              type="button"
              className="threads-sidebar-thread-action danger"
              data-action="delete"
              aria-label={thread.node ? `Delete ${thread.name} on ${nameOfComputer(thread.node)}` : `Delete ${thread.name}…`}
              title={thread.node ? `Delete on ${nameOfComputer(thread.node)}` : 'Delete…'}
              disabled={Boolean(thread.node)}
              tabIndex={actionTabIndex}
              onClick={(event) => {
                event.stopPropagation()
                askDelete({ kind: 'one', thread: { id: thread.id, name: thread.name } })
              }}
            >
              <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="threads-sidebar-thread-action"
            aria-label={`More actions for ${thread.name}`}
            title="More"
            aria-haspopup="menu"
            aria-expanded={contextMenu?.anchorKey === menuKey}
            tabIndex={actionTabIndex}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => toggleMenuFrom(event, menuTarget, menuKey, inNeedsMe)}
          >
            <MoreHorizontal size={13} strokeWidth={2} aria-hidden="true" />
          </button>
        </span>
      )}

      </div>

    )

  }



  const renderNeedsMe = () => showNeedsMe && (
    <section className="threads-sidebar-needs-me" aria-label={needsMeLabel(needsMe.length)}>
      <div className="threads-sidebar-heading">
        <span className="threads-sidebar-heading-label">Needs me · {needsMe.length}</span>
      </div>
      <div className="threads-sidebar-tree threads-sidebar-thread-feed">
        {needsMe.map((thread) => renderThreadRow(thread, { root: true, layout: 'card', inNeedsMe: true }))}
      </div>
    </section>
  )

  return (

    // While a menu is open, the rows under the pointer do not light their actions (see threads-sidebar.css).
    <aside className={`threads-sidebar${contextMenu ? ' menu-open' : ''}${className ? ` ${className}` : ''}`} style={{ width: threadsSidebarWidth }}>

      <div className="threads-sidebar-tabs-row">
        <div className="threads-sidebar-tabs" role="tablist" aria-label="Sidebar" onKeyDown={onTabKeyDown}>
          {([
            ['projects', 'Projects', FolderKanban],
            ['threads', 'Threads', ListTree],
            ['chats', 'Agents', MessagesSquare]
          ] as const).map(([view, label, Icon]) => (
            <button
              key={view}
              type="button"
              role="tab"
              id={`${tabsId}-${view}-tab`}
              tabIndex={sidebarView === view ? 0 : -1}
              aria-selected={sidebarView === view}
              aria-controls={`${tabsId}-${view}-panel`}
              title={label}
              aria-label={label}
              className={`threads-sidebar-tab${sidebarView === view ? ' active' : ''}`}
              onClick={() => void setSidebarView(view)}
            >
              <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
              <span className="threads-sidebar-tab-label">{label}</span>
            </button>
          ))}
        </div>
        <button type="button" className="threads-sidebar-toolbar-button threads-sidebar-add-project" onClick={() => void openProject()} title="Add project" aria-label="Add project">
          <FolderPlus size={16} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>

      <div ref={scrollRef} className="threads-sidebar-scroll" data-view={sidebarView} data-more-below={moreBelow || undefined}>

      <div className="threads-sidebar-section threads-sidebar-section-projects" role="tabpanel" id={`${tabsId}-projects-panel`} aria-labelledby={`${tabsId}-projects-tab`} hidden={sidebarView !== 'projects'}>

        {sidebarView === 'projects' && renderNeedsMe()}

        {projectGroups.length === 0 ? (

          <div className="threads-sidebar-tree">
            <div className="threads-sidebar-empty threads-sidebar-empty-projects">
              <span>No projects</span>
              <button type="button" className="threads-sidebar-inline-action" onClick={() => void openProject()}>Add project</button>
            </div>
          </div>

        ) : (

        <div className="threads-sidebar-tree" role="tree" aria-label="Projects" onKeyDown={onTreeKeyDown}>

          {projectGroups.map((group) => {

              // The group is named by one project: this computer's when it has one.
              const project = group.project
              const alsoOn = groupComputers(group).filter((node) => node !== project.node)

              const expanded = expandedProjects.has(project.id)

              const projectThreads = projectThreadsOf(group.id)
              const projectThreadCount = projectThreads.length
              // The project row carries its threads' state: the worst of them, and while it is closed how many need the person.
              const projectLevels = projectThreads.map((thread) => attentionOf(thread.id))
              const projectAttention = worstOf(projectLevels)
              const projectNeedsMe = projectLevels.filter((level) => level === 'needs-me').length
              const projectAttentionTitle = projectAttention === 'needs-me'
                ? needsMeLabel(projectNeedsMe)
                : projectAttention === 'quiet' ? '' : PROJECT_ATTENTION_TITLE[projectAttention]

              const showAllProjectThreads = expandedProjectThreadLists.has(project.id)

              const isRenaming = renaming?.type === 'project' && renaming.id === project.id
              const menuTarget: ThreadsContextMenuTarget = {
                type: 'project',
                id: project.id,
                name: project.name,
                pinned: Boolean(project.pinnedAt),
                path: project.path,
                // The menu acts on the project that names the group, on the computer that holds it.
                ...(project.node ? { node: project.node, computerName: computers[project.node]?.name ?? UNKNOWN_COMPUTER_NAME } : {}),
                ...(alsoOn.length ? { alsoOn: alsoOn.map((node) => computers[node]?.name ?? UNKNOWN_COMPUTER_NAME) } : {})
              }
              // "name · ~/path · computer" on one line: the computer only when projects of several computers are listed.
              const projectTitle = projectTooltip({
                name: project.name,
                path: project.path,
                computerName: menuTarget.computerName,
                selfName,
                home: homeFolder
              })
              const menuKey = `project:${project.id}`
              const treeKey = `project:${project.id}`
              const childrenId = `${tabsId}-project-${project.id}`



              return (

                <div
                  key={project.id}
                  className="threads-sidebar-project"
                  data-project-id={project.id}
                  draggable={!isRenaming}
                  onDragStart={(event) => startDrag(event, { type: 'project', id: project.id })}
                  onDragOver={(event) => {
                    if (canDropOn({ type: 'project', id: project.id })) event.preventDefault()
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    void reorderBefore({ type: 'project', id: project.id })
                  }}
                  onDragEnd={endDrag}
                >

                  <div

                    className={`threads-sidebar-project-row${expanded ? ' expanded' : ''}${project.pinnedAt ? ' pinned' : ''}`}
                    // The row's tooltips sit beside the sidebar, level with the row, never over the rows around it.
                    data-tooltip-placement="outside-left"

                  >

                    <button

                      type="button"

                      className="threads-sidebar-project-toggle"

                      role="treeitem"

                      aria-level={1}

                      aria-expanded={expanded}

                      aria-owns={expanded ? childrenId : undefined}

                      tabIndex={treeTabStop === treeKey ? 0 : -1}

                      data-tree-key={treeKey}

                      title={isRenaming ? undefined : projectTitle.text}
                      data-tooltip-one-line=""
                      aria-description={isRenaming ? undefined : projectTitle.full}

                      onFocus={() => setTreeFocus(treeKey)}

                      onClick={() => {

                        if (!isRenaming) toggleProject(project.id)

                      }}

                      onKeyDown={(event) => {
                        if (isRenaming) return
                        if (event.key === 'F2') {
                          event.preventDefault()
                          startRename({ type: 'project', id: project.id, name: project.name, returnFocus: event.currentTarget })
                        } else if (isMenuKey(event)) {
                          event.preventDefault()
                          openMenuBelow(event.currentTarget, menuTarget)
                        } else if (event.key === 'Delete') {
                          event.preventDefault()
                          setRemovingProject(menuTarget)
                        }
                      }}

                      onContextMenu={(event) => openContextMenu(event, menuTarget)}

                    >

                      {/* Says the row opens: shown on hover and focus, turned down while open. */}
                      <ChevronRight size={12} strokeWidth={2} className="threads-sidebar-project-chevron" aria-hidden="true" />

                      {expanded ? (
                        <FolderOpen size={16} strokeWidth={1.8} className="threads-sidebar-project-icon" aria-hidden="true" />
                      ) : (
                        <Folder size={16} strokeWidth={1.8} className="threads-sidebar-project-icon" aria-hidden="true" />
                      )}

                      {project.pinnedAt && (

                        <Pin

                          size={12}

                          strokeWidth={2}

                          className="threads-sidebar-pin-icon"

                          aria-hidden="true"

                        />

                      )}

                      {isRenaming ? (

                        <SidebarRenameInput

                          className="threads-sidebar-project-rename"

                          initialName={renaming.name}

                          onSubmit={(name) => void submitRename(name)}

                          onCancel={endRename}

                        />

                      ) : (

                        <span
                          className="threads-sidebar-project-name"
                          onDoubleClick={(event) => {
                            event.stopPropagation()
                            startRename({ type: 'project', id: project.id, name: project.name, returnFocus: event.currentTarget.closest('button') })
                          }}
                        >{project.name}</span>

                      )}

                      {projectAttention !== 'quiet' && (
                        <span
                          className={`threads-sidebar-project-status threads-sidebar-project-status--${projectAttention}`}
                          role="img"
                          aria-label={projectAttentionTitle}
                          title={projectAttentionTitle}
                        >
                          <span className="threads-sidebar-status-dot" aria-hidden="true" />
                          {!expanded && projectNeedsMe > 0 && (
                            <span className="threads-sidebar-project-count" aria-hidden="true">{projectNeedsMe}</span>
                          )}
                        </span>
                      )}

                      <ThreadComputerBadge thread={project} withName of="project" className="threads-sidebar-project-computer" />

                      {/* A project this computer has too: the other computers that hold it are marked by icon. */}
                      {alsoOn.map((node) => (
                        <ThreadComputerBadge
                          key={node}
                          thread={group.members.find((member) => member.node === node) ?? { node }}
                          of="also"
                          className="threads-sidebar-project-also"
                        />
                      ))}

                    </button>

                    <button
                      type="button"
                      className="threads-sidebar-icon-btn threads-sidebar-project-more"
                      title="More"
                      aria-label={`More actions for ${project.name}`}
                      aria-haspopup="menu"
                      aria-expanded={contextMenu?.anchorKey === menuKey}
                      tabIndex={-1}
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={(event) => toggleMenuFrom(event, menuTarget, menuKey)}
                    >
                      <MoreHorizontal size={14} strokeWidth={2} aria-hidden="true" />
                    </button>

                    <button
                      type="button"
                      className="threads-sidebar-icon-btn threads-sidebar-project-new-chat"
                      title="New thread in project"
                      aria-label={`New thread in ${project.name}`}
                      tabIndex={-1}
                      onClick={() => {
                        void createProjectThread(project.id)
                      }}
                    >
                      <MessageSquarePlus size={14} strokeWidth={2} aria-hidden="true" />
                    </button>

                  </div>

                  <Collapse
                    open={expanded}
                    animate={toggledProjectRef.current === project.id}
                    id={childrenId}
                    role="group"
                    className="threads-sidebar-children"
                    itemCount={projectThreadCount}
                  >

                      {projectThreadCount === 0 ? (

                        <div className="threads-sidebar-empty threads-sidebar-empty-nested" role="none">
                          <span>No threads</span>
                          <button
                            type="button"
                            className="threads-sidebar-icon-btn threads-sidebar-empty-new-thread"
                            title={`New thread in ${project.name}`}
                            aria-label={`New thread in ${project.name}`}
                            onClick={() => void createProjectThread(project.id)}
                          >
                            <MessageSquarePlus size={14} strokeWidth={2} aria-hidden="true" />
                          </button>
                        </div>

                      ) : (

                        <>
                          <div
                            className={`threads-sidebar-thread-list ui-collapse-items${showAllProjectThreads ? ' expanded' : ''}`}
                            style={{ '--project-thread-count': projectThreadCount } as CSSProperties}
                            role="none"
                          >
                            {projectThreads.map((thread, index) => renderThreadRow(thread, {
                              inTree: true,
                              clipped: !showAllProjectThreads && index >= PROJECT_THREAD_PREVIEW_LIMIT
                            }))}
                          </div>
                          {projectThreadCount > PROJECT_THREAD_PREVIEW_LIMIT && (
                            <button
                              type="button"
                              className="threads-sidebar-show-more"
                              tabIndex={-1}
                              onClick={() => {
                                setExpandedProjectThreadLists((prev) => {
                                  const next = new Set(prev)
                                  if (showAllProjectThreads) next.delete(project.id)
                                  else next.add(project.id)
                                  return next
                                })
                              }}
                            >
                              {showAllProjectThreads ? 'Show less' : 'Show more'}
                            </button>
                          )}
                        </>

                      )}

                  </Collapse>

                </div>

              )

            })}

        </div>

        )}

      </div>



      <div className="threads-sidebar-section threads-sidebar-section-feed" role="tabpanel" id={`${tabsId}-threads-panel`} aria-labelledby={`${tabsId}-threads-tab`} hidden={sidebarView !== 'threads'}>
        {sidebarView === 'threads' && renderNeedsMe()}
        <div
          className="threads-sidebar-tree threads-sidebar-thread-feed threads-sidebar-feed-list"
          // Below the last row the dragged row goes last; in the gap between two rows, where the line shows.
          onDragOver={(event) => {
            if (!draggedItem.current?.feed) return
            event.preventDefault()
            const rows = event.currentTarget.querySelectorAll('.threads-sidebar-thread-container')
            const bottom = rows[rows.length - 1]?.getBoundingClientRect().bottom
            const last = feedThreads[feedThreads.length - 1]
            if (last && bottom !== undefined && event.clientY > bottom && (feedDrop?.id !== last.id || !feedDrop.after)) {
              setFeedDrop({ id: last.id, after: true })
            }
          }}
          onDrop={(event) => {
            if (!draggedItem.current?.feed) return
            event.preventDefault()
            if (feedDrop) dropFeedThread(feedDrop.id, feedDrop.after)
          }}
        >
          {feedThreads.length === 0 ? (
            <div className="threads-sidebar-empty">No threads</div>
          ) : (
            <>
              {feedThreads.map((thread) => renderThreadRow(thread, { root: true, layout: 'card' }))}
            </>
          )}
        </div>
      </div>

      <div className="threads-sidebar-section threads-sidebar-section-chats" role="tabpanel" id={`${tabsId}-chats-panel`} aria-labelledby={`${tabsId}-chats-tab`} hidden={sidebarView !== 'chats'}>
        {sidebarView === 'chats' && <ChatsSidebar />}
      </div>

      </div>

      {/* The same footer under Projects and Threads: "No project" (the Threads list already holds those threads,
          so only Projects shows it), then one "Archived" disclosure, with Clear all. */}
      <div className="threads-sidebar-footer" hidden={sidebarView === 'chats'}>

        <section className="threads-sidebar-section threads-sidebar-bottom-recent" aria-label="No project" hidden={sidebarView !== 'projects'}>
          <div className="threads-sidebar-heading">
            <button type="button" className="threads-sidebar-heading-toggle"
              onClick={() => setNoProjectExpanded((expanded) => !expanded)} aria-expanded={noProjectExpanded}>
              <Folder size={14} strokeWidth={2} aria-hidden="true" />
              <span>No project · {orphanThreads.length}</span>
            </button>
          </div>
          {/* The same rows and indent as a project's threads. */}
          <Collapse open={noProjectExpanded} itemCount={orphanThreads.length}>
            {orphanThreads.length === 0 ? (
              <div className="threads-sidebar-tree">
                <div className="threads-sidebar-children">
                  <div className="threads-sidebar-empty threads-sidebar-empty-nested">No threads</div>
                </div>
              </div>
            ) : (
              <div className="threads-sidebar-tree" role="tree" aria-label="No project" onKeyDown={onTreeKeyDown}>
                <div className="threads-sidebar-children" role="none">
                  {orphanThreads.map((thread) => renderThreadRow(thread, { inTree: true, treeLevel: 1, tabStop: noProjectTabStop }))}
                </div>
              </div>
            )}
          </Collapse>
        </section>

        <section className={`threads-sidebar-section threads-sidebar-section-settled${archivedExpanded ? '' : ' collapsed'}`} aria-label="Archived">

          <div className="threads-sidebar-heading">
            <button
              ref={archivedHeadingRef}
              type="button"
              className="threads-sidebar-heading-toggle"
              onClick={() => setArchivedExpanded((expanded) => !expanded)}
              aria-expanded={archivedExpanded}
            >
              <Archive size={14} strokeWidth={2} className="threads-sidebar-settled-icon" aria-hidden="true" />
              <span>Archived · {archivedThreads.length}</span>
            </button>
            {localArchivedCount > 0 && (
              <button
                type="button"
                className="threads-sidebar-heading-action"
                data-testid="archived-clear-all"
                aria-label="Delete all archived threads…"
                title="Delete all archived threads"
                onClick={() => askDelete(clearAllRequest(archivedThreads.map((thread) => ({ id: thread.id, name: thread.name, ...(thread.node ? { node: thread.node } : {}) }))))}
              >
                Clear all
              </button>
            )}
          </div>

          <Collapse open={archivedExpanded} itemCount={archivedThreads.length}>
              <div className="threads-sidebar-tree threads-sidebar-thread-feed threads-sidebar-settled-list">
                {archivedThreads.length === 0 ? (
                  <div className="threads-sidebar-empty">No archived threads</div>
                ) : (
                  archivedThreads.map((thread) => renderThreadRow(thread, { root: true, layout: 'card' }))
                )}
              </div>
          </Collapse>

        </section>

      </div>

      {deleteRequest && (
        <DeleteArchivedDialog
          request={deleteRequest}
          busy={deleteState.busy}
          error={deleteState.error}
          onConfirm={() => void confirmDelete()}
          onCancel={cancelDelete}
        />
      )}

      <ProfileSwitcher onSwitched={(profile) => useAppStore.getState().activateProfile(profile.id)} />

      {contextMenu && (

        <ThreadsContextMenu

          x={contextMenu.x}

          y={contextMenu.y}

          target={contextMenu.target}

          onClose={closeContextMenu}

          onPin={handlePin}

          onArchive={handleArchive}

          onRegenerateTitle={() => void handleRegenerateTitle()}

          onRename={handleRename}

          onRemove={handleRemove}
          onTrustGitSettings={handleTrustGitSettings}
          onNewThread={handleNewProjectThread}
          onNewThreadFromPullRequest={handleNewThreadFromPullRequest}
          {...projectOpeners(contextMenu.target)}
          onCopyPath={contextMenu.target.path ? handleCopyPath : undefined}

          onSetExpiry={(ms) => void handleSetExpiry(ms)}

        />

      )}

      <Modal
        open={removingProject !== null}
        title="Remove project"
        onClose={() => setRemovingProject(null)}
        footer={<>
          <button type="button" className="settings-btn" onClick={() => setRemovingProject(null)}>Cancel</button>
          <button type="button" className="settings-btn" data-testid="remove-project-confirm" onClick={confirmRemoveProject}>Remove</button>
        </>}
      >
        {removingProject && (
          <p className="threads-sidebar-remove-project">
            {removingProject.computerName ? `${removingProject.name} on ${removingProject.computerName}` : removingProject.name} leaves the sidebar. Its folder and threads stay.
            {removingProject.alsoOn?.length ? ` ${removingProject.alsoOn.join(' and ')} keep${removingProject.alsoOn.length === 1 ? 's' : ''} theirs.` : ''}
          </p>
        )}
      </Modal>

      {pullRequestProject && (
        <StartFromPullRequestDialog
          projectId={pullRequestProject.id}
          projectName={pullRequestProject.name}
          onClose={() => setPullRequestProject(null)}
        />
      )}

    </aside>

  )

}
