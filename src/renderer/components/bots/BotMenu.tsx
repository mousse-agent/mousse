import { useEffect, useRef, useState } from 'react'
import { Image, Info, MoreHorizontal, Pause, Pencil, Play, Trash2 } from '../../lib/icons'
import type { BotSummary } from '../../../shared/bots/personal/chat'
import { useBotsStore } from '../../stores/botsStore'

/** The bot's one menu (bot-ui §4.8): About this bot, Rename, Change look, Pause or Resume, Delete bot. */
export function BotMenu({ bot }: { bot: BotSummary }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])
  useEffect(() => { if (open) root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus() }, [open])
  const pick = (action: () => void) => () => { setOpen(false); action() }
  const store = useBotsStore.getState
  const paused = bot.state === 'paused'
  return <div className="bot-menu-root" ref={root} onKeyDown={(event) => {
    if (event.key === 'Escape') { setOpen(false); root.current?.querySelector<HTMLElement>('.bot-header-more')?.focus() }
    if (!open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
    event.preventDefault()
    const items = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const index = items.indexOf(document.activeElement as HTMLElement)
    items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
  }}>
    <button type="button" className={`bot-header-more${open ? ' is-open' : ''}`} aria-label="Bot menu" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><MoreHorizontal size={16} /></button>
    {open && <div className="bot-menu" role="menu" aria-label={`${bot.name} menu`}>
      <button type="button" role="menuitem" onClick={pick(() => useBotsStore.setState({ aboutOpen: true }))}><Info size={14} aria-hidden />About this bot</button>
      <button type="button" role="menuitem" onClick={pick(() => useBotsStore.setState({ dialog: { kind: 'rename', botId: bot.id }, error: null }))}><Pencil size={14} aria-hidden />Rename</button>
      <button type="button" role="menuitem" onClick={pick(() => useBotsStore.setState({ dialog: { kind: 'look', botId: bot.id }, error: null }))}><Image size={14} aria-hidden />Change look</button>
      <button type="button" role="menuitem" onClick={pick(() => void (paused ? store().resume(bot.id) : store().pause(bot.id)))}>{paused ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}{paused ? 'Resume' : 'Pause'}</button>
      <hr />
      <button type="button" role="menuitem" className="is-danger" onClick={pick(() => useBotsStore.setState({ dialog: { kind: 'delete', botId: bot.id }, error: null }))}><Trash2 size={14} aria-hidden />Delete bot</button>
    </div>}
  </div>
}
