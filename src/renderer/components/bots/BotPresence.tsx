import { botDayLabel, botGroupTime } from './messageGroups'
import { Fragment, memo, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { Activity, AppWindow, ArrowRight, Brain, ChevronDown, Circle, CircleAlert, CircleCheck, CircleDotDashed, CircleX, Clock, Eye, EyeOff, FileText, Globe, Moon, Pencil, Search, TerminalSquare, X } from '../../lib/icons'
import type { BotChip, BotLaunchedThread, BotSummary, BotWatcherItem, BotWorkItem } from '../../../shared/bots/personal/chat'
import { formatAgo } from '../../lib/formatAgo'
import { setThreadHidden } from '../../lib/threadActions'
import { openBotThread } from '../../lib/botThread'
import { useBotsStore } from '../../stores/botsStore'
import { useAppStore } from '../../stores/appStore'
import { botThreadCount, showBotThreads } from '../../lib/showBotThreads'
import { launchedGroups, launchedLook, presenceOf, stickerOf, type BotStickerKind, type LaunchedTone } from './botChatShape'
import { runningFor } from './BotStartedCards'
import { useThreadRefMenu } from '../ThreadRefMenu'
import { isQualifiedId } from '../../../shared/threadRef'

/** How long work has run, in plain words: "just now", "4 min", "1 h 20 min". */
export function workElapsed(startedAt: string, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(startedAt)) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
}

/** What a piece of work is doing now, in a few words. */
function workDoing(item: BotWorkItem, chip: BotChip | undefined): string {
  if (item.status === 'queued') return 'queued'
  if (item.status === 'waiting_for_internet') return 'waiting for internet'
  if (item.wait) {
    const event = item.wait.event
    if (!event) {
      const due = item.wait.dueAt
      const day = new Date(due).toDateString() === new Date().toDateString() ? '' : `${botDayLabel(due)} `
      return `checks again at ${day}${botGroupTime(due)}`
    }
    if (event.kind === 'pr') return `waits for ${event.repo}#${event.number}${event.on === 'checks' ? ' · its checks' : event.on === 'review' ? ' · a review' : ''}`
    return `waits for ${event.kind === 'thread' ? event.title ?? `thread ${event.threadId}` : event.title}`
  }
  if (item.status === 'paused') return item.waitsFor === 'answer' ? `waiting on you${item.detail ? ` · ${item.detail}` : ''}` : 'held'
  return chip ? `${chip.text}${chip.highlight ? ` ${chip.highlight}` : ''}` : 'working'
}

/** "2 subagents": how many of the work's subagents run now. */
export function subagentsCount(n: number): string {
  return n === 1 ? '1 subagent' : `${n} subagents`
}

