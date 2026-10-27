import { createHash, randomUUID } from 'node:crypto'
import { NetError, type NodeId } from '../../../shared/net'
import {
  ROUTED_PAGES_CALLER_BYTES,
  ROUTED_PAGES_PER_CALLER,
  ROUTED_PAGES_TTL_MS,
  ROUTED_PAGE_BYTES,
  isRoutedReply,
  type RoutedPage,
  type RoutedPaged,
  type RoutedReply
} from '../../../shared/bridge/routed'
import type { Clock } from '../../net/contracts'

/** Every caller's held results together; a busy owner never keeps more than this for readers. */
const ALL_CALLERS_BYTES = 128 * 1024 * 1024

interface Held {
  caller: NodeId
  bytes: Buffer
  expiresAt: number
}

/**
 * Results of routed reads that did not fit one RPC reply. The owner serializes the reply once,
 * keeps it in memory (a read leaves nothing on disk) for a minute, and the caller fetches it in
 * pages with `routed.page`. Each caller holds at most four results and 32 MiB; a newer result
 * pushes out its oldest, so a caller that walks away cannot block itself.
 */
export class ReplyPages {
  private readonly held = new Map<string, Held>()
  private total = 0
  constructor(private readonly clock: Pick<Clock, 'now'>) {}

  /** Keeps `reply` for `caller` and says how to fetch it. */
  hold(caller: NodeId, reply: RoutedReply): RoutedPaged {
    const bytes = Buffer.from(JSON.stringify(reply))
    if (bytes.length > ROUTED_PAGES_CALLER_BYTES) throw new NetError('too_large')
    this.expire()
    const mine = (): Array<[string, Held]> =>
      [...this.held].filter(([, entry]) => entry.caller === caller)
    let own = mine()
    while (
      own.length >= ROUTED_PAGES_PER_CALLER ||
      own.reduce((sum, [, entry]) => sum + entry.bytes.length, 0) + bytes.length >
        ROUTED_PAGES_CALLER_BYTES
    ) {
      this.drop(own[0][0])
      own = mine()
    }
    while (this.total + bytes.length > ALL_CALLERS_BYTES && this.held.size)
      this.drop(this.held.keys().next().value!)
    const id = randomUUID()
    this.held.set(id, { caller, bytes, expiresAt: this.clock.now() + ROUTED_PAGES_TTL_MS })
    this.total += bytes.length
    return {
      id,
      bytes: bytes.length,
      pages: Math.max(1, Math.ceil(bytes.length / ROUTED_PAGE_BYTES)),
      sha256: createHash('sha256').update(bytes).digest('hex')
    }
  }

  /** One page of a result `caller` holds; absent when it expired, was pushed out or is another caller's. */
  page(caller: NodeId, id: string, index: number): RoutedPage | undefined {
    this.expire()
    const entry = this.held.get(id)
    if (!entry || entry.caller !== caller) return undefined
    const start = index * ROUTED_PAGE_BYTES
    if (!Number.isSafeInteger(index) || index < 0 || start >= Math.max(1, entry.bytes.length))
      return undefined
    return {
      index,
      data: entry.bytes.subarray(start, start + ROUTED_PAGE_BYTES).toString('base64')
    }
  }

  /** The caller is gone (blocked, or its session ended): what it held goes with it. */
  dropCaller(caller: NodeId): void {
    for (const [id, entry] of [...this.held]) if (entry.caller === caller) this.drop(id)
  }

  heldCount(caller?: NodeId): number {
    this.expire()
    return [...this.held.values()].filter((entry) => !caller || entry.caller === caller).length
  }

  private expire(): void {
    const now = this.clock.now()
    for (const [id, entry] of [...this.held]) if (entry.expiresAt <= now) this.drop(id)
  }
  private drop(id: string): void {
    const entry = this.held.get(id)
    if (!entry) return
    this.held.delete(id)
    this.total -= entry.bytes.length
  }
}

/**
 * Puts a paged reply back together: fetches every page with `fetchPage`, checks the length and the
 * hash, and returns the reply the owner held. A failure is thrown, never a partial reply.
 */
export async function reassemblePagedReply(
  paged: RoutedPaged,
  fetchPage: (id: string, index: number) => Promise<RoutedPage>
): Promise<RoutedReply> {
  const parts: Buffer[] = []
  let received = 0
  for (let index = 0; index < paged.pages; index += 1) {
    const page = await fetchPage(paged.id, index)
    if (page.index !== index) throw new NetError('bad_request', 'A page came out of order.')
    const bytes = Buffer.from(page.data, 'base64')
    received += bytes.length
    if (received > paged.bytes) throw new NetError('bad_request', 'A paged reply is too long.')
    parts.push(bytes)
  }
  if (received !== paged.bytes) throw new NetError('bad_request', 'A paged reply is too short.')
  const whole = Buffer.concat(parts)
  if (createHash('sha256').update(whole).digest('hex') !== paged.sha256)
    throw new NetError('bad_request', 'A paged reply does not match its hash.')
  const reply: unknown = JSON.parse(whole.toString('utf8'))
  if (!isRoutedReply(reply)) throw new NetError('bad_request', 'A paged reply is not a reply.')
  return reply
}
