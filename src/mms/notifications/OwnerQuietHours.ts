import type { QuietHours } from '../../shared/settings'

export const APP_PRESENCE_CAPABILITY = 'app.presence.v1'
export const ACTIVE_FOR_MS = 15 * 60_000

/** Profile-owned activity. Nothing in a model's turn is allowed to report it. Reset on service restart. */
export class OwnerQuietHours {
  private readonly reports = new Map<string, number>()
  private activeAt = -Infinity
  private zone?: string
  private zoneAt = -Infinity
  constructor(private readonly setting: () => QuietHours | undefined,
    private readonly clock: () => number = Date.now,
    private readonly computerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone) {}

  reportPresence(connection: string, at: number, zone: string): void {
    const now = this.clock()
    if (now - (this.reports.get(connection) ?? -Infinity) < 60_000) return
    for (const [id, last] of this.reports) if (now - last >= 60_000) this.reports.delete(id)
    this.reports.set(connection, now)
    this.report(at, zone)
  }
  ownerZone(): string { return this.zone ?? this.computerZone() }
  active(): boolean { return this.clock() - this.activeAt < ACTIVE_FOR_MS }
  report(at = this.clock(), zone?: string): void {
    const now = this.clock()
    // Device clocks cannot keep the owner active indefinitely or move activity backwards.
    const accepted = Math.min(now, at)
    this.activeAt = Math.max(this.activeAt, accepted)
    if (zone && accepted >= this.zoneAt) {
      new Intl.DateTimeFormat('en', { timeZone: zone }).format(now)
      this.zone = zone
      this.zoneAt = accepted
    }
  }

  /** The only reader of the wish. End is an instant; schedules continue using the computer's clock. */
  quietHoursFor(_botId?: string, at = this.clock()): { end: number } | undefined {
    const hours = this.setting()
    if (!hours || hours.from === hours.to) return undefined
    const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: this.ownerZone(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    const inside = (time: number): boolean => {
      const local = formatter.format(time)
      return hours.from < hours.to ? local >= hours.from && local < hours.to : local >= hours.from || local < hours.to
    }
    if (!inside(at)) return undefined
    // Walk real minutes, not local dates: a skipped end releases at the gap's end; an overlapping end
    // releases at its first occurrence. This also handles half-hour transitions and midnight changes.
    let end = Math.floor(at / 60_000) * 60_000 + 60_000
    const limit = end + 48 * 3600_000
    while (end < limit && inside(end)) end += 60_000
    return { end }
  }
}