/** Each running subagent on a line of the tooltip: its title, its model and entry, and what it runs without there. */
export function subagentsTitle(subagents: ReadonlyArray<{ title: string; model: string; lacks?: readonly string[] }>): string {
  return subagents.map((subagent) => `${subagent.title} · ${subagent.model}${subagent.lacks?.length ? ` · can't ${subagent.lacks.join(' or ')} there` : ''}`).join('\n')
}

/** One piece of work in the header's list: its title, what it is doing, for how long, and Stop. The time moves twice a minute. */
const WorkLine = memo(function WorkLine({ botId, item }: { botId: string; item: BotWorkItem }) {
  const chip = useBotsStore((s) => s.activity[item.id])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const running = item.status === 'running'
  // What the row says after its title, each part after a dot: what it does, the model of work on a model of its own (its
  // details on hover), how long it has run. A part with more to say (such as its subagents) goes in this list, after the model.
  const details: ReactNode[] = [
    workDoing(item, chip),
    ...(item.model ? [<span className="bot-work-model" title={item.model.detail}>{item.model.name}</span>] : []),
    // Its subagents running now; on hover each one's title, model and entry (which provider does that part).
    ...(item.subagents?.length ? [<span className="bot-work-subagents" title={subagentsTitle(item.subagents)}>{subagentsCount(item.subagents.length)}</span>] : []),
    ...(item.status === 'queued' ? [] : [workElapsed(item.startedAt, now)])
  ]
  return <li className={`bot-work-line${running ? ' is-running' : ''}`}>
    <span className="bot-work-title">{item.title}</span>
    <span className="bot-work-doing">{details.map((part, index) => <Fragment key={index}>{index > 0 && ' · '}{part}</Fragment>)}</span>
    <button type="button" data-nav aria-label={`Stop ${item.title}`} title="Stop" onClick={() => void useBotsStore.getState().stopWork(botId, item.id)}><X size={13} aria-hidden /></button>
  </li>
})

/** A background command in the header's list: its title and how long it has run; the command and its last line on hover; Stop. */
const WatcherLine = memo(function WatcherLine({ botId, item, now }: { botId: string; item: BotWatcherItem; now: number }) {
  return <li className="bot-work-line is-running" title={item.lastLine ? `${item.command}\n${item.lastLine}` : item.command}>
    <span className="bot-work-title">{item.title}</span>
    <span className="bot-work-doing">{runningFor(item.startedAt, now)}</span>
    <button type="button" data-nav aria-label={`Stop ${item.title}`} title="Stop" onClick={() => void useBotsStore.getState().stopWork(botId, item.id)}><X size={13} aria-hidden /></button>
  </li>
})

const TONE_ICONS: Record<LaunchedTone, typeof Circle> = { working: CircleDotDashed, waiting: CircleAlert, idle: Circle, done: CircleCheck, failed: CircleX }

/**
 * A thread the bot started, in the header's list: its title, where it stands (an icon and a word, the row tinted to
 * match), its project and when it last changed. The whole row opens it in the bot's chat pane (`openBotThread`). Rows
 * that no longer work are dimmed. A thread the bot keeps out of the sidebar says "Hidden", and has Show in sidebar beside it
 * when it is a thread of this computer (the computer that runs a thread shows it; `threads.setHidden` is not routed).
 * `tooltip: false` (the hover card): no "Open …" tooltip, which would cover the row above.
 */
export const BotThreadLine = memo(function BotThreadLine({ botId, thread, now, onOpen, tooltip = true }: { botId: string; thread: BotLaunchedThread; now: number; onOpen(): void; tooltip?: boolean }) {
  const { tone, label } = launchedLook(thread.status)
  const Icon = TONE_ICONS[tone]
  const ago = formatAgo(Date.parse(thread.updatedAt), now)
  const [showing, setShowing] = useState(false)
  const refMenu = useThreadRefMenu(thread.threadId)
  const meta: ReactNode[] = [
    ...(thread.hidden ? [<span className="bot-thread-hidden" title="Not in your sidebar"><EyeOff size={11} aria-hidden />Hidden</span>] : []),
    ...(thread.project ? [thread.project] : []),
    ...(ago ? [`updated ${ago}`] : [])
  ]
  return <li className="bot-thread-item">
    <button type="button" className="bot-thread-line" data-tone={tone} data-hidden={thread.hidden || undefined} data-nav title={tooltip ? `Open ${thread.title}` : undefined}
      onClick={() => { onOpen(); void openBotThread(botId, thread.threadId) }} {...refMenu.bind}>
      <span className="bot-thread-top">
        <span className="bot-thread-title">{thread.title}</span>
        <span className="bot-thread-state"><Icon size={12} aria-hidden />{label}</span>
      </span>
      <span className="bot-thread-meta">{meta.map((part, index) => <Fragment key={index}>{index > 0 && ' · '}{part}</Fragment>)}</span>
    </button>
    {thread.hidden && !isQualifiedId(thread.threadId) && <button type="button" className="bot-thread-show" data-nav aria-label={`Show ${thread.title} in sidebar`} title="Show in sidebar" disabled={showing}
      onClick={() => { setShowing(true); void setThreadHidden(thread.threadId, false).finally(() => setShowing(false)) }}>
      <Eye size={13} aria-hidden />
    </button>}
    {refMenu.menu}
  </li>
})

/** Moves focus among the list's rows and buttons with the arrow keys, Home and End. */
function moveFocus(event: ReactKeyboardEvent<HTMLElement>): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  // Rows folded away under Show more are skipped.
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-nav]')].filter((item) => !item.closest('[inert]'))
  if (!items.length) return
  event.preventDefault()
  const at = items.indexOf(document.activeElement as HTMLElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
    : event.key === 'ArrowDown' ? (at + 1) % items.length : (at <= 0 ? items.length - 1 : at - 1)
  items[next]!.focus()
}

const STICKER_ICONS: Record<BotStickerKind, { icon: typeof Pencil; label: string }> = {
  typing: { icon: Pencil, label: 'Typing' },
  browser: { icon: AppWindow, label: 'Using the browser' },
  web: { icon: Globe, label: 'Reading the web' },
  search: { icon: Search, label: 'Searching the web' },
  command: { icon: TerminalSquare, label: 'Running a command' },
  file: { icon: FileText, label: 'Working on files' },
  schedule: { icon: Clock, label: 'Setting a schedule' },
  memory: { icon: Brain, label: 'Remembering' },
  working: { icon: Activity, label: 'Working' },
  paused: { icon: Moon, label: 'Paused' }
}

/**
 * The small round sticker on the header's face: what the bot does now (a pen while it types, the lead work's live
 * activity, a pause when paused). None while it is free. It never moves.
 */
export function BotActivitySticker({ bot, typing, offline }: { bot: BotSummary; typing: boolean; offline: boolean }) {
  const presence = presenceOf(bot, { typing, offline })
  const chip = useBotsStore((s) => (presence.lead ? s.activity[presence.lead.id] : undefined))
  const kind = stickerOf(presence, chip)
  if (!kind) return null
  const { icon: Icon, label } = STICKER_ICONS[kind]
  return <span className="bot-sticker" data-kind={kind} role="img" aria-label={label} title={label}><Icon size={9} strokeWidth={2.4} aria-hidden /></span>
}

