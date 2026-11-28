import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { X } from '../../lib/icons'
import type { BotSummary } from '../../../shared/bots/personal/chat'
import type { BotLook } from '../../../shared/bots/personal/look'
import { useBotsStore, type BotConfirmCommand } from '../../stores/botsStore'
import { runConfirmed } from './runBotCommand'
import { useChatsStore } from '../../stores/chatsStore'
import { BotLookPicker } from './face/BotLookPicker'
import { BOT_FULL_TRUST_PERMISSION } from '../../../shared/bots/personal/manifest'
import { botSetupBlock } from './botSetup'

/**
 * A small dialog in the Chats style (`chat-dialog`): focus inside, Escape and the backdrop close it.
 * With `keepOnBackdrop` (something was put in) a click beside it does nothing; Close and Escape still close.
 */
export function BotDialogFrame({ title, onClose, busy = false, keepOnBackdrop = false, width, children }: { title: string; onClose(): void; busy?: boolean; keepOnBackdrop?: boolean; width?: number; children: ReactNode }) {
  const titleId = useId()
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null
    const first = dialog.current?.querySelector<HTMLElement>('input, textarea') ?? dialog.current?.querySelector<HTMLElement>('button')
    first?.focus()
    return () => prior?.focus()
  }, [])
  return <div className="chat-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy && !keepOnBackdrop) onClose() }}>
    <div ref={dialog} className="chat-dialog bot-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} style={width ? { width: `min(${width}px, calc(100vw - 40px))` } : undefined} onKeyDown={(event) => {
      // Escape for an open menu (its button, or the menu itself in a portal) closes the menu, not the dialog.
      const target = event.target as HTMLElement
      const menu = !dialog.current?.contains(target) || Boolean(target.closest?.('[aria-expanded="true"]'))
      if (event.key === 'Escape' && !busy && !menu) onClose()
      if (event.key === 'Tab') {
        const items = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea')
        if (!items?.length) return
        const first = items[0]!, last = items[items.length - 1]!
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }}>
      <div className="chat-dialog-heading"><h2 id={titleId}>{title}</h2><button type="button" aria-label="Close" disabled={busy} onClick={onClose}><X size={16} /></button></div>
      {children}
    </div>
  </div>
}

const close = () => useBotsStore.setState({ dialog: null, error: null })

function RenameDialog({ bot }: { bot: BotSummary }) {
  const [name, setName] = useState(bot.name)
  const busy = useBotsStore((s) => s.busy)
  const error = useBotsStore((s) => s.error)
  const trimmed = name.trim()
  return <BotDialogFrame title="Rename" onClose={close} busy={busy}>
    <form onSubmit={(event) => {
      event.preventDefault()
      if (!trimmed || trimmed === bot.name) { close(); return }
      void useBotsStore.getState().update(bot.id, { name: trimmed }).then((ok) => { if (ok) close() })
    }}>
      <label className="bot-new-label" htmlFor="bot-rename">Name</label>
      <input id="bot-rename" className="bot-new-name" maxLength={60} value={name} onChange={(event) => setName(event.target.value)} />
      {error && <p role="alert" className="chat-error">{error}</p>}
      <div className="bot-new-foot"><button type="submit" className="chat-primary-button" disabled={busy || !trimmed}>Save</button></div>
    </form>
  </BotDialogFrame>
}

function LookDialog({ bot, others }: { bot: BotSummary; others: BotLook[] }) {
  const [look, setLook] = useState<BotLook>(bot.look)
  const busy = useBotsStore((s) => s.busy)
  const error = useBotsStore((s) => s.error)
  return <BotDialogFrame title="Change look" onClose={close} busy={busy} width={560}>
    <BotLookPicker look={look} onChange={setLook} existingLooks={others} />
    {error && <p role="alert" className="chat-error">{error}</p>}
    <div className="bot-new-foot">
      <button type="button" className="chat-primary-button" disabled={busy} onClick={() => {
        void useBotsStore.getState().update(bot.id, { look }).then((ok) => { if (ok) close() })
      }}>Save</button>
    </div>
  </BotDialogFrame>
}

