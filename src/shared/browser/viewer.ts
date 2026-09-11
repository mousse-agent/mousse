import type { ArtifactReference, ExecutionContext, ExecutionPolicySnapshot } from '../execution/types'
import type { BrowserObservation, BrowserPoint, BrowserScreenshot, BrowserSessionRecord, BrowserTab, BrowserViewport } from './types'
import { imagePointToViewport } from './geometry'

export type BrowserViewerMode = 'managed' | 'manual'
export type BrowserViewerConnection = 'connected' | 'reconnecting' | 'disconnected' | 'headless-waiting'
export type BrowserViewerControlOwner = 'agent' | 'human'

export interface BrowserViewerHistoryEntry {
  id: string
  at: string
  kind: 'opened' | 'observed' | 'action' | 'control' | 'connection' | 'closed' | 'error'
  message: string
  runId?: string
  threadId?: string
  artifactIds?: string[]
}

export interface BrowserViewerRunLink { runId?: string; threadId: string; profileId: string }

export interface BrowserViewerSnapshot {
  mode: 'managed'
  session?: BrowserSessionRecord
  tabs: BrowserTab[]
  observation?: BrowserObservation
  connection: BrowserViewerConnection
  controlOwner?: BrowserViewerControlOwner
  run?: BrowserViewerRunLink
  history: BrowserViewerHistoryEntry[]
  artifacts: ArtifactReference[]
  message?: string
  updatedAt: string
}

export interface BrowserViewerContext {
  execution: ExecutionContext
  policy: ExecutionPolicySnapshot
  signal?: AbortSignal
  vision?: boolean
}

export interface BrowserViewerClient {
  snapshot(input?: { sessionId?: string; context?: BrowserViewerContext }): Promise<BrowserViewerSnapshot>
  subscribe(listener: (snapshot: BrowserViewerSnapshot) => void): () => void
  observe(input: { sessionId: string; tabId?: string; context?: BrowserViewerContext }): Promise<BrowserViewerSnapshot>
  takeControl(input: { sessionId: string; context?: BrowserViewerContext }): Promise<BrowserViewerSnapshot>
  resumeAgent(input: { sessionId: string; context?: BrowserViewerContext }): Promise<BrowserViewerSnapshot>
  close(input: { sessionId: string; context?: BrowserViewerContext }): Promise<BrowserViewerSnapshot>
  history(input?: { sessionId?: string; context?: BrowserViewerContext }): Promise<BrowserViewerHistoryEntry[]>
  artifactUrl?(artifactId: string): string
}

export function viewerPointToCss(point: BrowserPoint, screenshot: BrowserScreenshot, viewport: BrowserViewport): BrowserPoint {
  return imagePointToViewport(point, screenshot, viewport)
}
