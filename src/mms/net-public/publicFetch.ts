import { secretFetchTestAddress } from './secretFetchTestAddress'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import * as http from 'node:http'
import * as https from 'node:https'
import { Address6 } from 'ip-address'

export interface PublicResponse { status: number; headers: http.IncomingHttpHeaders; body: Buffer }
export function publicUrl(value: string): URL {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an http or https page without credentials.')
  return url
}

/** Conservative global-unicast allowlist: transition, mapped and special-purpose ranges cannot tunnel to local hosts. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113))
  }
  if (isIP(address) !== 6) return false
  const n = new Address6(address).bigInt()
  // Only ordinary global unicast. Exclude Teredo, documentation and 6to4 entirely.
  return (n >> 125n) === 1n && !((n >> 96n) >= 0x20010000n && (n >> 96n) <= 0x200101ffn) && (n >> 96n) !== 0x20010db8n && (n >> 112n) !== 0x2002n && (n >> 112n) !== 0x3fffn
}

class ConnectionFailure extends Error {}

/** One resolution and pinned connections, with no ambient agent, redirects, cookies or credentials. */
export interface PublicFetchOptions {
  method?: 'GET' | 'HEAD'
  headers?: Record<string, string>
  /** Authenticated service reads return all statuses, with a 30s / 5 MiB limit. */
  secretRead?: boolean
  signal?: AbortSignal
}
export async function publicFetch(value: string, options: PublicFetchOptions = {}): Promise<PublicResponse> {
  const url = publicUrl(value)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const controller = new AbortController()
  const timeout = options.secretRead ? 30_000 : 15_000
  const limit = options.secretRead ? 5 * 1024 * 1024 : 2 * 1024 * 1024
  const abort = () => controller.abort(new Error('The request stopped.'))
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  const timer = setTimeout(() => controller.abort(new Error(options.secretRead ? 'The request took more than 30 seconds.' : 'The page took more than 15 seconds.')), timeout)
  try {
    if (controller.signal.aborted) throw controller.signal.reason
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))
    const trialAddress = options.secretRead ? secretFetchTestAddress(hostname) : undefined
    const addresses = await Promise.race([trialAddress ? Promise.resolve([trialAddress]) : isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }]) : lookup(hostname, { all: true }), aborted])
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address) && address !== trialAddress?.address)) throw new Error('The page must resolve only to public addresses.')
    let lastError: unknown
    for (const pinned of addresses) {
      if (controller.signal.aborted) throw controller.signal.reason
      if (!isPublicAddress(pinned.address) && pinned.address !== trialAddress?.address) throw new Error('The page must resolve only to public addresses.')
      try { return await new Promise<PublicResponse>((resolve, reject) => {
      let responded = false
      const req = (url.protocol === 'https:' ? https : http).request({
        protocol: url.protocol, hostname, port: url.port || undefined, path: url.pathname + url.search,
        method: options.method ?? 'GET', agent: false, family: pinned.family, servername: isIP(hostname) ? undefined : hostname,
        headers: { host: url.host, 'user-agent': 'Mousse', accept: options.secretRead ? 'application/json, text/plain;q=0.9, */*;q=0.8' : 'text/html, text/plain', ...options.headers },
        signal: controller.signal,
        lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family)
      }, res => {
        responded = true
        const status = res.statusCode ?? 0
        if (!options.secretRead && (status < 200 || status >= 300)) {
          let reason = `The page returned HTTP ${status}.`
          if (status >= 300 && status < 400 && res.headers.location) {
            try { reason = `it moved to ${new URL(res.headers.location, url).host}` } catch { reason = 'The page returned an invalid redirect.' }
          }
          res.destroy(); reject(new Error(reason)); return
        }
        const chunks: Buffer[] = []; let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > limit) { req.destroy(new Error(options.secretRead ? 'The response exceeds 5 MiB.' : 'The page exceeds 2 MiB.')); return }
          chunks.push(chunk)
        })
        res.on('error', error => reject(controller.signal.aborted ? controller.signal.reason : error))
        res.on('aborted', () => reject(controller.signal.aborted ? controller.signal.reason : new Error('The page response was interrupted.')))
        res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }))
      })
      req.on('error', error => reject(controller.signal.aborted ? controller.signal.reason : !responded ? new ConnectionFailure(error.message, { cause:error }) : error))
      req.end()
    }) } catch (error) {
      if (!(error instanceof ConnectionFailure)) throw error
      lastError = error
    }
    }
    throw lastError
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) }
}

/** Only controlled clauses reach the owner; transport diagnostics stay out of chat. */
export function pageFailureReason(error: unknown): string {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
  if (typeof error === 'string' && (['the response was interrupted', 'it could not be reached', "its certificate isn't valid", 'it took more than 15 seconds', 'it exceeds 2 MiB', 'it must resolve only to public addresses', 'it returned an invalid redirect'].includes(message) || /^it returned HTTP \d+$/.test(message))) return message
  const certificateCodes = new Set([
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
    'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY', 'ERROR_IN_CERT_NOT_BEFORE_FIELD',
    'ERROR_IN_CERT_NOT_AFTER_FIELD', 'INVALID_CA', 'INVALID_PURPOSE',
    'PATH_LENGTH_EXCEEDED', 'HOSTNAME_MISMATCH'
  ])
  // The pinned-connection wrapper keeps the original Node error as its cause.
  const seen = new Set<object>()
  let cause: unknown = error
  while (cause && typeof cause === 'object' && !seen.has(cause)) {
    seen.add(cause)
    const { code, cause: next } = cause as { code?: unknown; cause?: unknown }
    if (typeof code === 'string' && (/^(?:CERT_|ERR_TLS_CERT_)/.test(code) || certificateCodes.has(code))) return "its certificate isn't valid"
    cause = next
  }
  if (message === 'The page response was interrupted.') return 'the response was interrupted'
  const status = /^The page returned HTTP (\d+)\.$/.exec(message)
  if (status) return `it returned HTTP ${status[1]}`
  if (message === 'The page took more than 15 seconds.') return 'it took more than 15 seconds'
  if (message === 'The page exceeds 2 MiB.') return 'it exceeds 2 MiB'
  if (message === 'The page must resolve only to public addresses.') return 'it must resolve only to public addresses'
  if (message === 'The page returned an invalid redirect.') return 'it returned an invalid redirect'
  if (/^it moved to [^\s]+$/.test(message)) return message
  return 'it could not be reached'
}
