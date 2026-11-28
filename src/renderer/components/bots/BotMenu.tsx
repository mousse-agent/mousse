import { useEffect, useRef, useState } from 'react'
import { Eye, EyeOff, Image, Info, Lock, MoreHorizontal, Pause, Pencil, Play, Search, Trash2 } from '../../lib/icons'
import type { BotSummary } from '../../../shared/bots/personal/chat'
import { useBotsStore } from '../../stores/botsStore'
import { setBotChecklistHidden, useBotChecklistHidden } from './botChecklistSetting'

/**
 * The bot's one menu (bot-ui §4.8): About this bot, Find in chat, Hide or Show checklist, Rename, Change look, Pause or Resume, Make private
 * (only this computer reaches it; About's Devices in one click), Delete bot.
 */
export function BotMenu({ bot, onFind }: { bot: BotSummary; onFind?: () => void }) {
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
  const checklistHidden = useBotChecklistHidden(bot.id)
  // Only a service that says which devices reach the bot can set it; one already private has nothing to wall off.
  const canWall = bot.reach !== undefined && bot.reach !== 'this_computer'
  // A bot of another computer is set up there: its menu here finds in its chat and hides its checklist, nothing more.
  const setup = !bot.lives
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
      {setup && <button type="button" role="menuitem" onClick={pick(() => useBotsStore.setState({ aboutOpen: true }))}><Info size={14} aria-hidden />About this bot</button>}
      {onFind && <button type="button" role="menuitem" onClick={pick(onFind)}><Search size={14} aria-hidden />Find in chat</button>}
      <button type="button" role="menuitem" onClick={pick(() => setBotChecklistHidden(bot.id, !checklistHidden))}>{checklistHidden ? <Eye size={14} aria-hidden /> : <EyeOff size={14} aria-hidden />}{checklistHidden ? 'Show checklist' : 'Hide checklist'}</button>
      {setup && <>
        <button type="button" role="menuitem" onClick={pick(() => useBotsStore.setState({ dialog: { kind: 'rename', botId: bot.id }, error: null }))}><Pencil size={14} aria-hidden />Rename</button>
        <button type="button" role="menuitem" onClick={pick(() => useBotsStore.setState({ dialog: { kind: 'look', botId: bot.id }, error: null }))}><Image size={14} aria-hidden />Change look</button>
        <button type="button" role="menuitem" onClick={pick(() => void (paused ? store().resume(bot.id) : store().pause(bot.id)))}>{paused ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}{paused ? 'Resume' : 'Pause'}</button>
        {canWall && <button type="button" role="menuitem" title="Only this computer reaches it. Change it in About." onClick={pick(() => void store().makePrivate(bot.id))}><Lock size={14} aria-hidden />Make private</button>}
        <hr />
        <button type="button" role="menuitem" className="is-danger" onClick={pick(() => useBotsStore.setState({ dialog: { kind: 'delete', botId: bot.id }, error: null }))}><Trash2 size={14} aria-hidden />Delete bot</button>
      </>}
    </div>}
  </div>
}
