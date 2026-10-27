import { useEffect, useState } from 'react'
import type { StatusDescription } from '../../../shared/harness/status'
import type { ProviderLoginOption } from '../../../shared/providerAuth'
import { Check, Pencil, X } from '../../lib/icons'
import { SettingsRow } from '../settings/SettingsRow'
import { StatusLine, useAsyncAction } from './parts'

/**
 * The Setup row of a model API: replace the key, sign in again, or the cloud credentials it reuses.
 * Removing the provider lives in the editor header. API keys and pi sign-ins still go through the
 * provider login methods (`providers.login*`), which the daemon forwards to the gateway.
 */
export function ApiSetupRow({
  providerId,
  label,
  option,
  status,
  retired,
  onReplaceKey,
  onSignIn
}: {
  providerId: string
  label: string
  option?: ProviderLoginOption
  status: StatusDescription
  /** Its sign-in is going away (the entry has a Move banner): no sign-in or key to set here. */
  retired?: boolean
  /** Blank runs the guided key prompt. */
  onReplaceKey: (apiKey: string) => Promise<void>
  onSignIn: () => Promise<void>
}) {
  const { busy, error, run } = useAsyncAction()
  const [editingKey, setEditingKey] = useState(false)
  const [key, setKey] = useState('')
  const [instructions, setInstructions] = useState<string[]>([])
  const ambient = option?.ambient === true
  useEffect(() => {
    if (!ambient) return
    void window.mousse.providers
      .getAmbientInfo(providerId)
      .then((info) => setInstructions(info?.instructions ?? []))
      .catch(() => {})
  }, [ambient, providerId])

  const saveKey = () =>
    void run('key', async () => {
      await onReplaceKey(key.trim())
      setEditingKey(false)
      setKey('')
    })
  const errorLine = error ? <span className="prov-error">{error}</span> : null
  const statusLine = <StatusLine status={status} />

  if (ambient) {
    return <SettingsRow title="Cloud credentials" description={errorLine ?? (instructions.join(' ') || statusLine)} />
  }

  // A retired entry: its sign-in stays until it moves, nothing runs on it, and there is no signing in to it again.
  if (retired) {
    return <SettingsRow title="Account" description={statusLine} />
  }

  if (option?.authType === 'oauth') {
    return (
      <SettingsRow
        title="Account"
        description={errorLine ?? statusLine}
        control={
          <button type="button" className="settings-btn" disabled={busy !== null} onClick={() => void run('signin', onSignIn)}>
            Sign in again
          </button>
        }
      />
    )
  }

  return (
    <SettingsRow
      title="API key"
      description={errorLine ?? (editingKey ? 'Leave blank for guided setup' : statusLine)}
      control={
        editingKey ? (
          <span className="settings-icon-actions">
            <button type="button" className="settings-icon-btn" title="Cancel" aria-label="Cancel" disabled={busy !== null} onClick={() => setEditingKey(false)}>
              <X size={14} />
            </button>
            <input
              className="settings-input"
              type="password"
              value={key}
              autoFocus
              placeholder={`New ${label} key`}
              aria-label={`New ${label} API key`}
              onChange={(event) => setKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') saveKey()
                if (event.key === 'Escape') setEditingKey(false)
              }}
            />
            <button type="button" className="settings-icon-btn primary" title="Save key" aria-label="Save" disabled={busy !== null} onClick={saveKey}>
              <Check size={14} />
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="settings-icon-btn primary"
            title="Replace key"
            aria-label="Replace key"
            disabled={busy !== null}
            onClick={() => (option?.guidedLogin ? void run('key', () => onReplaceKey('')) : setEditingKey(true))}
          >
            <Pencil size={14} />
          </button>
        )
      }
    />
  )
}
