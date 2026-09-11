/**
 * Shared constants for the private daemon → Electron-main attached-browser
 * command transport. Envelope parsing and the framed router live in
 * `src/mms/protocol`. This file is the narrow import surface for later root
 * composition (GuiMmsController requestedCapabilities, backend dispatch).
 *
 * Capability grant is not cryptographic proof of an Electron GUI: any local
 * owner-token holder can declare `clientType=gui`. See the transport handoff.
 */

import type { BrowserWorkerRequest } from './types'

export const BROWSER_ATTACHED_V1_CAPABILITY = 'browser-attached-v1' as const
export const BROWSER_ATTACHED_DISPATCH_METHOD = 'browser.attached.dispatch' as const

/** Worker methods whose remote effect may already have reached the page. */
export const BROWSER_ATTACHED_MUTATION_METHODS = [
  'session.open',
  'session.close',
  'tabs.new',
  'tabs.close',
  'tabs.switch',
  'act',
  'human.act',
  'control.take',
  'control.release'
] as const satisfies readonly BrowserWorkerRequest['method'][]

const MUTATION_SET: ReadonlySet<string> = new Set(BROWSER_ATTACHED_MUTATION_METHODS)

export function isBrowserAttachedMutationMethod(
  method: BrowserWorkerRequest['method']
): boolean {
  return MUTATION_SET.has(method)
}
