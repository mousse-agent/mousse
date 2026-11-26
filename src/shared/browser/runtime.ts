import type { ExecutionContext } from '../execution/types'
import type { BrowserAutomationTool, BrowserToolContext, BrowserToolOutput } from './automation'

/** Trusted host injection. Never deserialize an execution context from model arguments. */
export interface BrowserRuntimePort {
  capabilities?(context: ExecutionContext): import('./capabilities').BrowserBackendCapabilities | undefined
  /** The screenshot's picture; `note` is a line the model is told with it (a bot: where it was saved, and that its owner sees it). */
  readScreenshot?(context: BrowserToolContext, sessionId: string, artifactId: string): Promise<{ data: string; mimeType: 'image/png'; note?: string }>
  requestAccess?(context: ExecutionContext, signal?: AbortSignal): Promise<'allowed' | 'already-allowed'>
  resolveTarget(context: ExecutionContext): BrowserToolContext['target']
  dispatch(context: BrowserToolContext, name: BrowserAutomationTool, args: unknown): Promise<BrowserToolOutput>
}
