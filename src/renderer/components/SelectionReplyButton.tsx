import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, Reply, Stop, VolumeHigh } from '../lib/icons'
import { COMPOSER_QUOTE_EVENT, type ComposerQuoteDetail } from '../lib/composerQuotes'
import { useReadAloudStore } from '../readAloud/readAloudStore'

/** Marks a conversation whose selected text can be replied to from its composer. */
export const QUOTE_SOURCE_ATTRIBUTE = 'data-quote-source'

interface Spot {
  /** Where the selection ends: the bar starts here, moved left as far as its width needs to stay in the window. */
  anchor: number
  top: number
  text: string
  /** The conversation's composer, for Reply; null where there is none (Read aloud only). */
  target: HTMLTextAreaElement | null
}

const GAP = 6
const BAR_HEIGHT = 30
const EDGE = 8
const BAR_CLASS = 'selection-actions'

/** The read-aloud key of a selected text: the same text keeps its key, so the bar shows Stop while it plays. */
export function selectionSpeechKey(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  return `selection-${(hash >>> 0).toString(36)}-${text.length}`
}

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
  const rects = range.getClientRects()
  const end = rects[rects.length - 1] ?? range.getBoundingClientRect()
  // A selection scrolled out of its conversation offers nothing.
  const view = source.getBoundingClientRect()
  if (end.bottom < view.top || end.top > view.bottom) return null
  const below = end.bottom + GAP + BAR_HEIGHT <= Math.min(view.bottom, window.innerHeight)
  return {
    anchor: end.right - EDGE,
    top: below ? end.bottom + GAP : Math.max(EDGE, end.top - GAP - BAR_HEIGHT),
    text,
    target
  }
}

/**
 * The bar beside text selected in a conversation: Read aloud, and Reply where the conversation has a composer (#364).
 * Reply puts the text in that composer as a Reply pill, at the caret; the agent gets it in double quotes, alone in its
 * paragraph. Read aloud keeps the selection, so the bar stays and shows Stop while it plays; clicking away closes the
 * bar and the reading goes on; Stop beside the thread in the sidebar ends it.
 */
export function SelectionReplyButton() {
  const [spot, setSpot] = useState<Spot | null>(null)
  const dragging = useRef(false)
  const bar = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const speechKey = spot ? selectionSpeechKey(spot.text) : undefined
  const status = useReadAloudStore((state) => (speechKey !== undefined && state.activeKey === speechKey ? state.status : 'idle'))
  const error = useReadAloudStore((state) => (speechKey !== undefined && state.error?.key === speechKey ? state.error.message : null))

  useEffect(() => {
    let frame = 0
    // Whether text was selected when last read. Reading the selection lays the page out, so a scroll or
    // a window resize reads it only while something is selected (every change of selection reads it).
    let selected = false
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const selection = window.getSelection()
        selected = !!selection && !selection.isCollapsed
        setSpot(dragging.current || !selected ? null : readSpot())
      })
    }
    const follow = () => {
      if (selected) update()
    }
    // The button waits until the mouse lets go, so it never jumps about while the selection is being made.
    const down = (event: PointerEvent) => {
      if ((event.target as Element | null)?.closest?.(`.${BAR_CLASS}`)) return
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
    window.addEventListener('scroll', follow, true)
    window.addEventListener('resize', follow)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', update)
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('pointerup', up, true)
      window.removeEventListener('scroll', follow, true)
      window.removeEventListener('resize', follow)
    }
  }, [])

  // Its width decides how far left it must sit to stay inside the window; it changes with Reply and Stop.
  useLayoutEffect(() => {
    if (bar.current) setWidth(bar.current.offsetWidth)
  }, [spot?.target, status])

  if (!spot) return null
  const target = spot.target
  const reply = target
    ? () => {
        const detail: ComposerQuoteDetail = { target, text: spot.text }
        window.dispatchEvent(new CustomEvent(COMPOSER_QUOTE_EVENT, { detail }))
        window.getSelection()?.removeAllRanges()
        setSpot(null)
      }
    : undefined
  const reading = status !== 'idle'
  const readLabel = reading ? 'Stop reading' : 'Read aloud'
  const left = Math.max(EDGE, Math.min(spot.anchor, window.innerWidth - width - EDGE))
  return createPortal(
    <div
      ref={bar}
      className={BAR_CLASS}
      role="toolbar"
      aria-label="Selected text actions"
      style={{ left, top: spot.top }}
      // Pressing a button must not clear the selection it acts on.
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className="selection-action"
        onClick={() => useReadAloudStore.getState().toggle(speechKey!, spot.text)}
        aria-label={readLabel}
        aria-busy={status === 'loading' || undefined}
        title={error ?? (status === 'loading' ? 'Preparing audio, click to stop' : undefined)}
        data-read-aloud={status}
      >
        {status === 'loading' ? (
          <Loader2 size={13} strokeWidth={2} className="animate-spin" aria-hidden />
        ) : reading ? (
          <Stop size={13} strokeWidth={2} aria-hidden />
        ) : (
          <VolumeHigh size={13} strokeWidth={2} aria-hidden />
        )}
        <span>{status === 'playing' || status === 'paused' ? 'Stop' : 'Read aloud'}</span>
      </button>
      {reply && (
        <>
          <span className="selection-actions-divider" aria-hidden />
          <button type="button" className="selection-action" onClick={reply} aria-label="Reply to the selected text">
            <Reply size={13} strokeWidth={2} aria-hidden />
            <span>Reply</span>
          </button>
        </>
      )}
    </div>,
    document.body
  )
}
