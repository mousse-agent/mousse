import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'

import { expiresAtAfter } from '../../shared/threadExpiry'
import type { CSSProperties, KeyboardEvent } from 'react'

import { Archive, ChevronRight, Folder, FolderOpen, Layers, ListTree, Loader2, Lock, MessagesSquare, MessageSquarePlus, MoreHorizontal, Pause, Pin, Trash2 } from '../lib/icons'
import '../styles/private-threads.css'
import { useThreadsAwaitingApproval } from '../hooks/useThreadsAwaitingApproval'
import { useThreadMessageMatches } from '../hooks/useThreadMessageMatches'

import type { Project, Thread, ThreadActivitySnapshot, ThreadActivityState } from '../../shared/types'
import { isDefaultThreadName, isThreadStarted } from '../../shared/threadTitle'
import { arrangeThreadFeed, sortArchivedThreads, sortSidebarThreads, sortThreadFeed } from '../../shared/threadSidebarSort'
import { openSubagentParentRow, rollUpActivities, visibleThreads } from '../../shared/threadLineage'
import { needsMeLabel, threadAttention, threadStatus, worstOf, type ThreadAttention, type ThreadLinkStatus } from '../../shared/threadAttention'
import { needsMeThreads, useSupervisedWaits } from '../lib/needsMe'
import { hasMoreBelow, revealDelta } from '../lib/sidebarScroll'
import { SIDEBAR_REVEAL_TIMEOUT_MS, useSidebarRevealStore } from '../lib/sidebarReveal'
import { useSidebarShowMoreStore } from '../lib/sidebarShowMore'
import { setReferenceDragData } from '../../shared/chatReferences'
import { useAppStore } from '../stores/appStore'
import { workspaceModeFor, type SidebarTab } from '../stores/sidebarTabAgreement'
import { confirmNavigation } from '../services/navigationGuards'
import { useChatsStore } from '../stores/chatsStore'
import { archiveThread, setThreadArchived, createAndSelectProjectThread, createAndSelectThread, hideThreads, selectThread } from '../lib/threadActions'
import { draftedThreadIds, draftedThreadsKey, unsentChatTitle, withUnsentChats } from '../lib/sidebarDrafts'
import { dropPendingThreadRows, isPendingRowId, pruneRowKeys, servedPendingRows, usePendingThreadRows, withPendingRows } from '../lib/pendingThreadRows'
import { runWithToast } from '../lib/actionToast'
import { copyThreadReference } from '../lib/threadReference'
import { Modal } from './ui/Modal'
import { PillTabs, type PillTab } from './ui/PillTabs'
import { ChatsSidebar } from './chats/ChatsSidebar'
import { ProfileSwitcher } from './profiles/ProfileSwitcher'
import { DeleteArchivedDialog } from './sidebar/DeleteArchivedDialog'
import { ArchivedList } from './sidebar/ArchivedList'
import { ThreadFilterBar, type BotOption, type ComputerOption, type ProjectOption } from './sidebar/ThreadFilterBar'
import { useThreadFilterStore } from '../stores/threadFilterStore'
import { useBotsStore } from '../stores/botsStore'
import { filterNarrows, lastUsedBy, LOCAL_COMPUTER_ID, queryWords, threadInFilter, type ThreadFilter } from '../lib/threadFilter'
import { clearAllRequest, deleteThreads, type DeleteRequest } from '../lib/archivedThreads'
import { threadsForList, useArchiveMotionRows, usePendingArchives, withPendingArchives } from '../lib/archiveMotion'
import { Collapse, COLLAPSE_LONG_LIST, motionAllowed } from './ui/Collapse'
import { scaleMotionMs, useMotionScale, VIEW_SWAP_IN_MS } from '../lib/motion'

import {
  ThreadsContextMenu,

  type ProjectOpener,

  type ThreadsContextMenuTarget,
  ThreadsTabMenu
} from './ThreadsContextMenu'
import { defaultEditor, loadLastEditorId, openLabel, splitEditors } from './sideCard/openInEditor'
import { loadEditors, useEditorsStore } from '../stores/editorsStore'

import { StartFromPullRequestDialog } from './StartFromPullRequestDialog'
import { ThreadComputerBadge } from './ComputerBadge'
import { ThreadBranchLine, ThreadHoverCard, ThreadModelIcon } from './ThreadRowDetails'
import { UNKNOWN_COMPUTER_NAME, useComputers } from '../lib/computers'
import { groupComputers, groupProjects } from '../lib/projectGroups'
import { projectHueColor, projectHues } from '../lib/projectHues'
import { ProjectIcon } from './ProjectIcon'
import { projectIconMenuActions } from '../lib/projectIconActions'
import { projectTooltip, thisHomeFolder } from '../lib/projectTooltip'
import { useThreadProjectColors } from '../lib/threadProjectColorsSetting'
import { threadPullRequestsOf, type ThreadPullRequestSummary } from '../../shared/pullRequests'
import { ThreadReplyPreview } from './ThreadRowExtras'
import { ThreadSpeechIndicator, ThreadSpeechMark, useSpeakingThreadId } from '../readAloud/ThreadSpeechIndicator'

import { ProjectRunsDot } from './automations/inbox/ProjectRunsDot'
import { countRender } from '../chat/components/agent-elements/render-counts'
import { plainThreads, sameListedActivity, ThreadCardStatus, ThreadExpiryIcon, ThreadRowStatusIcon } from './ThreadRowStatus'
import { ThreadOpeningMark } from './ThreadOpening'
import '../styles/threads-sidebar.css'
import '../styles/sidebar-view-motion.css'



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
/** How long the pointer rests on a thread before its card opens. */
const HOVER_CARD_DELAY_MS = 500
// "No project", the last group of the Projects tree, opens, closes and clips like a project under this id,
// which is no project's.
const OTHER_THREADS_ID = ':other'
const PROJECT_ATTENTION_TITLE: Record<Exclude<ThreadAttention, 'quiet' | 'needs-me'>, string> = {
  working: 'Working',
  paused: 'Paused',
  done: 'Done'
}
// One Threads tab shows the thread list by project (the Projects tree) or as one list of cards; the swap button beside
// the filter switches between the two (`threadsSidebarView` keeps which).
const SIDEBAR_TABS = [
  { id: 'threads', label: 'Threads', icon: ListTree },
  { id: 'chats', label: 'Chats', icon: MessagesSquare }
] as const satisfies readonly PillTab<string>[]
type SidebarView = SidebarTab
type SidebarTabId = (typeof SIDEBAR_TABS)[number]['id']

/** Shift+F10 or the context-menu key: open a row's menu from the keyboard. */
const isMenuKey = (event: KeyboardEvent) => event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)

/** On hover, a title cut off by an ellipsis gets the full text as its native tooltip; one that fits gets none. */
const tooltipIfTruncated = (fullTitle: string) => (event: React.MouseEvent<HTMLElement>) => {
  const element = event.currentTarget
  if (element.scrollWidth > element.clientWidth) element.title = fullTitle
  else element.removeAttribute('title')
}

/**
 * A row's title: it ends in an ellipsis where it does not fit and stays still on hover, the full text in its tooltip.
 * `provisional`: taken from the first message while the title model works; dimmed until the model's title replaces it.
 */
function ThreadTitle({ name, fullTitle, provisional, onDoubleClick }: { name: string; fullTitle?: string; provisional?: boolean; onDoubleClick?: (event: React.MouseEvent<HTMLElement>) => void }) {
  return (
    <span className={provisional ? 'threads-sidebar-thread-name provisional' : 'threads-sidebar-thread-name'} onMouseEnter={tooltipIfTruncated(fullTitle ?? name)} onDoubleClick={onDoubleClick}>
      {name}
    </span>
  )
}



