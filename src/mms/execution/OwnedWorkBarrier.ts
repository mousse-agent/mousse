/** Tracks actual promise settlement separately from an abort request or a UI running flag. */
export class OwnedWorkBarrier {
  private readonly controller = new AbortController()
  private readonly active = new Map<symbol, string>()
  private readonly idleListeners = new Set<() => void>()

  get signal(): AbortSignal { return this.controller.signal }
  get stopping(): boolean { return this.signal.aborted }
  get count(): number { return this.active.size }
  snapshot(): Record<string, number> {
    const result: Record<string, number> = Object.create(null)
    for (const label of this.active.values()) result[label] = (result[label] ?? 0) + 1
    return result
  }

  assertAccepting(): void {
    if (this.stopping) throw Object.assign(new Error('Profile work is shutting down'), { code: 'profile_draining' })
  }

  run<T>(label: string, work: () => T | Promise<T>): Promise<T> {
    this.assertAccepting()
    const identity = Symbol(label)
    this.active.set(identity, label)
    const release = (): void => {
      this.active.delete(identity)
      if (!this.active.size) for (const listener of [...this.idleListeners]) listener()
    }
    try { return Promise.resolve(work()).finally(release) }
    catch (error) { release(); return Promise.reject(error) }
  }

  beginShutdown(): void {
    if (!this.stopping) this.controller.abort(new DOMException('Profile shutdown', 'AbortError'))
  }

  /** A timeout never clears ownership or permits an archive/removal to proceed. */
  waitForIdle(timeoutMs = 30_000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return Promise.reject(new Error('Invalid shutdown timeout'))
    if (!this.active.size) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const idle = (): void => { clearTimeout(timer); this.idleListeners.delete(idle); resolve() }
      const timer = setTimeout(() => {
        this.idleListeners.delete(idle)
        reject(Object.assign(new Error('Profile work did not finish before the shutdown deadline'), { code: 'profile_busy', details: this.snapshot() }))
      }, timeoutMs)
      this.idleListeners.add(idle)
      if (!this.active.size) idle()
    })
  }
}
