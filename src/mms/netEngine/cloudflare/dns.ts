import { Resolver } from 'node:dns/promises'
import { setTimeout as delay } from 'node:timers/promises'

const PUBLICATION_WAIT_MS = 60_000

/** Check the authority before a new hostname can be cached as missing by the system resolver. */
export async function waitForCloudflareDns(hostname: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const resolver = new Resolver({ timeout: 1_500, tries: 1 })
  const cancel = () => resolver.cancel()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const zone = hostname.slice(hostname.indexOf('.') + 1)
    const nameservers = await resolver.resolveNs(zone)
    const authority = nameservers.find((name) => /\.ns\.cloudflare\.com\.?$/i.test(name))
    if (!authority) return
    resolver.setServers(await resolver.resolve4(authority))
    const until = Date.now() + PUBLICATION_WAIT_MS
    do {
      signal.throwIfAborted()
      const replies = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)])
      if (replies.some((reply) => reply.status === 'fulfilled' && reply.value.length)) return
      const awaitingPublication = replies.every((reply) => reply.status === 'rejected' &&
        ['ENOTFOUND', 'ENODATA'].includes((reply.reason as NodeJS.ErrnoException)?.code ?? ''))
      if (!awaitingPublication) return
      await delay(1_000, undefined, { signal, ref: false })
    } while (Date.now() < until)
  } catch {
    // Some networks allow DNS only through their configured resolver. The
    // normal identity-pinned probe can still run there.
    signal.throwIfAborted()
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
