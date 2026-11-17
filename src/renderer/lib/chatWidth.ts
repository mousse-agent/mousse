import { useSyncExternalStore } from 'react'
import type { ChatWidth } from '../../shared/settings'

/** The transcript's text column per Chat width setting, in px. Full takes the whole pane. */
export const CHAT_TEXT_WIDTH: Readonly<Record<Exclude<ChatWidth, 'full'>, number>> = { normal: 736, wide: 1152 }

/** The message list's gutters on both sides of the text column (px-6 in message-list.tsx). */
const CHAT_COLUMN_GUTTERS = 48

/** The conversation column (text plus gutters) for a Chat width, in px; Infinity when it fills the pane. */
export function chatColumnWidth(width: ChatWidth): number {
  return width === 'full' ? Infinity : CHAT_TEXT_WIDTH[width] + CHAT_COLUMN_GUTTERS
}

let current: ChatWidth = 'normal'
const listeners = new Set<() => void>()

/**
 * Settings → Appearance → Chat width: `data-chat-width` on the root element, which app.css reads
 * to set the column (the composer shares it), and the value for code that lays out beside it.
 */
export function applyChatWidth(width: ChatWidth): void {
  document.documentElement.setAttribute('data-chat-width', width)
  if (width === current) return
  current = width
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function snapshot(): ChatWidth {
  return current
}

export function useChatWidth(): ChatWidth {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
