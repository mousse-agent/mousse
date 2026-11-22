import { useSyncExternalStore } from 'react'

// The bots whose checklist is hidden from their chat header ("Hide checklist" in the bot's menus). A view choice of
// this computer, kept per bot in local storage; every bot shows its checklist until it is hidden.
const STORAGE_KEY = 'mousse-bot-checklist-hidden'

let hidden: ReadonlySet<string> = read()
const listeners = new Set<() => void>()

function read(): ReadonlySet<string> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    const ids: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Hides or shows a bot's checklist, and remembers it. */
export function setBotChecklistHidden(botId: string, next: boolean): void {
  if (hidden.has(botId) === next) return
  const ids = new Set(hidden)
  if (next) ids.add(botId)
  else ids.delete(botId)
  hidden = ids
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...ids])) } catch { /* kept for this session */ }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether the bot's checklist is hidden from its chat. */
export function useBotChecklistHidden(botId: string): boolean {
  return useSyncExternalStore(subscribe, () => hidden.has(botId), () => false)
}
