import { isIP } from 'node:net'
import { isPublicAddress } from '../net-public/publicFetch'
import { SECRET_SERVICES, type SecretBinding } from '../../shared/secretServices'

/** Resolve model input once, before showing a card. Never accept model-selected header formats or path grants. */
export function resolveSecretBinding(value: unknown): SecretBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a known service or an https origin.')
  const input = value as Record<string, unknown>
  if (Object.keys(input).length !== 1) throw new Error('Choose one service or one origin.')
  if (typeof input.service === 'string') {
    const binding = Object.hasOwn(SECRET_SERVICES, input.service.toLowerCase()) ? SECRET_SERVICES[input.service.toLowerCase()] : undefined
    if (!binding) throw new Error('That service is not known. Use its https origin instead.')
    return { ...structuredClone(binding), serviceId: input.service.toLowerCase() }
  }
  if (typeof input.origin !== 'string') throw new Error('Use an https origin without a path or user name.')
  let url: URL
  try { url = new URL(input.origin.replace(/:(\d+)\.(?=\/?$)/, ':$1')) } catch { throw new Error('Use an https origin without a path or user name.') }
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      url.port === '0' || (!isIP(hostname) && (!hostname.includes('.') || /(?:^|\.)(?:local|internal|localhost)$/.test(hostname))) ||
      !/^https:\/\/[^/?#\\]+\/?$/i.test(input.origin) || (isIP(hostname) && !isPublicAddress(hostname))) {
    throw new Error('Use a public https origin without a path or user name.')
  }
  const known = Object.entries(SECRET_SERVICES).find(([, binding]) => binding.origin === url.origin)
  if (known) return { ...structuredClone(known[1]), serviceId: known[0] }
  return { origin: url.origin, header: 'Authorization', format: 'Bearer {}' }
}
