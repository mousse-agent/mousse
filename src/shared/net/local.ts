import type { NodeCapability } from './capabilities'
import type { NodeId, UserId } from './ids'
import type { Route } from './identity'
import type { KeystoreState, RosterState } from './identity'
import type { NetErrorCode } from './errors'

export const NET_LOCAL_CAPABILITY = 'net.v1'
export const NET_LOCAL_METHODS = [
  'net.plus.discover',
  'net.plus.login.begin',
  'net.plus.login.finish',
  'net.plus.configure',
  'net.plus.renew',
  'net.plus.allow',
  'net.plus.status',
  'net.plus.bind',
  'net.plus.connect',
  'net.plus.disconnect',
  'net.plus.login.cancel',
  'net.plus.enrollment.requests',
  'net.plus.enrollment.approve',
  'net.plus.enrollment.deny',
  'net.plus.enrollment.offer',
  'net.transport.list',
  'net.transport.configure',
  'net.init',
  'net.disable',
  'net.status',
  'net.doctor',
  'net.protect',
  'net.unlock',
  'bridge.invite',
  'bridge.join',
  'bridge.nodes',
  'bridge.revoke',
  'bridge.rename',
  'net.authority.transfer',
  'net.authority.status',
  'net.recovery.export',
  'net.recovery.import'
] as const
export type NetLocalMethod = (typeof NET_LOCAL_METHODS)[number]
export interface NetInitInput {
  name?: string
  listen?: boolean
  host?: string
  port?: number
  passphrase?: string
}
export interface BridgeInviteInput {
  ttlMs?: number
  name?: string
  caps?: NodeCapability[]
}
export interface NetStatus {
  enabled: boolean
  features?: import('../featureFlags').NetFeatureFlags
  restartRequired?: boolean
  keystore: KeystoreState | 'unavailable'
  transports?: Array<{
    id: string
    enabled: boolean
    state: 'disabled' | 'provisioning' | 'ready' | 'degraded' | 'failed'
    routes: Route[]
    error?: NetErrorCode
  }>
  protected?: boolean
  self?: { node: NodeId; user: UserId; isAuthority: boolean }
  rosterState?: RosterState
  routes: Route[]
  peers: Array<{ node: NodeId; state: 'connecting' | 'open' | 'closed'; error?: NetErrorCode }>
  error?: NetErrorCode
}
/** A phone asking to join through Mousse Plus, as `net.plus.enrollment.requests` returns it. */
export interface PlusEnrollmentRequestView {
  id: string
  deviceName: string
  kind: 'phone' | 'computer'
  boxPublicKey: string
  transportFingerprint: string
  createdAt: number
  expiresAt: number
  /** Six digits the phone also shows; computed locally, never by Plus. */
  matchCode: string
}
export interface PlusEnrollmentOffer {
  offerId: string
  /** `mousse://net/join?...` payload for the QR code. Contains the one-time key. */
  url: string
  inviteId: string
  expiresAt: number
}
export interface NetDoctor {
  ok: boolean
  checks: Array<{ name: string; ok: boolean; code?: NetErrorCode; message: string }>
}
