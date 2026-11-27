import { useEffect, useId, useMemo, useRef, useState, type FocusEvent, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { MessageSquare } from '../lib/icons'
import { UNKNOWN_COMPUTER_NAME, threadComputerState, useComputers, useSelfNode, type Computer } from '../lib/computers'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import { groupProjects } from '../lib/projectGroups'
import { projectHues } from '../lib/projectHues'
import { useReplyPreviews } from '../lib/replyPreviewSetting'
import { useThreadProjectColors } from '../lib/threadProjectColorsSetting'
import { useThreadsAwaitingApproval } from '../hooks/useThreadsAwaitingApproval'
import { useAppStore } from '../stores/appStore'
import { openLinkedThread } from '../utils/chatLinks'
import { showToast } from './ui/Toast'
import { ThreadCardBody } from './ThreadsSidebar'
import { threadLinkStatus, type ThreadLinkStatus } from '../../shared/threadAttention'
import { useThreadRefMenu } from './ThreadRefMenu'
import { threadLink } from '../../shared/threadLink'
import { threadPullRequestsOf } from '../../shared/pullRequests'
import { parseQualifiedId } from '../../shared/threadRef'
import type { Thread, ThreadActivityState, TurnPhase } from '../../shared/types'
import '../styles/threads-sidebar.css'
import '../styles/threadChip.css'

/** How long the pointer rests on a link before its card opens. */
const CARD_OPEN_DELAY_MS = 350

/**
 * What a thread chip shows of its thread. `listed`: this window lists it (with its status, `threadLinkStatus`, and whether
 * it is archived, which the link only hints at: an archived thread still shows how its latest run ended). `offline` and
 * `not-shared`: it runs on another computer that is not connected, or no longer shares its threads with this one (a row
 * of the merged lists says so, or, for a thread the window never listed, the device list). `missing`: not listed here,
 * so deleted.
 */
export type ThreadChipState =
  | { kind: 'listed'; title: string; status: ThreadLinkStatus; archived: boolean }
  | { kind: 'offline' | 'not-shared'; title?: string; computer: string }
  | { kind: 'missing' }

/** The words a chip says for a thread's status; a quiet thread says nothing. */
const STATUS_WORDS: Record<ThreadLinkStatus, string | null> = {
  working: 'Working',
  waiting: 'Waiting',
  approval: 'Needs you',
  question: 'Needs you',
  paused: 'Paused',
  done: 'Done',
  failed: 'Failed',
  quiet: null
}

/**
 * The state of the chip for `threadId`, from what this window holds: the thread's row if it lists one, its activity
 * and the phase of its latest turn, whether other rows of its computer say that computer stopped sharing
 * (`notSharing`), and the computers.
 */
export function threadChipState(
  threadId: string,
  thread: Thread | undefined,
  activity: ThreadActivityState | undefined,
  notSharing: boolean,
  computers: Readonly<Record<string, Computer>>,
  lastPhase?: TurnPhase
): ThreadChipState {
  const node = thread?.node ?? parseQualifiedId(threadId)?.node
  const computer = node ? computers[node] : undefined
  const computerName = computer?.name ?? UNKNOWN_COMPUTER_NAME
  if (thread) {
    const title = thread.name.trim() || 'Untitled thread'
    const reach = node ? threadComputerState(thread, computer) : 'online'
    if (reach !== 'online') return { kind: reach, title, computer: computerName }
    return { kind: 'listed', title, status: threadLinkStatus(activity, lastPhase, false, thread.setupFailure !== undefined, thread.lastRun), archived: thread.archivedAt !== undefined }
  }
  if (node) {
    // Not listed, but its computer's other rows say it stopped sharing, or the device list says it is not connected.
    if (notSharing) return { kind: 'not-shared', computer: computerName }
    if (!computer || !computer.online) return { kind: 'offline', computer: computerName }
  }
  return { kind: 'missing' }
}

/** What the link's state says: its tooltip, and read as part of its name. */
function stateWords(state: ThreadChipState): string | null {
  switch (state.kind) {
    case 'listed': {
      const words = STATUS_WORDS[state.status]
      if (!state.archived) return words
      return words ? `${words}, archived` : 'Archived'
    }
    case 'offline':
      return `${state.computer} is offline`
    case 'not-shared':
      return `${state.computer} is not sharing`
    case 'missing':
      return 'Deleted'
  }
}

/** The card's last line, for a thread its status does not cover: archived, or its computer is away. */
function cardNote(state: ThreadChipState): string | null {
  if (state.kind === 'listed') return state.archived ? 'Archived' : null
  return stateWords(state)
}

/** Keyboard focus, not the focus a click gives: only that opens the card. */
function focusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible')
  } catch {
    return true
  }
}

