import { isIP } from 'node:net'

/**
 * The loopback addresses an address names, or undefined when it names anything else.
 *
 * An editor's port forwards (`direct-tcpip`, which `-L`, `-D` and `-W` all use) and remote forwards (`-R`) may
 * only touch this computer's own loopback. The test is on the text of the address alone, and a name is never
 * looked up: `localhost` is mapped here to `127.0.0.1` and `::1`, so no name can be made to resolve to a
 * loopback address (or away from one) by whoever controls a resolver, and nothing is sent to a resolver.
 */
export function loopbackTargets(host: unknown): string[] | undefined {
  if (typeof host !== 'string') return undefined
  const text = host.replace(/^\[|\]$/gu, '')
  if (text.toLowerCase() === 'localhost') return ['127.0.0.1', '::1']
  const version = isIP(text)
  if (version === 4) return text.split('.')[0] === '127' ? [text] : undefined
  if (version !== 6) return undefined
  // The URL parser writes every spelling of an IPv6 address one way (`0:0:0:0:0:0:0:1` is `[::1]`, and
  // `::ffff:127.0.0.1` is `[::ffff:7f00:1]`), which is easier to test than the many spellings.
  let canonical: string
  try {
    canonical = new URL(`http://[${text}]/`).hostname
  } catch {
    return undefined
  }
  if (canonical === '[::1]') return ['::1']
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/u.exec(canonical)
  if (!mapped) return undefined
  const high = parseInt(mapped[1]!, 16)
  const low = parseInt(mapped[2]!, 16)
  return high >> 8 === 127 ? [`127.${high & 0xff}.${low >> 8}.${low & 0xff}`] : undefined
}

/** A TCP port a forward may name. */
export const isForwardPort = (port: unknown): port is number =>
  typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536
