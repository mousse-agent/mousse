/**
 * Control Protocol 2.0 shared types and schemas.
 * Canonical cross-surface definitions aligned with docs/WIRE_PROTOCOL.md.
 * Used across MMS daemon, Electron main, CLI, and renderer.
 */

export type ControlMode = 'hosted' | 'self-hosted'
export type WireMode = 'hosted' | 'self-hosted'
export type StorageMode = 'hosted' | 'self_hosted'

export function wireModeFromStorage(mode: StorageMode | ControlMode): ControlMode {
  return mode === 'self_hosted' ? 'self-hosted' : mode
}

export function storageModeFromWire(mode: ControlMode | StorageMode): StorageMode {
  return mode === 'self-hosted' ? 'self_hosted' : mode
}

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

/**
 * QR Payload (mousse://pair?v=2&data=<base64url(canonical-json)>).
 * Note: `v` is only in the URI query string, NOT a JSON field.
 */
export interface QrPayload {
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

export type QrV2Payload = QrPayload

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

// --- Relay Auth Messages ---

export interface AdmissionCredential {
  admissionId: string
  installationId: string
  deviceId: string
  pairingId: string
  role: 'mms' | 'mobile'
  nonce: string
  expiresAt: number
  protocolMajor: 2
  protocolMinor?: number
  token: string
}

export interface RelayAuthMessage {
  type: 'auth'
  admission: AdmissionCredential
  connectorEpoch?: number
  challengeResponse?: string
  protocolMajor: 2
  protocolMinor?: number
}

export interface RelayAuthOkMessage {
  type: 'authOk'
  role: 'mms' | 'mobile'
  pairingId: string
  gatewayId?: string
  epoch?: number
  serverTime?: number
}

export interface RelayAuthFailMessage {
  type: 'authFail'
  code:
    | 'AUTH_REQUIRED'
    | 'AUTH_EXPIRED'
    | 'DEVICE_REVOKED'
    | 'PAIRING_REQUIRED'
    | 'PROTOCOL_INCOMPATIBLE'
    | 'FORBIDDEN'
    | 'RATE_LIMITED'
    | 'INVALID_REQUEST'
  message: string
}

export interface RelayPingMessage {
  type: 'ping'
}

export interface RelayPongMessage {
  type: 'pong'
}

export type RelayControlMessage =
  | RelayAuthMessage
  | RelayAuthOkMessage
  | RelayAuthFailMessage
  | RelayPingMessage
  | RelayPongMessage

// --- Wire Envelopes for Control Protocol 2.0 inside E2E encrypted channel ---

export interface ControlRequestEnvelope {
  type: 'request'
  requestId: string
  method: string
  params?: unknown
  idempotencyKey?: string
  protocolMajor?: 2
  protocolMinor?: number
  /** Compatibility alias */
  kind?: 'request'
  /** Compatibility alias */
  id?: string
}

export interface ControlResponseResultEnvelope {
  type: 'response'
  requestId: string
  result: unknown
  error?: never
  /** Compatibility alias */
  kind?: 'response'
  /** Compatibility alias */
  id?: string
  /** Compatibility alias */
  ok?: true
}

export interface ControlResponseErrorEnvelope {
  type: 'response'
  requestId: string
  error: {
    code: string
    message: string
    details?: unknown
  }
  result?: never
  /** Compatibility alias */
  kind?: 'response'
  /** Compatibility alias */
  id?: string
  /** Compatibility alias */
  ok?: false
}

export type ControlResponseEnvelope =
  | ControlResponseResultEnvelope
  | ControlResponseErrorEnvelope

export interface ControlEventEnvelope {
  type: 'event'
  instanceId: string
  sequence: number
  eventType: string
  payload?: unknown
  /** Compatibility alias */
  kind?: 'event'
  /** Compatibility alias for eventType */
  channel?: string
  /** Compatibility alias for payload */
  data?: unknown
  /** Compatibility alias */
  ts?: string
}

export interface ControlCancelEnvelope {
  type: 'cancel'
  requestId: string
  /** Compatibility alias */
  kind?: 'cancel'
}

export interface ControlResumeCursor {
  instanceId: string
  sequence: number
}

export interface ControlSnapshotRequiredEnvelope {
  type: 'snapshotRequired'
  reason?: 'ring_overflow' | 'restart' | 'authorization_change' | 'gap' | 'explicit' | string
  cursor?: ControlResumeCursor
  /** Compatibility alias */
  kind?: 'snapshotRequired'
  lastKnownSequence?: number
}

export interface ControlPingEnvelope {
  type: 'ping'
  nonce?: string
  sentAt?: number
  /** Compatibility alias */
  kind?: 'ping'
  ts?: number
}

export interface ControlPongEnvelope {
  type?: 'pong'
  kind?: 'pong'
  nonce?: string
  ts?: number
}

export type ControlEnvelope =
  | ControlRequestEnvelope
  | ControlResponseEnvelope
  | ControlEventEnvelope
  | ControlCancelEnvelope
  | ControlSnapshotRequiredEnvelope
  | ControlPingEnvelope
  | ControlPongEnvelope
