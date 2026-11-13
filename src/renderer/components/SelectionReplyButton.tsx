import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Reply } from '../lib/icons'
import { COMPOSER_QUOTE_EVENT, type ComposerQuoteDetail } from '../lib/composerQuotes'

/** Marks a conversation whose selected text can be replied to from its composer. */
export const QUOTE_SOURCE_ATTRIBUTE = 'data-quote-source'

interface Spot {
  left: number
  top: number
  text: string
  target: HTMLTextAreaElement
}

const GAP = 6
const BUTTON_HEIGHT = 30

function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement
}

/** The shown composer nearest to `source`: the one of the same conversation. */
function composerFor(source: Element): HTMLTextAreaElement | null {
  for (let node: Element | null = source.parentElement; node; node = node.parentElement) {
    const found = [...node.querySelectorAll<HTMLTextAreaElement>('textarea.composer-input')].find((input) => !input.disabled && !input.closest('[inert]'))
    if (found) return found
  }
  return null
}

function readSpot(): Spot | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const text = selection.toString().trim()
  if (!text) return null
  const range = selection.getRangeAt(0)
  const source = elementOf(range.startContainer)?.closest(`[${QUOTE_SOURCE_ATTRIBUTE}]`)
  if (!source || source !== elementOf(range.endContainer)?.closest(`[${QUOTE_SOURCE_ATTRIBUTE}]`)) return null
  if (elementOf(range.commonAncestorContainer)?.closest('textarea, input, [contenteditable="true"]')) return null
  if (source.closest('[inert]')) return null
  const target = composerFor(source)
  if (!target) return null
  const rects = range.getClientRects()
  const end = rects[rects.length - 1] ?? range.getBoundingClientRect()
  // A selection scrolled out of its conversation offers nothing.
  const view = source.getBoundingClientRect()
  if (end.bottom < view.top || end.top > view.bottom) return null
  const below = end.bottom + GAP + BUTTON_HEIGHT <= Math.min(view.bottom, window.innerHeight)
  return {
    left: Math.max(8, Math.min(end.right - 8, window.innerWidth - 96)),
    top: below ? end.bottom + GAP : Math.max(8, end.top - GAP - BUTTON_HEIGHT),
    text,
    target
  }
}

/**
 * The Reply button beside text selected in a conversation (#364). It puts the text in that conversation's composer
 * as a Reply pill, at the caret; the agent gets it in double quotes, alone in its paragraph.
 */
export function SelectionReplyButton() {
  const [spot, setSpot] = useState<Spot | null>(null)
  const dragging = useRef(false)

  useEffect(() => {
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setSpot(dragging.current ? null : readSpot()))
    }
    // The button waits until the mouse lets go, so it never jumps about while the selection is being made.
    const down = (event: PointerEvent) => {
      if ((event.target as Element | null)?.closest?.('.selection-reply-button')) return
      dragging.current = true
      setSpot(null)
    }
    const up = () => {
      dragging.current = false
      update()
    }
    document.addEventListener('selectionchange', update)
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('pointerup', up, true)
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', update)
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('pointerup', up, true)
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [])

  if (!spot) return null
  const reply = () => {
    const detail: ComposerQuoteDetail = { target: spot.target, text: spot.text }
    window.dispatchEvent(new CustomEvent(COMPOSER_QUOTE_EVENT, { detail }))
    window.getSelection()?.removeAllRanges()
    setSpot(null)
  }
  return createPortal(
    <button
      type="button"
      className="selection-reply-button"
      style={{ left: spot.left, top: spot.top }}
      // Pressing it must not clear the selection it quotes.
      onMouseDown={(event) => event.preventDefault()}
      onClick={reply}
      aria-label="Reply to the selected text"
    >
      <Reply size={13} strokeWidth={2} aria-hidden />
      <span>Reply</span>
    </button>,
    document.body
  )
}
