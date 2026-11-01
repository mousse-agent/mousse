import { existsSync, readFileSync } from 'node:fs'
import type { SubagentResultReport } from '../../shared/subagentResult'
import type { ThreadAction } from '../../shared/threadActions'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { git, tryGit } from '../actions/git'
import { snapshotOrigin } from '../actions/snapshots'

export type { SubagentResultReport } from '../../shared/subagentResult'

/** Commits a report lists by name; the rest are counted. */
export const REPORT_COMMIT_LIMIT = 20
/** Changed files a report names; the rest are counted. */
const REPORT_FILE_LIMIT = 10

export interface SubagentResultInput {
  /** Any folder of the repository that holds both revisions. */
  cwd: string
  workedIn: string
  shared: boolean
  baseSha: string
  resultSha: string
  /** Refs to keep the two revisions under. Each is written to point at its revision. */
  pins?: { base?: string; result?: string }
}

/**
 * Freezes what a subagent left: it pins the base and the result under `refs/mousse/` and reads the Git state the
 * result was taken on from the snapshot itself (its HEAD and branch), so the report says the same whatever the
 * worktree does next. It writes only the two pins: nothing in the parent's or the subagent's checkout changes.
 */
export function buildSubagentResultReport(input: SubagentResultInput): SubagentResultReport {
  const { cwd } = input
  const baseSha = git(cwd, ['rev-parse', '--verify', `${input.baseSha}^{commit}`])
  const resultSha = git(cwd, ['rev-parse', '--verify', `${input.resultSha}^{commit}`])
  if (input.pins?.base) git(cwd, ['update-ref', '--no-deref', input.pins.base, baseSha])
  if (input.pins?.result) git(cwd, ['update-ref', '--no-deref', input.pins.result, resultSha])
  const changed = baseSha === resultSha ? [] : git(cwd, ['diff', '--name-only', '--no-renames', baseSha, resultSha]).split(/\r?\n/).filter(Boolean)
  const after = snapshotOrigin(cwd, resultSha)
  const startHead = snapshotOrigin(cwd, baseSha).head ?? baseSha
  let commits: Array<{ sha: string; subject: string }> = []
  let commitCount = 0
  let rewroteHistory = false
  if (after.head && after.head !== startHead) {
    if (tryGit(cwd, ['merge-base', '--is-ancestor', startHead, after.head]).ok) {
      commitCount = Number(git(cwd, ['rev-list', '--count', '--first-parent', `${startHead}..${after.head}`])) || 0
      const listed = git(cwd, ['log', '--first-parent', '--format=%H%x00%s', `-n${REPORT_COMMIT_LIMIT}`, `${startHead}..${after.head}`])
      commits = listed.split(/\r?\n/).filter(Boolean).map((line) => { const [sha, subject] = line.split('\0'); return { sha: sha!, subject: subject ?? '' } }).reverse()
    } else rewroteHistory = true
  }
  return {
    workedIn: input.workedIn,
    shared: input.shared,
    baseSha,
    resultSha,
    ...(input.pins?.base ? { baseRef: input.pins.base } : {}),
    ...(input.pins?.result ? { resultRef: input.pins.result } : {}),
    changedFileCount: changed.length,
    changedFiles: changed.slice(0, REPORT_FILE_LIMIT),
    git: { ...(after.branch ? { branch: after.branch } : {}), ...(after.head ? { head: after.head } : {}), commits, commitCount, ...(rewroteHistory ? { rewroteHistory } : {}) }
  }
}

/** Where a delegated task's base and result are pinned: `<prefix>/base` and `<prefix>/result`. A ref name cannot hold `:`. */
export function delegationResultRefPrefix(childThreadId: string, delegationId: string): string {
  return `refs/mousse/delegations/${childThreadId}/${delegationId.replace(/[^A-Za-z0-9._-]/g, '-')}`
}

/** The file in a subagent's thread folder that keeps each delegated task's frozen result. */
export const SUBAGENT_RESULTS_FILE = 'subagent-results.json'

export interface StoredSubagentResult {
  delegationId: string
  repositoryId?: string
  report: SubagentResultReport
}

/** The results kept in `path`; an absent or unreadable file holds none. */
export function readSubagentResults(path: string): StoredSubagentResult[] {
  try {
    if (!existsSync(path)) return []
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(value) ? value.filter((row): row is StoredSubagentResult => Boolean(row) && typeof row === 'object' && typeof (row as StoredSubagentResult).delegationId === 'string' && Boolean((row as StoredSubagentResult).report)) : []
  } catch { return [] }
}

export function writeSubagentResults(path: string, rows: StoredSubagentResult[]): void {
  atomicWriteJsonSync(path, rows)
}

/**
 * The files a thread's turn records say its folder held at `at`: the end of the last turn finished by then, or the
 * start of the one running then. Undefined before its first record.
 */
export function recordedFilesAt(actions: ReadonlyArray<Pick<ThreadAction, 'createdAt' | 'completedAt' | 'startSha' | 'endSha' | 'scope'>>, at: string): string | undefined {
  const turns = actions.filter((action) => action.scope !== 'conversation' && action.createdAt <= at).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const last = turns.at(-1)
  if (!last) return undefined
  return last.completedAt && last.completedAt <= at && last.endSha ? last.endSha : last.startSha
}

const short = (sha: string): string => sha.slice(0, 12)

/** The report as the plain text the parent agent reads, with how to bring the result in with Git. */
export function formatSubagentResultReport(report: SubagentResultReport): string {
  const lines: string[] = []
  lines.push(report.shared
    ? `Worked in: ${report.workedIn} (your own folder, shared with you; its changes are already in your files, mixed with yours).`
    : `Worked in: ${report.workedIn} (its own worktree).`)
  const names = report.changedFiles.join(', ') + (report.changedFileCount > report.changedFiles.length ? `, and ${report.changedFileCount - report.changedFiles.length} more` : '')
  lines.push(report.changedFileCount === 0
    ? 'Files: no change from where it started.'
    : `Files: ${report.changedFileCount} changed (${names}).`)
  const pinned = report.baseRef && report.resultRef ? `, kept as ${report.baseRef} and ${report.resultRef}` : ''
  lines.push(`Snapshots: base ${report.baseSha}, result ${report.resultSha}${pinned}.`)
  const where = report.git.head ? `${report.git.branch ? `on branch ${report.git.branch}` : 'on a detached HEAD'} at ${short(report.git.head)}` : 'with no commit'
  const history = report.git.rewroteHistory
    ? 'HEAD no longer contains the commit it started on.'
    : report.git.commitCount === 0
      ? 'It made no commits.'
      : `It made ${report.git.commitCount} commit(s): ${report.git.commits.map((commit) => `${short(commit.sha)} ${commit.subject}`).join('; ')}${report.git.commitCount > report.git.commits.length ? '; …' : ''}.`
  lines.push(`Git: ${where}. ${history}`)
  if (report.shared) lines.push('Mousse merged nothing.')
  else if (report.changedFileCount > 0) lines.push(`Mousse merged nothing. To bring the files in: git diff --binary ${report.baseSha} ${report.resultSha} | git apply --3way${report.git.commitCount > 0 && !report.git.rewroteHistory ? ' (or cherry-pick the commits above)' : ''}.`)
  else lines.push('Mousse merged nothing; there is nothing to bring in.')
  return lines.join('\n')
}
