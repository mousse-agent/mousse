export type NodeId = `nod_${string}`
export type UserId = `usr_${string}`
export type Base64Url = string
export interface Signed { payload: Base64Url; sig: Base64Url }
export interface NodePublicKeys { sign: Base64Url; agree: Base64Url; transport: Base64Url }
export interface NodeDelegation {
  v: 1; kind: 'node'; subject: NodeId; keys: NodePublicKeys; owner: UserId; name: string
  caps: Array<'read' | 'chat' | 'write' | 'terminal' | 'settings'>
  keyEpoch: number; issuedAt: number; expiresAt: number
}
export interface Roster {
  v: 1; owner: UserId; rootKey: Base64Url; recoveryEpoch: number; lineage: string
  version: number; authorityNode: NodeId; nodes: Signed[]; bots: Signed[]
  revoked: Array<{ subject: NodeId | `bot_${string}`; throughKeyEpoch: number; revokedAt: number }>
  issuedAt: number
}
export interface RelayIdentity {
  node: NodeId; signKey: Base64Url
  sign(bytes: Uint8Array): Uint8Array
}
export interface HostedRelayRegistration { registrationId: string; generation: number }
export type RelayRole = 'listen' | 'dial' | 'register'
export type RelayRendezvousContext = { ticket: string } | { ticketHash: string; expiresAt: number }
export interface HostedRelayAuth extends HostedRelayRegistration {
  t: 'auth'; v: 1; audience: string; nonce: string; node: NodeId; signKey: string
  role: RelayRole; target: NodeId; sig: string; rendezvous?: RelayRendezvousContext
}
export interface RelayAdmission extends HostedRelayRegistration {
  id: string; node: NodeId; signKey: string; role: RelayRole; target: NodeId
  expiresAt: number; principal: string; policyRevision: number
}
export interface RelayCircuitLease { id: string; expiresAt: number }
/** Hosted policy gates reachability and resources; endpoints own all Net permissions. */
export interface NetRelayPolicy {
  admit(input: { installationId: string; gatewayId: string; connectionId: string; nonce: string; remoteAddress: string; now: number; auth: HostedRelayAuth }): Promise<RelayAdmission>
  pair(input: { listener: RelayAdmission; dialer: RelayAdmission; now: number }): Promise<RelayCircuitLease>
  /** Revalidate the existing circuit without reserving/charging another circuit. */
  renewCircuit(input: { circuitId: string; listener: RelayAdmission; dialer: RelayAdmission; now: number }): Promise<RelayCircuitLease>
  renew(input: { admissionId: string; generation: number; now: number }): Promise<RelayAdmission>
  charge(input: { admissionId: string; generation: number; direction: 'ingress'; bytes: number; now: number }): Promise<void>
  release(input: { admissionId: string; generation: number; reason: string }): Promise<void>
}
export interface HostedRelayRendezvous { transport: string; relay: string; ticket: string; expiresAt: number }
