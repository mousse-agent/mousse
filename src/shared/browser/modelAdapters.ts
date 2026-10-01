import type { BrowserAction, BrowserObservation, BrowserPoint, BrowserScreenshot, BrowserTarget } from './types'

/** Public provider names understood by the native browser adapter layer. */
export type BrowserModelProvider = 'openai' | 'anthropic' | 'google'
export type BrowserModelTier = 'B0' | 'B1' | 'B2' | 'B3'
export type BrowserModelAvailability = 'available' | 'experimental' | 'unavailable'
export type BrowserCoordinateSystem = 'screenshot-pixels-top-left' | 'viewport-pixels-top-left' | 'normalized-1000x1000' | 'semantic-ref'

export interface BrowserModelCapabilityRecord {
  provider: BrowserModelProvider
  model: string
  endpoint: string
  tier: BrowserModelTier
  availability: BrowserModelAvailability
  adapterRevision: string
  browserRevision: string
  testedAt: string
  coordinateSystem: BrowserCoordinateSystem
  supportsImages: boolean
  supportsSemanticRefs: boolean
  supportsOrderedBatches: boolean
  supportsSafetyDecisions: boolean
  limitations: readonly string[]
}

export interface BrowserModelRequest {
  model: string
  prompt: string
  previousResponseId?: string
  continuation?: BrowserModelContinuation
  /** Optional exact observation used to convert provider coordinates once into image pixels. */
  observation?: BrowserObservation
  /** Fallback dimensions are allowed for request construction but never for coordinate action decoding. */
  viewport?: { width: number; height: number }
  enablePromptInjectionDetection?: boolean
}

export interface BrowserModelContinuation {
  provider: BrowserModelProvider
  responseId?: string
  callId: string
  acknowledgedSafetyCheckIds?: readonly string[]
  providerCallIds?: readonly string[]
}

export interface BrowserModelSafetyDecision {
  decision: 'allow' | 'require_confirmation' | 'block'
  explanation?: string
  id?: string
  code?: string
}

export type BrowserModelAction =
  | { kind: 'action'; action: BrowserAction; providerCallId?: string; providerName?: string; intent?: string; safety?: BrowserModelSafetyDecision }
  | { kind: 'keyboard-type'; text: string; target?: BrowserTarget; providerCallId?: string; providerName?: string; pressEnter?: boolean; intent?: string; safety?: BrowserModelSafetyDecision }
  | { kind: 'keypress'; keys: readonly string[]; providerCallId?: string; providerName?: string; intent?: string; safety?: BrowserModelSafetyDecision }
  | { kind: 'screenshot'; providerCallId?: string; providerName?: string; intent?: string; safety?: BrowserModelSafetyDecision }
  | { kind: 'wait'; seconds?: number; providerCallId?: string; providerName?: string; intent?: string; safety?: BrowserModelSafetyDecision }

export interface BrowserModelProviderCall {
  callId: string
  name?: string
  actionStart: number
  actionCount: number
}

export interface BrowserModelCall {
  provider: BrowserModelProvider
  callId: string
  actions: readonly BrowserModelAction[]
  responseId?: string
  continuation?: BrowserModelContinuation
  safetyDecisions: readonly BrowserModelSafetyDecision[]
  providerCalls?: readonly BrowserModelProviderCall[]
}

export interface BrowserModelScreenshot {
  dataUrl: string
  mediaType: string
  detail?: 'original' | 'high' | 'low'
}

export interface BrowserModelActionResult {
  outcome: 'verified' | 'unverified' | 'blocked' | 'failed' | 'unknown-effect'
  message?: string
  screenshot?: BrowserModelScreenshot
  safetyAcknowledgement?: boolean
  /** Kept small and provider-neutral; page text is untrusted evidence. */
  evidence?: { url?: string; title?: string; text?: string }
}

export interface BrowserModelDecodeContext {
  observation?: BrowserObservation
  viewport?: { width: number; height: number }
}

export interface BrowserModelAdapter {
  readonly capability: BrowserModelCapabilityRecord
  buildRequest(input: BrowserModelRequest): unknown
  decodeResponse(response: unknown, input?: BrowserModelDecodeContext): BrowserModelCall | undefined
  encodeResult(call: BrowserModelCall, result: BrowserModelActionResult, continuation?: BrowserModelContinuation): unknown
  encodeResults?(call: BrowserModelCall, results: readonly BrowserModelActionResult[], continuation?: BrowserModelContinuation): unknown
}

export interface BrowserModelExecutionResult {
  call: BrowserModelCall
  results: readonly BrowserModelActionResult[]
  request: unknown
  response: unknown
  encodedResult?: unknown
  stoppedBecause?: 'failure' | 'approval' | 'unknown-effect' | 'cancelled'
}

export type BrowserModelExecutor = (action: BrowserModelAction, signal?: AbortSignal) => Promise<BrowserModelActionResult>

export function imageTarget(point: BrowserPoint): BrowserTarget {
  return { kind: 'image-point', point }
}

export function screenshotToModelInput(screenshot: BrowserScreenshot, dataUrl: string): BrowserModelScreenshot {
  const mediaType = dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png'
  return { dataUrl, mediaType, detail: 'original' }
}
