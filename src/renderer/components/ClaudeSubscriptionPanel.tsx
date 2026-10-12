import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw } from '../lib/icons'
import type { ClaudeLoginPolicy, ClaudeSubscriptionStatus } from '../../shared/providerAuth'

/** Which Claude Code sign-in this profile uses, and whether it currently works. */
export function ClaudeSubscriptionPanel() {
  const [status, setStatus] = useState<ClaudeSubscriptionStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async (action: () => Promise<ClaudeSubscriptionStatus>) => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await action())
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    const load = () => {
      void window.mousse.providers.claudeStatus().then(setStatus).catch(() => {})
    }
    load()
    return window.mousse.providers.onChanged(load)
  }, [])

  if (!status) return null
  const cli = status.loginPolicy === 'cli'
  const setPolicy = (policy: ClaudeLoginPolicy) =>
    void run(() => window.mousse.providers.claudeSetLoginPolicy(policy))
  const recheck = () => void run(() => window.mousse.providers.claudeStatus(true))

  let line: string
  let action: { label: string; onClick: () => void } | null = { label: 'Recheck', onClick: recheck }
  switch (status.state) {
    case 'connected':
      line = cli
        ? 'Connected through the Claude sign-in from your terminal.'
        : 'Connected with this profile’s own Claude sign-in.'
      break
    case 'missing_binary':
      line = status.message ?? 'Claude Code CLI not found.'
      break
    case 'signed_out':
      line = cli
        ? `${status.message ?? 'Claude Code is not signed in.'} Run \`claude auth login\` in a terminal, then recheck.`
        : (status.message ?? 'This profile has no Claude sign-in of its own.')
      if (!cli) action = null
      break
    case 'disconnected':
      line = status.message ?? 'Disconnected in Mousse.'
      action = { label: 'Reconnect', onClick: () => setPolicy('cli') }
      break
    default:
      line = `Could not check the Claude sign-in. ${status.message ?? ''}`.trim()
  }

  return (
    <div className="provider-list-item claude-subscription-panel">
      <div>
        <strong>Claude Subscription</strong>
        <label className="claude-login-policy">
          <input
            type="checkbox"
            checked={cli}
            disabled={busy}
            onChange={(event) => setPolicy(event.target.checked ? 'cli' : 'isolated')}
          />
          Use the Claude sign-in from your terminal (shares that account’s usage limits)
        </label>
        <span className="provider-list-meta" role="status">
          {line}
        </span>
        {status.loginPolicy === 'isolated' && status.defaultProfile && status.isolatedSignIn && (
          <span className="provider-list-meta">
            This profile kept the Claude sign-in it had before. Turn on the option above to use your
            terminal sign-in instead.
          </span>
        )}
        {error && <span className="settings-error">{error}</span>}
      </div>
      {action && (
        <button
          type="button"
          className="provider-remove-btn"
          title={action.label}
          aria-label={`${action.label} Claude sign-in`}
          disabled={busy}
          onClick={action.onClick}
        >
          {busy ? <Loader2 size={14} className="icon-spin" /> : <RefreshCw size={14} />}
          <span className="claude-panel-action-label">{action.label}</span>
        </button>
      )}
    </div>
  )
}
