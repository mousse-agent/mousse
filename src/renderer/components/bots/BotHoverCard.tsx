import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { BotSummary } from '../../../shared/bots/personal/chat'
import { botActiveThreads, botCardStatus } from './botChatShape'
import { BotThreadLine } from './BotPresence'

/** How long the pointer rests on a bot's row before its card opens, and how long the card stays once it leaves. */
const OPEN_DELAY_MS = 350
const CLOSE_DELAY_MS = 180

/**
 * A bot's row in the sidebar with its hover card: resting on the row opens a card to its right, top edges aligned, with
 * the bot's name, its status in words and the threads it works on now (`botActiveThreads`, the same threads the line
 * under its name counts). A thread opens in the bot's chat pane. The card opens only while the bot works on threads, and
 * stays while the pointer moves onto it.
 */
export function BotHoverCard({ bot, children }: { bot: BotSummary; children: ReactNode }) {
  const threads = botActiveThreads(bot)
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const anchor = useRef<HTMLDivElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const clear = () => window.clearTimeout(timer.current)
  const close = useCallback(() => { window.clearTimeout(timer.current); setAt(null) }, [])
  const open = () => {
    const row = anchor.current
    if (!row || !threads.length) return
    const rect = row.getBoundingClientRect()
    // Just past the sidebar's edge, so the card covers the pane beside it and never the list.
    const edge = row.closest('[data-mousse="sidebar"]')?.getBoundingClientRect().right ?? rect.right
    setNow(Date.now())
    setAt({ top: rect.top, left: edge + 8 })
  }
  const enter = () => { clear(); if (!at) timer.current = window.setTimeout(open, OPEN_DELAY_MS) }
  const leave = () => { clear(); timer.current = window.setTimeout(() => setAt(null), CLOSE_DELAY_MS) }
  // Nothing left to list, a scroll of the list or Escape closes it.
  useEffect(() => { if (!threads.length) close() }, [threads.length, close])
  useEffect(() => {
    if (!at) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    // Only a scroll that moves the row (the sidebar's list), not one in the pane beside it.
    const scroll = (event: Event) => { if (event.target instanceof Node && anchor.current && event.target.contains(anchor.current)) close() }
    document.addEventListener('keydown', escape)
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('blur', close)
    return () => { document.removeEventListener('keydown', escape); window.removeEventListener('scroll', scroll, true); window.removeEventListener('blur', close) }
  }, [at, close])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return <div ref={anchor} className="bot-hover-anchor" onPointerEnter={enter} onPointerLeave={leave} onClickCapture={(event) => { if (anchor.current?.contains(event.target as Node)) close() }}>
    {children}
    {at && threads.length > 0 && createPortal(
      <div className="bot-work bot-hover-card" role="dialog" aria-label={`What ${bot.name} is working on`} style={{ top: at.top, left: at.left }}
        onPointerEnter={clear} onPointerLeave={leave}>
        <div className="bot-hover-head">
          <span className="bot-hover-name">{bot.name}</span>
          <span className="bot-hover-status">{botCardStatus(bot)}</span>
        </div>
        <ul className="bot-work-list" aria-label="Threads it works on">
          {threads.map((thread) => <BotThreadLine key={thread.threadId} botId={bot.id} thread={thread} now={now} onOpen={close} />)}
        </ul>
      </div>,
      document.body
    )}
  </div>
}
