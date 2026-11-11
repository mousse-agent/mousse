/**
 * A least-recently-used cache bounded by an estimate of the bytes its entries hold, not by their
 * count: a thread of short replies keeps many entries, one of huge code blocks keeps few. Reading an
 * entry makes it the newest; adding one evicts the oldest until the total fits the budget. An entry
 * larger than the whole budget is not kept.
 */
export class ByteLruCache<K, V> {
  private readonly entries = new Map<K, { value: V; bytes: number }>()
  private total = 0
  private hitCount = 0
  private missCount = 0

  constructor(readonly budgetBytes: number) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) {
      this.missCount += 1
      return undefined
    }
    this.hitCount += 1
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  /** The entry without counting a read or making it the newest. */
  peek(key: K): V | undefined {
    return this.entries.get(key)?.value
  }

  has(key: K): boolean {
    return this.entries.has(key)
  }

  set(key: K, value: V, bytes: number): void {
    // The entry it replaces is gone even when the new one is not kept.
    this.remove(key)
    if (!(bytes >= 0) || bytes > this.budgetBytes) return
    this.entries.set(key, { value, bytes })
    this.total += bytes
    for (const [oldest, entry] of this.entries) {
      if (this.total <= this.budgetBytes) break
      this.entries.delete(oldest)
      this.total -= entry.bytes
    }
  }

  delete(key: K): boolean {
    return this.remove(key)
  }

  private remove(key: K): boolean {
    const entry = this.entries.get(key)
    if (!entry) return false
    this.entries.delete(key)
    this.total -= entry.bytes
    return true
  }

  clear(): void {
    this.entries.clear()
    this.total = 0
  }

  get size(): number {
    return this.entries.size
  }

  /** The estimated bytes of every entry held now. */
  get bytes(): number {
    return this.total
  }

  get hits(): number {
    return this.hitCount
  }

  get misses(): number {
    return this.missCount
  }
}
