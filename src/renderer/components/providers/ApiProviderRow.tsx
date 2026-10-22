import { useState } from 'react'
import type { LlmModelOption } from '../../../shared/settings'
import type { ProviderAuthType, ProviderLoginOption } from '../../../shared/providerAuth'
import { Check, Pencil, X } from '../../lib/icons'
import { SettingsRow } from '../settings/SettingsRow'
import { ModelsSubRow, ProviderRow, RemoveButton, modelCount, useAsyncAction, type HealthState } from './parts'

export interface ApiProviderEntry {
  providerId: string
  instanceId: string
  label: string
  authType: ProviderAuthType
  source?: string
  enabled: boolean
}

export function apiHealth(entry: ApiProviderEntry): HealthState {
  if (entry.source?.startsWith('unsupported')) return { health: 'error', label: 'Unsupported credential' }
  return {
    health: 'ready',
    label: 'Ready',
    detail: entry.authType === 'oauth' ? 'Signed in' : entry.source ? `Key from ${entry.source}` : 'Key saved'
  }
}

interface ApiProviderRowProps {
  entry: ApiProviderEntry
  option?: ProviderLoginOption
  models: LlmModelOption[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onToggle: (enabled: boolean) => Promise<void>
  onRemove: () => Promise<void>
  /** Blank runs the guided key prompt. */
  onReplaceKey: (apiKey: string) => Promise<void>
  onSignIn: () => Promise<void>
  onRefreshModels: () => Promise<void>
}

export function ApiProviderRow(props: ApiProviderRowProps) {
  const { entry, models, open, onOpenChange, onToggle } = props
  return (
    <ProviderRow
      iconId={entry.providerId}
      name={entry.label}
      meta={entry.enabled ? modelCount(models) : undefined}
      state={apiHealth(entry)}
      enabled={entry.enabled}
      toggleLabel={`Use ${entry.label}`}
      open={open}
      onOpenChange={onOpenChange}
      onToggle={onToggle}
    >
      <ApiDetails {...props} />
    </ProviderRow>
  )
}

function ApiDetails({ entry, option, models, onRemove, onReplaceKey, onSignIn, onRefreshModels }: ApiProviderRowProps) {
  const { busy, error, run } = useAsyncAction()
  const [editingKey, setEditingKey] = useState(false)
  const [key, setKey] = useState('')

  const ambient = option?.ambient === true
  const saveKey = () =>
    void run('key', async () => {
      await onReplaceKey(key.trim())
      setEditingKey(false)
      setKey('')
    })

  return (
    <>
      {entry.enabled && <ModelsSubRow models={models} onRefresh={onRefreshModels} />}

      {entry.authType === 'api_key' && !ambient && (
        <SettingsRow
          indent
          title="API key"
          description={editingKey ? 'Leave blank for guided setup' : undefined}
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
                  placeholder={`New ${entry.label} key`}
                  aria-label={`New ${entry.label} API key`}
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
      )}

      {entry.authType === 'oauth' && (
        <SettingsRow
          indent
          title="Sign-in"
          control={
            <button type="button" className="settings-btn" disabled={busy !== null} onClick={() => void run('signin', onSignIn)}>
              Sign in again
            </button>
          }
        />
      )}

      <SettingsRow
        indent
        title="Remove provider"
        description={ambient ? undefined : entry.authType === 'oauth' ? 'Signs out' : 'Deletes the saved key'}
        control={<RemoveButton disabled={busy !== null} onRemove={() => void run('remove', onRemove)} />}
      />
      {error && <p className="prov-error prov-indent">{error}</p>}
    </>
  )
}
