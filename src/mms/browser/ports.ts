import type { BrowserAction, BrowserActionOutcome, BrowserErrorCode, BrowserWorkerRequest } from '../../shared/browser/types'

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
}
