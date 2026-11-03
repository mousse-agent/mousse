import type { ThreadRunsOn } from '../../shared/types'
import { openThread } from '../lib/openThread'

/**
 * Top of the composer of a remote subagent's thread (issue #469). Its turns run on another computer, so
 * this thread only shows what it was asked and what it answered; the line says where it runs and opens its
 * thread there, where a person writes to it and answers its questions.
 */
export function RemoteSubagentNotice({ runsOn }: { runsOn: ThreadRunsOn | undefined }) {
  if (!runsOn) return null
  return (
    <div className="composer-banner" role="status">
      {runsOn.ref ? (
        <button
          type="button"
          className="composer-banner-row"
          aria-label={`This subagent runs on ${runsOn.computerName}. Open its thread there`}
          onClick={() => void openThread(runsOn.ref!)}
        >
          <span className="composer-banner-text">This subagent runs on {runsOn.computerName}. Open its thread there to follow it or write to it.</span>
        </button>
      ) : (
        <div className="composer-banner-row">
          <span className="composer-banner-text">This subagent is starting on {runsOn.computerName}.</span>
        </div>
      )}
    </div>
  )
}
