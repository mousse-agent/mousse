import type { BrowserErrorCode } from '../shared/browser/types'

export class BrowserWorkerError extends Error {
  readonly code: BrowserErrorCode
  constructor(code: BrowserErrorCode, message: string) {
    super(message)
    this.name = 'BrowserWorkerError'
    this.code = code
  }
}

export function isBrowserWorkerError(value: unknown): value is BrowserWorkerError {
  return value instanceof BrowserWorkerError
}

export function fail(code: BrowserErrorCode, message: string): never {
  throw new BrowserWorkerError(code, message)
}
