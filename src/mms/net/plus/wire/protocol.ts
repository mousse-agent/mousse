import { canonicalJson, parseBoundedJsonDocument } from './codec.js'
import { decodeBase64, isNodeId, verifyBytes } from './crypto.js'
import { NetRelayError } from './errors.js'
import type { HostedRelayAuth } from './types.js'

export const HOSTED_RELAY_PATH = '/v1/net/relay'
export const HOSTED_RELAY_AUTH_DOMAIN = 'mousse-plus/net-relay-auth/v1'
export const AUTH_MAX_BYTES = 16 * 1024
export const FRAME_MAX_BYTES = 64 * 1024
/** Configured audience is origin + exact endpoint; never derive it from proxy headers. */
export function canonicalAudience(address: string): string {
  let url: URL
  try { url = new URL(address) } catch { throw new NetRelayError('bad_request') }
  if (url.username || url.password || url.search || url.hash || url.pathname !== HOSTED_RELAY_PATH || !['wss:', 'ws:'].includes(url.protocol)) throw new NetRelayError('bad_request')
  if (url.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new NetRelayError('bad_request')
  return `${url.origin}${HOSTED_RELAY_PATH}`
}
export function hostedRelayProofBytes(auth: Omit<HostedRelayAuth, 'sig'> | HostedRelayAuth): Uint8Array {
  const { sig: _sig, ...claims } = auth as HostedRelayAuth
  return canonicalJson({ domain: HOSTED_RELAY_AUTH_DOMAIN, ...claims })
}
export function parseHostedRelayAuth(bytes: Uint8Array, audience: string, nonce: string): HostedRelayAuth {
  const value = parseBoundedJsonDocument(bytes, AUTH_MAX_BYTES)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NetRelayError('bad_request')
  const auth = value as HostedRelayAuth
  const required = ['t', 'v', 'audience', 'nonce', 'node', 'signKey', 'role', 'target', 'registrationId', 'generation', 'sig']
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && key !== 'rendezvous') || auth.t !== 'auth' || auth.v !== 1 || auth.audience !== audience || canonicalAudience(auth.audience) !== auth.audience || auth.nonce !== nonce || !isNodeId(auth.node) || !isNodeId(auth.target) || !['listen', 'dial', 'register'].includes(auth.role) || typeof auth.registrationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(auth.registrationId) || !Number.isSafeInteger(auth.generation) || auth.generation < 1) throw new NetRelayError('bad_request')
  decodeBase64(auth.nonce, 32); decodeBase64(auth.signKey, 32)
  if (auth.role !== 'dial' && auth.target !== auth.node) throw new NetRelayError('forbidden')
  if (auth.rendezvous !== undefined) {
    const r = auth.rendezvous
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new NetRelayError('bad_request')
    if ('ticket' in r) {
      if (auth.role !== 'dial' || Object.keys(r).length !== 1) throw new NetRelayError('bad_request')
      decodeBase64(r.ticket, 32)
    } else {
      if (auth.role !== 'register' || Object.keys(r).length !== 2 || !('ticketHash' in r) || !('expiresAt' in r) || !Number.isSafeInteger(r.expiresAt) || r.expiresAt < 1) throw new NetRelayError('bad_request')
      decodeBase64(r.ticketHash, 32)
    }
  } else if (auth.role === 'register') throw new NetRelayError('bad_request')
  verifyBytes(hostedRelayProofBytes(auth), decodeBase64(auth.sig, 64), auth.signKey)
  return auth
}
