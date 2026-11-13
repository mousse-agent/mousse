import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { Smile } from '../../lib/icons'

/** The emoji a bot's composer offers: the everyday ones of a messaging app, no search and no skin tones. */
export const BOT_EMOJI = [
  '😀', '😂', '🙂', '😉', '😍', '🥰', '😎', '🤔',
  '😅', '😬', '🙃', '😴', '😮', '😢', '😡', '🤯',
  '👍', '👎', '👌', '🙏', '👏', '🙌', '💪', '👋',
  '❤️', '🔥', '✅', '❌', '⭐', '🎉', '💡', '⚠️',
  '☕', '🍕', '🌧️', '☀️', '📌', '📎', '🗓️', '⏰'
] as const

/** The text with `emoji` put in at the caret (or over the selection), and where the caret goes after it. */
export function insertAt(text: string, emoji: string, start: number, end: number): { text: string; caret: number } {
  const from = Math.max(0, Math.min(start, text.length))
  const to = Math.max(from, Math.min(end, text.length))
  return { text: text.slice(0, from) + emoji + text.slice(to), caret: from + emoji.length }
}

/** Closes a popover on a press outside `root` or Escape (`onEscape` runs after, to put the focus back). */
export function useDismiss(open: boolean, close: () => void, root: RefObject<HTMLElement | null>, onEscape?: () => void): void {
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close() }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { close(); onEscape?.() } }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', escape) }
  }, [open, close, root, onEscape])
}

/** The grid of everyday emoji (`BOT_EMOJI`): the composer's, and a reaction's "+". `chosen` is marked as picked. */
export function EmojiGrid({ label, chosen, onPick, className }: { label: string; chosen?: string; onPick(emoji: string): void; className?: string }) {
  return <div className={`bot-emoji-grid${className ? ` ${className}` : ''}`} role="menu" aria-label={label}>
    {BOT_EMOJI.map((emoji) => <button key={emoji} type="button" role="menuitemradio" aria-checked={emoji === chosen} aria-label={emoji} onClick={() => onPick(emoji)}>{emoji}</button>)}
  </div>
}

/**
 * The composer's emoji button: a small grid above it; a pick goes in at the caret and the box keeps the focus.
 * `field` finds the composer's text box; `value` and `onChange` are its draft.
 */
export function BotEmojiButton({ field, value, onChange }: { field(): HTMLTextAreaElement | null; value: string; onChange(next: string): void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  // Where the caret was when the grid opened: a click in the grid moves the focus, not the caret.
  const caret = useRef<{ start: number; end: number }>({ start: value.length, end: value.length })
  const close = useCallback(() => setOpen(false), [])
  const refocus = useCallback(() => field()?.focus(), [field])
  useDismiss(open, close, root, refocus)
  const toggle = () => {
    const box = field()
    caret.current = box ? { start: box.selectionStart, end: box.selectionEnd } : { start: value.length, end: value.length }
    setOpen((was) => !was)
  }
  const pick = (emoji: string) => {
    const next = insertAt(value, emoji, caret.current.start, caret.current.end)
    onChange(next.text)
    caret.current = { start: next.caret, end: next.caret }
    setOpen(false)
    window.requestAnimationFrame(() => {
      const box = field()
      if (!box) return
      box.focus()
      box.setSelectionRange(next.caret, next.caret)
    })
  }
  return <div className="bot-emoji" ref={root}>
    <button type="button" className="composer-icon-btn bot-emoji-button" title="Emoji" aria-label="Emoji" aria-expanded={open} aria-haspopup="true"
      onMouseDown={(event) => event.preventDefault()} onClick={toggle}>
      <Smile size={16} strokeWidth={2} />
    </button>
    {open && <EmojiGrid label="Emoji" onPick={pick} />}
  </div>
}
