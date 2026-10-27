import type { PullRequestWatchEnd, PullRequestWatchMode, PullRequestWatchStatus } from '../../../shared/pullRequests'

export interface WatchOption {
  mode: PullRequestWatchMode
  label: string
  /** Why this choice cannot be picked; null when it can. */
  disabledReason: string | null
}

export interface WatchControlModel {
  mode: PullRequestWatchMode
  options: WatchOption[]
  /** What the watch is doing now ("Watching · next check in 4m"); null when it is off. */
  summary: string | null
  /** True while the watch is on; the eye shows then. */
  watching: boolean
  /** Why the watch stopped by itself, to say once; null otherwise. */
  endedLine: string | null
  /** The account whose own comments are left out, said so nobody wonders why theirs are missing. */
  viewerLine: string | null
}

const ENDED: Record<PullRequestWatchEnd, string> = {
  merged: 'The pull request was merged, so the watch ended.',
  closed: 'The pull request was closed, so the watch ended.',
  comment_loop: 'Ten updates in a row were only comments, so the watch ended.',
  id_cap: 'The pull request has too many comments to keep watching.',
  read_failures: 'The pull request could not be read several times, so the watch ended.',
  not_found: 'The pull request was not found, so the watch ended.',
  signed_out: 'GitHub could not be reached (not signed in?), so the watch ended.',
  stopped: 'The thread was stopped, so the watch ended.',
  unlinked: 'The thread was unlinked from the pull request, so the watch ended.',
  settled: 'The thread was archived, so the watch ended.',
  trashed: 'The thread was deleted, so the watch ended.'
}

/** "in 4m", "in 30s", "now". */
export function inTime(at: string | null, now: number): string {
  const ms = at ? Date.parse(at) - now : 0
  if (!(ms > 1000)) return 'now'
  const seconds = Math.round(ms / 1000)
  if (seconds < 90) return `in ${seconds}s`
  return `in ${Math.round(seconds / 60)}m`
}

/** What the side card shows for a thread's watch: the three choices, what it is doing, why it ended, and whose comments it skips. */
export function pullRequestWatchModel(status: PullRequestWatchStatus | null, now: number): WatchControlModel {
  const mode: PullRequestWatchMode = status?.state === 'watching' || status?.state === 'paused' ? status.mode : 'off'
  const options: WatchOption[] = [
    { mode: 'off', label: 'Off', disabledReason: null },
    { mode: 'notify', label: 'Notify', disabledReason: null },
    { mode: 'act', label: 'Let the agent act', disabledReason: status?.actRefusal ?? null }
  ]
  const watching = mode !== 'off'
  const summary = !status || !watching
    ? null
    : status.state === 'paused'
      ? `Waiting for GitHub · next check ${inTime(status.nextCheckAt, now)}`
      : `Watching · next check ${inTime(status.nextCheckAt, now)}`
  return {
    mode,
    options,
    summary,
    watching,
    endedLine: status?.state === 'ended' && status.ended ? ENDED[status.ended.reason] : null,
    viewerLine: watching && status?.viewer && status.host ? `Comments by ${status.viewer} on ${status.host} are not reported.` : null
  }
}
