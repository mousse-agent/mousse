import type { BrowserErrorCode, BrowserLifecycle } from './types'

/** Opaque IDs only. Electron native handles stay in main. */
export type AttachedGuestId = string
export type AttachedOwnerId = string
/** Trusted host-global opaque tab ID. Per-window tab IDs must be namespaced before registration. */
export type AttachedUiTabId = string
export type AttachedProfileEpoch = string

export type AttachedThreadBinding =
  | { readonly kind: 'thread'; readonly threadId: string }
  | { readonly kind: 'unbound' }

export interface AttachedGuestDescriptor {
  readonly guestId: AttachedGuestId
  readonly ownerId: AttachedOwnerId
  readonly uiTabId: AttachedUiTabId
  readonly profileId: string
  readonly profileEpoch: AttachedProfileEpoch
  readonly thread: AttachedThreadBinding
}

export interface AttachedControlState {
  readonly sessionId: string
  readonly uiTabId: AttachedUiTabId
  readonly profileId: string
  readonly owner: 'agent' | 'human' | 'disconnected'
  readonly controlLeaseId?: string
  readonly generation: number
  readonly lifecycle: BrowserLifecycle
}

export interface AttachedActionCapabilities {
  readonly navigate: boolean
  readonly click: boolean
  readonly fill: boolean
  readonly type: boolean
  readonly key: boolean
  readonly select: boolean
  readonly check: boolean
  readonly scroll: boolean
  readonly hover: boolean
  readonly coordinateTargeting: boolean
  readonly boundedPointerDrag: boolean
  readonly artifactUpload: false
  readonly quarantinedDownloads: false
}

export interface AttachedCapabilityReport {
  readonly ready: boolean
  readonly backend: 'electron-attached'
  readonly guiDependent: true
  readonly transport: 'electron-debugger'
  readonly setupRequired: false
  readonly version?: string
  readonly capabilities: {
    readonly screenshots: boolean
    readonly accessibility: true
    readonly oopif: 'unsupported'
    readonly openShadowDom: true
    readonly closedShadowDom: 'unsupported'
    readonly modelEvaluate: false
    readonly tabs: { readonly list: true; readonly switch: true; readonly new: false; readonly close: false }
    readonly actions: AttachedActionCapabilities
    readonly preservesLivePage: true
    readonly destroysHumanTabOnClose: false
    readonly headlessContinuityOnGuiClose: false
  }
  readonly unsupportedMethods: readonly string[]
  readonly message: string
}

export interface AttachedSessionOpenParams {
  readonly uiTabId: AttachedUiTabId
  readonly threadId?: string
  readonly runId?: string
  readonly url?: string
}

export interface TrustedOwnerBindingInput {
  readonly ownerId: AttachedOwnerId
  readonly guestId: AttachedGuestId
  readonly profileId: string
  readonly profileEpoch: AttachedProfileEpoch
  readonly uiTabId: AttachedUiTabId
}

/**
 * Trusted main-only callback. Renderer/model cannot supply this.
 * Return false to fail closed before dispatch.
 */
export type TrustedOwnerBinding = (input: TrustedOwnerBindingInput) => boolean | Promise<boolean>

export const ATTACHED_UNSUPPORTED_METHODS = ['tabs.new', 'tabs.close'] as const

export const ATTACHED_CAPABILITY_DEFAULT: AttachedCapabilityReport = {
  ready: true,
  backend: 'electron-attached',
  guiDependent: true,
  transport: 'electron-debugger',
  setupRequired: false,
  capabilities: {
    screenshots: false,
    accessibility: true,
    oopif: 'unsupported',
    openShadowDom: true,
    closedShadowDom: 'unsupported',
    modelEvaluate: false,
    tabs: { list: true, switch: true, new: false, close: false },
    actions: {
      navigate: true,
      click: true,
      fill: true,
      type: true,
      key: true,
      select: true,
      check: true,
      scroll: true,
      hover: true,
      coordinateTargeting: true,
      boundedPointerDrag: true,
      artifactUpload: false,
      quarantinedDownloads: false
    },
    preservesLivePage: true,
    destroysHumanTabOnClose: false,
    headlessContinuityOnGuiClose: false
  },
  unsupportedMethods: ATTACHED_UNSUPPORTED_METHODS,
  message: 'Electron-attached backend targets an existing in-app webview tab. OOPIF auto-attach, tab create/close, upload, and downloads are unsupported.'
}

export type AttachedBindingFailureCode = Extract<
  BrowserErrorCode,
  'profile_mismatch' | 'session_closed' | 'policy_denied' | 'unsupported' | 'invalid_action' | 'human_controlled' | 'worker_disconnected'
>
