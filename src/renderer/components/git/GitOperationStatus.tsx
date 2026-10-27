import { useEffect, useState } from 'react'
import { cancelGitOperation, dismissGitOperation, useGitOperation } from '../../stores/gitOperationStore'
import { describeOperation, type GitOperationState } from './gitOperationLogic'

interface GitOperationStatusViewProps {
  state: GitOperationState
  /** Clock for the elapsed time; tests pin it. */
  now: number
  onCancel: () => void
  onDismiss: () => void
}

/**
 * What the folder's Git action is doing: "Pushing… 1m 05s · pre-push · last line", a Cancel button
 * while it can be stopped, and its output behind "Show output". After a failure or a cancel the
 * outcome and the output stay until the next action or Dismiss.
 */
export function GitOperationStatusView({ state, now, onCancel, onDismiss }: GitOperationStatusViewProps) {
  const view = describeOperation(state, now)
  return (
    <div className="git-operation" data-phase={state.phase} data-kind={state.kind}>
      <div className="git-operation-row">
        <div className="git-operation-text" role="status">
          <span className="git-operation-headline">{view.headline}</span>
          {view.hook && <span className="git-operation-detail">{view.hook}</span>}
          {view.lastLine && <span className="git-operation-detail">{view.lastLine}</span>}
        </div>
        {view.elapsed && <span className="git-operation-elapsed" aria-hidden="true">{view.elapsed}</span>}
        <span className="git-operation-actions">
          {view.cancelLabel && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
              {view.cancelLabel}
            </button>
          )}
          {view.ended && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss}>
              Dismiss
            </button>
          )}
        </span>
      </div>
      {state.lines.length > 0 && (
        <details className="git-operation-output">
          <summary>Show output</summary>
          <pre className="git-operation-log" tabIndex={0} aria-label="Git output">{state.lines.join('\n')}</pre>
        </details>
      )}
    </div>
  )
}

/** The status of the Git action running on `path`, if any. Renders nothing otherwise. */
export function GitOperationStatus({ path }: { path: string | null }) {
  const state = useGitOperation(path)
  const running = state !== null && (state.phase === 'starting' || state.phase === 'running')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  if (!path || !state) return null
  return <GitOperationStatusView state={state} now={now} onCancel={() => void cancelGitOperation(path)} onDismiss={() => dismissGitOperation(path)} />
}
