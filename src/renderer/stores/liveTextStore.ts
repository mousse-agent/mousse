import { useCallback, useMemo, useSyncExternalStore } from 'react'
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
 *
 * A thought being written streams the same way: text added to it goes here, and only its row (and
 * the header of the group it ends) reads it. A thought is live while the transcript holds it as
 * processing, and while nothing follows it: the moment a message lands after it, its live text is
 * written to the transcript (`handOverLiveThoughts`), so what reads the transcript's thoughts (a
 * group's title) sees all of it.
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

/** `subscribeVersion`, telling its listener at most once every `everyMs`: at the first change, then once at the end of the interval. */
function subscribeVersionEvery(everyMs: number): (listener: () => void) => () => void {
  if (everyMs <= 0) return subscribeVersion
  return (listener) => {
    let lastAt = -Infinity
    let timer: ReturnType<typeof setTimeout> | null = null
    const tell = () => {
      timer = null
      lastAt = Date.now()
      listener()
    }
    const unsubscribe = subscribeVersion(() => {
      if (timer !== null) return
      const wait = lastAt + everyMs - Date.now()
      if (wait <= 0) tell()
      else timer = setTimeout(tell, wait)
    })
    return () => {
      unsubscribe()
      if (timer !== null) clearTimeout(timer)
    }
  }
}

const noSubscription = (): (() => void) => () => {}
const readVersion = (): number => version
const readNoVersion = (): number => 0

/**
 * A number that changes whenever any reply's live text does, while `active`; 0 otherwise. Only an
 * active reader subscribes, so a streamed delta renders nothing that does not ask for it. With
 * `everyMs`, the reader renders for it at most once per interval, however many deltas arrive.
 */
export function useLiveTextVersion(active: boolean, everyMs = 0): number {
  const subscribe = useMemo(() => subscribeVersionEvery(everyMs), [everyMs])
  return useSyncExternalStore(
    active ? subscribe : noSubscription,
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

/** The live text of `id`, rendering only when it changes; nothing while `id` is undefined. */
function useEntry(id: string | undefined): LiveText | undefined {
  const subscribe = useCallback((listener: () => void) => {
    if (id === undefined) return () => {}
    let set = listeners.get(id)
    if (!set) listeners.set(id, (set = new Set()))
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) listeners.delete(id)
    }
  }, [id])
  const read = () => (id === undefined ? undefined : entries.get(id))
  return useSyncExternalStore(subscribe, read, read)
}

/** The text to show for the reply `id`, whose transcript text is `shown`. Renders only when that reply's live text changes. */
export function useLiveText(id: string, shown: string): string {
  return pickText(useEntry(id), shown)
}

/**
 * A thought row's text as the transcript holds it (`thought`), and where it can be live: from `from`
 * on, it is the transcript text of the thought `id`. A row joins back-to-back thoughts, so only its
 * newest one can still be written.
 */
export interface LiveThoughtSource {
  id: string
  thought: string
  from: number
}

/** The text to show for a thought row: its newest thought's live text over the transcript's. Renders only when that changes. */
export function useLiveThought(source: LiveThoughtSource | undefined): string {
  const entry = useEntry(source?.id)
  if (!source) return ''
  const own = source.thought.slice(source.from)
  if (!own) return source.thought
  return source.thought.slice(0, source.from) + pickText(entry, own)
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

/**
 * True when `next` only adds text to the thought `held`, which already has text: both are still being
 * written and nothing else about it changed. Its start, its end and anything else go to the transcript.
 */
export function isLiveThoughtUpdate(held: ChatMessage, next: ChatMessage): boolean {
  if (held.id !== next.id || held.kind !== 'thinking' || next.kind !== 'thinking') return false
  if (held.thinking?.status !== 'processing' || next.thinking?.status !== 'processing') return false
  if (held.thinking.content === next.thinking.content || !held.thinking.content.trim()) return false
  const { thinking: _held, ...heldRest } = held
  const { thinking: _next, ...nextRest } = next
  return sameData(heldRest, nextRest)
}

/** Whether the transcript holds `message` as still being written: a reply streaming in, or a thought in progress. */
function isStillWritten(message: ChatMessage | undefined): boolean {
  return message?.streaming === true || (message?.kind === 'thinking' && message.thinking?.status === 'processing')
}

function findFromEnd(messages: readonly ChatMessage[], id: string): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) if (messages[index]!.id === id) return messages[index]
  return undefined
}

