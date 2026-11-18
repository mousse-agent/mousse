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
      (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 2))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113))
  }
  if (isIP(address) !== 6) return false
  const n = new Address6(address).bigInt()
  // Only ordinary global unicast. Exclude Teredo, documentation and 6to4 entirely.
  return (n >> 125n) === 1n && (n >> 96n) !== 0x20010000n && (n >> 96n) !== 0x20010db8n && (n >> 112n) !== 0x2002n
}

/** One resolution and one pinned connection, with no ambient agent, redirects, cookies or credentials. */
export async function publicFetch(value: string): Promise<PublicResponse> {
  const url = publicUrl(value)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('The page took more than 15 seconds.')), 15_000)
  try {
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))
    const addresses = await Promise.race([isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }]) : lookup(hostname, { all: true }), aborted])
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error('The page must resolve only to public addresses.')
    const pinned = addresses[0]!
    return await new Promise<PublicResponse>((resolve, reject) => {
      const req = (url.protocol === 'https:' ? https : http).request({
        protocol: url.protocol, hostname, port: url.port || undefined, path: url.pathname + url.search,
        method: 'GET', agent: false, servername: isIP(hostname) ? undefined : hostname,
        headers: { host: url.host, 'user-agent': 'Mousse', accept: 'text/html, text/plain' },
        signal: controller.signal,
        lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family)
      }, res => {
        const status = res.statusCode ?? 0
        if (status < 200 || status >= 300) {
          let reason = `The page returned HTTP ${status}.`
          if (status >= 300 && status < 400 && res.headers.location) {
            try { reason = `it moved to ${new URL(res.headers.location, url).host}` } catch { reason = 'The page returned an invalid redirect.' }
          }
          res.destroy(); reject(new Error(reason)); return
        }
        const chunks: Buffer[] = []; let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 2 * 1024 * 1024) { req.destroy(new Error('The page exceeds 2 MiB.')); return }
          chunks.push(chunk)
        })
        res.on('error', reject)
        res.on('aborted', () => reject(new Error('The page response was interrupted.')))
        res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }))
      })
      req.on('error', reject)
      req.end()
    })
  } finally { clearTimeout(timer) }
}
