import { useEffect, useId, useMemo, useRef, useState } from 'react'

import type { CSSProperties, KeyboardEvent } from 'react'

import { Archive, CircleCheck, CircleDotDashed, Folder, FolderOpen, FolderPlus, FolderKanban, GitBranch, GitPullRequest, ListTree, Loader2, MessageQuestion, MessagesSquare, MessageSquarePlus, MoreHorizontal, Pause, Pin, Shield } from '../lib/icons'
import { useThreadsAwaitingApproval } from '../hooks/useThreadsAwaitingApproval'

import { isThreadActivityActive, type Thread, type ThreadActivityState, type TurnPause } from '../../shared/types'
import { pausedStatusLabel } from '../lib/pausedRun'
import { isDefaultThreadName, isThreadStarted } from '../../shared/threadTitle'
import { arrangeThreadFeed, sortSidebarThreads, sortThreadFeed } from '../../shared/threadSidebarSort'
import { openSubagentParentRow, rollUpActivities, visibleThreads } from '../../shared/threadLineage'
import { needsMeLabel, threadAttention, threadStatus, worstOf, type ThreadAttention } from '../../shared/threadAttention'
import { needsMeThreads } from '../lib/needsMe'
import { setReferenceDragData } from '../../shared/chatReferences'
import { useAppStore } from '../stores/appStore'
import { confirmNavigation } from '../services/navigationGuards'
import { useChatsStore } from '../stores/chatsStore'
import { createAndSelectProjectThread, selectThread } from '../lib/threadActions'
import { runWithToast, showUndoToast } from '../lib/actionToast'
import { Modal } from './ui/Modal'
import { ChatsSidebar } from './chats/ChatsSidebar'
import { ProfileSwitcher } from './profiles/ProfileSwitcher'
import { RecentlyDeletedSection } from './sidebar/RecentlyDeletedSection'
import { Collapse } from './ui/Collapse'

import {
  ThreadsContextMenu,

  type ThreadsContextMenuTarget

} from './ThreadsContextMenu'

import { StartFromPullRequestDialog } from './StartFromPullRequestDialog'
import { ThreadHoverCard } from './ThreadHoverCard'
import { ThreadComputerBadge } from './ComputerBadge'
import { UNKNOWN_COMPUTER_NAME, useComputers } from '../lib/computers'
import { groupComputers, groupProjects } from '../lib/projectGroups'
import { projectHues } from '../lib/projectHues'
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

