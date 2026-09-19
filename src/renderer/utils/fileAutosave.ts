export type ExternalReconciliation =
  | { kind: 'unchanged' }
  | { kind: 'replace'; content: string }
  | { kind: 'conflict'; diskContent: string }

/** Decide how a polling read may be applied without ever discarding editor bytes. */
export function reconcileExternalContent(savedContent: string, localContent: string, diskContent: string): ExternalReconciliation {
  if (diskContent === savedContent) return { kind: 'unchanged' }
  if (localContent === savedContent) return { kind: 'replace', content: diskContent }
  return { kind: 'conflict', diskContent }
}

export interface AutosaveAttempt {
  content: string
  baseline: string
}

interface SerializedAutosaveOptions {
  read: () => Promise<string>
  write: (content: string) => Promise<void>
  onSaved: (content: string) => void
  onConflict: (diskContent: string) => void
  onError: (error: unknown) => void
  delay?: number
}

/**
 * A trailing debounce with one writer. Every write is preceded by a disk read,
 * preventing a known external update from being silently overwritten.
 */
export class SerializedAutosave {
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: AutosaveAttempt | undefined
  private running: Promise<void> | undefined
  private disposed = false

  constructor(private readonly options: SerializedAutosaveOptions) {}

  schedule(attempt: AutosaveAttempt): void {
    if (this.disposed) return
    this.pending = attempt
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.drain()
    }, this.options.delay ?? 650)
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    await this.drain()
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.pending = undefined
  }

  dispose(): void {
    this.disposed = true
    this.cancel()
  }

  private async drain(): Promise<void> {
    if (this.running) {
      await this.running
      if (this.pending) await this.drain()
      return
    }
    const attempt = this.pending
    this.pending = undefined
    if (!attempt || this.disposed) return
    this.running = this.perform(attempt)
    await this.running
    this.running = undefined
    if (this.pending) await this.drain()
  }

  private async perform(attempt: AutosaveAttempt): Promise<void> {
    try {
      const diskContent = await this.options.read()
      if (diskContent !== attempt.baseline) {
        this.pending = undefined
        this.options.onConflict(diskContent)
        return
      }
      await this.options.write(attempt.content)
      this.options.onSaved(attempt.content)
    } catch (error) {
      this.options.onError(error)
    }
  }
}
