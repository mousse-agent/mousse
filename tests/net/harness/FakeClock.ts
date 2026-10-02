import type { Clock } from '../../../src/mms/net/contracts'

/** Deterministic wall/monotonic clock. Wall-clock skew never changes timer order. */
export class FakeClock implements Clock {
  private tick = 0
  private wall: number
  private nextId = 0
  private timers = new Map<number, { at: number; callback: () => void }>()
  constructor(wall = 1_790_942_400_000) { this.wall = wall }
  now(): number { return this.wall }
  monotonic(): number { return this.tick }
  setWallTime(now: number): void { this.wall = now }
  setTimeout(callback: () => void, ms: number): { cancel(): void } {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('Invalid timer delay')
    const id = ++this.nextId
    this.timers.set(id, { at: this.tick + ms, callback })
    return { cancel: () => { this.timers.delete(id) } }
  }
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('Invalid advance')
    const until = this.tick + ms
    let calls = 0
    while (true) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!next || next[1].at > until) break
      if (++calls > 100_000) throw new Error('Timer loop did not converge')
      this.wall += next[1].at - this.tick
      this.tick = next[1].at
      this.timers.delete(next[0])
      next[1].callback()
    }
    this.wall += until - this.tick
    this.tick = until
  }
  pending(): number { return this.timers.size }
}
