import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Plus, Smile } from '../../lib/icons'
import { EmojiGrid, moveFocus, useDismiss } from './BotEmoji'

/**
 * The owner's reaction on a bot's message, as in a messenger: hovering (or focusing) the bubble shows one "Add reaction"
 * button; it opens a small popup with six quick emoji and "+" for the composer's grid. The reaction shows as a badge on
 * the bubble's corner. One per message: another replaces it, and the same one again (or the badge) removes it. It
 * never starts a turn (`bots.chat.react`).
 */

/** The six quick reactions. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const

/** What picking `emoji` sets: it, or nothing when it is the reaction already there. */
export const toggled = (current: string | undefined, emoji: string): string | null => (current === emoji ? null : emoji)

/** "Add reaction" beside a bot's bubble, on hover or focus; it opens the quick reactions, and their "+" every emoji. */
export function BotReactionBar({ current, onReact, onPicked, onFocus }: {
  current?: string
  onReact(emoji: string | null): void
  /** After a pick: the message hides the bar and takes the focus back, so nothing holds the bar open. */
  onPicked?(): void
  /** The focus came into the bar (Tab): it shows again. */
  onFocus?(): void
}) {
  // Closed, the six quick reactions, or every emoji.
  const [open, setOpen] = useState<false | 'quick' | 'all'>(false)
  const root = useRef<HTMLDivElement>(null)
  const add = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => setOpen(false), [])
  const refocus = useCallback(() => add.current?.focus(), [])
  useDismiss(open !== false, close, root, refocus)
  // Opened (or widened to every emoji): it moves left as far as needed to stay inside the transcript, and the focus goes
  // to the reaction there now, else the first, so arrows and Enter work.
  useLayoutEffect(() => {
    const menu = open ? root.current?.querySelector<HTMLElement>('[role="menu"]') : null
    if (!menu) return
    const lane = menu.closest('.chat-transcript')
    if (lane?.clientWidth) {
      const box = menu.getBoundingClientRect()
      const left = lane.getBoundingClientRect().left
      const over = box.right - (left + lane.clientWidth - 8)
      if (over > 0) menu.style.translate = `${-Math.ceil(Math.min(over, Math.max(0, box.left - left - 8)))}px 0`
    }
    ;(menu.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? menu.querySelector<HTMLButtonElement>('button'))?.focus()
  }, [open])
  const pick = (emoji: string) => {
    setOpen(false)
    onReact(toggled(current, emoji))
    onPicked?.()
  }
  return <div className={`bot-react-bar${open ? ' is-open' : ''}`} ref={root} role="toolbar" aria-label="React to this message" onFocus={onFocus}>
    <button ref={add} type="button" className="bot-react-add" aria-label="Add reaction" title="Add reaction" aria-haspopup="menu" aria-expanded={open !== false}
      onClick={() => setOpen((was) => (was ? false : 'quick'))}>
      <Smile size={14} aria-hidden />
    </button>
    {open === 'quick' && <div className="bot-emoji-grid bot-react-grid bot-react-quick-grid" role="menu" aria-label="Reactions" onKeyDown={(event) => moveFocus(event, QUICK_REACTIONS.length + 1)}>
      {QUICK_REACTIONS.map((emoji) => <button key={emoji} type="button" role="menuitemradio" aria-checked={current === emoji}
        aria-label={current === emoji ? `Remove your reaction ${emoji}` : `React ${emoji}`} title={current === emoji ? 'Remove your reaction' : undefined} onClick={() => pick(emoji)}>{emoji}</button>)}
      <button type="button" role="menuitem" className="bot-react-more" aria-label="More reactions" title="More reactions" onClick={() => setOpen('all')}>
        <Plus size={14} aria-hidden />
      </button>
    </div>}
    {open === 'all' && <EmojiGrid label="Reactions" chosen={current} onPick={pick} className="bot-react-grid" />}
  </div>
}

/** The owner's reaction on the bubble's corner; pressing it removes it. */
export function BotReactionBadge({ emoji, onRemove }: { emoji: string; onRemove(): void }) {
  return <button type="button" className="bot-reaction is-mine" aria-label={`Your reaction ${emoji}. Remove it`} title="Remove your reaction" onClick={onRemove}>{emoji}</button>
}
