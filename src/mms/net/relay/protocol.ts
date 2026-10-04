import { createHash } from 'node:crypto'
import type { NodeId, Signed } from '../../../shared/net'
import { NetError } from '../../../shared/net/errors'
import { canonicalJson } from '../sync/codec'
import { decodeBase64 } from '../identity/crypto'

export interface RelayRendezvous {
  transport: 'relay' | 'plus-relay'
  relay: string
  ticket: string
  expiresAt: number
}
export interface RelayIdentity {
  node: NodeId
  signKey: string
  sign(bytes: Uint8Array): Uint8Array
  delegation?: Signed
  roster?: Signed
}
export interface RelayAuth {
  t: 'auth'
  v: 1
  nonce: string
  node: NodeId
  signKey: string
  role: 'listen' | 'dial' | 'register'
  target: NodeId
  sig: string
  delegation?: Signed
  roster?: Signed
  ticket?: string
  ticketHash?: string
  expiresAt?: number
}
export function relayProofBytes(auth: Omit<RelayAuth, 'sig'> | RelayAuth): Uint8Array {
  const { sig: _sig, ...claims } = auth as RelayAuth
  return canonicalJson({ domain: 'mousse-net/relay-auth/v1', ...claims })
}
export function ticketHash(ticket: string): string {
  return createHash('sha256').update(decodeBase64(ticket, 32)).digest('base64url')
}
export function relayUrl(address: string, target?: NodeId): URL {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    throw new NetError('bad_request', 'Invalid relay address.')
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== '/mousse-relay' ||
    !['ws:', 'wss:'].includes(url.protocol)
  )
    throw new NetError('bad_request', 'Invalid relay address.')
  if (url.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new NetError('bad_request', 'Public relay routes require outer TLS.')
  for (const key of url.searchParams.keys())
    if (key !== 'node') throw new NetError('bad_request', 'Invalid relay query.')
  if (target) url.searchParams.set('node', target)
  return url
}
