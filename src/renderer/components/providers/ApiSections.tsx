import { useState } from 'react'
import type { StatusDescription } from '../../../shared/harness/status'
import type { AddOptionMethod } from '../../../shared/harness/types'
import { Check, Pencil, X } from '../../lib/icons'
import { SettingsRow } from '../settings/SettingsRow'
import { StatusLine, useAsyncAction } from './parts'

/**
 * The Setup row of a model API: replace the key, sign in again, or the cloud credentials it reuses.
 * Removing the provider lives in the editor header. A pasted key goes through
 * `providers.instances.setSecret`; a sign-in or guided key through `providers.instances.signIn`.
 */
export function ApiSetupRow({
  label,
  method,
  guidedKey,
  ambientInstructions,
  status,
  retired,
  onReplaceKey,
  onSignIn
}: {
  label: string
  /** How the entry signs in: its saved credential's kind, else the first method its Add option offers. */
  method?: AddOptionMethod
  /** The key comes from the provider's guided sign-in, not a pasted one. */
  guidedKey?: boolean
  /** Where the environment's cloud credentials come from (`ambient`). */
  ambientInstructions?: readonly string[]
  status: StatusDescription
  /** Its sign-in is going away (the entry has a Move banner): no sign-in or key to set here. */
  retired?: boolean
  /** Blank runs the guided key sign-in. */
  onReplaceKey: (apiKey: string) => Promise<void>
  onSignIn: () => Promise<void>
}) {
  const { busy, error, run } = useAsyncAction()
  const [editingKey, setEditingKey] = useState(false)
  const [key, setKey] = useState('')

  const saveKey = () =>
    void run('key', async () => {
      await onReplaceKey(key.trim())
      setEditingKey(false)
      setKey('')
    })
  const errorLine = error ? <span className="prov-error">{error}</span> : null
  const statusLine = <StatusLine status={status} />

  if (method === 'ambient') {
    return <SettingsRow title="Cloud credentials" description={errorLine ?? (ambientInstructions?.join(' ') || statusLine)} />
  }

  // A retired entry: its sign-in stays until it moves, nothing runs on it, and there is no signing in to it again.
  if (retired) {
    return <SettingsRow title="Account" description={statusLine} />
  }

  if (method === 'oauth') {
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
            onClick={() => (guidedKey ? void run('key', () => onReplaceKey('')) : setEditingKey(true))}
          >
            <Pencil size={14} />
          </button>
        )
      }
    />
  )
}