/** The confirm before Delete: the chat and memory are kept 30 days, then erased. */
function DeleteDialog({ bot }: { bot: BotSummary }) {
  const busy = useBotsStore((s) => s.busy)
  const error = useBotsStore((s) => s.error)
  return <BotDialogFrame title={`Delete ${bot.name}?`} onClose={close} busy={busy}>
    <p className="bot-dialog-text">It stops at once and leaves your bots. Its chat and memory are kept for 30 days, then erased.</p>
    {error && <p role="alert" className="chat-error">{error}</p>}
    <div className="bot-new-foot">
      <button type="button" className="bot-ghost-button" disabled={busy} onClick={close}>Cancel</button>
      <button type="button" className="chat-primary-button bot-danger-button" disabled={busy} onClick={() => {
        void useBotsStore.getState().remove(bot.id).then((ok) => {
          if (ok && useChatsStore.getState().activeBotId === bot.id) useChatsStore.setState({ activeBotId: null })
        })
      }}>Delete bot</button>
    </div>
  </BotDialogFrame>
}

/** What each confirming `/` command asks, and its button. */
const COMMAND_CONFIRMS: Record<BotConfirmCommand, { title: (name: string) => string; text: string; action: string }> = {
  forget: { title: (name) => `Wipe ${name}'s memory?`, text: 'Every saved memory entry and what automations do without asking are forgotten.', action: 'Wipe memory' },
  'forget-history': { title: () => 'Wipe chat history?', text: 'The chat, run notes and what automations do without asking go; saved memory stays.', action: 'Wipe history' },
  reset: { title: (name) => `Reset ${name}?`, text: 'Chat, memory, schedules and reminders go. Name, look, permissions and models stay.', action: 'Reset' }
}

/** The confirm before `/forget`, `/forget history` or `/reset` runs. */
function CommandConfirmDialog({ bot, command }: { bot: BotSummary; command: BotConfirmCommand }) {
  const copy = COMMAND_CONFIRMS[command]
  return <BotDialogFrame title={copy.title(bot.name)} onClose={close}>
    <p className="bot-dialog-text">{copy.text}</p>
    <div className="bot-new-foot">
      <button type="button" className="bot-ghost-button" onClick={close}>Cancel</button>
      <button type="button" className="chat-primary-button bot-danger-button" onClick={() => { void runConfirmed(bot.id, command) }}>{copy.action}</button>
    </div>
  </BotDialogFrame>
}

/**
 * The approval before "Allow everything" turns on: what it grants and what still holds, then Allow. Turning it off needs
 * no approval (About's switch narrows at once).
 */
function FullTrustDialog({ bot }: { bot: BotSummary }) {
  const busy = useBotsStore((s) => s.busy)
  const error = useBotsStore((s) => s.error)
  return <BotDialogFrame title={`Allow ${bot.name} everything?`} onClose={close} busy={busy}>
    <p className="bot-dialog-text">It can use every tool without asking. Your switches, Settings and Labs still apply.</p>
    {error && <p role="alert" className="chat-error">{error}</p>}
    <div className="bot-new-foot">
      <button type="button" className="bot-ghost-button" disabled={busy} onClick={close}>Cancel</button>
      <button type="button" className="chat-primary-button" disabled={busy} onClick={() => {
        void useBotsStore.getState().setPermission(bot.id, BOT_FULL_TRUST_PERMISSION, true).then(() => { if (!useBotsStore.getState().error) close() })
      }}>Allow everything</button>
    </div>
  </BotDialogFrame>
}

/** Whichever of Rename, Change look, the Delete confirm, a command's confirm or Allow everything is open. */
export function BotDialogs() {
  const dialog = useBotsStore((s) => s.dialog)
  const bots = useBotsStore((s) => s.bots)
  const bot = dialog && bots.find((entry) => entry.id === dialog.botId)
  // Its computer went offline, or lowered this one to Use: the dialog closes rather than change what it no longer can.
  const blocked = Boolean(bot && botSetupBlock(bot))
  useEffect(() => {
    if (blocked) close()
  }, [blocked])
  if (!dialog || !bot || blocked) return null
  if (dialog.kind === 'confirm') return <CommandConfirmDialog key={`${bot.id}:${dialog.command}`} bot={bot} command={dialog.command} />
  if (dialog.kind === 'rename') return <RenameDialog key={bot.id} bot={bot} />
  if (dialog.kind === 'fullTrust') return <FullTrustDialog key={bot.id} bot={bot} />
  if (dialog.kind === 'look') return <LookDialog key={bot.id} bot={bot} others={bots.filter((entry) => entry.id !== bot.id).map((entry) => entry.look)} />
  return <DeleteDialog key={bot.id} bot={bot} />
}
