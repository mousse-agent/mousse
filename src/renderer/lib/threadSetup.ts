import type { PermissionMode } from '../../shared/permissionMode'
import type { ModelOverride } from '../../shared/providerInstances'

/**
 * What a new chat's thread still has to be given after it was made, in the same send: the model and permission mode
 * the composer showed. A thread made on this computer is made with them; one made on another computer gets them in
 * conditional calls after (`threads.applySettings`). Nothing of it is kept: a refusal sends nothing, and the composer
 * shows what the thread really has.
 */
export interface ThreadSetup {
  model?: ModelOverride
  permissionMode?: PermissionMode
}

export function needsSetup(setup: ThreadSetup): boolean {
  return Boolean(setup.model || setup.permissionMode)
}

/** The code of a refusal as the window gets it (a serialized app error or an `Error` with `code`). */
export function errorCodeOf(error: unknown): string | undefined {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : undefined
}

/**
 * The line for a bound send the daemon refused, or undefined for any other refusal: the thread's settings changed since
 * they were shown, the computer that runs it is too old to bind a send, or (`bound`: the send carried `expect`) the
 * thread was busy, where a bound send never waits.
 */
export function boundSendRefusal(error: unknown, bound = false): string | undefined {
  const code = errorCodeOf(error)
  if (code === 'thread_settings_changed') return 'Not sent: settings changed. Check and send again.'
  if (code === 'thread_busy' && bound) return 'Not sent: this chat is busy. Send again when it is free.'
  if (code === 'computer_outdated') {
    const details = (error as { details?: { name?: unknown } }).details
    return typeof details?.name === 'string' ? setupRefusalLine(code, details.name) : 'Update Mousse on that computer to send from here.'
  }
  return undefined
}

/** The line a send shows when its thread's settings could not be applied on `computer`; nothing was sent. */
export function setupRefusalLine(code: string, computer: string): string {
  return code === 'computer_outdated'
    ? `Update Mousse on ${computer} to send from here.`
    : `Not sent: couldn't apply your settings on ${computer}.`
}
