import { create } from 'zustand'
import type { ChatMessage, Thread } from '../../shared/types'
import { isDefaultThreadName } from '../../shared/threadTitle'
import { reconcileMessageSnapshot, sortMessagesDeterministic, upsertMessage, useAppStore } from './appStore'

/**
 * Side chats (`Thread.lineage.relationship: 'side'`) shown in a thread's Side chats panel: which one each thread has
 * open, and the transcripts of the ones shown. The app store's transcript is the open thread's; a side chat is never
 * the open thread, so its messages are kept here, from the same message events.
 */
interface SideChatsState {
  /** The side chat each thread's panel shows, by parent thread; none: the list. */
  openByParent: Readonly<Record<string, string>>
  /** Transcripts of the side chats shown since the profile opened, by side chat. */
  transcripts: Readonly<Record<string, readonly ChatMessage[]>>
  /** Shows `sideChatId` in `parentThreadId`'s panel, or the list with null. */
  open: (parentThreadId: string, sideChatId: string | null) => void
}

export const useSideChatsStore = create<SideChatsState>((set) => ({
  openByParent: {},
  transcripts: {},
  open: (parentThreadId, sideChatId) => set((state) => {
    const openByParent = { ...state.openByParent }
    if (sideChatId) openByParent[parentThreadId] = sideChatId
    else delete openByParent[parentThreadId]
    return { openByParent }
  })
}))

function writeTranscript(threadId: string, change: (current: readonly ChatMessage[]) => readonly ChatMessage[]): void {
  useSideChatsStore.setState((state) => {
    const current = state.transcripts[threadId]
    if (!current) return state
    const next = change(current)
    return next === current ? state : { transcripts: { ...state.transcripts, [threadId]: next } }
  })
}

/** Reads `threadId`'s transcript and follows it from now on. */
export async function loadSideChat(threadId: string): Promise<void> {
  const profileId = useAppStore.getState().profileId
  useSideChatsStore.setState((state) => (state.transcripts[threadId] ? state : { transcripts: { ...state.transcripts, [threadId]: [] } }))
  const messages = await window.mousse.orchestrator.getMessages(threadId)
  if (useAppStore.getState().profileId !== profileId) return
  writeTranscript(threadId, (current) => reconcileMessageSnapshot([...current], messages ?? []))
}

/** Shows `content` in `threadId`'s transcript until the service's copy of it arrives. */
export function showSentPrompt(threadId: string, content: string): string {
  const id = `optimistic:${crypto.randomUUID()}`
  writeTranscript(threadId, (current) => upsertMessage([...current], { id, role: 'user', content, timestamp: new Date().toISOString() }))
  return id
}

/** Takes back a prompt `showSentPrompt` showed, for a send that did not go ahead. */
export function dropSentPrompt(threadId: string, id: string): void {
  writeTranscript(threadId, (current) => (current.some((message) => message.id === id) ? current.filter((message) => message.id !== id) : current))
}

function landMessage(threadId: string, message: ChatMessage): void {
  writeTranscript(threadId, (current) => {
    // The service's copy of a prompt sent here takes the place of the one shown since the click.
    const shown = message.role === 'user' ? current.findIndex((entry) => entry.id.startsWith('optimistic:') && entry.content === message.content) : -1
    const held = shown === -1 ? [...current] : current.filter((_, index) => index !== shown)
    return upsertMessage(held, message)
  })
}

let watchers = 0
let stopWatching: (() => void) | null = null

/**
 * Follows the message events of the side chats in `transcripts` while a panel shows one. Streamed updates land once
 * per frame. Returns the stop.
 */
export function watchSideChats(): () => void {
  watchers += 1
  if (watchers === 1) {
    const pending = new Map<string, Map<string, ChatMessage>>()
    let frame: number | null = null
    const flush = () => {
      frame = null
      const updates = [...pending]
      pending.clear()
      for (const [threadId, messages] of updates) {
        writeTranscript(threadId, (current) => {
          let next = [...current]
          for (const message of messages.values()) next = upsertMessage(next, message)
          return next
        })
      }
    }
    const followed = (threadId: string) => Boolean(useSideChatsStore.getState().transcripts[threadId])
    const offs = [
      window.mousse.orchestrator.onThreadMessage(({ threadId, message }) => {
        if (!followed(threadId)) return
        flush()
        landMessage(threadId, message)
      }),
      window.mousse.orchestrator.onThreadMessageUpdated(({ threadId, message }) => {
        if (!followed(threadId)) return
        const held = pending.get(threadId) ?? new Map<string, ChatMessage>()
        held.set(message.id, message)
        pending.set(threadId, held)
        frame ??= requestAnimationFrame(flush)
      }),
      window.mousse.orchestrator.onThreadMessages((snapshot) => {
        if (!followed(snapshot.threadId)) return
        flush()
        writeTranscript(snapshot.threadId, (current) => (snapshot.replace
          ? sortMessagesDeterministic([...snapshot.messages])
          : reconcileMessageSnapshot([...current], snapshot.messages)))
      }),
      // Another profile's side chats are not this one's.
      useAppStore.subscribe((state, previous) => {
        if (state.profileId !== previous.profileId) useSideChatsStore.setState({ openByParent: {}, transcripts: {} })
      })
    ]
    stopWatching = () => {
      if (frame !== null) cancelAnimationFrame(frame)
      for (const off of offs) off()
    }
  }
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    watchers -= 1
    if (watchers === 0) {
      stopWatching?.()
      stopWatching = null
      // Not followed from here on: a panel shown again reads them afresh.
      useSideChatsStore.setState({ transcripts: {} })
    }
  }
}

/**
 * The side chat's own conversation: what it carries from its parent (the inherited copies and the fork's marker) is the
 * parent's, already on screen beside it.
 */
export function sideChatMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => !message.inherited && !(message.kind === 'context_handoff' && message.contextHandoff?.transfer === 'fork'))
}

/** A side chat's name in its row and its tab: its title, or "New side chat" until it has one. */
export function sideChatTitle(thread: Pick<Thread, 'name'> | undefined): string {
  return thread && !isDefaultThreadName(thread.name) ? thread.name : 'New side chat'
}

/** The side chat `parentThreadId`'s panel shows, while it is still one of its side chats. */
export function useOpenSideChat(parentThreadId: string | null): Thread | undefined {
  const openId = useSideChatsStore((state) => (parentThreadId ? state.openByParent[parentThreadId] : undefined))
  return useAppStore((state) => {
    if (!openId || !parentThreadId) return undefined
    const thread = state.threads.find((entry) => entry.id === openId)
    return thread && !thread.settledAt && thread.lineage?.parentThreadId === parentThreadId ? thread : undefined
  })
}
