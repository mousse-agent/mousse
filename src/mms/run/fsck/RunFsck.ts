/**
 * Run Engine consistency checker. Inspects a profile's run state and reports findings such as
 * orphaned non-terminal runs, attempt/run status disagreement, dangling active attempts,
 * thread event sequence gaps and receipts for unknown runs. See docs/run-engine/SPEC.md §7.
 *
 * Phase 0 is a skeleton: the finding shape is final, but no checks are implemented yet.
 */

export interface FsckFinding {
  code: string
  severity: 'error' | 'warning'
  message: string
  details?: Record<string, unknown>
}

export interface RunFsckOptions {
  /** Root of the profile whose run state is checked (holds the profile database). */
  profileHome: string
}

export class RunFsck {
  readonly profileHome: string

  constructor(opts: RunFsckOptions) {
    this.profileHome = opts.profileHome
  }

  check(): FsckFinding[] {
    return []
  }
}
