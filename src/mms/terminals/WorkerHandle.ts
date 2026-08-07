import { EventEmitter } from 'events'

export type WorkerKind = 'pty' | 'headless'
export interface WorkerExitMetadata {
  code: number | null
  signal: string | null
  at: string
  error?: string
}

/**
 * One-shot worker ownership primitive. It makes exit observable exactly once even when a
 * caller explicitly stops the worker and the underlying process emits a later exit event.
 */
export class WorkerHandle extends EventEmitter {
  readonly startedAt = new Date().toISOString()
  private exitMetadata: WorkerExitMetadata | undefined

  constructor(readonly id: string, readonly agentId: string, readonly kind: WorkerKind) {
    super()
  }

  get alive(): boolean {
    return !this.exitMetadata
  }

  get exit(): WorkerExitMetadata | undefined {
    return this.exitMetadata
  }

  recordExit(code: number | null, signal: string | null, error?: unknown): WorkerExitMetadata {
    if (this.exitMetadata) return this.exitMetadata
    this.exitMetadata = {
      code,
      signal,
      at: new Date().toISOString(),
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {})
    }
    this.emit('exit', this.exitMetadata)
    return this.exitMetadata
  }
}
