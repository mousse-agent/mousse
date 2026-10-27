import { useState } from 'react'
import type { PullRequestWatchMode, PullRequestWatchStatus } from '../../../shared/pullRequests'
import { Eye } from '../../lib/icons'
import { ipcErrorLine } from '../../lib/errorText'
import { pullRequestWatchModel } from './pullRequestWatchLogic'

interface PullRequestWatchControlProps {
  status: PullRequestWatchStatus | null
  /** Sets the watch; rejects with the daemon's own refusal. */
  onChange: (mode: PullRequestWatchMode) => Promise<unknown>
  now?: number
}

/**
 * The side card's watch of the pull request: Off, Notify (a line in the thread) or Let the agent act (also wakes the agent
 * for checks and for what maintainers write). Says what it is doing, why it ended, and whose comments it leaves out.
 */
export function PullRequestWatchControl({ status, onChange, now = Date.now() }: PullRequestWatchControlProps) {
  const model = pullRequestWatchModel(status, now)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pick = async (mode: PullRequestWatchMode) => {
    if (busy || mode === model.mode) return
    setBusy(true)
    setError(null)
    try {
      await onChange(mode)
    } catch (failure) {
      setError(ipcErrorLine(failure).replace(/^[A-Za-z]*Error:\s*/, ''))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="side-card-git-pr-watch">
      <div className="side-card-git-pr-watch-line">
        <span className="side-card-git-pr-watch-label">
          {model.watching && <Eye size={12} strokeWidth={2} aria-hidden="true" />}
          Watch
        </span>
        <div className="side-card-git-pr-watch-options" role="radiogroup" aria-label="Watch this pull request">
          {model.options.map((option) => (
            <button
              key={option.mode}
              type="button"
              role="radio"
              aria-checked={option.mode === model.mode}
              aria-disabled={option.disabledReason !== null || busy}
              title={option.disabledReason ?? option.hint}
              className="side-card-git-pr-watch-option"
              onClick={() => {
                if (option.disabledReason === null) void pick(option.mode)
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {model.summary && <p className="side-card-git-pr-watch-note">{model.summary}</p>}
      {model.viewerLine && <p className="side-card-git-pr-watch-note">{model.viewerLine}</p>}
      {model.endedLine && <p className="side-card-git-pr-watch-note">{model.endedLine}</p>}
      {error && (
        <p className="side-card-git-pr-error" role="alert" title={error}>
          {error}
        </p>
      )}
    </div>
  )
}
