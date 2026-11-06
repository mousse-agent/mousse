import { createAndSelectProjectThread, selectThread } from '../lib/threadActions'
import { scrollToMessage } from '../stores/chatNavigationStore'
import { useAppStore, type PaletteMode } from '../stores/appStore'
import type { PaletteItem } from './paletteItems'
import { runCommand } from './commandRegistry'

interface FocusTarget {
  focus(): void
}

/** The element that had focus when the palette opened; it gets focus back when the palette closes. */
let opener: FocusTarget | null = null

/**
 * Closes the palette, puts focus back on the opener, and only then runs `then` (the chosen command or
 * thread). Focus is restored first and synchronously so a command that moves focus itself, such as
 * Focus composer, keeps it; nothing restores focus later. Escape passes no `then`.
 */
export function closePalette({
  opener: target,
  then,
  setOpen = (open) => useAppStore.getState().setPaletteOpen(open)
}: {
  opener: FocusTarget | null
  then?: () => void
  setOpen?: (open: boolean) => void
}): void {
  setOpen(false)
  target?.focus()
  then?.()
}

/** Opens the palette; `messages` (Search threads) puts message hits first. */
export function openPalette(mode: PaletteMode = 'all'): void {
  opener = typeof document === 'undefined' ? null : (document.activeElement as FocusTarget | null)
  useAppStore.getState().setPaletteOpen(true, mode)
}

/** Closes the palette from any route (Escape, the close button, a click outside, the shortcut). */
export function dismissPalette(then?: () => void): void {
  const target = opener
  opener = null
  closePalette({ opener: target, then })
}

export function togglePalette(): void {
  if (useAppStore.getState().paletteOpen) dismissPalette()
  else openPalette()
}

/** Opens the thread, then scrolls its transcript to the message and highlights it. */
export async function openMessage(threadId: string, messageId: string): Promise<void> {
  await selectThread(threadId)
  // A navigation guard can keep the current thread open; its transcript has no such message.
  if (useAppStore.getState().activeThreadId === threadId) scrollToMessage(messageId)
}

/**
 * Closes the palette, then runs the command or opens the thread, message or project the row stands
 * for. A "+N more" row is not chosen; the palette expands it in place.
 */
export function chooseCommandPaletteItem(item: PaletteItem): void {
  if (item.kind === 'more') return
  dismissPalette(() => {
    if (item.kind === 'command') runCommand(item.id, 'palette')
    else if (item.kind === 'thread') void selectThread(item.id)
    else if (item.kind === 'message') void openMessage(item.threadId, item.id)
    else if (item.threadId) void selectThread(item.threadId)
    else void createAndSelectProjectThread(item.id)
  })
}
