export type RunStoreErrorCode =
  | 'storage_full'
  | 'storage_corrupt'
  | 'stale_write'
  | 'bad_request'
  | 'internal'
  | 'conflict'
  | 'downgrade_unsupported'

export class RunStoreError extends Error {
  readonly code: RunStoreErrorCode

  constructor(code: RunStoreErrorCode, message?: string, options?: { cause?: unknown }) {
    super(
      message ?? `Run storage error: ${code}.`,
      options?.cause === undefined ? undefined : { cause: options.cause }
    )
    this.name = 'RunStoreError'
    this.code = code
  }
}

export function fail(code: RunStoreErrorCode, message: string): never {
  throw new RunStoreError(code, message)
}

/**
 * A command the engine refuses for a stated reason (SPEC §16: `run_not_forkable`,
 * `fork_not_completed`, `merge_back_pending`, ...). Protocol handlers report `reason` as the error
 * code. Not a storage failure: nothing was written.
 */
export class CommandRejection extends Error {
  constructor(
    readonly reason: string,
    message?: string
  ) {
    super(message ?? reason)
    this.name = 'CommandRejection'
  }
}

export function reject(reason: string, message?: string): never {
  throw new CommandRejection(reason, message)
}