/**
 * Applies one frame of streamed updates: text added to a reply on screen, or to the thought that
 * ends the transcript, goes to its live text; the rest goes to `write` (the main store) in one call.
 * A message whose update went to the store has its live text dropped right after, so its final text
 * takes over once, in the same render.
 */
export function applyStreamedUpdates(
  updates: readonly ChatMessage[],
  held: readonly ChatMessage[],
  write: (messages: ChatMessage[]) => void
): void {
  const toStore: ChatMessage[] = []
  const handedOver: string[] = []
  // Set once a message the transcript does not hold yet lands in this frame: nothing ends it any more.
  let landed = false
  for (const update of updates) {
    const current = findFromEnd(held, update.id)
    if (current && isLiveTextUpdate(current, update)) {
      setLiveText(update.id, { text: assistantDisplayText(update.content), over: assistantDisplayText(current.content) })
      continue
    }
    if (!landed && current && current === held[held.length - 1] && isLiveThoughtUpdate(current, update)) {
      setLiveText(update.id, { text: update.thinking!.content, over: current.thinking!.content })
      continue
    }
    if (!current && !landed) {
      // A message lands after the thought through this channel: the thought's live text goes first, in the same write.
      landed = true
      collectLiveThoughts(held, toStore, handedOver)
    }
    toStore.push(update)
    if (entries.has(update.id) && !handedOver.includes(update.id)) handedOver.push(update.id)
  }
  if (toStore.length > 0) write(toStore)
  for (const id of handedOver) clearLiveText(id)
}

/** Adds to `toStore` every live thought of `messages` with its live text, and its id to `handedOver`, skipping ones already there. */
function collectLiveThoughts(messages: readonly ChatMessage[], toStore: ChatMessage[], handedOver: string[]): void {
  for (const [id, entry] of entries) {
    if (handedOver.includes(id)) continue
    const message = findFromEnd(messages, id)
    if (message?.kind !== 'thinking' || !message.thinking) continue
    handedOver.push(id)
    const text = pickText(entry, message.thinking.content)
    if (text !== message.thinking.content) toStore.push({ ...message, thinking: { ...message.thinking, content: text } })
  }
}

/**
 * Writes the live text of every thought in `messages` to `write` (the main store), in one call, and
 * drops it: a message is about to land after the thought, and what reads the transcript's thoughts
 * then (a group's title, the row once it is done) must see all of it.
 */
export function handOverLiveThoughts(messages: readonly ChatMessage[], write: (messages: ChatMessage[]) => void): void {
  const toStore: ChatMessage[] = []
  const handedOver: string[] = []
  collectLiveThoughts(messages, toStore, handedOver)
  if (toStore.length > 0) write(toStore)
  for (const id of handedOver) clearLiveText(id)
}

/**
 * A new message of the selected thread lands (`onThreadMessage`): the streamed updates held for the
 * frame are applied first (`flush`), then the live text of a thought it follows is handed to the
 * transcript, then the message is added. A user message replaces its optimistic copy.
 */
export function landMessage(message: ChatMessage, flush: () => void): void {
  flush()
  const store = useAppStore.getState()
  handOverLiveThoughts(store.messages, store.updateMessages)
  const state = useAppStore.getState()
  if (message.role === 'user') {
    const isCopy = (m: ChatMessage) => m.id.startsWith('optimistic:') && m.content === message.content
    if (state.messages.some(isCopy)) {
      state.setMessages([...state.messages.filter((m) => !isCopy(m)), message])
      return
    }
  }
  state.addMessage(message)
}

/**
 * Drops the live text of every reply or thought the transcript `messages` no longer holds as being
 * written: it ended (by any path), or it is not there (another thread or profile is shown).
 */
export function dropSettledLiveText(messages: readonly ChatMessage[]): void {
  for (const id of [...entries.keys()]) {
    if (!isStillWritten(findFromEnd(messages, id))) clearLiveText(id)
  }
}

// Runs inside each store write, before React renders it: the transcript and the live text change together.
useAppStore.subscribe((state, previous) => {
  if (state.profileId !== previous.profileId) clearAllLiveText()
  else if (state.messages !== previous.messages && entries.size > 0) dropSettledLiveText(state.messages)
})
