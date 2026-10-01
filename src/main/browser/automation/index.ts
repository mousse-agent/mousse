export { ElectronAttachedBrowserBackend } from './backend'
export type { AttachedBackendConfig, AttachedCallOptions } from './backend'
export { TrustedGuestRegistry } from './registry'
export type { RegisterGuestInput, TrustedGuestRecord, TrustedGuestRegistryOptions } from './registry'
export { wrapElectronWebContents } from './electronGuest'
export type { GuestDebuggerHandle, GuestWebContentsHandle } from './guestHandle'
export { ElectronDebuggerTransport } from './debuggerTransport'
export { AttachedPageSession } from './session'
export { createFailClosedAttachedPolicy, createLoopbackAttachedPolicy } from './policy'
export type {
  AttachedCapabilityReport,
  AttachedControlState,
  AttachedGuestDescriptor,
  AttachedSessionOpenParams,
  AttachedThreadBinding,
  TrustedOwnerBinding
} from '../../../shared/browser/attached'
