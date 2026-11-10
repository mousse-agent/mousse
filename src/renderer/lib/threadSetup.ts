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

/** The line a send shows when its thread's settings could not be applied on `computer`; nothing was sent. */
export function setupRefusalLine(code: string, computer: string): string {
  return code === 'computer_outdated'
    ? `Update Mousse on ${computer} to send from here.`
    : `Not sent: couldn't apply your settings on ${computer}.`
}
