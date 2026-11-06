import { parseChatReference, type ChatReference } from '../../shared/chatReferences'
import { useAppStore } from '../stores/appStore'

/** A path from the Files tree or a Files tab, made absolute against the files root it was listed under. */
export function absoluteFilesPath(path: string, filesRoot: string): string {
  if (/^(?:[a-zA-Z]:[\\/]|\/)/.test(path)) return path
  return `${filesRoot.replace(/[\\/]$/, '')}/${path.replace(/^[\\/]/, '')}`
}

/** The chat reference a Files entry carries, by drag or by "Add to chat": scoped to its thread and project. */
export function filesEntryReference(entry: {
  path: string
  name: string
  kind: 'file' | 'folder'
  filesRoot: string
  threadId: string | null
  projectId?: string | null
}): Omit<ChatReference, 'id'> {
  return {
    kind: entry.kind,
    title: entry.name,
    path: absoluteFilesPath(entry.path, entry.filesRoot),
    threadId: entry.threadId ?? undefined,
    projectId: entry.projectId ?? undefined
  }
}

/**
 * Adds a reference to the active composer, as dropping it there does. Returns false when the reference is
 * incomplete; the store drops such a reference without saying so.
 */
export function addReferenceToChat(reference: Omit<ChatReference, 'id'>): boolean {
  const parsed = parseChatReference({ ...reference, id: `${reference.kind}:${crypto.randomUUID()}` })
  if (!parsed) return false
  const store = useAppStore.getState()
  store.addComposerReference(store.activeThreadId, parsed)
  return Boolean(useAppStore.getState().composerReferences[store.activeThreadId ?? '__blank__']?.some((item) => item.id === parsed.id))
}
