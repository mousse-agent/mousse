import type { NodeCapability } from './capabilities'
import type { NodeId, UserId } from './ids'
import type { Route } from './identity'
import type { KeystoreState, RosterState } from './identity'
import type { NetErrorCode } from './errors'

export const NET_LOCAL_CAPABILITY = 'net.v1'
export const NET_LOCAL_METHODS = [
  'net.init', 'net.status', 'net.doctor', 'bridge.invite', 'bridge.join',
  'bridge.nodes', 'bridge.revoke', 'bridge.rename'
] as const
export type NetLocalMethod = typeof NET_LOCAL_METHODS[number]
export interface NetInitInput { name?: string; listen?: boolean; host?: string; port?: number }
export interface BridgeInviteInput { ttlMs?: number; name?: string; caps?: NodeCapability[] }
export interface NetStatus {
  enabled: boolean
  keystore: KeystoreState
  self?: { node: NodeId; user: UserId; isAuthority: boolean }
  rosterState?: RosterState
  routes: Route[]
  peers: Array<{ node: NodeId; state: 'connecting' | 'open' | 'closed'; error?: NetErrorCode }>
  error?: NetErrorCode
}
export interface NetDoctor {
  ok: boolean
  checks: Array<{ name: string; ok: boolean; code?: NetErrorCode; message: string }>
}
