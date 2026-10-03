import type { Duplex } from 'node:stream'
import type { Clock, InboundInfo } from '../contracts'
import {
  PREAUTH_DEADLINE_MS,
  PREAUTH_MAX_CONNECTIONS,
  PREAUTH_MAX_PER_ADDRESS
} from '../../../shared/net'

export function inboundPrincipal(info: InboundInfo): string | undefined {
  if (!info.remoteAddress) return undefined
  return info.transport === 'relay'
    ? `relay:${info.remoteAddress}`
    : `address:${info.remoteAddress.replace(/^::ffff:/, '')}`
}

type Lease = {
  principal?: string
  timer: { cancel(): void }
  closed(): void
}

/** One profile-wide budget from carrier handoff through authenticated hello/enrollment. */
export class PreauthAdmission {
  private readonly leases = new Map<Duplex, Lease>()
  private readonly principals = new Map<string, number>()
  private readonly listeners = new Set<() => void>()
  private stopped = false
  constructor(private readonly clock: Clock) {}

  count(): number {
    return this.leases.size
  }
  canAdmit(principal?: string): boolean {
    return (
      !this.stopped &&
      this.leases.size < PREAUTH_MAX_CONNECTIONS &&
      (principal === undefined || (this.principals.get(principal) ?? 0) < PREAUTH_MAX_PER_ADDRESS)
    )
  }
  reserve(raw: Duplex, principal?: string): number | undefined {
    if (raw.destroyed || this.leases.has(raw) || !this.canAdmit(principal)) return undefined
    const deadline = this.clock.monotonic() + PREAUTH_DEADLINE_MS
    const closed = () => this.release(raw)
    const timer = this.clock.setTimeout(() => {
      raw.destroy()
      this.release(raw)
    }, PREAUTH_DEADLINE_MS)
    this.leases.set(raw, { principal, timer, closed })
    if (principal !== undefined)
      this.principals.set(principal, (this.principals.get(principal) ?? 0) + 1)
    raw.once('close', closed)
    return deadline
  }
  release(raw: Duplex): void {
    const lease = this.leases.get(raw)
    if (!lease) return
    this.leases.delete(raw)
    lease.timer.cancel()
    raw.removeListener('close', lease.closed)
    if (lease.principal !== undefined) {
      const count = this.principals.get(lease.principal)! - 1
      if (count) this.principals.set(lease.principal, count)
      else this.principals.delete(lease.principal)
    }
    for (const listener of this.listeners) listener()
  }
  onAvailable(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  close(): void {
    this.stopped = true
    for (const raw of this.leases.keys()) {
      raw.destroy()
      this.release(raw)
    }
    this.listeners.clear()
  }
}
