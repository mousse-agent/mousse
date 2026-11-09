import type { AttachedFile } from '../components/ChatComposer'
import { withDraftAppended, type RecoveredQueueDraft } from '../hooks/useThreadQueue'
import { useAppStore } from '../stores/appStore'
import { imagePayloadToFile } from '../utils/imageAttachments'
import { composerPartsFromMarkers } from '../utils/messageAttachments'

/**
 * Puts an unsaved edit whose queued message started into the thread's composer, as the composer holds a message
 * it gives back: the edited text after what the composer has, the message's images as attached files (`addFiles`,
 * since the composer keeps files by thread in memory), its browser elements and references as attachments, and the
 * markers it cannot rebuild (attached file names, voice messages) as text after the edited text.
 */
export function restoreQueuedDraft(
  threadId: string,
  recovered: RecoveredQueueDraft,
  addFiles: (threadId: string, files: AttachedFile[]) => void
): void {
  const store = useAppStore.getState()
  const parts = composerPartsFromMarkers(recovered.markers)
  const text = [recovered.text, parts.text].filter(Boolean).join('\n\n')
  // An edit that cleared the text gives back only the attachments: the composer's text stays as it is.
  if (text) store.setComposerDraft(threadId, withDraftAppended(store.composerDrafts[threadId] ?? '', text))
  for (const reference of parts.references) store.addComposerReference(threadId, reference)
  for (const element of parts.browserElements) {
    store.addBrowserElementAttachment(threadId, { ...element, id: crypto.randomUUID(), text: element.text ?? '' })
  }
  const files = (recovered.images ?? []).map((image): AttachedFile => {
    const file = imagePayloadToFile(image)
    return { id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file) }
  })
  if (files.length) addFiles(threadId, files)
}
