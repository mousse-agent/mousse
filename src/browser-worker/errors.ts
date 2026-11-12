import type { BrowserErrorCode } from '../shared/browser/types'
import { BROWSER_PROBLEM_CODES, browserProblemMessage, type BrowserProblem } from '../shared/browser/navigation'

export class BrowserWorkerError extends Error {
  readonly code: BrowserErrorCode
  /** A failed navigation's class and Chromium's own code. */
  readonly problem?: BrowserProblem
  constructor(code: BrowserErrorCode, message: string, problem?: BrowserProblem) {
    super(message)
    this.name = 'BrowserWorkerError'
    this.code = code
    if (problem) this.problem = problem
  }
}

export function isBrowserWorkerError(value: unknown): value is BrowserWorkerError {
  return value instanceof BrowserWorkerError
}

export function fail(code: BrowserErrorCode, message: string): never {
  throw new BrowserWorkerError(code, message)
}

/** Fails with a navigation problem's class, its plain message and what to do next. */
export function failProblem(problem: BrowserProblem): never {
  throw new BrowserWorkerError(BROWSER_PROBLEM_CODES[problem.kind], browserProblemMessage(problem), problem)
}
