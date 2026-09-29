import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import type { ControlStatus, PairingGrant, RemoteScope } from '../shared/controlTypes'

export interface PairingApprovalDeps {
  controlStatus(): Promise<ControlStatus>
  pairingApprove(
    pairingId: string,
    scopes?: RemoteScope[]
  ): Promise<{ grant: PairingGrant; receipt: string; receiptSignature: string }>
  showMessageBox(window: BrowserWindow | null, options: MessageBoxOptions): Promise<MessageBoxReturnValue>
  window: BrowserWindow | null
}

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  'mousse:read': 'Read projects, threads, and settings',
  'mousse:chat': 'Send messages and run agent turns',
  'mousse:write': 'Create and modify projects, threads, and files',
  'mousse:terminal': 'Open and use terminals on this computer',
  'mousse:settings': 'Change Mousse settings'
}

export function describeScope(scope: string): string {
  return SCOPE_DESCRIPTIONS[scope] ?? `Unrecognized permission (${scope})`
}

/**
 * Confirms a device pairing natively in the main process before the daemon
 * approves it. Scopes must be a subset of what the device actually requested.
 * Throws (rejecting the renderer's invoke) when refused or cancelled.
 */
export async function approvePairingWithConfirmation(
  deps: PairingApprovalDeps,
  pairingId: string,
  scopes?: RemoteScope[]
): Promise<{ grant: PairingGrant; receipt: string; receiptSignature: string }> {
  const status = await deps.controlStatus()
  const pending = status.pendingPairing
  if (!pending || pending.pairingId !== pairingId || pending.state !== 'claimed' || !pending.claimedBy) {
    throw new Error('No pending pairing request matches this approval')
  }
  const requested = pending.claimedBy.requestedScopes
  const approved = scopes ?? requested
  if (approved.length === 0 || approved.some((scope) => !requested.includes(scope))) {
    throw new Error('Approved permissions exceed what the device requested')
  }

  const peer = pending.claimedBy
  const detail = [
    `Device: ${peer.mobileDeviceName?.trim() || 'Unnamed device'}`,
    `Device ID: ${peer.mobileDeviceId}`,
    `Fingerprint: ${peer.fingerprint || 'unknown'}`,
    '',
    'This device will be able to:',
    ...approved.map((scope) => `  - ${describeScope(scope)}`)
  ].join('\n')

  const result = await deps.showMessageBox(deps.window, {
    type: 'warning',
    title: 'Approve device pairing',
    message: 'Allow this device to control Mousse?',
    detail,
    buttons: ['Approve', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  })
  if (result.response !== 0) throw new Error('Pairing approval was cancelled')

  return deps.pairingApprove(pairingId, approved)
}