/** An unsent new chat's title, its draft as typed. It reads the draft itself, so typing redraws only the title. */
function UnsentChatTitle({ threadId }: { threadId: string }) {
  const title = useAppStore((s) => unsentChatTitle(s.composerDrafts[threadId]))
  return <ThreadTitle name={title} />
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



/** A thread's card: its project mark, project and status, title, latest reply and computer. Also a thread link's hover card. */
export function ThreadCardBody({
  thread,
  projectName,
  project,
  hue,
  threadId,
  activity,
  liveActivity,
  awaitsApproval,
  isRenaming,
  renamingName,
  isGeneratingTitle,
  fullTitle,
  onRename,
  onCancelRename,
  onStartRename,
  preview,
  pullRequests,
  statusWithAge = false,
  linkStatus,
  terseStatus = false
}: {
  thread: Pick<Thread, 'name' | 'projectId' | 'updatedAt' | 'pinnedAt' | 'node' | 'offline' | 'notShared' | 'localOnly' | 'expiresAt' | 'expiryStopsRun' | 'setupFailure' | 'worktreeEnabled' | 'modelOverride'>
  projectName?: string
  /** The thread's project, for its own icon in the mark. */
  project?: Project
  /** The project's hue (`--hue-N`), shared with the row's tint. */
  hue?: number
  threadId: string
  /** The activity the list shows for the thread; with `liveActivity`, its status reads the thread's own (`ThreadCardStatus`). */
  activity?: ThreadActivityState
  liveActivity: boolean
  /** The input it waits for is a permission request. */
  awaitsApproval: boolean

  isRenaming: boolean
  renamingName: string
  isGeneratingTitle: boolean
  /** The tooltip of a title that does not fit. */
  fullTitle: string
  onRename: (name: string) => void
  onCancelRename: () => void
  /** Double-click on the title starts a rename. */
  onStartRename?: (event: React.MouseEvent<HTMLElement>) => void
  /** The latest reply, shown under the title (a thread link's card); absent when it has none or previews are off. */
  preview?: string
  pullRequests: readonly ThreadPullRequestSummary[]
  /** The status says how long ago too when it is Done or waits for the person (`ThreadCardStatus`'s `withAge`). */
  statusWithAge?: boolean
  /** A thread link's card: the status its link shows (`threadLinkStatus`), so the two never differ. */
  linkStatus?: ThreadLinkStatus
  /**
   * The Threads list's card: Working, Waiting, Paused and Done are the icon alone, named in its title. A thread link's
   * card keeps the words, since the pointer passes through it and could never show the title.
   */
  terseStatus?: boolean
}) {
  return (
    <>
      <span className="threads-sidebar-card-body">
        <span className="threads-sidebar-card-meta">
          {projectName ? (
            <span className="threads-sidebar-card-mark" style={hue ? { color: projectHueColor(hue) } : undefined} aria-hidden="true"><ProjectIcon project={project} size={14} fallback={<Folder size={14} strokeWidth={1.8} />} /></span>
          ) : (
            <span className="threads-sidebar-card-mark threads-sidebar-card-mark-empty" aria-hidden="true">
              <Folder size={14} strokeWidth={1.8} />
            </span>
          )}
          <span className="threads-sidebar-card-project">{projectName ?? 'No project'}</span>
          {thread.pinnedAt && <Pin size={11} strokeWidth={2} className="threads-sidebar-card-pin" aria-label="Pinned" />}
          {/* A thread slow to open shows its ring where the status sits, as a row does in its gutter. */}
          <ThreadOpeningMark threadId={threadId}>
            <ThreadCardStatus threadId={threadId} activity={activity} live={liveActivity} awaitsApproval={awaitsApproval} updatedAt={thread.updatedAt} withAge={statusWithAge} setupFailed={thread.setupFailure?.reason} linkStatus={linkStatus} terse={terseStatus} />
          </ThreadOpeningMark>
          <ThreadModelIcon thread={thread} />
        </span>
        {isRenaming ? (
          <SidebarRenameInput initialName={renamingName} onSubmit={onRename} onCancel={onCancelRename} />
        ) : isGeneratingTitle ? (
          <span className="threads-sidebar-skeleton" aria-label="Generating title" />
        ) : (
          <span className="threads-sidebar-card-title" onDoubleClick={onStartRename} onMouseEnter={tooltipIfTruncated(fullTitle)}>
            {thread.localOnly && <Lock size={11} strokeWidth={2} className="thread-private-icon" aria-label="Private" />}
            {thread.expiresAt && <ThreadExpiryIcon expiresAt={thread.expiresAt} size={11} />}
            {thread.name}
          </span>
        )}
        {preview && !isRenaming && !isGeneratingTitle && <ThreadReplyPreview text={preview} className="threads-sidebar-card-preview" />}
        <ThreadBranchLine thread={thread} threadId={threadId} pullRequests={pullRequests} model={false} hideEmpty className="threads-sidebar-card-sub" />
      </span>
    </>
  )
}

export function ThreadsSidebar({ className = '' }: { className?: string }) {
  countRender('ThreadsSidebar')

  const tabsId = useId()
  const projects = useAppStore((s) => s.projects)

  // An archive asked for here shows from the click on, before the service's update arrives (archiveMotion.ts).
  const storeThreads = useAppStore((s) => s.threads)
  const pendingArchives = usePendingArchives((s) => s.pending)
  const listedInStore = useMemo(() => withPendingArchives(storeThreads, pendingArchives), [storeThreads, pendingArchives])
  const agentChats = useChatsStore((s) => s.snapshot.chats)
  const agentThreadIds = useMemo(() => new Set(agentChats.map((chat) => chat.threadId)), [agentChats])

  // A thread being opened is highlighted from the click on, while the chat still shows the one before (`openingThreadId`).
  const storeActiveThreadId = useAppStore((s) => s.openingThreadId ?? s.activeThreadId)
  const speakingThreadId = useSpeakingThreadId()

  // The activity the list is drawn from. A push that only swaps Working and Waiting on a plain thread keeps the one
  // held, so the list and its other rows stay as they are; that thread's status reads its own (`ThreadRowStatus`).
  const plainThreadIds = useMemo(() => plainThreads(listedInStore), [listedInStore])
  const plainRef = useRef(plainThreadIds)
  plainRef.current = plainThreadIds
  const listedRef = useRef(listedInStore)
  listedRef.current = listedInStore
  const heldActivity = useRef<ThreadActivitySnapshot | null>(null)
  const storeActivity = useAppStore((s) => {
    const held = heldActivity.current
    if (held && sameListedActivity(held, s.threadActivity, plainRef.current, listedRef.current)) return held
    heldActivity.current = s.threadActivity
    return s.threadActivity
  })
  // A thread a send is starting is listed from the click on, before the service has made it (`pendingThreadRows`).
  const shownProfileId = useAppStore((s) => s.profileId)
  const pendingRows = usePendingThreadRows((s) => s.rows)
  const pendingRowKeys = usePendingThreadRows((s) => s.rowKeys)
  const { threads, activity: threadActivity, openRowId: activeThreadId, rowKeys, unmade: unmadeRows } = useMemo(
    // A bot's chat thread is never taken for a pending send's thread.
    () => withPendingRows(listedInStore, pendingRows.filter((row) => row.profileId === shownProfileId), storeActivity, storeActiveThreadId, pendingRowKeys, agentThreadIds),
    [listedInStore, pendingRows, shownProfileId, storeActivity, storeActiveThreadId, pendingRowKeys, agentThreadIds]
  )
  // A pending row goes once the service shows the same (its thread listed, named and with a state); its key a minute on.
  useEffect(() => {
    dropPendingThreadRows(servedPendingRows(pendingRows, listedInStore, storeActivity))
    pruneRowKeys(new Set(listedInStore.map((thread) => thread.id)))
  }, [pendingRows, listedInStore, storeActivity])
  const approvalThreads = useThreadsAwaitingApproval()

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  // The project the user last opened or closed. Only that group animates; one revealed for the thread
  // being opened (or a project just added) appears at once.
  const toggledProjectRef = useRef<string | null>(null)

  // Show more survives the sidebar closing and the hover peek (a separate mount).
  const expandedProjectThreadLists = useSidebarShowMoreStore((s) => s.groups)
  const setExpandedProjectThreadLists = useSidebarShowMoreStore((s) => s.setGroups)

  const [archivedExpanded, setArchivedExpanded] = useState(false)
  // The archived threads waiting on a delete confirmation, and how that delete is going.
  const [deleteRequest, setDeleteRequest] = useState<DeleteRequest | null>(null)
  const [deleteState, setDeleteState] = useState<{ busy: boolean; error?: string }>({ busy: false })
  const archivedHeadingRef = useRef<HTMLButtonElement>(null)
  // The row of the Projects tree that last had focus (`project:<id>` or `thread:<id>`): its Tab stop.
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
    if (state.sidebarMode !== workspaceModeFor(view) && !await confirmNavigation()) return
    // The workspace follows the tab (`agreeWithTab`).
    useAppStore.getState().setThreadsSidebarView(view)
  }

  // Tab switch motion (sidebar-view-motion.css). The content follows the tabs at once: the new view shows in
  // the click's own update and settles in with a short lift as its panel unhides. With motion off (the setting,
  // the OS, or no renderer) it does not move.
  const sidebarAnimations = useAppStore((s) => s.sidebarAnimations)
  const instantViews = useMotionScale() === 0 || !sidebarAnimations || !motionAllowed()
  const contentView = sidebarView

  // The Archived footer is not under Chats: it is hidden as Chats shows and unfolds as another view comes in,
  // so the list above it gives the room smoothly.
  const footerRef = useRef<HTMLDivElement>(null)
  // Archived's list scrolls under its heading, so the heading stays in view however far the list is scrolled.
  const archivedScrollRef = useRef<HTMLDivElement>(null)
  // The filter's Archived lists archived threads in place of the others, so the footer has nothing to add.
  const filterArchived = useThreadFilterStore((s) => s.archived)
  const footerHidden = contentView === 'chats' || filterArchived
  const footerWasHidden = useRef(footerHidden)
  useLayoutEffect(() => {
    const footer = footerRef.current
    const wasHidden = footerWasHidden.current
    footerWasHidden.current = footerHidden
    if (!footer || typeof footer.animate !== 'function') return
    for (const animation of footer.getAnimations()) if (animation.id === 'footer-swap') animation.cancel()
    if (footerHidden || instantViews || !wasHidden) return
    const height = footer.getBoundingClientRect().height
    if (height < 0.5) return
    const frame = (at: { height: number; opacity: number }) => ({ blockSize: `${at.height}px`, opacity: at.opacity, overflow: 'hidden' })
    const animation = footer.animate([frame({ height: 0, opacity: 0 }), frame({ height, opacity: 1 })], {
      duration: scaleMotionMs(VIEW_SWAP_IN_MS),
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    })
    animation.id = 'footer-swap'
  }, [footerHidden, instantViews])

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
  // The thread whose card shows beside the row the pointer rests on (`ThreadHoverCard`), and that row.
  const [hoverCardId, setHoverCardId] = useState<string | null>(null)
  const hoverCardAnchor = useRef<HTMLElement | null>(null)
  const hoverCardTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const openHoverCardSoon = (threadId: string, anchor: HTMLElement) => {
    clearTimeout(hoverCardTimer.current)
    hoverCardTimer.current = setTimeout(() => {
      hoverCardAnchor.current = anchor
      setHoverCardId(threadId)
    }, HOVER_CARD_DELAY_MS)
  }
  const closeHoverCard = () => {
    clearTimeout(hoverCardTimer.current)
    setHoverCardId(null)
  }
  useEffect(() => () => clearTimeout(hoverCardTimer.current), [])
  const [pendingTitleIds, setPendingTitleIds] = useState<Set<string>>(new Set())
  const pendingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const draggedItem = useRef<DraggedSidebarItem | null>(null)
  const suppressClick = useRef(false)
  // Where a dragged project or thread would land: before or after this row, shown as a line.
  const [rowDrop, setRowDrop] = useState<{ type: DraggedSidebarItem['type']; id: string; after: boolean } | null>(null)
  const threadFeedOrder = useAppStore((s) => s.threadFeedOrder)
  const setThreadFeedOrder = useAppStore((s) => s.setThreadFeedOrder)

  const threadsSidebarWidth = useAppStore((s) => s.threadsSidebarWidth)



  // A project that several computers hold for the same repository is one group; the others' projects that
  // match none of this computer's stay groups of their own, named with their computer.
  const { groups: projectGroups, groupOf } = useMemo(() => groupProjects(projects), [projects])
  const groupById = useMemo(() => new Map(projectGroups.map((group) => [group.id, group])), [projectGroups])

  // The filter row's (ThreadFilterBar): Show, a bot, a project, a computer, Archived and what is typed; the Projects
  // tab's unticked projects. Show and the unticked projects are this profile's.
  const profileId = useAppStore((s) => s.profileId)
  // Before the window's profile is known the list is the warm start's (showWarmView): shown as it was, not acted on.
  const warmOnly = useAppStore((s) => !s.profileReady && s.warmView !== null)
  // The filter saved on this computer for the profile shown, the warm start's one included.
  const filterProfileId = useAppStore((s) => (s.profileReady ? s.profileId : s.warmView?.profileId ?? s.profileId))
  useEffect(() => { useThreadFilterStore.getState().load(filterProfileId) }, [filterProfileId])
  const filterQuery = useThreadFilterStore((s) => s.query)
  const filterShow = useThreadFilterStore((s) => s.show)
  const filterProjectId = useThreadFilterStore((s) => s.projectId)
  const filterBotId = useThreadFilterStore((s) => s.botId)
  const filterComputerIds = useThreadFilterStore((s) => s.computerIds)
  const hiddenProjectIds = useThreadFilterStore((s) => s.hiddenProjects)
  const filter = useMemo<ThreadFilter>(
    () => ({ query: filterQuery, show: filterShow, projectId: filterProjectId, botId: filterBotId, computerIds: filterComputerIds, archived: filterArchived }),
    [filterQuery, filterShow, filterProjectId, filterBotId, filterComputerIds, filterArchived]
  )
  const filtering = filterNarrows(filter)
  const bots = useBotsStore((s) => s.bots)
  const hasRemoteProjects = projects.some((project) => project.node)
  const hasRemoteThreads = threads.some((thread) => thread.node)
  const { byNode: computers, devices } = useComputers(
    hasRemoteProjects || hasRemoteThreads || filterComputerIds.some((id) => id !== LOCAL_COMPUTER_ID)
  )
  const hasOtherComputers = hasRemoteProjects || hasRemoteThreads || Object.keys(computers).length > 0
  // What is typed also finds the threads whose messages hold it.
  const messageMatches = useThreadMessageMatches(filterQuery)
  const inFilter = useMemo(() => {
    const projectById = new Map(projects.map((project) => [project.id, project]))
    const botById = new Map(bots.map((bot) => [bot.id, bot]))
    const context = {
      groupOf: (projectId: string) => groupOf.get(projectId) ?? projectId,
      projectName: (projectId: string) => projectById.get(projectId)?.name,
      botName: (botId: string) => botById.get(botId)?.name,
      computerName: hasOtherComputers
        ? (node: string | undefined) => (node ? (computers[node]?.name ?? UNKNOWN_COMPUTER_NAME) : 'This computer')
        : undefined,
      messageMatches
    }
    return (thread: Thread) => threadInFilter(thread, filter, context)
  }, [filter, projects, bots, groupOf, computers, hasOtherComputers, messageMatches])

  // Subagent threads sit under their parent, not beside it: the list holds the threads people started. A thread one of
  // the owner's bots keeps out of the sidebar (`Thread.hidden`, how a bot's threads start) is listed in its chat instead,
  // and under Archived once it is archived; the filter's Bot threads, All or a bot lists it here too.
  const listedThreads = useMemo(() => visibleThreads(threads), [threads])
  // A thread archived or unarchived, by any means, leaves its list and arrives in its new place with motion: for a
  // moment its old row stays in the old list (`threadsForList`) while it fades and closes (archiveMotion.ts).
  const asideRef = useRef<HTMLElement>(null)
  const { moves: archiveMoves, motionOf: archiveMotionOfRow } = useArchiveMotionRows(asideRef, listedThreads, sidebarAnimations)
  const unarchivedListThreads = useMemo(() => threadsForList(listedThreads, archiveMoves, false).filter(inFilter), [listedThreads, archiveMoves, inFilter])
  const archivedListThreads = useMemo(() => threadsForList(listedThreads, archiveMoves, true).filter(inFilter), [listedThreads, archiveMoves, inFilter])
  // A parent row shows what its subagents are doing, however deep they are nested.
  const rolledUpActivity = useMemo(() => rollUpActivities(threads, threadActivity), [threads, threadActivity])
  // While a subagent's thread is open, the row it sits under is highlighted instead.
  const openSubagentParentId = useMemo(
    () => (activeThreadId ? openSubagentParentRow(activeThreadId, threads) : null),
    [activeThreadId, threads]
  )

  // A new chat is composer state, not a conversation, until its first message is sent: before that it is listed
  // only by its draft (`unsentChats`).
  const availableThreads = useMemo(
    () => sortSidebarThreads(unarchivedListThreads.filter((thread) => !thread.archivedAt && isThreadStarted(thread) && !agentThreadIds.has(thread.id))),
    [unarchivedListThreads, agentThreadIds]
  )
  // Threads whose composer holds unsent text. A new chat not sent yet is listed in its project once it has some
  // (Projects tab only; the Threads tab lists conversations).
  const draftedKey = useAppStore((s) => draftedThreadsKey(s.composerDrafts))
  const draftedIds = useMemo(() => draftedThreadIds(draftedKey), [draftedKey])
  const unsentChats = useMemo(
    () => sortSidebarThreads(unarchivedListThreads.filter((thread) => !thread.archivedAt && !isThreadStarted(thread) && !agentThreadIds.has(thread.id) && draftedIds.has(thread.id))),
    [unarchivedListThreads, agentThreadIds, draftedIds]
  )
  const projectListThreads = useMemo(() => withUnsentChats(availableThreads, unsentChats), [availableThreads, unsentChats])
  // The listed threads the owner's bots started, which the Threads tab's menu and a project's menu hide. Only this
  // computer's: a thread is hidden by the computer that runs it.
  const shownBotThreads = useMemo(() => availableThreads.filter((thread) => thread.startedByBot && !thread.node && !thread.hidden), [availableThreads])
  const archivedThreads = useMemo(
    () => sortArchivedThreads(archivedListThreads.filter((thread) => Boolean(thread.archivedAt) && isThreadStarted(thread) && !agentThreadIds.has(thread.id))),
    [archivedListThreads, agentThreadIds]
  )
  // The Threads tab: in the order its rows were dragged into, with threads started since on top, newest
  // first. Later messages do not move a row. With the filter's Archived on, both tabs list the archived threads instead.
  const feedThreads = useMemo(
    () => (filterArchived ? archivedThreads : sortThreadFeed(availableThreads, threadFeedOrder)),
    [filterArchived, archivedThreads, availableThreads, threadFeedOrder]
  )
  const treeThreads = filterArchived ? archivedThreads : projectListThreads
  const attentionOf = (threadId: string) => threadAttention(rolledUpActivity[threadId] ?? threadActivity[threadId])
  // Threads that wait for an answer or an approval, from every project and computer, at the top of the list.
  const notifyBotThreads = useAppStore((s) => s.notifyBotThreads)
  const supervisedWaits = useSupervisedWaits()
  const needsMe = useMemo(() => needsMeThreads(threads, threadActivity, agentThreadIds, notifyBotThreads, supervisedWaits), [threads, threadActivity, agentThreadIds, notifyBotThreads, supervisedWaits])
  // With one thread in all, its own row already says it: a group of it would only repeat it.
  // While the filter narrows the list, the threads it keeps list in it, Needs me or not.
  const showNeedsMe = needsMe.length > 0 && availableThreads.length > 1 && !filtering
  // The Threads tab lists a thread in one place: while "Needs me" shows it, the list below leaves it out.
  // Dragging still arranges `feedThreads`, so the thread comes back where it was.
  const feedRows = useMemo(() => {
    if (!showNeedsMe) return feedThreads
    const waiting = new Set(needsMe.map((thread) => thread.id))
    return feedThreads.filter((thread) => !waiting.has(thread.id))
  }, [feedThreads, needsMe, showNeedsMe])

  const threadProjectColors = useThreadProjectColors()
  const hueByGroup = useMemo(
    () => projectHues(projectGroups.map((group) => ({ id: group.id, createdAt: group.project.createdAt }))),
    [projectGroups]
  )
  // What the filter row offers: each project group with its icon or coloured folder, each bot with its face; "Recent"
  // in their lists is by their newest thread.
  const projectOptions = useMemo((): ProjectOption[] => {
    const lastUsed = lastUsedBy(threads, (thread) => (thread.projectId ? groupOf.get(thread.projectId) ?? thread.projectId : undefined))
    return projectGroups.map((group) => ({
      id: group.id,
      name: group.project.name,
      project: group.project,
      color: projectHueColor(hueByGroup.get(group.id)),
      lastUsed: lastUsed.get(group.id)
    }))
  }, [threads, projectGroups, groupOf, hueByGroup])
  const botOptions = useMemo((): BotOption[] => {
    const lastUsed = lastUsedBy(threads, (thread) => thread.startedByBot?.botId)
    return bots.map((bot) => ({ id: bot.id, name: bot.name, look: bot.look, lastUsed: lastUsed.get(bot.id) }))
  }, [threads, bots])
  const computerOptions = useMemo((): ComputerOption[] => {
    const nodes = new Set<string>()
    for (const thread of listedThreads) if (thread.node && !agentThreadIds.has(thread.id)) nodes.add(thread.node)
    for (const project of projects) if (project.node) nodes.add(project.node)
    for (const node of Object.keys(computers)) nodes.add(node)
    for (const id of filterComputerIds) if (id !== LOCAL_COMPUTER_ID) nodes.add(id)
    if (nodes.size === 0 && filterComputerIds.length === 0) return []
    const lastUsed = lastUsedBy(threads, (thread) => thread.node ?? LOCAL_COMPUTER_ID)
    return [
      { id: LOCAL_COMPUTER_ID, name: 'This computer', local: true, lastUsed: lastUsed.get(LOCAL_COMPUTER_ID) },
      ...[...nodes].map((node): ComputerOption => ({
        id: node,
        name: computers[node]?.name ?? UNKNOWN_COMPUTER_NAME,
        lastUsed: lastUsed.get(node)
      }))
    ]
  }, [listedThreads, agentThreadIds, projects, computers, filterComputerIds, threads])
  const nameOfComputer = (node: string): string => computers[node]?.name ?? UNKNOWN_COMPUTER_NAME
  const localArchivedCount = archivedThreads.filter((thread) => !thread.node).length
  // With projects of several computers, a project's tooltip names this one too.
  const selfName = hasRemoteProjects ? devices.find((device) => device.self)?.name : undefined
  // This computer's home folder: its projects' paths read `~/…` in their tooltip.
  const homeFolder = thisHomeFolder()
  // The editors and file manager this computer has, for the project menu's "Open in" and "Show in" items.
  const editors = useEditorsStore((s) => s.editors)
  const hasLocalProjects = projects.some((project) => !project.node)
  useEffect(() => {
    if (hasLocalProjects) void loadEditors()
  }, [hasLocalProjects])
  const groupIdOf = (projectId: string | undefined): string | undefined => (projectId ? groupOf.get(projectId) ?? projectId : undefined)
  // The Projects tree group a thread lists under: its project's, else "No project" (threads without a project,
  // and threads whose project was removed from the sidebar).
  const listGroupOf = (projectId: string | undefined): string => {
    const groupId = groupIdOf(projectId)
    return groupId && groupById.has(groupId) ? groupId : OTHER_THREADS_ID
  }
  const otherThreads = treeThreads.filter((thread) => listGroupOf(thread.projectId) === OTHER_THREADS_ID)
  // The group in focus: the open thread's (a draft's project too), whose header stays bright while the other
  // groups dim (threads-sidebar.css). None for a Chats thread or with nothing open, and then nothing dims.
  const focusedThread = threads.find((thread) => thread.id === (openSubagentParentId ?? activeThreadId))
  const activeGroupId = focusedThread && !agentThreadIds.has(focusedThread.id) && inFilter(focusedThread) ? listGroupOf(focusedThread.projectId) : undefined
  // The Threads tab dims its other cards only while the open thread has a card there.
  const feedHasActive = Boolean(focusedThread && feedRows.some((thread) => thread.id === focusedThread.id))

  // Reveal the highlighted row once per thread: open its group, show the group's whole list when it is past
  // the first 5, or open "Archived". A draft is revealed when it is started and gets its row. Before the frame is
  // drawn, so a row a send just listed shows in the frame that lists it.
  const revealedRow = useRef<string | null>(null)
  useLayoutEffect(() => {
    // The row to reveal is the highlighted one, which for a subagent is its parent's.
    const shownId = openSubagentParentId ?? activeThreadId
    if (!shownId || revealedRow.current === shownId) return
    const shown = threads.find((thread) => thread.id === shownId)
    // A hidden bot thread has no row to reveal.
    if (!shown || !isThreadStarted(shown) || agentThreadIds.has(shown.id) || !inFilter(shown)) return
    revealedRow.current = shownId
    if (shown.archivedAt) {
      setArchivedExpanded(true)
      return
    }
    const groupId = listGroupOf(shown.projectId)
    setExpandedProjects((prev) => {
      if (prev.has(groupId)) return prev
      // A group opened for the thread being shown appears at once; only a group the user toggles animates.
      if (toggledProjectRef.current === groupId) toggledProjectRef.current = null
      return new Set(prev).add(groupId)
    })
    const position = availableThreads.filter((thread) => listGroupOf(thread.projectId) === groupId).findIndex((thread) => thread.id === shownId)
    if (position >= PROJECT_THREAD_PREVIEW_LIMIT) {
      setExpandedProjectThreadLists((prev) => (prev.has(groupId) ? prev : new Set(prev).add(groupId)))
    }
    // listGroupOf reads groupOf and groupById, which are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId, openSubagentParentId, threads, availableThreads, agentThreadIds, groupOf, groupById, inFilter])

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

  // The row of a thread a send is starting is scrolled into view in the frame that lists it.
  const scrolledPendingRow = useRef<string | null>(null)
  useLayoutEffect(() => {
    const id = activeThreadId
    if (!id || scrolledPendingRow.current === id || !pendingRows.some((row) => row.key === id)) return
    const scroller = scrollRef.current
    const row = scroller ? [...scroller.querySelectorAll<HTMLElement>('.threads-sidebar-thread[data-thread-id]')].find((item) => item.dataset.threadId === id && item.offsetParent !== null) : undefined
    if (!scroller || !row) return
    scrolledPendingRow.current = id
    const delta = revealDelta(scroller.getBoundingClientRect(), row.getBoundingClientRect())
    if (delta) scroller.scrollTop += delta
  }, [activeThreadId, pendingRows, expandedProjects, expandedProjectThreadLists])

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

  // A project the title bar's path asked to show (`showProjectInSidebar`): its group opens and scrolls into view.
  const revealRequest = useSidebarRevealStore((s) => s.project)
  const handledReveal = useRef(0)
  useEffect(() => {
    if (!revealRequest || revealRequest.seq === handledReveal.current) return
    handledReveal.current = revealRequest.seq
    if (Date.now() - revealRequest.at > SIDEBAR_REVEAL_TIMEOUT_MS) return
    const groupId = listGroupOf(revealRequest.projectId)
    toggledProjectRef.current = groupId
    revealProject.current = groupId
    // A new set even when the group is open already, so the scroll above runs.
    setExpandedProjects((prev) => new Set(prev).add(groupId))
    // listGroupOf reads groupOf and groupById, which are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealRequest, groupOf, groupById])

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



  const openProject = () => useAppStore.getState().setNewProjectOpen(true)

  // `projectId` is the project that names its group, so it is also the group's id. A retry reuses the draft a
  // failed attempt may have made.
  const createProjectThread = (projectId: string) => runWithToast('start a thread', async () => {
    setExpandedProjects((prev) => new Set(prev).add(projectId))
    await createAndSelectProjectThread(projectId)
  }, { retry: true })

  // The Projects tree's rows in order, as the keyboard walks them: each group (the projects, then "No project"
  // when it has threads), and the shown threads of an open one.
  const projectThreadsOf = (groupId: string) => treeThreads.filter((thread) => listGroupOf(thread.projectId) === groupId)
  // The filter leaves out the projects unticked in its menu and, while it narrows to some threads, the projects with none
  // of them; those it keeps show open.
  const treeNarrowed = filter.show === 'bots' || filter.botId !== null || filter.projectId !== null || filter.computerIds.length > 0 || filter.archived || queryWords(filter.query).length > 0
  const hiddenProjectSet = new Set(hiddenProjectIds)
  const shownGroups = projectGroups.filter((group) => !hiddenProjectSet.has(group.id) &&
    (filter.projectId === null || group.id === filter.projectId) &&
    (!treeNarrowed || projectThreadsOf(group.id).length > 0))
  const groupOpen = (groupId: string) => treeNarrowed || expandedProjects.has(groupId)
  // "No project" is always listed once there is a project, like a project with no threads, unless the filter narrows
  // to one project or to threads it has none of. With no project at all it waits for a thread (the empty state says
  // "No projects").
  const showOtherThreads = filter.projectId === null && (otherThreads.length > 0 || (!treeNarrowed && projectGroups.length > 0))
  const treeGroupIds = [...shownGroups.map((group) => group.id), ...(showOtherThreads ? [OTHER_THREADS_ID] : [])]
  const treeKeys = treeGroupIds.flatMap((groupId) => {
    const key = `project:${groupId}`
    if (!groupOpen(groupId)) return [key]
    const shown = projectThreadsOf(groupId)
    const visible = expandedProjectThreadLists.has(groupId) ? shown : shown.slice(0, PROJECT_THREAD_PREVIEW_LIMIT)
    return [key, ...visible.map((thread) => `thread:${thread.id}`)]
  })
  const highlightedKey = `thread:${openSubagentParentId ?? activeThreadId}`
  // The tree is one Tab stop: the row last focused in it, else the open thread's row, else its first row.
  const treeTabStop = treeFocus && treeKeys.includes(treeFocus)
    ? treeFocus
    : treeKeys.includes(highlightedKey) ? highlightedKey : treeKeys[0]

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
          const groupId = listGroupOf(threads.find((thread) => thread.id === id)?.projectId)
          flushSync(() => setExpandedProjectThreadLists((prev) => new Set(prev).add(groupId)))
          focusRow(next.querySelector<HTMLElement>('[role="treeitem"]') ?? undefined)
          break
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
        if (!groupOpen(id)) toggleProject(id)
        else if (rows[index + 1]?.getAttribute('aria-level') === '2') focusRow(rows[index + 1])
        break
      case 'ArrowLeft':
        if (isProject) {
          if (groupOpen(id)) toggleProject(id)
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
        !(dragged.feed && filtering) &&
        // Threads drop only among threads of the same kind (pinned ones list first); a Threads tab row may cross projects.
        (dragged.type === 'project' || (Boolean(dragged.pinned) === Boolean(target.pinned) && (dragged.feed || dragged.projectId === target.projectId)))
    )
  }

  /** Moves the row dragged in the Threads tab before or after `target`, or to the end without one. */
  const dropFeedThread = (target?: string, after = false) => {
    const dragged = draggedItem.current
    setRowDrop(null)
    // A filtered list holds only some threads: its order is not the tab's.
    if (!dragged?.feed || dragged.id === target || filtering) return
    suppressClick.current = true
    window.setTimeout(() => { suppressClick.current = false }, 0)
    setThreadFeedOrder(arrangeThreadFeed(feedThreads.flatMap((thread) => (unmadeRows.has(thread.id) ? [] : [thread.id])), dragged.id, target, after))
  }

  /** Moves the dragged project, or thread within its project, before or after `target`. */
  const reorderAt = async (target: DraggedSidebarItem, after: boolean) => {
    const dragged = draggedItem.current
    setRowDrop(null)
    if (!dragged || !canDropOn(target)) return
    suppressClick.current = true
    window.setTimeout(() => { suppressClick.current = false }, 0)
    if (dragged.type === 'project') {
      // One entry per group: a project on several computers is dragged as one.
      const ids = projectGroups.map((group) => group.id)
      ids.splice(ids.indexOf(dragged.id), 1)
      ids.splice(ids.indexOf(target.id) + (after ? 1 : 0), 0, dragged.id)
      await window.mousse.projects.reorder(ids)
      return
    }
    // Reorder must include every thread in the group (including hidden drafts), the other computers' threads
    // of the same repository among them; the project is the one that names the group.
    const group = threads.filter((thread) => groupIdOf(thread.projectId) === dragged.projectId && !isPendingRowId(thread.id))
    const ids = group.map((thread) => thread.id)
    ids.splice(ids.indexOf(dragged.id), 1)
    ids.splice(ids.indexOf(target.id) + (after ? 1 : 0), 0, dragged.id)
    await window.mousse.threads.reorder(dragged.projectId, ids)
  }

  /** The lower half of a row drops after it, so a row can also go last. */
  const dropsInLowerHalf = (event: React.DragEvent) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientY > rect.top + rect.height / 2
  }

  const endDrag = () => {
    draggedItem.current = null
    setRowDrop(null)
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

  // The Threads tab's menu, while bot threads are listed: Hide all bot threads. From the keyboard (the menu key) it
  // opens below the tab.
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; returnFocus: HTMLElement } | null>(null)
  const openTabMenu = (tab: SidebarTabId, event: React.MouseEvent<HTMLButtonElement>) => {
    if (tab !== 'threads' || !shownBotThreads.length) return
    event.preventDefault()
    const anchor = event.currentTarget
    const rect = anchor.getBoundingClientRect()
    const fromKeyboard = event.clientX === 0 && event.clientY === 0
    setTabMenu({ x: fromKeyboard ? rect.left : event.clientX, y: fromKeyboard ? rect.bottom + 4 : event.clientY, returnFocus: anchor })
  }
  const closeTabMenu = () => {
    const returnTo = tabMenu?.returnFocus
    setTabMenu(null)
    if (returnTo?.isConnected) returnTo.focus({ preventScroll: true })
  }
  const handleHideAllBotThreads = () => {
    const ids = shownBotThreads.map((thread) => thread.id)
    closeTabMenu()
    void hideThreads(ids)
  }
  // A project's listed bot threads, for its menu's Hide bot threads.
  const botThreadsOfProject = (projectId: string) => {
    const groupId = listGroupOf(projectId)
    return shownBotThreads.filter((thread) => listGroupOf(thread.projectId) === groupId)
  }
  const handleHideProjectBotThreads = () => {
    if (!contextMenu || contextMenu.target.type !== 'project') return
    const ids = botThreadsOfProject(contextMenu.target.id).map((thread) => thread.id)
    closeContextMenu()
    void hideThreads(ids)
  }

  // One thread a bot started, from its row's menu.
  const handleHideThread = () => {
    if (!contextMenu || contextMenu.target.type !== 'thread') return
    const id = contextMenu.target.id
    closeContextMenu()
    void hideThreads([id])
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

  // Archiving shows no toast: the row moving to Archived says it. Only a failure toasts.
  const setArchived = (threadId: string, archived: boolean) =>
    runWithToast(archived ? 'archive' : 'unarchive', () => (archived ? archiveThread(threadId) : setThreadArchived(threadId, false)), { retry: true })

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
      await window.mousse.threads.setExpiry(target.id, ms === null ? null : expiresAtAfter(ms), target.expiryStopsRun === true)
    } catch (error) {
      console.error('Setting when the thread is deleted failed', error)
    }
  }

  const handleArchive = () => {
    if (!contextMenu || contextMenu.target.type !== 'thread') return
    const { target } = contextMenu
    closeContextMenu()
    void setArchived(target.id, !target.archived)
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
  const handleCopyReference = () => {
    if (contextMenu?.target.type !== 'thread') return
    const { id, node } = contextMenu.target
    closeContextMenu()
    void runWithToast('copy the reference', () => copyThreadReference(id, node))
  }
  const projectIconActions = (target: ThreadsContextMenuTarget) =>
    projectIconMenuActions(target.type === 'project' ? projects.find((project) => project.id === target.id) : undefined, closeContextMenu)

  const handleRename = () => {
    if (!contextMenu) return
    const { target, inNeedsMe, returnFocus } = contextMenu
    closeContextMenu()
    startRename({ type: target.type, id: target.id, name: target.name, inNeedsMe, returnFocus })
  }

  // A project of this computer: the folder picker, then the same project in the folder chosen. A refusal (no folder
  // there, or another project's folder) is the failure toast.
  const handleChangeFolder = () => {
    if (!contextMenu) return
    const { target } = contextMenu
    closeContextMenu()
    void runWithToast('change the folder', () => window.mousse.projects.changeFolder(target.id, target.path))
  }

  // Only an archived thread of this computer is deleted, after its confirmation; a project asks first too.
  const handleRemove = () => {
    if (!contextMenu) return
    const { target } = contextMenu
    closeContextMenu()
    if (target.type === 'thread') {
      if (target.archived && !target.node) askDelete({ kind: 'one', thread: { id: target.id, name: target.name } })
    } else setRemovingProject(target)
  }

  // From an archived row's menu: every archived thread of this computer, after the same confirmation.
  const handleDeleteAllArchived = () => {
    closeContextMenu()
    askDelete(clearAllRequest(archivedThreads.map((thread) => ({ id: thread.id, name: thread.name, ...(thread.node ? { node: thread.node } : {}) }))))
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

  /** The activity a row shows: rolled up over its subagents, or Working for a send that is starting it. */
  // A wait the bot that started the thread answers shows as Working: it waits on no one the row speaks to.
  const shownActivityOf = (threadId: string) => {
    const activity = rolledUpActivity[threadId] ?? threadActivity[threadId]
    return activity === 'awaiting_input' && supervisedWaits.has(threadId) ? 'processing' : activity
  }
  /**
   * A plain thread's row reads its own activity: the list's may be one push behind on Working and Waiting. One with
   * subagents, or one a starting send shows Working, shows what the list computed.
   */
  const liveActivityOf = (threadId: string) =>
    plainThreadIds.has(threadId) && !supervisedWaits.has(threadId) && rolledUpActivity[threadId] === undefined && threadActivity[threadId] === storeActivity[threadId]
  /** A tree row's time (5m, until 3:40 PM), with a word only for what needs the person; its icon is in the gap. */
  const renderThreadStatus = (thread: Thread) => (
    <ThreadCardStatus threadId={thread.id} activity={shownActivityOf(thread.id)} live={liveActivityOf(thread.id)} awaitsApproval={approvalThreads.has(thread.id)} updatedAt={thread.updatedAt} setupFailed={thread.setupFailure?.reason} terse icon={false} />
  )
  /** A tree row's status has words (Approval, Input, until 3:40 PM, Didn't start), so its row keeps a second line for them. */
  const wordyStatus = (thread: Thread) =>
    !!thread.setupFailure || ['approval', 'question', 'paused'].includes(threadStatus(shownActivityOf(thread.id), approvalThreads.has(thread.id)))
  /** What goes in the gap before a tree row's title: that it is read aloud, else its status, else its unsent draft. */
  const renderThreadMark = (thread: Thread, draft: boolean) => (speakingThreadId === thread.id ? <ThreadSpeechMark /> : (
    <ThreadRowStatusIcon threadId={thread.id} activity={shownActivityOf(thread.id)} live={liveActivityOf(thread.id)} awaitsApproval={approvalThreads.has(thread.id)} setupFailed={thread.setupFailure?.reason} draft={draft} />
  ))

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
   * `inTree`: a thread row of the Projects tree, a tree item with a roving tab stop; `clipped` marks one past a
   * group's preview of 5 that is not shown, which keyboard and screen readers skip until it is.
   */
  const renderThreadRow = (thread: (typeof threads)[number], { root = false, layout = 'row', inNeedsMe = false, inTree = false, clipped = false }: {
    root?: boolean
    layout?: 'row' | 'card'
    inNeedsMe?: boolean
    inTree?: boolean
    clipped?: boolean
  } = {}) => {
    countRender(`SidebarRow:${thread.id}`)
    const isArchived = Boolean(thread.archivedAt)
    // While the thread moves between its list and Archived: the row leaving (not clickable) or the one arriving.
    const archiveMotion = inNeedsMe ? undefined : archiveMotionOfRow(thread)
    // A pending row whose thread the service has not made or started yet: it has nothing to act on but opening it.
    const unmade = unmadeRows.has(thread.id)
    // A new chat not sent yet, listed by its draft: it opens, and has nothing to rename, pin, archive or move yet.
    const unsentChat = !isThreadStarted(thread) && draftedIds.has(thread.id)
    // A chat not sent yet has no status or age.
    const statusNode = layout === 'row' && !unsentChat ? renderThreadStatus(thread) : null
    const actionless = unmade || unsentChat
    const isRenaming = renaming?.type === 'thread' && renaming.id === thread.id && Boolean(renaming.inNeedsMe) === inNeedsMe
    // A row already named (a pending send's, from its prompt) shows its name, not a placeholder.
    const isGeneratingTitle = pendingTitleIds.has(thread.id) && isDefaultThreadName(thread.name)
    const pullRequests = threadPullRequestsOf(thread)
    const hasDraft = draftedIds.has(thread.id)
    const groupId = groupIdOf(thread.projectId)
    const group = groupId ? groupById.get(groupId) : undefined
    // Only the Threads tab's cards carry the project's tint, unless Appearance turns it off; a thread without a
    // project has none.
    const hue = layout === 'card' && threadProjectColors !== 'off' && group ? hueByGroup.get(group.id) : undefined
    const menuTarget: ThreadsContextMenuTarget = {
      type: 'thread', id: thread.id, name: thread.name, pinned: Boolean(thread.pinnedAt), archived: isArchived,
      ...(thread.node ? { node: thread.node, computerName: nameOfComputer(thread.node) } : {}),
      ...(thread.expiresAt ? { expiresAt: thread.expiresAt, ...(thread.expiryStopsRun ? { expiryStopsRun: true } : {}) } : {}),
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
      if (actionless) return
      startRename({ type: 'thread', id: thread.id, name: thread.name, inNeedsMe, returnFocus: event.currentTarget.closest('button') })
    }
    // In the tree the row's own buttons leave the Tab order: the tree is one stop, and the row menu has them all.
    const actionTabIndex = inTree ? -1 : undefined
    // Cards in the Threads tab can be dragged into an order of their own (archived and Needs me rows cannot).
    const feed = layout === 'card' && !isArchived && !inNeedsMe
    const dragItem: DraggedSidebarItem = { type: 'thread', id: thread.id, projectId: groupIdOf(thread.projectId), pinned: Boolean(thread.pinnedAt), ...(feed ? { feed } : {}) }
    const dropLine = !inNeedsMe && rowDrop?.type === 'thread' && rowDrop.id === thread.id ? (rowDrop.after ? ' drop-after' : ' drop-before') : ''

    return (

      <div
        key={rowKeys.get(thread.id) ?? thread.id}
        className={`threads-sidebar-thread-container${speakingThreadId === thread.id ? ' speaking' : ''}${dropLine}`}
        data-pinned={(Boolean(thread.pinnedAt) && !isArchived) || undefined}
        inert={clipped || archiveMotion === 'leave' || undefined}
        // Past a group's preview of 5: folded away until Show more (threads-sidebar.css).
        data-clipped={clipped || undefined}
        aria-hidden={archiveMotion === 'leave' || undefined}
        data-archive-motion={archiveMotion}
        data-archive-thread={archiveMotion ? thread.id : undefined}
        // The row whose menu is open, however it was opened: an archived row stays lit while it is (threads-sidebar.css).
        data-menu-open={(contextMenu?.target.type === 'thread' && contextMenu.target.id === thread.id && Boolean(contextMenu.inNeedsMe) === inNeedsMe) || undefined}
      >

      <button

        type="button"

        className={`threads-sidebar-thread${layout === 'card' ? ' threads-sidebar-card' : ''}${root ? ' threads-sidebar-thread-root' : ''}${

          isActive ? ' active' : openSubagentParentId === thread.id ? ' has-open-subagent' : ''

        }${thread.pinnedAt ? ' pinned' : ''}${isArchived ? ' archived' : ''}${unsentChat ? ' unsent-chat' : ''}${hue ? ` project-tinted project-color-${threadProjectColors}` : ''}`}

        style={hue ? ({ '--project-tint': projectHueColor(hue) } as CSSProperties) : undefined}

        aria-current={isActive ? 'page' : undefined}

        {...(inTree ? {
          role: 'treeitem',
          'aria-level': 2,
          'aria-selected': isActive || openSubagentParentId === thread.id,
          tabIndex: treeTabStop === `thread:${thread.id}` ? 0 : -1,
          'data-tree-key': `thread:${thread.id}`,
          onFocus: () => setTreeFocus(`thread:${thread.id}`)
        } : {})}

        data-thread-id={thread.id}

        draggable={!isRenaming && !isArchived && !inNeedsMe && !actionless}

        // Resting the pointer on the row, not on its buttons (which sit outside it), opens the thread's card.
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse' && !isRenaming && !unmade && !unsentChat) openHoverCardSoon(thread.id, event.currentTarget)
        }}

        onPointerLeave={closeHoverCard}

        onPointerDown={closeHoverCard}

        onDragStart={(event) => {
          event.stopPropagation()
          closeHoverCard()
          startDrag(event, dragItem)
        }}

        onDragOver={(event) => {
          // Nothing drops onto a row the service has not made yet, or a chat not sent yet.
          if (inNeedsMe || actionless || !canDropOn(dragItem)) return
          event.preventDefault()
          event.stopPropagation()
          const after = dropsInLowerHalf(event)
          if (rowDrop?.type !== 'thread' || rowDrop.id !== thread.id || rowDrop.after !== after) setRowDrop({ type: 'thread', id: thread.id, after })
        }}

        onDrop={(event) => {
          event.stopPropagation()
          event.preventDefault()
          if (inNeedsMe || actionless) return
          if (feed) dropFeedThread(thread.id, dropsInLowerHalf(event))
          else void reorderAt(dragItem, dropsInLowerHalf(event))
        }}

        onDragEnd={endDrag}

        onClick={() => {

          // A thread a send is starting opens once it exists, before the service lists it started; a row with no thread yet does not.
          if (!isRenaming && !suppressClick.current && !isPendingRowId(thread.id)) void selectThread(thread.id)

        }}

        onKeyDown={(event) => {
          if (isRenaming || actionless) return
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

        onContextMenu={(event) => (actionless ? event.preventDefault() : openContextMenu(event, menuTarget, inNeedsMe))}

      >

        {layout === 'card' ? (
          <ThreadCardBody
            terseStatus
            thread={thread}
            projectName={group?.project.name}
            project={group?.project}
            hue={hue}
            threadId={thread.id}
            activity={shownActivityOf(thread.id)}
            liveActivity={liveActivityOf(thread.id)}
            awaitsApproval={approvalThreads.has(thread.id)}
            isRenaming={isRenaming}
            renamingName={renaming?.name ?? ''}
            isGeneratingTitle={isGeneratingTitle}
            fullTitle={fullTitle}
            onRename={(name) => void submitRename(name)}
            onCancelRename={endRename}
            onStartRename={renameFromTitle}
            pullRequests={pullRequests}
          />
        ) : (
          <>
        {/* The status (or draft) in the gap before the title. Two lines: the title across the row, then the computer,
            the branch, the pull requests, the time and the model; a thread with none of the first three has one line,
            with its time and model after the title (ThreadBranchLine's data-single). */}
        <span className="threads-sidebar-thread-gutter"><ThreadOpeningMark threadId={thread.id}>{renderThreadMark(thread, hasDraft)}</ThreadOpeningMark></span>
        <span className="threads-sidebar-thread-text">
          <span className="threads-sidebar-thread-line">
            {thread.pinnedAt && <Pin size={12} strokeWidth={2} className="threads-sidebar-pin-icon" aria-hidden="true" />}

            {thread.localOnly && (
              <span className="thread-private-icon" title="Private: stays on this computer">
                <Lock size={12} strokeWidth={2} aria-label="Private" />
              </span>
            )}

            {thread.expiresAt && <ThreadExpiryIcon expiresAt={thread.expiresAt} size={12} />}

            {isRenaming ? (
              <SidebarRenameInput initialName={renaming.name} onSubmit={(name) => void submitRename(name)} onCancel={endRename} />
            ) : isGeneratingTitle ? (
              <span className="threads-sidebar-skeleton" aria-label="Generating title" />
            ) : unsentChat ? (
              <UnsentChatTitle threadId={thread.id} />
            ) : (
              <ThreadTitle name={thread.name} fullTitle={fullTitle} provisional={thread.titleSource === 'provisional'} onDoubleClick={renameFromTitle} />
            )}
          </span>
          <ThreadBranchLine
            thread={thread}
            threadId={thread.id}
            pullRequests={pullRequests}
            end={statusNode}
            wordy={!!statusNode && wordyStatus(thread)}
            className="threads-sidebar-thread-sub"
          />
        </span>
          </>
        )}

      </button>

      {speakingThreadId === thread.id && <ThreadSpeechIndicator wave={layout === 'card'} />}

      {!isRenaming && !actionless && (
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

  /**
   * A group row carries its threads' state: how many finished that nobody has looked at yet, as a muted count after
   * the name (the row then stays bright, threads-sidebar.css); and, while it is closed, the worst state above that in
   * the chevron's slot: a spinner while threads work, how many need the person, or a pause mark. Hover and focus give
   * the slot back to the chevron; an open group shows its threads' own marks instead.
   */
  const renderGroupStatus = (groupThreads: Thread[], expanded: boolean) => {
    const levels = groupThreads.map((thread) => attentionOf(thread.id))
    const attention = worstOf(levels.filter((level) => level !== 'done'))
    const finishedCount = levels.filter((level) => level === 'done').length
    const needsMeCount = levels.filter((level) => level === 'needs-me').length
    const finishedLabel = `${finishedCount} finished`
    const title = attention === 'quiet' ? '' : attention === 'needs-me' ? needsMeLabel(needsMeCount) : PROJECT_ATTENTION_TITLE[attention]
    return (
      <>
        {/* Right after the name (the name's :has(+ …) rule); the mark is placed in the chevron's slot, so its order is free. */}
        {finishedCount > 0 && (
          <span className="threads-sidebar-project-finished" role="img" aria-label={finishedLabel} title={finishedLabel}>{finishedCount}</span>
        )}
        {!expanded && attention !== 'quiet' && (
          <span
            className={`threads-sidebar-project-mark threads-sidebar-project-status--${attention}`}
            role="img"
            aria-label={title}
          >
            {attention === 'working' ? (
              <Loader2 size={12} strokeWidth={2.2} className={sidebarAnimations ? 'icon-spin' : undefined} aria-hidden="true" />
            ) : attention === 'paused' ? (
              <Pause size={11} strokeWidth={2.2} aria-hidden="true" />
            ) : needsMeCount}
          </span>
        )}
      </>
    )
  }

  /** A group's thread rows: the first 5, and Show more for the rest. */
  const renderGroupThreads = (groupId: string, groupThreads: Thread[]) => {
    const showAll = expandedProjectThreadLists.has(groupId)
    return (
      <>
        <div
          className={`threads-sidebar-thread-list ui-collapse-items${showAll ? ' expanded' : ''}`}
          role="none"
        >
          {groupThreads.map((thread, index) => renderThreadRow(thread, {
            inTree: true,
            clipped: !showAll && index >= PROJECT_THREAD_PREVIEW_LIMIT
          }))}
        </div>
        {groupThreads.length > PROJECT_THREAD_PREVIEW_LIMIT && (
          <button
            type="button"
            className="threads-sidebar-show-more"
            tabIndex={-1}
            onClick={() => {
              setExpandedProjectThreadLists((prev) => {
                const next = new Set(prev)
                if (showAll) next.delete(groupId)
                else next.add(groupId)
                return next
              })
            }}
          >
            {showAll ? 'Show less' : 'Show more'}
          </button>
        )}
      </>
    )
  }

  /** "No project", the Projects tree's last group: the threads of no project, with no project actions. */
  const renderOtherThreads = () => {
    const expanded = groupOpen(OTHER_THREADS_ID)
    const treeKey = `project:${OTHER_THREADS_ID}`
    const childrenId = `${tabsId}-other-threads`
    return (
      <div className="threads-sidebar-project threads-sidebar-other-threads" data-project-id={OTHER_THREADS_ID} data-active-project={activeGroupId === OTHER_THREADS_ID || undefined}>
        <div className={`threads-sidebar-project-row${expanded ? ' expanded' : ''}`}>
          <button
            type="button"
            className="threads-sidebar-project-toggle"
            role="treeitem"
            aria-level={1}
            aria-expanded={expanded}
            aria-owns={expanded ? childrenId : undefined}
            tabIndex={treeTabStop === treeKey ? 0 : -1}
            data-tree-key={treeKey}
            onFocus={() => setTreeFocus(treeKey)}
            onClick={() => toggleProject(OTHER_THREADS_ID)}
          >
            <ChevronRight size={12} strokeWidth={2} className="threads-sidebar-project-chevron" aria-hidden="true" />
            <Layers size={16} strokeWidth={1.8} className="threads-sidebar-project-icon" aria-hidden="true" />
            <span className="threads-sidebar-project-name">No project</span>
            {renderGroupStatus(otherThreads, expanded)}
          </button>
          {/* The global new thread: no project, as "No project" in the composer's picker. */}
          <button
            type="button"
            className="threads-sidebar-icon-btn threads-sidebar-project-new-chat"
            title="New thread"
            aria-label="New thread"
            tabIndex={-1}
            onClick={() => void runWithToast('start a thread', createAndSelectThread, { retry: true })}
          >
            <MessageSquarePlus size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <Collapse
          open={expanded}
          animate={sidebarAnimations && toggledProjectRef.current === OTHER_THREADS_ID}
          id={childrenId}
          role="group"
          className="threads-sidebar-children"
          itemCount={otherThreads.length}
        >
          {otherThreads.length === 0 ? (
            <div className="threads-sidebar-empty threads-sidebar-empty-nested" role="none">No threads</div>
          ) : renderGroupThreads(OTHER_THREADS_ID, otherThreads)}
        </Collapse>
      </div>
    )
  }

  // Not while a menu is open or a row is renamed; gone with its thread.
  const hoverCardShown = hoverCardId && !contextMenu && !tabMenu && !renaming ? threads.find((thread) => thread.id === hoverCardId) : undefined

  return (

    // While a menu is open, the rows under the pointer do not light their actions (see threads-sidebar.css).
    <aside ref={asideRef} data-mousse="sidebar" inert={warmOnly || undefined} className={`threads-sidebar${contextMenu || tabMenu ? ' menu-open' : ''}${className ? ` ${className}` : ''}`} style={{ width: threadsSidebarWidth }}>

      <div className="threads-sidebar-tabs-row">
        <PillTabs
          tabs={SIDEBAR_TABS}
          value={sidebarView === 'chats' ? 'chats' : 'threads'}
          // Threads comes back in the view used last.
          onSelect={(tab) => void setSidebarView(tab === 'chats' ? 'chats' : useAppStore.getState().lastThreadListView)}
          onTabContextMenu={openTabMenu}
          ariaLabel="Sidebar"
          idPrefix={tabsId}
        />
      </div>

      {contentView !== 'chats' && (
        <ThreadFilterBar view={contentView} projects={projectOptions} bots={botOptions} computers={computerOptions} onSwapView={() => void setSidebarView(contentView === 'projects' ? 'threads' : 'projects')} />
      )}

      <div ref={scrollRef} className="threads-sidebar-scroll" data-view={contentView} data-fill={footerHidden || undefined} data-more-below={moreBelow || undefined}>

      <div className="threads-sidebar-section threads-sidebar-section-projects" role="tabpanel" id={`${tabsId}-${contentView === 'projects' ? 'threads' : 'projects'}-panel`} aria-labelledby={`${tabsId}-threads-tab`} hidden={contentView !== 'projects'}>

        {contentView === 'projects' && renderNeedsMe()}

        {projectGroups.length === 0 && (

          <div className="threads-sidebar-tree">
            <div className="threads-sidebar-empty threads-sidebar-empty-projects">
              <span>No projects</span>
              <button type="button" className="threads-sidebar-inline-action" onClick={() => void openProject()}>Add project</button>
            </div>
          </div>

        )}

        {projectGroups.length > 0 && treeGroupIds.length === 0 && (
          <div className="threads-sidebar-tree">
            <div className="threads-sidebar-empty">{filtering ? 'No matching threads' : 'No projects shown'}</div>
          </div>
        )}

        {treeGroupIds.length > 0 && (

        <div className="threads-sidebar-tree" role="tree" aria-label="Projects" data-has-active={activeGroupId !== undefined || undefined} onKeyDown={onTreeKeyDown}>

          {shownGroups.map((group) => {

              // The group is named by one project: this computer's when it has one.
              const project = group.project
              const alsoOn = groupComputers(group).filter((node) => node !== project.node)

              const expanded = groupOpen(project.id)

              const projectThreads = projectThreadsOf(group.id)
              const projectThreadCount = projectThreads.length

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
                  className={`threads-sidebar-project${rowDrop?.type === 'project' && rowDrop.id === project.id ? (rowDrop.after ? ' drop-after' : ' drop-before') : ''}`}
                  data-project-id={project.id}
                  data-active-project={activeGroupId === group.id || undefined}
                  // The folder icon's color: the group's hue, as on its threads' cards (polish.css).
                  style={{ '--project-hue': projectHueColor(hueByGroup.get(group.id)) } as CSSProperties}
                  draggable={!isRenaming}
                  onDragStart={(event) => startDrag(event, { type: 'project', id: project.id })}
                  onDragOver={(event) => {
                    if (!canDropOn({ type: 'project', id: project.id })) {
                      // Over a row it cannot drop on, no line promises a place.
                      if (rowDrop) setRowDrop(null)
                      return
                    }
                    event.preventDefault()
                    // The lower half of the group drops after it, so a project can also go last.
                    const after = dropsInLowerHalf(event)
                    if (rowDrop?.type !== 'project' || rowDrop.id !== project.id || rowDrop.after !== after) setRowDrop({ type: 'project', id: project.id, after })
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    void reorderAt({ type: 'project', id: project.id }, dropsInLowerHalf(event))
                  }}
                  onDragEnd={endDrag}
                >

                  <div

                    className={`threads-sidebar-project-row${expanded ? ' expanded' : ''}${projectThreadCount === 0 ? ' empty' : ''}${project.pinnedAt ? ' pinned' : ''}`}
                    // The row whose menu is open stays lit while the other groups dim (threads-sidebar.css).
                    data-menu-open={(contextMenu?.target.type === 'project' && contextMenu.target.id === project.id) || undefined}
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

                      <ProjectIcon
                        project={project}
                        expanded={expanded}
                        className="threads-sidebar-project-icon"
                        fallback={expanded ? (
                          <FolderOpen size={16} strokeWidth={1.8} className="threads-sidebar-project-icon" aria-hidden="true" />
                        ) : (
                          <Folder size={16} strokeWidth={1.8} className="threads-sidebar-project-icon" aria-hidden="true" />
                        )}
                      />

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

                        // No double-click rename: clicks on a project open and close it. Rename is in its menu and on F2.
                        <span className="threads-sidebar-project-name">{project.name}</span>

                      )}

                      {renderGroupStatus(projectThreads, expanded)}

                    </button>

                    {/* Its automations' runs that need the person, on this computer's projects in the group. */}
                    <ProjectRunsDot name={project.name} projectIds={group.members.filter((member) => !member.node).map((member) => member.id)} />

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

                    {/* The computers that hold it, after the "…" so that showing it on hover moves neither these nor
                        New thread. A click here opens and closes the project, as on the rest of the row. */}
                    <span className="threads-sidebar-project-computers" onClick={() => { if (!isRenaming) toggleProject(project.id) }} onContextMenu={(event) => openContextMenu(event, menuTarget)}>
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
                    </span>

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
                    animate={sidebarAnimations && toggledProjectRef.current === project.id}
                    id={childrenId}
                    role="group"
                    className="threads-sidebar-children"
                    itemCount={projectThreadCount}
                  >

                      {projectThreadCount === 0 ? (

                        <div className="threads-sidebar-empty threads-sidebar-empty-nested" role="none">No threads</div>

                      ) : renderGroupThreads(project.id, projectThreads)}

                  </Collapse>

                </div>

              )

            })}

          {showOtherThreads && renderOtherThreads()}

        </div>

        )}

      </div>



      <div className="threads-sidebar-section threads-sidebar-section-feed" role="tabpanel" id={`${tabsId}-${contentView === 'projects' ? 'feed' : 'threads'}-panel`} aria-labelledby={`${tabsId}-threads-tab`} hidden={contentView !== 'threads'}>
        {contentView === 'threads' && renderNeedsMe()}
        <div
          className="threads-sidebar-tree threads-sidebar-thread-feed threads-sidebar-feed-list"
          data-has-active={feedHasActive || undefined}
          // Below the last row the dragged row goes last; in the gap between two rows, where the line shows.
          onDragOver={(event) => {
            if (!draggedItem.current?.feed || filtering) return
            event.preventDefault()
            const rows = event.currentTarget.querySelectorAll('.threads-sidebar-thread-container')
            const bottom = rows[rows.length - 1]?.getBoundingClientRect().bottom
            const last = [...feedRows].reverse().find((thread) => !unmadeRows.has(thread.id))
            if (last && bottom !== undefined && event.clientY > bottom && (rowDrop?.type !== 'thread' || rowDrop.id !== last.id || !rowDrop.after)) {
              setRowDrop({ type: 'thread', id: last.id, after: true })
            }
          }}
          onDrop={(event) => {
            if (!draggedItem.current?.feed) return
            event.preventDefault()
            if (rowDrop?.type === 'thread') dropFeedThread(rowDrop.id, rowDrop.after)
          }}
        >
          {/* Cards render only while the tab shows (or is coming in), so a change to the list does not redraw a hidden copy of it. */}
          {contentView !== 'threads' && sidebarView !== 'threads' ? null : feedThreads.length === 0 ? (
            <div className="threads-sidebar-empty">{filtering ? 'No matching threads' : 'No threads'}</div>
          ) : (
            <>
              {feedRows.map((thread) => renderThreadRow(thread, { root: true, layout: 'card' }))}
            </>
          )}
        </div>
      </div>

      <div className="threads-sidebar-section threads-sidebar-section-chats" role="tabpanel" id={`${tabsId}-chats-panel`} aria-labelledby={`${tabsId}-chats-tab`} hidden={contentView !== 'chats'}>
        {contentView === 'chats' && <ChatsSidebar />}
      </div>

      </div>

      {/* The same footer under Projects and Threads: one "Archived" disclosure; the whole heading opens and closes it. */}
      <div ref={footerRef} className="threads-sidebar-footer" hidden={footerHidden}>

        <section className={`threads-sidebar-section threads-sidebar-section-archived${archivedExpanded ? ' expanded' : ' collapsed'}`} aria-label="Archived">

          <div className="threads-sidebar-heading">
            <button
              ref={archivedHeadingRef}
              type="button"
              className="threads-sidebar-heading-toggle"
              onClick={() => {
                // How far below the footer's top the list starts: its motion is capped to the room under it (threads-sidebar.css).
                const footer = footerRef.current
                const heading = archivedHeadingRef.current?.parentElement
                if (footer && heading) footer.style.setProperty('--threads-sidebar-archived-head', `${heading.getBoundingClientRect().bottom - footer.getBoundingClientRect().top}px`)
                setArchivedExpanded((expanded) => !expanded)
              }}
              aria-expanded={archivedExpanded}
            >
              <Archive size={14} strokeWidth={2} className="threads-sidebar-archived-icon" aria-hidden="true" />
              <span>Archived</span>
              {archivedThreads.length > 0 && <span className="threads-sidebar-archived-count">{archivedThreads.length}</span>}
              <ChevronRight size={12} strokeWidth={2} className="threads-sidebar-archived-chevron" aria-hidden="true" />
            </button>
          </div>

          {/* Built only while open, and only the cards in view (ArchivedList). A long list opens at once: its height
              motion would lay out the footer on every frame. */}
          <div ref={archivedScrollRef} className="threads-sidebar-archived-scroll">
          <Collapse open={archivedExpanded} itemCount={archivedThreads.length} animate={sidebarAnimations && archivedThreads.length <= COLLAPSE_LONG_LIST}>
            {archivedThreads.length === 0 ? (
              <div className="threads-sidebar-tree threads-sidebar-thread-feed threads-sidebar-archived-list">
                <div className="threads-sidebar-empty">No archived threads</div>
              </div>
            ) : (
              <ArchivedList
                threads={archivedThreads}
                renderRow={(thread) => renderThreadRow(thread, { root: true, layout: 'card' })}
                scrollRef={archivedScrollRef}
                keepIds={[
                  ...(contextMenu?.target.type === 'thread' && !contextMenu.inNeedsMe ? [contextMenu.target.id] : []),
                  ...(renaming?.type === 'thread' && !renaming.inNeedsMe ? [renaming.id] : []),
                ]}
                revealId={openSubagentParentId ?? activeThreadId ?? undefined}
              />
            )}
          </Collapse>
          </div>

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
          onChangeFolder={contextMenu.target.type === 'project' && !contextMenu.target.node ? handleChangeFolder : undefined}
          onTrustGitSettings={handleTrustGitSettings}
          onNewThread={handleNewProjectThread}
          onNewThreadFromPullRequest={handleNewThreadFromPullRequest}
          {...projectOpeners(contextMenu.target)}
          onCopyPath={contextMenu.target.path ? handleCopyPath : undefined}
          onCopyReference={contextMenu.target.type === 'thread' ? handleCopyReference : undefined}

          onSetExpiry={(ms) => void handleSetExpiry(ms)}
          onDeleteAllArchived={localArchivedCount > 0 ? handleDeleteAllArchived : undefined}
          {...projectIconActions(contextMenu.target)}
          onHideBotThreads={contextMenu.target.type === 'project' && botThreadsOfProject(contextMenu.target.id).length > 0 ? handleHideProjectBotThreads : undefined}
          onHideThread={contextMenu.target.type === 'thread' && shownBotThreads.some((thread) => thread.id === contextMenu.target.id) ? handleHideThread : undefined}

        />

      )}

      {tabMenu && <ThreadsTabMenu x={tabMenu.x} y={tabMenu.y} onClose={closeTabMenu} onHideAllBotThreads={handleHideAllBotThreads} />}

      {/* In the document's body: the sidebar is a size container, which pins a fixed overlay inside it, under the main view. */}
      {removingProject && createPortal(<Modal
        open
        title="Remove project"
        onClose={() => setRemovingProject(null)}
        footer={<>
          <button type="button" className="settings-btn" onClick={() => setRemovingProject(null)}>Cancel</button>
          <button type="button" className="settings-btn" data-testid="remove-project-confirm" onClick={confirmRemoveProject}>Remove</button>
        </>}
      >
        <p className="threads-sidebar-remove-project">
          {removingProject.computerName ? `${removingProject.name} on ${removingProject.computerName}` : removingProject.name} leaves the sidebar. Its folder and threads stay.
          {removingProject.alsoOn?.length ? ` ${removingProject.alsoOn.join(' and ')} keep${removingProject.alsoOn.length === 1 ? 's' : ''} theirs.` : ''}
        </p>
      </Modal>, document.body)}

      {pullRequestProject && (
        <StartFromPullRequestDialog
          projectId={pullRequestProject.id}
          projectName={pullRequestProject.name}
          onClose={() => setPullRequestProject(null)}
        />
      )}

      {hoverCardShown && (
        <ThreadHoverCard thread={hoverCardShown} project={projects.find((project) => project.id === hoverCardShown.projectId)} anchorRef={hoverCardAnchor} />
      )}

    </aside>

  )

}