/**
 * Under the bot's name in the header: "typing…", "System check +1", "Managing 2 threads", "paused", "free". While it has
 * work, or has started threads, the line opens their list: work with Stop (queued pieces last), then the threads it
 * started that still go (working, then waiting on you), then under "Recent" those that finished in the last six hours,
 * and "See all" at the bottom: the sidebar's Threads tab, filtered to this bot. While something runs, Recent opens
 * folded: Show more unfolds it and Show less folds it again, and each opening of the list starts folded. A row opens
 * its thread. Arrow keys move along the list; Escape or a click away closes it.
 */
export function BotPresenceLine({ bot, typing, offline }: { bot: BotSummary; typing: boolean; offline: boolean }) {
  const presence = presenceOf(bot, { typing, offline })
  const work = bot.work ?? []
  const watchers = bot.watchers ?? []
  const [now, setNow] = useState(() => Date.now())
  const { going, ended } = launchedGroups(bot.threads ?? [], now)
  // Its threads not archived, listed in the sidebar by "See all".
  const allThreads = useAppStore((s) => botThreadCount(s.threads, bot.id))
  const listed = work.length + watchers.length + going.length + ended.length + allThreads
  const [open, setOpen] = useState(false)
  // Recent unfolded by Show more; every opening starts folded.
  const [more, setMore] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  // Opened from the keyboard, focus goes to the first row.
  const focusFirst = useRef(false)
  useEffect(() => { if (!listed) setOpen(false) }, [listed])
  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    if (focusFirst.current) list.current?.querySelector<HTMLElement>('[data-nav]')?.focus()
    focusFirst.current = false
    const away = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      if (root.current?.contains(document.activeElement)) trigger.current?.focus()
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', escape)
    return () => { window.clearInterval(timer); document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', escape) }
  }, [open])
  if (!listed) return <span className="bot-presence" data-kind={presence.kind} role="status">{presence.text}</span>
  // Running work first, then what waits, each in the order it came.
  const ordered = [...work.filter((item) => item.status !== 'queued'), ...work.filter((item) => item.status === 'queued')]
  const close = () => setOpen(false)
  // With nothing running, Recent is all there is, so it shows unfolded and has no Show more.
  const folds = ordered.length + watchers.length + going.length > 0 && ended.length > 0
  const recentShown = !folds || more
  return <div className="bot-presence-root" ref={root}>
    <button type="button" ref={trigger} className="bot-presence is-button" data-kind={presence.kind} aria-expanded={open} aria-haspopup="dialog"
      onClick={(event) => { focusFirst.current = event.detail === 0; setMore(false); setOpen((was) => !was) }}
      onKeyDown={(event) => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); focusFirst.current = true; setMore(false); setOpen(true) } }}>
      <span role="status">{presence.text}</span><ChevronDown size={12} aria-hidden />
    </button>
    {open && <div className="bot-work" ref={list} role="dialog" aria-label={`What ${bot.name} is running`} onKeyDown={moveFocus}>
      {ordered.length > 0 && <ul className="bot-work-list" aria-label="Work">{ordered.map((item) => <WorkLine key={item.id} botId={bot.id} item={item} />)}</ul>}
      {watchers.length > 0 && <>
        <p className="bot-work-heading">Background work</p>
        <ul className="bot-work-list" aria-label="Background work">{watchers.map((item) => <WatcherLine key={item.id} botId={bot.id} item={item} now={now} />)}</ul>
      </>}
      {going.length > 0 && <ul className="bot-work-list" aria-label="Threads it started">{going.map((thread) => <BotThreadLine key={thread.threadId} botId={bot.id} thread={thread} now={now} onOpen={close} />)}</ul>}
      {ended.length > 0 && <div className="bot-work-fold" id={`bot-recent-${bot.id}`} data-open={recentShown || undefined} inert={!recentShown}><div>
        <p className="bot-work-heading bot-thread-recent">Recent<span className="bot-thread-count">{ended.length}</span></p>
        <ul className="bot-work-list" aria-label="Recent">{ended.map((thread) => <BotThreadLine key={thread.threadId} botId={bot.id} thread={thread} now={now} onOpen={close} />)}</ul>
      </div></div>}
      {(folds || allThreads > 0) && <div className="bot-work-foot">
        {folds && <button type="button" className="bot-work-more" data-nav aria-expanded={more} aria-controls={`bot-recent-${bot.id}`}
          onClick={() => setMore((was) => !was)}>
          {more ? 'Show less' : <>Show more<span className="bot-thread-count">{ended.length}</span></>}
        </button>}
        {allThreads > 0 && <button type="button" className="bot-thread-all" data-nav
          onClick={() => { close(); void showBotThreads(bot.id) }}>
          See all {allThreads === 1 ? '1 thread' : `${allThreads} threads`}<ArrowRight size={13} aria-hidden />
        </button>}
      </div>}
    </div>}
  </div>
}
