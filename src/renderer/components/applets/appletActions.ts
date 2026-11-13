import type { AppletReference } from '../../../shared/applets'
import { useAppStore } from '../../stores/appStore'
import { readAppletAppearance } from './appearance'

/**
 * Where an applet shows outside the open thread (a bot's chat): the thread it was published in, which the app reads it
 * from, and the composer its text goes to (false when it could not take it). A thread's applet needs none.
 */
export interface AppletConversation {
  threadId: string
  addToDraft(text: string): boolean
}

/** Applies `change` to the thread's composer draft, only while that thread and profile are still the open ones. */
function appendToDraft(profileId: string | null, threadId: string, text: string): boolean {
  const state = useAppStore.getState()
  if (state.profileId !== profileId || state.activeThreadId !== threadId) return false
  const draft = state.composerDrafts[threadId] ?? ''
  state.setComposerDraft(threadId, draft ? `${draft}\n\n${text}` : text)
  return true
}

/** What an applet asked to add to the conversation, as the composer gets it. */
export function appletInputText(reference: AppletReference, input: string): string {
  return `From applet "${reference.title}":\n${input}`
}

/** The request to fix an applet, as the composer gets it. */
export function appletRepairText(reference: AppletReference, error: string | null): string {
  return `Please fix applet "${reference.title}" (appletId: ${reference.appletId}, expectedRevision: ${reference.revisionId}). Runtime diagnostic: ${(error ?? 'The applet needs repair.').slice(0, 2000)}`
}

export function addAppletInputToDraft(profileId: string | null, threadId: string, reference: AppletReference, input: string, conversation?: AppletConversation): boolean {
  const text = appletInputText(reference, input)
  return conversation ? conversation.addToDraft(text) : appendToDraft(profileId, threadId, text)
}

export function requestAppletRepair(profileId: string | null, threadId: string, reference: AppletReference, error: string | null, conversation?: AppletConversation): void {
  const text = appletRepairText(reference, error)
  if (conversation) conversation.addToDraft(text)
  else appendToDraft(profileId, threadId, text)
}

export async function exportApplet(
  threadId: string,
  reference: AppletReference,
  format: 'html' | 'source' | 'png',
  runtimeId: string | null
): Promise<void> {
  await window.mousse.applets.export({
    threadId,
    appletId: reference.appletId,
    revisionId: reference.revisionId,
    format,
    appearance: readAppletAppearance(),
    runtimeId: runtimeId ?? undefined
  })
}
