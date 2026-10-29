import type { UpdateState } from '../../../shared/updates'
import { CircleAlert, RotateCcw, X } from '../../lib/icons'
import { dismissUpdateError, retryUpdate } from '../../stores/updateStore'
import '../../styles/updates.css'

const TITLE = {
  check: 'Update check failed',
  download: 'Update download failed',
  install: 'Update not installed'
} as const

/** A failed update check, download or install: what happened, with Retry and Dismiss. */
export function UpdateErrorNotice({ error }: { error: NonNullable<UpdateState['error']> }) {
  return (
    <div className="update-error" role="alert">
      <CircleAlert size={15} strokeWidth={1.8} className="update-error-icon" aria-hidden="true" />
      <div className="update-error-text">
        <strong>{TITLE[error.during]}</strong>
        <span>{error.message}</span>
      </div>
      <button type="button" className="settings-retry-btn" onClick={() => void retryUpdate()}>
        <RotateCcw size={13} aria-hidden="true" />Try again
      </button>
      <button type="button" className="settings-icon-btn" title="Dismiss" aria-label="Dismiss" onClick={dismissUpdateError}>
        <X size={14} />
      </button>
    </div>
  )
}
