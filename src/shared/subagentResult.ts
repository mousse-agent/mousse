/**
 * What a finished subagent or workflow agent left, reported to the agent that started it. Mousse never merges it:
 * the files are kept as two snapshots under `refs/mousse/`, and the parent agent brings them in with Git.
 */
export interface SubagentResultReport {
  /** The folder it worked in. */
  workedIn: string
  /** True when it worked in the parent's own folder instead of a worktree of its own. */
  shared: boolean
  /** The files it started from: a snapshot or a commit. */
  baseSha: string
  /** The files it finished with: a snapshot or a commit. */
  resultSha: string
  /** Refs under `refs/mousse/` that keep `baseSha` and `resultSha`; they outlive the worktree. */
  baseRef?: string
  resultRef?: string
  /** Files that differ between the base and the result; `changedFiles` lists the first few. */
  changedFileCount: number
  changedFiles: string[]
  /** The Git state it left: the branch HEAD was on (absent when detached), HEAD, and the commits it added. */
  git: {
    branch?: string
    head?: string
    /** First-parent commits from where it started to HEAD, oldest first: the latest `REPORT_COMMIT_LIMIT` of `commitCount`. */
    commits: Array<{ sha: string; subject: string }>
    commitCount: number
    /** HEAD no longer contains the commit it started on (a reset or rebase). */
    rewroteHistory?: boolean
  }
}
