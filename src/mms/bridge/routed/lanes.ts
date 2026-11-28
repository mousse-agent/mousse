import { DomainRpcError } from '../../protocol/domainRegistry'

/**
 * At most `size` pieces of work at once per key (a computer); the rest wait in turn, and stop waiting when their call
 * ends. For transfers that must not crowd out other calls to the same computer: a bot's files.
 */
export class Lanes {
  private readonly held = new Map<string, { running: number; waiting: Array<() => void> }>()
  constructor(private readonly size: number) {}

  /** Waits for room under `key`; answers what gives it back. */
  async enter(key: string, signal?: AbortSignal): Promise<() => void> {
    let lane = this.held.get(key)
    if (!lane) {
      lane = { running: 0, waiting: [] }
      this.held.set(key, lane)
    }
    const at = lane
    while (at.running >= this.size) {
      if (signal?.aborted) throw new DomainRpcError('cancelled', 'Cancelled.')
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          signal?.removeEventListener('abort', wake)
          const index = at.waiting.indexOf(wake)
          if (index >= 0) at.waiting.splice(index, 1)
          resolve()
        }
        signal?.addEventListener('abort', wake, { once: true })
        at.waiting.push(wake)
      })
    }
    if (signal?.aborted) throw new DomainRpcError('cancelled', 'Cancelled.')
    at.running += 1
    let done = false
    return () => {
      if (done) return
      done = true
      at.running -= 1
      at.waiting.shift()?.()
      if (!at.running && !at.waiting.length) this.held.delete(key)
    }
  }
}
