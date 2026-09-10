export const BROWSER_CONTRACT_VERSION = 1 as const
export type BrowserLifecycle = 'starting' | 'ready' | 'agent-controlled' | 'human-controlled' | 'waiting-approval' | 'disconnected' | 'recovering' | 'closed'
export type BrowserCapabilityTier = 'structured' | 'hybrid' | 'native'

export interface BrowserSessionRecord {
  id: string
  profileId: string
  runId?: string
  threadId?: string
  workspaceId?: string
  persistent: boolean
  backend: 'managed-chromium' | 'electron-attached'
  browserVersion: string
  generation: number
  lifecycle: BrowserLifecycle
  controlLeaseId?: string
  createdAt: string
  updatedAt: string
}
export interface BrowserPoint { x: number; y: number }
export interface BrowserBounds extends BrowserPoint { width: number; height: number }
export interface BrowserViewport {
  cssWidth: number
  cssHeight: number
  deviceScaleFactor: number
  scrollX: number
  scrollY: number
}
export interface BrowserScreenshot {
  artifactId: string
  pixelWidth: number
  pixelHeight: number
  cssToImageScaleX: number
  cssToImageScaleY: number
  cropOriginCss?: BrowserPoint
}
export interface BrowserElement {
  ref: string
  frameRef: string
  role?: string
  name?: string
  text?: string
  bounds?: BrowserBounds
  states: string[]
}
export interface BrowserTab { id: string; title: string; url: string }
export interface BrowserObservation {
  sessionId: string
  tabId: string
  generation: number
  observationId: string
  documentId: string
  capturedAt: string
  url: string
  title: string
  viewport: BrowserViewport
  tabs: BrowserTab[]
  elements: BrowserElement[]
  screenshot?: BrowserScreenshot
  truncated: boolean
  continuation?: string
  warnings: string[]
  provenance: 'untrusted-page'
}
export type BrowserTarget = { kind: 'ref'; ref: string } | { kind: 'image-point'; point: BrowserPoint }
export type BrowserAction =
  | { type: 'navigate'; url: string }
  | { type: 'back' | 'forward' | 'reload' }
  | { type: 'click' | 'double-click' | 'hover'; target: BrowserTarget; button?: 'left' | 'right' | 'middle' }
  | { type: 'fill' | 'type'; target: BrowserTarget; text: string }
  | { type: 'key'; key: string; target?: BrowserTarget }
  | { type: 'select'; target: BrowserTarget; values: string[] }
  | { type: 'check'; target: BrowserTarget; checked: boolean }
  | { type: 'scroll'; target?: BrowserTarget; deltaX: number; deltaY: number }
  | { type: 'drag'; from: BrowserTarget; to: BrowserTarget }
  | { type: 'upload'; target: BrowserTarget; artifactIds: string[] }
  | { type: 'dialog'; accept: boolean; promptText?: string }

export type BrowserWaitCondition =
  | { type: 'url'; equals?: string; includes?: string }
  | { type: 'text'; text: string; present: boolean }
  | { type: 'element'; ref: string; state: 'visible' | 'hidden' | 'enabled' | 'disabled' }
  | { type: 'document-ready' }

export interface BrowserActionRequest {
  requestId: string
  sessionId: string
  tabId: string
  generation: number
  observationId: string
  controlLeaseId: string
  action: BrowserAction
  timeoutMs: number
  expected?: BrowserWaitCondition
}
export type BrowserActionOutcome = 'verified' | 'unverified' | 'blocked' | 'failed' | 'unknown-effect'
export interface BrowserActionResult {
  requestId: string
  outcome: BrowserActionOutcome
  dispatched: boolean
  observation?: BrowserObservation
  code?: BrowserErrorCode
  message?: string
  artifactIds: string[]
}
export type BrowserErrorCode = 'setup_required' | 'profile_mismatch' | 'session_closed' | 'stale_generation' | 'stale_observation' | 'stale_ref' | 'invalid_geometry' | 'not_actionable' | 'policy_denied' | 'approval_required' | 'human_controlled' | 'timeout' | 'cancelled' | 'worker_disconnected' | 'unsupported' | 'invalid_action'

/** Private broker envelope: validated by MMS; never exposed to page or model JS. */
export interface BrowserWorkerRequest {
  version: 1
  id: string
  profileId: string
  method: 'session.open' | 'session.close' | 'tabs.list' | 'tabs.new' | 'tabs.close' | 'tabs.switch' | 'observe' | 'find' | 'act' | 'wait' | 'extract' | 'control.take' | 'control.release'
  params: Record<string, unknown>
}
export interface BrowserWorkerResponse {
  version: 1
  id: string
  ok: boolean
  result?: unknown
  error?: { code: BrowserErrorCode; message: string }
}
