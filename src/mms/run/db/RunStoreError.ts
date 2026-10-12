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
