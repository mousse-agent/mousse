import type { Signed } from '../../../shared/net'
export type { PlusConfiguration, PlusStatus } from '../../../shared/net/local'
export interface ChallengeStatement {
  v: 1
  domain: 'mousse-plus/net-control/v1'
  installationId: string
  audience: string
  challengeId: string
  nonce: string
  accountId: string
  userId: string
  rootKey: string
  nodeId: string | null
  purpose: 'bind' | 'register' | 'renew' | 'route' | 'rendezvous'
  operationId: string
  intentHash: string
  issuedAt: number
  expiresAt: number
}
export interface RegistrationResult {
  registration: {
    id: string
    accountId: string
    userId: string
    nodeId: string
    generation: number
    expiresAt: number
  }
  connectorToken: string
  relayAudience: string
}
export interface BindingIntent {
  roster: Signed
}
