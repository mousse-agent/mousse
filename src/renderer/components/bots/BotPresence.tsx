import { Fragment, memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { Activity, AppWindow, Brain, ChevronDown, Clock, FileText, Globe, Moon, Pencil, Search, TerminalSquare, X } from '../../lib/icons'
import type { BotChip, BotSummary, BotWorkItem } from '../../../shared/bots/personal/chat'
import { useBotsStore } from '../../stores/botsStore'
import { presenceOf, stickerOf, type BotStickerKind } from './botChatShape'

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
  if (item.status === 'paused') return 'held'
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
    <button type="button" aria-label={`Stop ${item.title}`} title="Stop" onClick={() => void useBotsStore.getState().stopWork(botId, item.id)}><X size={13} aria-hidden /></button>
  </li>
})

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
 * Under the bot's name in the header: "typing…", "System check +1", "paused", "free". While work runs or waits the line
 * opens the list of that work (title, time, Stop; queued pieces last), which closes on a click away or Escape.
 */
export function BotPresenceLine({ bot, typing, offline }: { bot: BotSummary; typing: boolean; offline: boolean }) {
  const presence = presenceOf(bot, { typing, offline })
  const work = bot.work ?? []
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { if (!work.length) setOpen(false) }, [work.length])
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', escape) }
  }, [open])
  if (!work.length) return <span className="bot-presence" data-kind={presence.kind} role="status">{presence.text}</span>
  // Running work first, then what waits, each in the order it came.
  const ordered = [...work.filter((item) => item.status !== 'queued'), ...work.filter((item) => item.status === 'queued')]
  return <div className="bot-presence-root" ref={root}>
    <button type="button" className="bot-presence is-button" data-kind={presence.kind} aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((was) => !was)}>
      <span role="status">{presence.text}</span><ChevronDown size={12} aria-hidden />
    </button>
    {open && <ul className="bot-work" aria-label={`${bot.name}'s work`}>{ordered.map((item) => <WorkLine key={item.id} botId={bot.id} item={item} />)}</ul>}
  </div>
}
