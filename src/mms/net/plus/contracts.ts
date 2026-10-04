import type { Signed } from '../../../shared/net'
export interface PlusConfiguration {
  apiOrigin: string
  audience: string
  installationId: string
  accountId: string
  gatewayId: string
}
export interface PlusStatus {
  configured: boolean
  connected: boolean
  accountId?: string
  audience?: string
  expiresAt?: number
  registrationId?: string
  generation?: number
}
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
