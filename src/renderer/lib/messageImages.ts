import type { ChatMessage } from '../../shared/types'
import { useAppStore } from '../stores/appStore'

/** Where an image is that a transcript sent without its bytes. */
export interface MissingImage {
  messageId: string
  index: number
}

const hasBytes = (image: { data?: unknown }): boolean => typeof image.data === 'string' && image.data.length > 0

/**
 * The images of `messages` that came without their bytes (a long thread of another computer sends its
 * older images by name and type only), newest first, at most `limit`.
 */
export function missingImages(messages: readonly Pick<ChatMessage, 'id' | 'images'>[], limit = 24): MissingImage[] {
  const found: MissingImage[] = []
  for (let at = messages.length - 1; at >= 0 && found.length < limit; at -= 1) {
    const message = messages[at]
    message.images?.forEach((image, index) => {
      if (!hasBytes(image) && found.length < limit) found.push({ messageId: message.id, index })
    })
  }
  return found
}

export interface MessageImageDeps {
  fetchImage: (threadId: string, messageId: string, index: number) => Promise<{ name: string; mimeType: string; data: string }>
  /** The shown thread's messages, and a way to replace one of them. */
  shown: () => { threadId: string | null; messages: readonly ChatMessage[] }
  update: (message: ChatMessage) => void
}

const requested = new Set<string>()
const CONCURRENCY = 3
/** An image that could not be fetched is asked for again after these waits (the other computer was busy or reconnecting). */
const RETRY_DELAYS_MS = [1000, 3000, 9000]
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const keyOf = (threadId: string, image: MissingImage) => `${threadId}:${image.messageId}:${image.index}`

const defaultDeps: MessageImageDeps = {
  fetchImage: (threadId, messageId, index) => window.mousse.threads.messageImage(threadId, messageId, index),
  shown: () => {
    const state = useAppStore.getState()
    return { threadId: state.activeThreadId, messages: state.messages }
  },
  update: (message) => useAppStore.getState().updateMessage(message)
}

/** Fetches one image into its message; false when it could not be fetched. */
async function fetchInto(threadId: string, image: MissingImage, deps: MessageImageDeps): Promise<boolean> {
  try {
    const bytes = await deps.fetchImage(threadId, image.messageId, image.index)
    const shown = deps.shown()
    if (shown.threadId !== threadId) {
      // The person moved on before it came: it is asked for again when this thread is opened.
      requested.delete(keyOf(threadId, image))
      return true
    }
    const message = shown.messages.find((entry) => entry.id === image.messageId)
    if (!message?.images?.[image.index]) return true
    const images = message.images.map((entry, index) => (index === image.index ? { ...entry, data: bytes.data } : entry))
    deps.update({ ...message, images })
    return true
  } catch {
    return false
  }
}

/** Asks again for an image that could not be fetched, a few times with growing waits, while its thread is shown. */
function retryLater(threadId: string, image: MissingImage, deps: MessageImageDeps, attempt = 0): void {
  const key = keyOf(threadId, image)
  if (attempt >= RETRY_DELAYS_MS.length || retryTimers.has(key)) return
  retryTimers.set(key, setTimeout(() => {
    retryTimers.delete(key)
    // Forgotten (Retry, or the thread opened again) means a newer request owns it.
    if (!requested.has(key)) return
    if (deps.shown().threadId !== threadId) {
      requested.delete(key)
      return
    }
    void fetchInto(threadId, image, deps).then((fetched) => { if (!fetched) retryLater(threadId, image, deps, attempt + 1) })
  }, RETRY_DELAYS_MS[attempt]))
}

/**
 * Fetches the images of the shown thread's messages that have no bytes, a few at a time, and puts each
 * into its message. One that cannot be fetched is asked for again a few times, then stays a name until
 * the thread is opened again or Retry is pressed.
 */
export async function hydrateMessageImages(threadId: string, deps: MessageImageDeps = defaultDeps): Promise<void> {
  const todo = missingImages(deps.shown().messages).filter((image) => !requested.has(keyOf(threadId, image)))
  for (const image of todo) requested.add(keyOf(threadId, image))
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < todo.length) {
      const image = todo[next++]
      if (!(await fetchInto(threadId, image, deps))) retryLater(threadId, image, deps)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker))
}

/** Forgets what was asked for. Tests start clean. */
export function resetMessageImageRequests(): void {
  requested.clear()
  for (const timer of retryTimers.values()) clearTimeout(timer)
  retryTimers.clear()
}

/**
 * Forgets what was asked for of one thread, so opening it again, or pressing Retry, asks again for the images
 * that could not be fetched (the other computer was offline). Images already fetched are kept by the transcript.
 */
export function forgetMessageImageRequests(threadId: string): void {
  for (const key of requested) if (key.startsWith(`${threadId}:`)) requested.delete(key)
  for (const [key, timer] of retryTimers) {
    if (!key.startsWith(`${threadId}:`)) continue
    clearTimeout(timer)
    retryTimers.delete(key)
  }
}
