import type { AttachedFile } from '../components/ChatComposer'
import { withDraftAppended, type RecoveredQueueDraft } from '../hooks/useThreadQueue'
import { useAppStore } from '../stores/appStore'
import type { ChatImageAttachment } from '../../shared/types'
import { imagePayloadToFile } from '../utils/imageAttachments'
import { composerPartsFromMarkers } from '../utils/messageAttachments'

type ImageBytes = { name: string; mimeType: string; data: string }

export interface QueuedImageFetch {
  /** One image of the queued message, while it is still in the queue. */
  fromQueue: (threadId: string, queueItemId: string, index: number) => Promise<ImageBytes>
  /** One image of a message in the transcript (the queued message once it started). */
  fromMessage: (threadId: string, messageId: string, index: number) => Promise<ImageBytes>
  /** The id of the transcript message the queued message became, when the thread is shown and it is there. */
  startedMessageId: (threadId: string, queueItemId: string) => string | undefined
}

const defaultFetch: QueuedImageFetch = {
  fromQueue: (threadId, queueItemId, index) => window.mousse.threads.queueImage(threadId, queueItemId, index),
  fromMessage: (threadId, messageId, index) => window.mousse.threads.messageImage(threadId, messageId, index),
  startedMessageId: (threadId, queueItemId) => {
    const state = useAppStore.getState()
    if (state.activeThreadId !== threadId) return undefined
    return state.messages.find((message) => message.role === 'user' && message.queueItemId === queueItemId)?.id
  }
}

/** What the composer says when some of a queued message's images could not be given back. */
export function lostImagesLine(count: number): string {
  return `${count} ${count === 1 ? 'image' : 'images'} from the queued message couldn't be restored.`
}

/** An image's bytes: as it came, else from the queued message while it waits, else from the message it became. */
async function imageBytes(threadId: string, itemId: string | undefined, image: ChatImageAttachment, index: number, fetch: QueuedImageFetch): Promise<ImageBytes | null> {
  if (image.data) return image
  if (!itemId) return null
  try {
    return await fetch.fromQueue(threadId, itemId, index)
  } catch {
    const messageId = fetch.startedMessageId(threadId, itemId)
    if (!messageId) return null
    try {
      return await fetch.fromMessage(threadId, messageId, index)
    } catch {
      return null
    }
  }
}

/**
 * Puts an unsaved edit whose queued message started into the thread's composer, as the composer holds a message
 * it gives back: the edited text after what the composer has, the message's images as attached files (`addFiles`,
 * since the composer keeps files by thread in memory), its files with paths as attached files sent as those paths, its
 * browser elements and references as attachments, and the markers it cannot rebuild (file names without paths, voice
 * messages) as text after the edited text. An image a queue list sent by name only is fetched first; `onImagesLost`
 * gets how many could not be, so none is dropped without a word.
 */
export async function restoreQueuedDraft(
  threadId: string,
  recovered: RecoveredQueueDraft,
  addFiles: (threadId: string, files: AttachedFile[]) => void,
  onImagesLost: (count: number) => void = () => undefined,
  fetch: QueuedImageFetch = defaultFetch
): Promise<void> {
  const store = useAppStore.getState()
  const parts = composerPartsFromMarkers(recovered.markers)
  const text = [recovered.text, parts.text].filter(Boolean).join('\n\n')
  // An edit that cleared the text gives back only the attachments: the composer's text stays as it is.
  if (text) store.setComposerDraft(threadId, withDraftAppended(store.composerDrafts[threadId] ?? '', text))
  for (const reference of parts.references) store.addComposerReference(threadId, reference)
  for (const element of parts.browserElements) {
    store.addBrowserElementAttachment(threadId, { ...element, id: crypto.randomUUID(), text: element.text ?? '' })
  }
  const fetched = await Promise.all((recovered.images ?? []).map((image, index) => imageBytes(threadId, recovered.itemId, image, index, fetch)))
  const images = fetched.flatMap((image): AttachedFile[] => {
    if (!image) return []
    const file = imagePayloadToFile(image)
    return [{ id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file) }]
  })
  // The bytes are not kept with the message; the file is where its path says.
  const files = parts.files.map(({ name, path }): AttachedFile => ({ id: crypto.randomUUID(), file: new File([], name), path }))
  if (images.length || files.length) addFiles(threadId, [...images, ...files])
  const lost = fetched.length - images.length
  if (lost > 0) onImagesLost(lost)
}
