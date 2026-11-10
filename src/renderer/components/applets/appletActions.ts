import type { AppletReference } from '../../../shared/applets'
import { useAppStore } from '../../stores/appStore'
import { readAppletAppearance } from './appearance'

/** Applies `change` to the thread's composer draft, only while that thread and profile are still the open ones. */
function appendToDraft(profileId: string | null, threadId: string, text: string): boolean {
  const state = useAppStore.getState()
  if (state.profileId !== profileId || state.activeThreadId !== threadId) return false
  const draft = state.composerDrafts[threadId] ?? ''
  state.setComposerDraft(threadId, draft ? `${draft}\n\n${text}` : text)
  return true
}

export function addAppletInputToDraft(profileId: string | null, threadId: string, reference: AppletReference, input: string): boolean {
  return appendToDraft(profileId, threadId, `From applet "${reference.title}":\n${input}`)
}

export function requestAppletRepair(profileId: string | null, threadId: string, reference: AppletReference, error: string | null): void {
  appendToDraft(
    profileId,
    threadId,
    `Please fix applet "${reference.title}" (appletId: ${reference.appletId}, expectedRevision: ${reference.revisionId}). Runtime diagnostic: ${(error ?? 'The applet needs repair.').slice(0, 2000)}`
  )
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