function ScrollingThreadTitle({ name, onDoubleClick }: { name: string; onDoubleClick?: (event: React.MouseEvent<HTMLElement>) => void }) {
  const containerRef = useRef<HTMLSpanElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)

  const measure = () => {
    const container = containerRef.current
    const text = textRef.current
    if (!container || !text) return

    const overflow = Math.max(0, text.scrollWidth - container.clientWidth)
    container.dataset.overflow = overflow > 0 ? 'true' : 'false'
    container.style.setProperty('--thread-title-overflow', `${overflow}px`)
    container.style.setProperty('--thread-title-duration', `${overflow / 50}s`)
  }

  useEffect(() => {
    const container = containerRef.current
    const text = textRef.current
    if (!container || !text) return

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    observer.observe(text)
    return () => observer.disconnect()
  }, [name])

  return (
    <span
      ref={containerRef}
      className="threads-sidebar-thread-name"
      data-overflow="false"
      onMouseEnter={measure}
      onDoubleClick={onDoubleClick}
    >
      <span ref={textRef} className="threads-sidebar-thread-name-text">{name}</span>
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
  onRename,
  onCancelRename,
  onStartRename
}: {
  thread: Pick<Thread, 'name' | 'projectId' | 'updatedAt' | 'pinnedAt' | 'worktreeEnabled' | 'node' | 'offline' | 'notShared'>
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
          <span className="threads-sidebar-card-title" onDoubleClick={onStartRename}>
            {thread.pinnedAt && <Pin size={11} strokeWidth={2} aria-label="Pinned" />}
            {thread.name}
          </span>
        )}
        {(thread.worktreeEnabled || thread.node) && (
          <span className="threads-sidebar-card-sub">
            <ThreadComputerBadge thread={thread} withName className="threads-sidebar-card-device" />
            {thread.worktreeEnabled && (
              <>
                <GitBranch size={11} strokeWidth={2} aria-hidden="true" />
                Worktree
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

  // Search threads opens the command palette, mounted once in the app shell.
  const searchOpen = useAppStore((s) => s.paletteOpen)

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  // The project the user last opened or closed. Only that group animates; one revealed for the thread
  // being opened (or a project just added) appears at once.
  const toggledProjectRef = useRef<string | null>(null)

  const [expandedProjectThreadLists, setExpandedProjectThreadLists] = useState<Set<string>>(new Set())

  const [archivedExpanded, setArchivedExpanded] = useState(false)
  const [recentExpanded, setRecentExpanded] = useState(false)
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
  const [isDragging, setIsDragging] = useState(false)
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
  const { byNode: computers } = useComputers(projects.some((project) => project.node))
  const groupIdOf = (projectId: string | undefined): string | undefined => (projectId ? groupOf.get(projectId) ?? projectId : undefined)
  // "No project": threads without one, and threads whose project was removed from the sidebar.
  const orphanThreads = availableThreads.filter((thread) => !groupById.has(groupIdOf(thread.projectId) ?? ''))

  useEffect(() => {
    if (!activeThreadId) return
    // The project to reveal is the one the highlighted row is in, which for a subagent is its parent's.
    const shownThread = threads.find((thread) => thread.id === (openSubagentParentId ?? activeThreadId))
    const projectId = shownThread?.projectId
    const groupId = projectId ? groupOf.get(projectId) ?? projectId : undefined
    if (!groupId) return
    setExpandedProjects((prev) => {
      if (prev.has(groupId)) return prev
      if (toggledProjectRef.current === groupId) toggledProjectRef.current = null
      return new Set(prev).add(groupId)
    })
  }, [activeThreadId, openSubagentParentId, threads, groupOf])

  const toggleProject = (projectId: string) => {
    toggledProjectRef.current = projectId

    setExpandedProjects((prev) => {

      const next = new Set(prev)

      if (next.has(projectId)) {

        next.delete(projectId)

      } else {

        next.add(projectId)

      }

      return next

    })

  }



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

  const startDrag = (event: React.DragEvent, item: DraggedSidebarItem) => {
    if (renaming) {
      event.preventDefault()
      return
    }
    draggedItem.current = item
    setIsDragging(true)
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
        (dragged.type === 'project' || dragged.feed || dragged.projectId === target.projectId)
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
    setIsDragging(false)
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

  // A deleted thread goes to Recently deleted, so Undo restores it where it was.
  const deleteThread = async (threadId: string) => {
    if (await runWithToast('delete', () => window.mousse.threads.delete(threadId))) {
      showUndoToast('Deleted', 'restore', () => window.mousse.threads.restore(threadId))
    }
  }

  const handlePin = () => {
    if (!contextMenu) return
    const { target } = contextMenu
    closeContextMenu()
    void setPinned(target.type, target.id, !target.pinned)
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

  const handleTrustGitSettings = () => {
    if (!contextMenu || contextMenu.target.type !== 'project') return
    const projectId = contextMenu.target.id
    closeContextMenu()
    void runWithToast('trust Git settings', () => window.mousse.projects.trustGitSettings(projectId), { retry: true })
  }

  const handleRename = () => {
    if (!contextMenu) return
    const { target, inNeedsMe, returnFocus } = contextMenu
    closeContextMenu()
    startRename({ type: target.type, id: target.id, name: target.name, inNeedsMe, returnFocus })
  }

  // A thread is deleted at once, with Undo; a project asks first.
  const handleRemove = () => {
    if (!contextMenu) return
    const { target } = contextMenu
    closeContextMenu()
    if (target.type === 'thread') void deleteThread(target.id)
    else setRemovingProject(target)
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
      if (![...rows].some((row) => row.offsetParent !== null)) return
      event.preventDefault()
      setRenaming({ type: 'thread', id: thread.id, name: thread.name })
    }
    window.addEventListener('mousse:rename-thread', onRename)
    return () => window.removeEventListener('mousse:rename-thread', onRename)
  }, [threads])

  // `inNeedsMe`: a copy of the row in the "Needs me" group, which filters rows and so does not reorder them.
  const renderThreadRow = (thread: (typeof threads)[number], root = false, view: SidebarView = 'projects', layout: 'row' | 'card' = 'row', inNeedsMe = false) => {

    const isArchived = Boolean(thread.settledAt)
    const isRenaming = renaming?.type === 'thread' && renaming.id === thread.id && Boolean(renaming.inNeedsMe) === inNeedsMe
    const isGeneratingTitle = pendingTitleIds.has(thread.id)
    const statusNode = renderThreadStatus(thread.id)
    const showTrailing = Boolean(statusNode || thread.worktreeEnabled || thread.node)
    const groupId = groupIdOf(thread.projectId)
    const group = groupId ? groupById.get(groupId) : undefined
    // Only the Threads tab's cards carry the project's tint, unless Appearance turns it off; a thread without a
    // project has none.
    const hue = layout === 'card' && threadProjectColors && group ? hueByGroup.get(group.id) : undefined
    const menuTarget: ThreadsContextMenuTarget = { type: 'thread', id: thread.id, name: thread.name, pinned: Boolean(thread.pinnedAt), settled: isArchived }
    const menuKey = `thread:${thread.id}${inNeedsMe ? ':needs-me' : ''}`
    // Double-click on the title renames; focus goes back to the row afterwards.
    const renameFromTitle = (event: React.MouseEvent<HTMLElement>) => {
      event.stopPropagation()
      startRename({ type: 'thread', id: thread.id, name: thread.name, inNeedsMe, returnFocus: event.currentTarget.closest('button') })
    }



    const hoverEnabled = !contextMenu && !isDragging && !isRenaming && !searchOpen && sidebarView === view
    const feed = view === 'threads' && !isArchived
    const dragItem: DraggedSidebarItem = { type: 'thread', id: thread.id, projectId: groupIdOf(thread.projectId), ...(feed ? { feed } : {}) }
    const dropLine = feedDrop?.id === thread.id ? (feedDrop.after ? ' drop-after' : ' drop-before') : ''
    // The lower half of a row drops after it, so a row can also go last.
    const dropsAfter = (event: React.DragEvent) => {
      const rect = event.currentTarget.getBoundingClientRect()
      return event.clientY > rect.top + rect.height / 2
    }

    return (

      <ThreadHoverCard
        key={thread.id}
        thread={thread}
        enabled={hoverEnabled}
      >
        {({ anchorRef, onMouseEnter, onMouseLeave }) => (
      <div

        ref={anchorRef}

        className={`threads-sidebar-thread-container${speakingThreadId === thread.id ? ' speaking' : ''}${dropLine}`}

        onMouseEnter={onMouseEnter}

        onMouseLeave={onMouseLeave}

      >

      <button

        type="button"

        className={`threads-sidebar-thread${layout === 'card' ? ' threads-sidebar-card' : ''}${root ? ' threads-sidebar-thread-root' : ''}${

          activeThreadId === thread.id ? ' active' : openSubagentParentId === thread.id ? ' has-open-subagent' : ''

        }${thread.pinnedAt ? ' pinned' : ''}${isArchived ? ' settled' : ''}${hue ? ' project-tinted' : ''}`}

        style={hue ? ({ '--project-tint': `var(--hue-${hue})` } as CSSProperties) : undefined}

        aria-current={activeThreadId === thread.id ? 'page' : undefined}

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
          }
        }}

        onContextMenu={(event) => openContextMenu(event, menuTarget, inNeedsMe)}

      >

        {layout === 'row' && activeThreadId === thread.id && <span className="threads-sidebar-selected-dot" aria-hidden="true" />}

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
            onRename={(name) => void submitRename(name)}
            onCancelRename={endRename}
            onStartRename={renameFromTitle}
          />
        ) : (
          <>
        {thread.pinnedAt && (

          <Pin size={12} strokeWidth={2} className="threads-sidebar-pin-icon" aria-hidden="true" />

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

          <ScrollingThreadTitle name={thread.name} onDoubleClick={renameFromTitle} />

        )}

        {showTrailing && (
          <span className="threads-sidebar-thread-trailing">
            {statusNode}
            <ThreadComputerBadge thread={thread} className="threads-sidebar-device-icon" />
            {thread.worktreeEnabled && (
              <GitBranch
                size={12}
                strokeWidth={2}
                className="threads-sidebar-worktree-icon"
                aria-label="Worktree thread"
              />
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
            onClick={(event) => {
              event.stopPropagation()
              void setArchived(thread.id, !isArchived)
            }}
          >
            <Archive size={13} strokeWidth={2} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="threads-sidebar-thread-action"
            aria-label={`More actions for ${thread.name}`}
            title="More"
            aria-haspopup="menu"
            aria-expanded={contextMenu?.anchorKey === menuKey}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => toggleMenuFrom(event, menuTarget, menuKey, inNeedsMe)}
          >
            <MoreHorizontal size={13} strokeWidth={2} aria-hidden="true" />
          </button>
        </span>
      )}

      </div>
        )}
      </ThreadHoverCard>

    )

  }



  const renderNeedsMe = (view: SidebarView) => showNeedsMe && (
    <section className="threads-sidebar-needs-me" aria-label={needsMeLabel(needsMe.length)}>
      <div className="threads-sidebar-heading">
        <span className="threads-sidebar-heading-label">Needs me · {needsMe.length}</span>
      </div>
      <div className="threads-sidebar-tree threads-sidebar-thread-feed">
        {needsMe.map((thread) => renderThreadRow(thread, true, view, 'card', true))}
      </div>
    </section>
  )

  return (

    <aside className={`threads-sidebar${className ? ` ${className}` : ''}`} style={{ width: threadsSidebarWidth }}>

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
            <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
            {sidebarView === view && <span>{label}</span>}
          </button>
        ))}
      </div>

      <div className="threads-sidebar-scroll">

      <div className="threads-sidebar-section threads-sidebar-section-projects" role="tabpanel" id={`${tabsId}-projects-panel`} aria-labelledby={`${tabsId}-projects-tab`} hidden={sidebarView !== 'projects'}>

        {sidebarView === 'projects' && renderNeedsMe('projects')}

        <div className="threads-sidebar-tree">

          {projectGroups.length === 0 ? (

            <div className="threads-sidebar-empty">No projects</div>

          ) : (

            projectGroups.map((group) => {

              // The group is named by one project: this computer's when it has one.
              const project = group.project
              const alsoOn = groupComputers(group).filter((node) => node !== project.node)

              const expanded = expandedProjects.has(project.id)

              const projectThreads = availableThreads.filter((thread) => groupIdOf(thread.projectId) === group.id)
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
                // The menu acts on the project that names the group, on the computer that holds it.
                ...(project.node ? { node: project.node, computerName: computers[project.node]?.name ?? UNKNOWN_COMPUTER_NAME } : {}),
                ...(alsoOn.length ? { alsoOn: alsoOn.map((node) => computers[node]?.name ?? UNKNOWN_COMPUTER_NAME) } : {})
              }
              const menuKey = `project:${project.id}`



              return (

                <div
                  key={project.id}
                  className="threads-sidebar-project"
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

                  >

                    <button

                      type="button"

                      className="threads-sidebar-project-toggle"

                      aria-expanded={expanded}

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
                        }
                      }}

                      onContextMenu={(event) => openContextMenu(event, menuTarget)}

                    >

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
                      className="threads-sidebar-icon-btn threads-sidebar-project-new-chat threads-sidebar-project-more"
                      title="More"
                      aria-label={`More actions for ${project.name}`}
                      aria-haspopup="menu"
                      aria-expanded={contextMenu?.anchorKey === menuKey}
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={(event) => toggleMenuFrom(event, menuTarget, menuKey)}
                    >
                      <MoreHorizontal size={14} strokeWidth={2} aria-hidden="true" />
                    </button>

                    <button

                      type="button"

                      className="threads-sidebar-icon-btn threads-sidebar-project-new-chat"

                      title="New thread from a pull request"

                      aria-label="New thread from a pull request"

                      onClick={() => {

                        setPullRequestProject({ id: project.id, name: project.name })

                      }}

                    >

                      <GitPullRequest size={14} strokeWidth={2} />

                    </button>

                    <button

                      type="button"

                      className="threads-sidebar-icon-btn threads-sidebar-project-new-chat"

                      title="New thread in project"

                      aria-label="New thread in project"

                      onClick={() => {

                        void createProjectThread(project.id)

                      }}

                    >

                      <MessageSquarePlus size={14} strokeWidth={2} />

                    </button>

                  </div>

                  <Collapse
                    open={expanded}
                    animate={toggledProjectRef.current === project.id}
                    className="threads-sidebar-children"
                    itemCount={projectThreadCount}
                  >

                      {projectThreadCount === 0 ? (

                        <div className="threads-sidebar-empty threads-sidebar-empty-nested">

                          No threads

                        </div>

                      ) : (

                        <>
                          <div
                            className={`threads-sidebar-thread-list ui-collapse-items${showAllProjectThreads ? ' expanded' : ''}`}
                            style={{ '--project-thread-count': projectThreadCount } as CSSProperties}
                          >
                            {projectThreads.map((thread) => renderThreadRow(thread))}
                          </div>
                          {projectThreadCount > PROJECT_THREAD_PREVIEW_LIMIT && (
                            <button
                              type="button"
                              className="threads-sidebar-show-more"
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

            })

          )}

        </div>

        <button type="button" className="threads-sidebar-open-project" onClick={() => void openProject()}>
          <FolderPlus size={16} strokeWidth={1.8} aria-hidden="true" />Open project
        </button>


      </div>



      <div className="threads-sidebar-section threads-sidebar-section-feed" role="tabpanel" id={`${tabsId}-threads-panel`} aria-labelledby={`${tabsId}-threads-tab`} hidden={sidebarView !== 'threads'}>
        {sidebarView === 'threads' && renderNeedsMe('threads')}
        <div
          className="threads-sidebar-tree threads-sidebar-thread-feed"
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
              {feedThreads.map((thread) => renderThreadRow(thread, true, 'threads', 'card'))}
            </>
          )}
        </div>
      </div>

      <div className="threads-sidebar-section threads-sidebar-section-chats" role="tabpanel" id={`${tabsId}-chats-panel`} aria-labelledby={`${tabsId}-chats-tab`} hidden={sidebarView !== 'chats'}>
        {sidebarView === 'chats' && <ChatsSidebar />}
      </div>

      </div>

        <section className="threads-sidebar-section threads-sidebar-bottom-recent" aria-label="No project" hidden={sidebarView !== 'projects'}>
          <div className="threads-sidebar-heading">
          <button type="button" className="threads-sidebar-heading-toggle"
            onClick={() => setRecentExpanded((expanded) => !expanded)} aria-expanded={recentExpanded}>
            <Folder size={14} strokeWidth={2} aria-hidden="true" />
            <span>No project</span>
            <span className="threads-sidebar-settled-count">{orphanThreads.length}</span>
          </button>
          </div>
          <Collapse open={recentExpanded} className="threads-sidebar-tree" itemCount={orphanThreads.length}>
            {orphanThreads.length === 0 ? <div className="threads-sidebar-empty">No threads</div> : orphanThreads.map((thread) => renderThreadRow(thread, true))}
          </Collapse>
        </section>


      <div

        className={`threads-sidebar-section threads-sidebar-section-settled${archivedExpanded ? '' : ' collapsed'}`}

        hidden={sidebarView !== 'threads'}

      >

        <div className="threads-sidebar-heading">

          <button
            type="button"
            className="threads-sidebar-heading-toggle"
            onClick={() => setArchivedExpanded((expanded) => !expanded)}
            aria-expanded={archivedExpanded}
            aria-label={archivedExpanded ? 'Collapse archived threads' : 'Expand archived threads'}
          >
            <Archive size={14} strokeWidth={2} className="threads-sidebar-settled-icon" aria-hidden="true" />
            <span>Archived</span>
            <span className="threads-sidebar-settled-count">{archivedThreads.length}</span>
          </button>

        </div>

        <Collapse open={archivedExpanded} className="threads-sidebar-tree threads-sidebar-settled-list" itemCount={archivedThreads.length}>
          {archivedThreads.length === 0 ? (
            <div className="threads-sidebar-empty">No archived threads</div>
          ) : (
            archivedThreads.map((thread) => renderThreadRow(thread, true, 'threads', 'card'))
          )}
        </Collapse>

      </div>

      <RecentlyDeletedSection hidden={sidebarView !== 'threads'} />

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
