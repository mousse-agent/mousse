import type { MmsProfileServices } from '../MmsProfileServices'
import { keptAt, readProviderUsage, usageSlotList } from '../protocol/usageReads'
import { LIMIT_READING_STEP_MS, limitReadings } from './limitReadings'

/** How often the limits are read in the background, so their trends have a point at least this often. */
export const LIMIT_POLL_EVERY_MS = 15 * 60_000

/**
 * One light background read of the 5-hour and weekly limits every 15 minutes, for their trends. Only providers
 * with such a limit already read this month are read again (someone who never opened the page starts no reads), a provider read in
 * the last 15 minutes is skipped, and providers are read one at a time through the page's own reader, so its
 * caches, backoff and Retry-After waits apply: at most one read per provider per 15 minutes.
 */
export class LimitPoller {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private stopped = false

  constructor(
    private readonly mms: MmsProfileServices,
    private readonly read: (mms: MmsProfileServices, id: string) => Promise<unknown> = readProviderUsage,
    private readonly clock: () => number = Date.now
  ) {}

  start(): void {
    if (this.timer || this.stopped) return
    // The first read is a full interval after start, never part of it.
    this.timer = setInterval(() => { void this.tick() }, LIMIT_POLL_EVERY_MS)
    this.timer.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One round; a round still running when the next is due lets that one pass. */
  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const readings = limitReadings(this.mms.getProfileHomeDir())
      for (const slot of usageSlotList(this.mms)) {
        if (this.stopped) return
        // Signed out, or billed by key without limits: nothing to read.
        if (slot.signedOut || slot.authType === 'api_key') continue
        // Only a provider with a 5-hour or weekly limit kept this month: others have no trend to add to.
        const recorded = await readings.lastReadAt(slot.id)
        if (recorded === undefined) continue
        if (this.clock() - Math.max(recorded, keptAt(this.mms, slot.id) ?? 0) < LIMIT_READING_STEP_MS) continue
        await this.read(this.mms, slot.id).catch(() => undefined)
      }
    } catch {
      // A round that failed is tried again at the next one.
    } finally {
      this.running = false
    }
  }
}
