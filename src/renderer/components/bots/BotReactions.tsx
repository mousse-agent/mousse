import { useCallback, useRef, useState } from 'react'
import { Plus } from '../../lib/icons'
import { EmojiGrid, useDismiss } from './BotEmoji'

/**
 * The owner's reaction on a bot's message, as in a messenger: hovering (or focusing) the bubble shows six quick emoji
 * and "+" for the composer's grid; the reaction shows as a badge on the bubble's corner. One per message: another
 * replaces it, and the same one again (or the badge) removes it. It never starts a turn (`bots.chat.react`).
 */

/** The six quick reactions. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const

/** What picking `emoji` sets: it, or nothing when it is the reaction already there. */
export const toggled = (current: string | undefined, emoji: string): string | null => (current === emoji ? null : emoji)

/** The quick reactions beside a bot's bubble, on hover or focus, with "+" for every emoji. */
export function BotReactionBar({ current, onReact }: { current?: string; onReact(emoji: string | null): void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const more = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => setOpen(false), [])
  const refocus = useCallback(() => more.current?.focus(), [])
  useDismiss(open, close, root, refocus)
  const pick = (emoji: string) => { setOpen(false); onReact(toggled(current, emoji)) }
  return <div className={`bot-react-bar${open ? ' is-open' : ''}`} ref={root} role="toolbar" aria-label="React to this message">
    {QUICK_REACTIONS.map((emoji) => <button key={emoji} type="button" className="bot-react-quick" aria-pressed={current === emoji}
      aria-label={current === emoji ? `Remove your reaction ${emoji}` : `React ${emoji}`} title={current === emoji ? 'Remove your reaction' : undefined} onClick={() => pick(emoji)}>{emoji}</button>)}
    <button ref={more} type="button" className="bot-react-more" aria-label="More reactions" title="More reactions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
      <Plus size={14} aria-hidden />
    </button>
    {open && <EmojiGrid label="Reactions" chosen={current} onPick={pick} className="bot-react-grid" />}
  </div>
}

/** The owner's reaction on the bubble's corner; pressing it removes it. */
export function BotReactionBadge({ emoji, onRemove }: { emoji: string; onRemove(): void }) {
  return <button type="button" className="bot-reaction is-mine" aria-label={`Your reaction ${emoji}. Remove it`} title="Remove your reaction" onClick={onRemove}>{emoji}</button>
}
