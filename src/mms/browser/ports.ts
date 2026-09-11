import type { BrowserAction, BrowserActionOutcome, BrowserArtifactMetadata, BrowserErrorCode, BrowserResolvedArtifact, BrowserWorkerRequest } from '../../shared/browser/types'

export interface BrowserPolicyDecision {
  allowed: boolean
  code?: BrowserErrorCode
  message?: string
}

export interface BrowserPolicyPort {
  authorize(input: {
    profileId: string
    method: BrowserWorkerRequest['method']
    action?: BrowserAction
    url?: string
    sessionId?: string
  }): Promise<BrowserPolicyDecision> | BrowserPolicyDecision
}

export interface BrowserArtifactWrite {
  artifactId: string
  byteLength: number
  sha256: string
}

export interface BrowserArtifactPort {
  write(input: {
    profileId: string
    sessionId: string
    mediaType: string
    bytes: Uint8Array
    displayName: string
  }): Promise<BrowserArtifactWrite>
  /** Optional MMS-side grant resolver. The worker only receives validated staged paths. */
  resolveReadOnly?(input: { profileId: string; sessionId: string; runId?: string; artifactIds: string[] }): Promise<BrowserResolvedArtifact[]>
  /** Optional MMS-side quarantine publisher for completed browser downloads. */
  publishDownload?(input: { profileId: string; sessionId: string; runId?: string; path: string; displayName: string; mediaType: string; byteLength: number }): Promise<BrowserArtifactMetadata>
}

export interface BrowserJournalRecord {
  at: string
  profileId: string
  sessionId: string
  requestId: string
  generation: number
  phase: 'intent' | 'dispatched' | 'outcome'
  actionType: string
  dispatched?: boolean
  outcome?: BrowserActionOutcome
}

export interface BrowserJournalPort {
  append(record: BrowserJournalRecord): Promise<void> | void
}

export interface BrowserBrokerConfig {
  readonly profileRoot: string
  readonly browserRoot: string
  readonly artifactRoot: string
  readonly policy: BrowserPolicyPort
  readonly artifacts?: BrowserArtifactPort
  readonly journal?: BrowserJournalPort
  readonly workerModulePath?: string
  readonly transport?: 'child-process' | 'in-process'
  readonly requestTimeoutMs?: number
  /** Trusted host-only Chromium flags, primarily for isolated fixture routing. */
  readonly chromeExtraArgs?: readonly string[]
}
