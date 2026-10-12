import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw } from '../lib/icons'
import type { CodexStatus } from '../../shared/providerAuth'

/**
 * Whether this profile can use Codex: it reuses the sign-in from the terminal (`codex login`) and
 * never signs it out. Shown only once the Codex CLI is installed.
 */
export function CodexStatusPanel() {
  const [status, setStatus] = useState<CodexStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const load = () => {
      void window.mousse.providers.codexStatus().then(setStatus).catch(() => {})
    }
    load()
    return window.mousse.providers.onChanged(load)
  }, [])

  const recheck = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await window.mousse.providers.codexStatus(true))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }, [])

  if (!status || status.state === 'missing_binary') return null
  let line: string
  switch (status.state) {
    case 'connected':
      line = `Connected through the Codex sign-in from your terminal${status.planType ? ` (ChatGPT ${status.planType})` : ''}.`
      break
    case 'signed_out':
      line = `${status.message ?? 'Codex is not signed in.'} Run \`codex login\` in a terminal, then recheck.`
      break
    case 'disconnected':
      line = status.message ?? 'Disconnected in Mousse.'
      break
    default:
      line = `Could not check the Codex sign-in. ${status.message ?? ''}`.trim()
  }

  return (
    <div className="provider-list-item claude-subscription-panel">
      <div>
        <strong>Codex</strong>
        <span className="provider-list-meta" role="status">
          {line}
        </span>
        {error && <span className="settings-error">{error}</span>}
      </div>
      <button
        type="button"
        className="provider-remove-btn"
        title="Recheck"
        aria-label="Recheck Codex sign-in"
        disabled={busy}
        onClick={() => void recheck()}
      >
        {busy ? <Loader2 size={14} className="icon-spin" /> : <RefreshCw size={14} />}
        <span className="claude-panel-action-label">Recheck</span>
      </button>
    </div>
  )
}
