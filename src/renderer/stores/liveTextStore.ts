import { useCallback, useSyncExternalStore } from 'react'
import type { ChatMessage } from '../../shared/types'
import { assistantDisplayText } from '../chat/adapters/mousseToUI'
import { useAppStore } from './appStore'

/**
 * The text of replies still streaming in, kept apart from the transcript. A streamed update that
 * only adds text to a reply already on screen is written here, and only that reply's text component
 * reads it, so the transcript, its other turns and everything else that reads the thread's messages
 * stay as they are. Any other change (a new message, a tool's state, the reply's end) goes to the
 * main store as before, and the reply's final text replaces its live text there once.
 *
 * A live text exists only while the transcript holds its reply as still streaming: when the reply
 * arrives finished by any path (its last update, a snapshot after a restart, the thread opened
 * again after it ended elsewhere), leaves the transcript (another thread opened) or the profile
 * changes, its live text is dropped and the transcript's text is shown, the same text Copy, Find
 * and the model read.
 */
interface LiveText {
  /** The reply's text as it streams in, as the transcript shows it. */
  text: string
  /** The text the transcript holds for the reply: the live text is drawn over it. */
  over: string
}

const entries = new Map<string, LiveText>()
const listeners = new Map<string, Set<() => void>>()
/** Replies whose end never came here (their thread was left, a snapshot replaced them): the oldest go. */
const MAX_ENTRIES = 16
/** Changes whenever any live text does: what a reader of every reply (Find) follows. */
let version = 0
const versionListeners = new Set<() => void>()

function notify(id: string): void {
  version += 1
  for (const listener of listeners.get(id) ?? []) listener()
  for (const listener of versionListeners) listener()
}

/** Whether the reply `id` has a live text: its transcript text may not be what is shown. */
export function hasLiveText(id: string): boolean {
  return entries.has(id)
}

function subscribeVersion(listener: () => void): () => void {
  versionListeners.add(listener)
  return () => {
    versionListeners.delete(listener)
  }
}

const noSubscription = (): (() => void) => () => {}
const readVersion = (): number => version
const readNoVersion = (): number => 0

/**
 * A number that changes whenever any reply's live text does, while `active`; 0 otherwise. Only an
 * active reader subscribes, so a streamed delta renders nothing that does not ask for it.
 */
export function useLiveTextVersion(active: boolean): number {
  return useSyncExternalStore(
    active ? subscribeVersion : noSubscription,
    active ? readVersion : readNoVersion,
    active ? readVersion : readNoVersion
  )
}

function setLiveText(id: string, entry: LiveText): void {
  entries.delete(id)
  entries.set(id, entry)
  notify(id)
  for (const oldest of entries.keys()) {
    if (entries.size <= MAX_ENTRIES) break
    entries.delete(oldest)
    notify(oldest)
  }
}

function clearLiveText(id: string): void {
  if (entries.delete(id)) notify(id)
}

/** Drops every live text: the profile changed (see the store subscription below), and tests. */
export function clearAllLiveText(): void {
  const ids = [...entries.keys()]
  entries.clear()
  for (const id of ids) notify(id)
}

/** The live text of a reply whose transcript text is `shown`, or `shown` when it has none newer. */
export function liveTextOver(id: string, shown: string): string {
  return pickText(entries.get(id), shown)
}

function pickText(entry: LiveText | undefined, shown: string): string {
  if (!entry) return shown
  // The transcript text it was drawn over, or older text it extends: a snapshot of the reply, still
  // streaming, that lagged behind. A live text never outlives the stored reply's streaming (below).
  if (entry.over === shown || (entry.text.length > shown.length && entry.text.startsWith(shown))) return entry.text
  return shown
}

/** The text to show for the reply `id`, whose transcript text is `shown`. Renders only when that reply's live text changes. */
export function useLiveText(id: string, shown: string): string {
  const subscribe = useCallback((listener: () => void) => {
    let set = listeners.get(id)
    if (!set) listeners.set(id, (set = new Set()))
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) listeners.delete(id)
    }
  }, [id])
  const read = () => entries.get(id)
  const entry = useSyncExternalStore(subscribe, read, read)
  return pickText(entry, shown)
}

function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keysA = Object.keys(a)
  if (keysA.length !== Object.keys(b).length) return false
  return keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && sameData((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

/**
 * True when `next` only adds text to the reply `held`, which the transcript already shows as text:
 * both still stream, it is a plain reply, and nothing else about it changed. A reply that starts an
 * applet changes how it is drawn, so it goes to the transcript.
 */
export function isLiveTextUpdate(held: ChatMessage, next: ChatMessage): boolean {
  if (held.id !== next.id || held.role !== 'assistant' || next.role !== 'assistant') return false
  if (held.streaming !== true || next.streaming !== true || held.kind || next.kind) return false
  if (held.content === next.content || !assistantDisplayText(held.content).trim()) return false
  if (next.content.includes('mousse-applet')) return false
  const { content: _held, ...heldRest } = held
  const { content: _next, ...nextRest } = next
  return sameData(heldRest, nextRest)
}

function findFromEnd(messages: readonly ChatMessage[], id: string): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) if (messages[index]!.id === id) return messages[index]
  return undefined
}

/**
 * Applies one frame of streamed updates: text added to a reply on screen goes to its live text;
 * the rest goes to `write` (the main store) in one call. A reply whose update went to the store has
 * its live text dropped right after, so its final text takes over once, in the same render.
 */
export function applyStreamedUpdates(
  updates: readonly ChatMessage[],
  held: readonly ChatMessage[],
  write: (messages: ChatMessage[]) => void
): void {
  const toStore: ChatMessage[] = []
  const handedOver: string[] = []
  for (const update of updates) {
    const current = findFromEnd(held, update.id)
    if (current && isLiveTextUpdate(current, update)) {
      setLiveText(update.id, { text: assistantDisplayText(update.content), over: assistantDisplayText(current.content) })
      continue
    }
    toStore.push(update)
    if (entries.has(update.id)) handedOver.push(update.id)
  }
  if (toStore.length > 0) write(toStore)
  for (const id of handedOver) clearLiveText(id)
}

/**
 * Drops the live text of every reply the transcript `messages` no longer holds as streaming: it
 * ended (by any path), or it is not there (another thread or profile is shown).
 */
export function dropSettledLiveText(messages: readonly ChatMessage[]): void {
  for (const id of [...entries.keys()]) {
    if (findFromEnd(messages, id)?.streaming !== true) clearLiveText(id)
  }
}

// Runs inside each store write, before React renders it: the transcript and the live text change together.
useAppStore.subscribe((state, previous) => {
  if (state.profileId !== previous.profileId) clearAllLiveText()
  else if (state.messages !== previous.messages && entries.size > 0) dropSettledLiveText(state.messages)
})
