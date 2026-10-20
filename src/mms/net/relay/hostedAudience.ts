import { NetError } from '../../../shared/net'

/**
 * Wire vocabulary for the Mousse ID hosted relay that core Net must understand even when
 * the Mousse ID module is absent: signed routes and invites can name this transport, and
 * they are validated (and refused) without it. Values match `plus/wire/protocol.ts`.
 */
export const HOSTED_RELAY_TRANSPORT = 'plus-relay'
export const HOSTED_RELAY_PATH = '/v1/net/relay'

/** The exact hosted relay WebSocket address, or `bad_request` when the value is not one. */
export function canonicalHostedRelayAudience(address: string): string {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    throw new NetError('bad_request')
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== HOSTED_RELAY_PATH ||
    !['wss:', 'ws:'].includes(url.protocol)
  )
    throw new NetError('bad_request')
  if (url.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new NetError('bad_request')
  return `${url.origin}${HOSTED_RELAY_PATH}`
}
