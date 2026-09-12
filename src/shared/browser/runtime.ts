import type { ExecutionContext } from '../execution/types'
import type { BrowserAutomationTool, BrowserToolContext, BrowserToolOutput } from './automation'

/** Trusted host injection. Never deserialize an execution context from model arguments. */
export interface BrowserRuntimePort {
  readScreenshot?(context: BrowserToolContext, sessionId: string, artifactId: string): Promise<{ data: string; mimeType: 'image/png' }>
  requestAccess?(context: ExecutionContext, signal?: AbortSignal): Promise<'allowed' | 'already-allowed'>
  resolveTarget(context: ExecutionContext): BrowserToolContext['target']
  dispatch(context: BrowserToolContext, name: BrowserAutomationTool, args: unknown): Promise<BrowserToolOutput>
}
