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

const defaultDeps: MessageImageDeps = {
  fetchImage: (threadId, messageId, index) => window.mousse.threads.messageImage(threadId, messageId, index),
  shown: () => {
    const state = useAppStore.getState()
    return { threadId: state.activeThreadId, messages: state.messages }
  },
  update: (message) => useAppStore.getState().updateMessage(message)
}

/**
 * Fetches the images of the shown thread's messages that have no bytes, a few at a time, and puts each
 * into its message. An image is asked for once; one that cannot be fetched stays a name.
 */
export async function hydrateMessageImages(threadId: string, deps: MessageImageDeps = defaultDeps): Promise<void> {
  const todo = missingImages(deps.shown().messages).filter((image) => !requested.has(`${threadId}:${image.messageId}:${image.index}`))
  for (const image of todo) requested.add(`${threadId}:${image.messageId}:${image.index}`)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < todo.length) {
      const image = todo[next++]
      try {
        const bytes = await deps.fetchImage(threadId, image.messageId, image.index)
        const shown = deps.shown()
        if (shown.threadId !== threadId) {
          // The person moved on before it came: it is asked for again when this thread is opened.
          requested.delete(`${threadId}:${image.messageId}:${image.index}`)
          continue
        }
        const message = shown.messages.find((entry) => entry.id === image.messageId)
        if (!message?.images?.[image.index]) continue
        const images = message.images.map((entry, index) => (index === image.index ? { ...entry, data: bytes.data } : entry))
        deps.update({ ...message, images })
      } catch {
        // The image stays as its name; the thread works without it.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker))
}

/** Forgets what was asked for. Tests start clean. */
export function resetMessageImageRequests(): void {
  requested.clear()
}

/**
 * Forgets what was asked for of one thread, so opening it again, or pressing Retry, asks again for the images
 * that could not be fetched (the other computer was offline). Images already fetched are kept by the transcript.
 */
export function forgetMessageImageRequests(threadId: string): void {
  for (const key of requested) if (key.startsWith(`${threadId}:`)) requested.delete(key)
}