/**
 * A thread link's hover card: the thread as its card in the Threads tab reads (`ThreadCardBody`), with the project,
 * the status its link shows (the spinner while it works) and how long ago, the title and the latest reply. It only
 * shows: the pointer passes through it, so it never takes a click from the link or the text around it.
 */
function ThreadLinkCard({ id, thread, note, anchorRef }: { id: string; thread: Thread; note: string | null; anchorRef: RefObject<HTMLElement | null> }) {
  const content = useRef<HTMLDivElement>(null)
  const projects = useAppStore((state) => state.projects)
  const approvals = useThreadsAwaitingApproval()
  const activity = useAppStore((state) => state.threadActivity[thread.id])
  const lastPhase = useAppStore((state) => state.turnStates[thread.id]?.phase)
  const status = threadLinkStatus(activity, lastPhase, approvals.has(thread.id), thread.setupFailure !== undefined, thread.lastRun)
  const projectColors = useThreadProjectColors()
  const replyPreviews = useReplyPreviews()
  const { group, hue } = useMemo(() => {
    const { groups, groupOf } = groupProjects(projects)
    const groupId = thread.projectId ? groupOf.get(thread.projectId) ?? thread.projectId : undefined
    const found = groups.find((entry) => entry.id === groupId)
    const hues = found && projectColors !== 'off' ? projectHues(groups.map((entry) => ({ id: entry.id, createdAt: entry.project.createdAt }))) : undefined
    return { group: found, hue: found ? hues?.get(found.id) : undefined }
  }, [projects, thread.projectId, projectColors])
  const style = useFloatingPosition({ open: true, anchorRef, contentRef: content, placement: 'above-start', gap: 6 })
  return (
    <FloatingPortal>
      <div ref={content} id={id} role="tooltip" className="thread-chip-card" style={style}>
        <ThreadCardBody
          thread={thread}
          projectName={group?.project.name}
          project={group?.project}
          hue={hue}
          threadId={thread.id}
          liveActivity
          awaitsApproval={approvals.has(thread.id)}
          isRenaming={false}
          renamingName=""
          isGeneratingTitle={false}
          fullTitle={thread.name}
          onRename={() => {}}
          onCancelRename={() => {}}
          preview={replyPreviews ? thread.lastReply : undefined}
          pullRequests={threadPullRequestsOf(thread)}
          statusWithAge
          linkStatus={status}
        />
        {note && <span className="thread-chip-card-note">{note}</span>}
      </div>
    </FloatingPortal>
  )
}

/** What a click says when the thread cannot be opened. */
function unreachableText(state: ThreadChipState): string {
  if (state.kind === 'offline') return `${state.computer} is not connected, so this thread cannot be opened now.`
  if (state.kind === 'not-shared') return `${state.computer} no longer shares its threads with this computer.`
  return 'That thread is no longer here.'
}

/**
 * A link to a Mousse thread, drawn as text: a small icon tinted by the thread's status, then its title (or the
 * link's own text). Resting the pointer on it, or keyboard focus, shows the thread's card (`ThreadLinkCard`). A click
 * switches the main view to the thread in this window, and Back returns (the thread history records the switch). A
 * thread that is not listed here says why instead: deleted, or on a computer that is not connected or not sharing.
 */
