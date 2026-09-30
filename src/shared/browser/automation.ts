import type { ArtifactReference, ExecutionContext, ExecutionPolicySnapshot } from '../execution/types'
import type {
  BrowserAction,
  BrowserActionResult,
  BrowserObservation,
  BrowserSessionRecord,
  BrowserTab,
  BrowserWaitCondition
} from './types'

export const BROWSER_AUTOMATION_TOOLS = [
  'browser_open',
  'browser_tabs',
  'browser_observe',
  'browser_screenshot',
  'browser_find',
  'browser_act',
  'browser_wait',
  'browser_extract',
  'browser_request_human'
] as const

export type BrowserAutomationTool = typeof BROWSER_AUTOMATION_TOOLS[number]
export type BrowserAutomationCapability = 'browser.session' | 'browser.observe' | 'browser.action' | 'browser.extract' | 'browser.task'

export interface BrowserToolDescriptor {
  readonly name: BrowserAutomationTool
  readonly description: string
  readonly capability: BrowserAutomationCapability
  readonly vision: boolean
  readonly effect: 'read' | 'write' | 'external'
}

export interface BrowserToolContext {
  readonly execution: ExecutionContext
  readonly policy: ExecutionPolicySnapshot
  readonly signal?: AbortSignal
  readonly vision?: boolean
  /** Host-selected target. Models cannot supply or change this through tool arguments. */
  readonly target?: { readonly backend: 'electron-attached'; readonly uiTabId: string } | { readonly backend: 'managed-chromium' }
}

export interface BrowserOpenArgs {
  url?: string
  persistent?: boolean
  workspaceId?: string
}

export interface BrowserTabsArgs {
  sessionId: string
  operation?: 'list' | 'new' | 'switch' | 'close'
  tabId?: string
  url?: string
}

export interface BrowserObserveArgs {
  sessionId: string
  tabId?: string
  ref?: string
  includeScreenshot?: boolean
  maxElements?: number
}

export interface BrowserFindArgs {
  sessionId: string
  tabId: string
  query: string
  role?: string
  ref?: string
}

export interface BrowserActArgs {
  sessionId: string
  tabId: string
  generation: number
  observationId: string
  controlLeaseId: string
  action: BrowserAction
  timeoutMs?: number
  expected?: BrowserWaitCondition
}

export interface BrowserWaitArgs {
  sessionId: string
  tabId: string
  condition: BrowserWaitCondition
  timeoutMs?: number
}

export interface BrowserExtractArgs {
  sessionId: string
  tabId: string
  ref?: string
  schema?: unknown
}

export interface BrowserRequestHumanArgs {
  sessionId: string
  reason: string
  operation?: string
}

export type BrowserToolArgs =
  | BrowserOpenArgs
  | BrowserTabsArgs
  | BrowserObserveArgs
  | BrowserFindArgs
  | BrowserActArgs
  | BrowserWaitArgs
  | BrowserExtractArgs
  | BrowserRequestHumanArgs

export interface BrowserToolOutput {
  readonly capabilities?: import('./capabilities').BrowserBackendCapabilities
  readonly session?: BrowserSessionRecord
  readonly observation?: BrowserObservation
  readonly tabs?: BrowserTab[]
  readonly matches?: unknown[]
  readonly observationId?: string
  readonly action?: BrowserActionResult
  readonly extraction?: unknown
  readonly artifacts?: ArtifactReference[]
  readonly handoff?: { requestId: string; state: 'waiting-human' }
}

export interface BrowserToolError {
  readonly errorInfo?: import('../errors').ErrorInfo
  readonly code: string
  readonly message: string
  readonly details?: Record<string, unknown>
}

export type BrowserToolResult =
  | { readonly ok: true; readonly value: BrowserToolOutput }
  | { readonly ok: false; readonly error: BrowserToolError }

export interface BrowserWorkflowRequest {
  readonly nodeType: 'browser-session' | 'browser-observe' | 'browser-action' | 'browser-extract' | 'browser-task'
  readonly config: Record<string, unknown>
  readonly input: unknown
  readonly context: ExecutionContext
  readonly policy: ExecutionPolicySnapshot
  readonly signal: AbortSignal
  readonly vision?: boolean
}

export interface BrowserWorkflowAdapter {
  invoke(request: BrowserWorkflowRequest): Promise<{ output: unknown; artifacts?: ArtifactReference[] }>
}
