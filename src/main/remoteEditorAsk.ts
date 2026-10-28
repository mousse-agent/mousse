/**
 * Asking another computer to allow editor connections from this one. The call is the routed `editor.ask`: it
 * needs only the grant every routed call needs, changes nothing on that computer, and a person there answers it.
 */
import { isEditorAskReply } from '../shared/bridge/editorAsk'
import type { RemoteAskResult } from '../shared/remoteEditor'
import { connectionFailureOf, nodeOfThread, type Ask } from './remoteEditorFlow'

/**
 * Asks the computer that runs `threadId`. A refusal the person can act on (offline, blocked, too old) comes back
 * as a result, so a blocked computer is told it is blocked and never offered a second try; anything else is thrown.
 */
export async function askForEditorAccess(ask: Ask, threadId: unknown): Promise<RemoteAskResult> {
  const node = nodeOfThread(threadId)
  if (!node) throw new Error('This thread is on this computer. Only another computer can be asked.')
  try {
    const reply = await ask('editor.ask', { node })
    if (!isEditorAskReply(reply)) throw new Error('The other computer answered in a way this version does not know.')
    return { ok: true, reply }
  } catch (error) {
    const failure = connectionFailureOf(error)
    if (failure) return { ok: false, failure, message: error instanceof Error ? error.message : undefined }
    throw error
  }
}