export function ThreadChip({ threadId: linked, label }: { threadId: string; label?: ReactNode }) {
  // A link written on another computer names this computer's threads with this computer's node: read it by its id here.
  const qualified = parseQualifiedId(linked)
  const self = useSelfNode(qualified !== undefined)
  const threadId = qualified && qualified.node === self ? qualified.id : linked
  const thread = useAppStore((state) => state.threads.find((entry) => entry.id === threadId))
  const activity = useAppStore((state) => state.threadActivity[threadId])
  const lastPhase = useAppStore((state) => state.turnStates[threadId]?.phase)
  const node = thread?.node ?? parseQualifiedId(threadId)?.node
  // Only a chip naming another computer asks for the device list.
  const { byNode } = useComputers(node !== undefined)
  const notSharing = useAppStore((state) => !thread && node !== undefined && state.threads.some((entry) => entry.node === node && entry.notShared === true))
  const state = threadChipState(threadId, thread, activity, notSharing, byNode, lastPhase)
  const title = 'title' in state && state.title !== undefined ? state.title : null
  const words = stateWords(state)
  const shown = label ?? title ?? (state.kind === 'missing' ? 'A thread' : 'A thread on another computer')
  const name = [typeof label === 'string' ? label : title ?? (state.kind === 'missing' ? 'Thread' : 'Thread on another computer'), words].filter(Boolean).join(', ')
  const openable = state.kind === 'listed' || ((state.kind === 'offline' || state.kind === 'not-shared') && title !== null)
  // A thread this window lists has a card; one it does not says why in a plain tooltip.
  const card = thread !== undefined && state.kind !== 'missing'
  const cardId = useId()
  const anchor = useRef<HTMLAnchorElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const [cardOpen, setCardOpen] = useState(false)
  const hideCard = () => { window.clearTimeout(timer.current); setCardOpen(false) }
  useEffect(() => {
    if (!cardOpen) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') hideCard() }
    document.addEventListener('keydown', escape)
    window.addEventListener('blur', hideCard)
    return () => { document.removeEventListener('keydown', escape); window.removeEventListener('blur', hideCard) }
  }, [cardOpen])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const onPointerEnter = (event: PointerEvent<HTMLAnchorElement>) => {
    if (!card || event.pointerType === 'touch') return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCardOpen(true), CARD_OPEN_DELAY_MS)
  }
  const onFocus = (event: FocusEvent<HTMLAnchorElement>) => {
    if (!card || !focusVisible(event.currentTarget)) return
    window.clearTimeout(timer.current)
    setCardOpen(true)
  }
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    hideCard()
    if (openable) openLinkedThread(threadId)
    else showToast({ key: 'thread-link-missing', message: unreachableText(state) })
  }
  // Right-click: Copy reference, to point another chat's agent at this thread.
  const refMenu = useThreadRefMenu(threadId)
  return (
    <>
    <a
      ref={anchor}
      href={threadLink(threadId)}
      className="thread-chip"
      data-state={state.kind}
      {...(state.kind === 'listed' ? { 'data-status': state.status, ...(state.archived ? { 'data-archived': '' } : {}) } : {})}
      aria-label={openable ? `Open thread ${name}` : name}
      {...(openable ? {} : { 'aria-disabled': true })}
      {...(card ? {} : { title: unreachableText(state) })}
      {...(cardOpen ? { 'aria-describedby': cardId } : {})}
      onPointerEnter={onPointerEnter}
      onPointerLeave={hideCard}
      onFocus={onFocus}
      onBlur={hideCard}
      onClick={onClick}
      {...refMenu.bind}
    >
      <MessageSquare size={12} strokeWidth={2} aria-hidden="true" className="thread-chip-icon" />
      <span className="thread-chip-title">{shown}</span>
    </a>
    {cardOpen && card && <ThreadLinkCard id={cardId} thread={thread} note={cardNote(state)} anchorRef={anchor} />}
    {refMenu.menu}
    </>
  )
}
