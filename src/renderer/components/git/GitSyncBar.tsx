import { ArrowDown, Download } from '../../lib/icons'
import type { GitPullStrategy, GitScope, GitStatusSnapshot } from '../../../shared/types'
import { GIT_BUSY_REASON } from '../sideCard/gitSectionLogic'
import {
  abortLabel,
  syncActivityLine,
  syncControls,
  syncLabel,
  syncState,
  type SyncActivity
} from './gitPanelLogic'

interface GitSyncBarProps {
  status: GitStatusSnapshot | null
  scope: Pick<GitScope, 'workspaceThreadId'>
  activity: SyncActivity
  /** Any Git action of the panel is running, so no button here may start another. */
  busy: boolean
  onFetch: () => void
  onPull: (strategy: GitPullStrategy) => void
  onAbort: (kind: 'merge' | 'rebase') => void
}

const PULL_CHOICE_LABELS: Record<Exclude<GitPullStrategy, 'ff-only'>, string> = { merge: 'Merge', rebase: 'Rebase' }

/**
 * Where the branch stands against its upstream, with Fetch, Pull and, while a merge or rebase is
 * stopped, Abort. One line below says what the last of them did or why it failed.
 */
export function GitSyncBar({ status, scope, activity, busy, onFetch, onPull, onAbort }: GitSyncBarProps) {
  const state = syncState(status)
  if (!state) return null
  const controls = syncControls(status, scope)
  const line = syncActivityLine(activity)
  const running = activity.phase === 'running' ? activity.action : null
  const abortKind = controls.abort
  const locked = busy || running !== null
  const idleTitle = locked ? GIT_BUSY_REASON : undefined
  const statusText = line?.role === 'status' ? line.text : ''
  return (
    <div className="git-sync" data-state={state.kind}>
      <div className="git-sync-row">
        <span className="git-sync-label">{syncLabel(state)}</span>
        <span className="git-sync-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            title={controls.fetch.reason ?? idleTitle ?? 'Fetch from the remote'}
            aria-busy={running === 'fetch'}
            disabled={locked || !controls.fetch.enabled}
            onClick={onFetch}
          >
            <Download size={13} strokeWidth={2} aria-hidden="true" />
            {running === 'fetch' ? 'Fetching…' : 'Fetch'}
          </button>
          {controls.pull.choices.length === 1 ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title={controls.pull.reason ?? idleTitle ?? 'Pull, fast-forward only'}
              aria-busy={running === 'pull'}
              disabled={locked || !controls.pull.enabled}
              onClick={() => onPull('ff-only')}
            >
              <ArrowDown size={13} strokeWidth={2} aria-hidden="true" />
              {running === 'pull' ? 'Pulling…' : 'Pull'}
            </button>
          ) : (
            <span className="git-pull-choices" role="group" aria-label="Pull with">
              {controls.pull.choices.map((strategy) =>
                strategy === 'ff-only' ? null : (
                  <button
                    key={strategy}
                    type="button"
                    className="btn btn-ghost btn-sm"
                    title={controls.pull.reason ?? idleTitle ?? `Pull and ${strategy}`}
                    aria-label={`Pull and ${strategy}`}
                    aria-busy={running === 'pull'}
                    disabled={locked || !controls.pull.enabled}
                    onClick={() => onPull(strategy)}
                  >
                    {running === 'pull' ? 'Pulling…' : `Pull: ${PULL_CHOICE_LABELS[strategy]}`}
                  </button>
                )
              )}
            </span>
          )}
          {abortKind && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title={idleTitle ?? `Give up the ${abortKind} and return to how the branch was`}
              disabled={locked}
              onClick={() => onAbort(abortKind)}
            >
              {running === 'abort' ? 'Aborting…' : abortLabel(abortKind)}
            </button>
          )}
        </span>
      </div>
      <div className="git-sync-line" role="status">{statusText}</div>
      {line?.role === 'alert' && <div className="git-sync-line git-sync-error" role="alert">{line.text}</div>}
    </div>
  )
}
