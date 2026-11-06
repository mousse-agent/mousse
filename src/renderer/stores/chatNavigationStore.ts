import { useEffect } from 'react'
import { create } from 'zustand'

/**
 * Requests other parts of the app make of the open thread's transcript: show a message, or show the
 * thread's waiting request. A request waits until the transcript that has the message (or the thread
 * with the request) is open, then the transcript takes it; one nobody takes in time is dropped, so a
 * stale request never moves the view later.
 */

/** How long a request waits for its message or thread to open. */
export const CHAT_NAVIGATION_TIMEOUT_MS = 10_000

export interface MessageRequest {
  messageId: string
  /** Tells two requests for the same message apart. */
  seq: number
  at: number
}

export interface PendingRequestFocus {
  threadId: string
  seq: number
  at: number
}

interface ChatNavigationState {
  message: MessageRequest | null
  pendingRequest: PendingRequestFocus | null
  /**
   * Scrolls the transcript to the message and briefly highlights it. The message may be in a thread
   * that is still opening: select the thread first, then call this.
   */
  scrollToMessage(messageId: string): void
  /** Shows the thread's waiting request (a permission request in the transcript) once the thread is open. */
  focusPendingRequest(threadId: string): void
  /** The transcript took the message request `seq` (or gave up on it). */
  settleMessage(seq: number): void
  /** The chat took the focus request `seq` (or gave up on it). */
  settlePendingRequest(seq: number): void
}

let seq = 0

export const useChatNavigationStore = create<ChatNavigationState>((set, get) => ({
  message: null,
  pendingRequest: null,
  scrollToMessage(messageId) {
    set({ message: { messageId, seq: ++seq, at: Date.now() } })
  },
  focusPendingRequest(threadId) {
    set({ pendingRequest: { threadId, seq: ++seq, at: Date.now() } })
  },
  settleMessage(done) {
    if (get().message?.seq === done) set({ message: null })
  },
  settlePendingRequest(done) {
    if (get().pendingRequest?.seq === done) set({ pendingRequest: null })
  }
}))

/** Whether a request made at `at` has waited too long to act on. */
export function isStale(request: { at: number }, now = Date.now()): boolean {
  return now - request.at > CHAT_NAVIGATION_TIMEOUT_MS
}

/** See `ChatNavigationState.scrollToMessage`. */
export function scrollToMessage(messageId: string): void {
  useChatNavigationStore.getState().scrollToMessage(messageId)
}

/** See `ChatNavigationState.focusPendingRequest`. */
export function focusPendingRequest(threadId: string): void {
  useChatNavigationStore.getState().focusPendingRequest(threadId)
}

/**
 * Takes a `focusPendingRequest` for `threadId` once that thread is open and its waiting request has
 * a row in the transcript (`rowId`), and scrolls to the row. Called by the open thread's chat.
 */
export function usePendingRequestFocus(threadId: string | null | undefined, rowId: string | null): void {
  const request = useChatNavigationStore((state) => state.pendingRequest)
  useEffect(() => {
    if (!request) return
    const { settlePendingRequest } = useChatNavigationStore.getState()
    if (isStale(request)) {
      settlePendingRequest(request.seq)
      return
    }
    if (request.threadId !== threadId || !rowId) return
    settlePendingRequest(request.seq)
    scrollToMessage(rowId)
  }, [request, threadId, rowId])
}
