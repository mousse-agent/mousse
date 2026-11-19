import type { MmsProfileServices } from '../MmsProfileServices'
import { keptAt, readUsageAsPage, usageSlotList } from './usageReads'

/** How often a watched provider is read again. */
export const USAGE_WATCH_EVERY_MS = 5 * 60_000
/** How long one window's ask keeps a provider watched; a window that shows its ring asks again well within it. */
export const USAGE_WATCH_LEASE_MS = 7 * 60_000
/** A reading this close to the refresh is fresh enough: a timer a little early never reads twice in a row. */
const DUE_SLACK_MS = 30_000

/**
 * The 5-minute refresh behind a bot header's usage ring. A window asks (`providers.watchUsage`) while a header with a
 * ring for that provider is on screen, and again every few minutes; once no window has asked for a lease's length,
 * the provider is no longer read. Each watched provider is read at most once per 5 minutes, through the usage page's
 * own reads, so every provider's cache, backoff and Retry-After waits apply, and a reading the page or the background
 * reads just made counts. However many headers and windows show it, it is one read; every window hears the reading
 * as it is kept (`providers.usage`).
 */
export class UsageWatch {
  private readonly leases = new Map<string, number>()
  private readonly reading = new Map<string, Promise<void>>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly mms: MmsProfileServices,
    private readonly read: (mms: MmsProfileServices, id: string) => Promise<unknown> = readUsageAsPage,
    private readonly clock: () => number = Date.now
  ) {}

  /** Watches `providerId` for a lease's length, reading it now when its last reading is due. False: not a provider the page lists. */
  watch(providerId: string): boolean {
    if (!usageSlotList(this.mms).some((slot) => slot.id === providerId)) return false
    this.leases.set(providerId, this.clock() + USAGE_WATCH_LEASE_MS)
    if (!this.timer) {
      this.timer = setInterval(() => { void this.tick() }, USAGE_WATCH_EVERY_MS)
      this.timer.unref?.()
    }
    void this.refresh(providerId)
    return true
  }

  /** The providers watched now. */
  watched(): string[] {
    const now = this.clock()
    return [...this.leases].filter(([, until]) => until > now).map(([id]) => id)
  }

  /** One round: each provider still watched and due is read; with none left, the timer stops. */
  async tick(): Promise<void> {
    const now = this.clock()
    for (const [id, until] of this.leases) if (until <= now) this.leases.delete(id)
    if (!this.leases.size) {
      this.stop()
      return
    }
    await Promise.all([...this.leases.keys()].map((id) => this.refresh(id)))
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private refresh(id: string): Promise<void> {
    const running = this.reading.get(id)
    if (running) return running
    const at = keptAt(this.mms, id)
    if (at !== undefined && this.clock() - at < USAGE_WATCH_EVERY_MS - DUE_SLACK_MS) return Promise.resolve()
    const read = this.read(this.mms, id).then(() => undefined, () => undefined).finally(() => this.reading.delete(id))
    this.reading.set(id, read)
    return read
  }
}

const watches = new WeakMap<object, UsageWatch>()

/** The profile's usage watch, made on first use. */
export function usageWatch(mms: MmsProfileServices): UsageWatch {
  let watch = watches.get(mms)
  if (!watch) watches.set(mms, (watch = new UsageWatch(mms)))
  return watch
}
