/**
 * Control Protocol 2.0 shared types and schemas.
 * Used across MMS daemon, Electron main, CLI, and renderer.
 */

export type ControlMode = 'hosted' | 'self-hosted'

export type RemoteScope =
  | 'mousse:read'
  | 'mousse:chat'
  | 'mousse:write'
  | 'mousse:terminal'
  | 'mousse:settings'

export const ALL_REMOTE_SCOPES: readonly RemoteScope[] = [
  'mousse:read',
  'mousse:chat',
  'mousse:write',
  'mousse:terminal',
  'mousse:settings'
] as const

export const DEFAULT_PAIRING_SCOPES: readonly RemoteScope[] = [
  'mousse:read',
  'mousse:chat',
  'mousse:write',
  'mousse:terminal',
  'mousse:settings'
] as const

export type PairingStatus =
  | 'pending'
  | 'claimed'
  | 'approved'
  | 'active'
  | 'expired'
  | 'rejected'
  | 'revoked'

export interface QrV2Payload {
  v: 2
  mode: ControlMode
  controlOrigin: string
  installationId: string
  installationPublicKey: string
  mmsDeviceId: string
  mmsIdentityPublicKey: string
  pairingId: string
  expiresAt: number
  protocolMajor: 2
  pairingSecret: string
  accountId?: string
}

export interface PairingGrant {
  pairingId: string
  mobileDeviceId: string
  mobileDeviceName?: string
  mobileStaticPublicKey: string
  fingerprint?: string
  grantedScopes: RemoteScope[]
  createdAt: string
  lastUsedAt?: string
  status: 'active' | 'revoked'
  revokedAt?: string
  receiptSignature: string
}

export interface ClaimedPeerInfo {
  mobileDeviceId: string
  mobileDeviceName?: string
  mobileStaticPublicKey: string
  fingerprint: string
  requestedScopes: RemoteScope[]
  claimedAt: number
}

export interface PendingPairingState {
  pairingId: string
  pairingSecret: string
  expiresAt: number
  requestedScopes: RemoteScope[]
  qrUri: string
  state: 'pending' | 'claimed'
  claimedPeer?: ClaimedPeerInfo
}

export interface ControlStatus {
  mode: ControlMode
  enrolled: boolean
  serverUrl: string
  dashboardUrl: string
  mmsDeviceId: string
  account?: {
    id: string
    email?: string
    name?: string
  }
  relayConnected: boolean
  relayConnecting: boolean
  lastRelayError?: string
  activePairingsCount: number
  pendingPairing?: {
    pairingId: string
    expiresAt: number
    qrUri: string
    state: 'pending' | 'claimed'
    claimedBy?: {
      mobileDeviceId: string
      mobileDeviceName?: string
      fingerprint: string
      requestedScopes: RemoteScope[]
    }
  }
  pairings: PairingGrant[]
}

export interface CreatePairingResult {
  pairingId: string
  qrUri: string
  expiresAt: number
  scopes: RemoteScope[]
}

export interface ControlLoginResult {
  ok: boolean
  accountId?: string
  error?: string
}

// Wire envelopes for Control Protocol 2.0 inside E2E encrypted channel
export interface ControlRequestEnvelope {
  kind: 'request'
  id: string
  method: string
  params?: unknown
  idempotencyKey?: string
  version: number
}

export interface ControlResponseEnvelope {
  kind: 'response'
  id: string
  ok: boolean
  result?: unknown
  error?: {
    code: string
    message: string
    details?: unknown
  }
}

export interface ControlEventEnvelope {
  kind: 'event'
  instanceId: string
  sequence: number
  type: string
  threadId?: string
  data: unknown
  ts: string
}

export interface ControlCancelEnvelope {
  kind: 'cancel'
  requestId: string
}

export interface ControlSnapshotRequiredEnvelope {
  kind: 'snapshotRequired'
  reason: string
  lastKnownSequence?: number
}

export interface ControlPingEnvelope {
  kind: 'ping'
  ts: number
}

export interface ControlPongEnvelope {
  kind: 'pong'
  ts: number
}

export type ControlEnvelope =
  | ControlRequestEnvelope
  | ControlResponseEnvelope
  | ControlEventEnvelope
  | ControlCancelEnvelope
  | ControlSnapshotRequiredEnvelope
  | ControlPingEnvelope
  | ControlPongEnvelope
