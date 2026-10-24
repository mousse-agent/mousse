import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { LlmModelOption } from '../../../shared/settings'
import type { CliProviderConfig, CliProviderConfigPatch } from '../../../shared/providerAuth'
import { Plus, RotateCcw, X } from '../../lib/icons'
import { SettingsAdvanced, SettingsRow } from '../settings/SettingsRow'
import { formatArgs, parseArgs, type CliProviderDefinition } from './cliProviders'
import type { CliInstall } from './useCliInstall'
import {
  BrowseButton,
  ModelsSubRow,
  ProviderRow,
  RefreshButton,
  RemoveButton,
  formatVersion,
  modelCount,
  useAsyncAction,
  type HealthState
} from './parts'

export interface CliProviderRowProps {
  cli: CliProviderDefinition
  enabled: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  state: HealthState
  /** Undefined until loaded. */
  config?: CliProviderConfig
  models: LlmModelOption[]
  onToggle: (enabled: boolean) => Promise<void>
  onRemove: () => Promise<void>
  /** Rejects with the daemon's validation message, shown under the field. */
  onSaveConfig: (patch: CliProviderConfigPatch) => Promise<void>
  onRefreshModels: () => Promise<void>
  onSignIn: () => Promise<void>
  onRecheck: () => Promise<void>
  /** Antigravity only: Mousse downloads the agent, and signing out leaves it installed. */
  install?: CliInstall
  /** Starts the download and refreshes what the row shows when it succeeds. */
  onInstall?: () => Promise<void>
  onSignOut?: () => Promise<void>
}

export function CliProviderRow(props: CliProviderRowProps) {
  const { cli, enabled, open, onOpenChange, state, config, models } = props
  return (
    <ProviderRow
      iconId={cli.iconId}
      name={cli.label}
      version={formatVersion(config?.version)}
      meta={enabled ? modelCount(models) : undefined}
      state={state}
      enabled={enabled}
      toggleLabel={`Use ${cli.label}`}
      open={open}
      onOpenChange={onOpenChange}
      onToggle={props.onToggle}
    >
      <CliDetails {...props} />
    </ProviderRow>
  )
}

/** Description slot: the error replaces the description while it lasts. */
function withError(description: ReactNode, error: string | null): ReactNode {
  return error ? <span className="prov-error">{error}</span> : description
}

function CliDetails({
  cli,
  enabled,
  state,
  config,
  models,
  onRemove,
  onSaveConfig,
  onRefreshModels,
  onSignIn,
  onRecheck,
  install,
  onInstall,
  onSignOut
}: CliProviderRowProps) {
  const signIn = useAsyncAction()
  const removal = useAsyncAction()
  const managed = cli.id === 'antigravity'
  const installing = install?.busy === true
  const needsSignIn = managed ? state.action === 'sign-in' : state.health === 'attention' && state.label !== 'Not found'
  const recheckable = !managed && state.health !== 'ready'
  const idle = signIn.busy === null && !installing

  return (
    <>
      <SettingsRow
        indent
        title={managed && state.action === 'install' ? 'Install' : 'Sign-in'}
        description={withError(
          installing ? (install?.progress ?? 'Installing…') : (state.detail ?? state.label),
          signIn.error ?? install?.error ?? null
        )}
        control={
          <>
            {recheckable && (
              <RefreshButton
                label="Check sign-in again"
                busy={signIn.busy === 'recheck'}
                disabled={signIn.busy !== null}
                onClick={() => void signIn.run('recheck', onRecheck)}
              />
            )}
            {managed && installing && (
              <button type="button" className="settings-btn" onClick={() => void install?.cancel()}>
                Cancel
              </button>
            )}
            {managed && !installing && state.action === 'install' && onInstall && (
              <button type="button" className="settings-btn" disabled={signIn.busy !== null} onClick={() => void signIn.run('install', onInstall)}>
                Install
              </button>
            )}
            {needsSignIn && (
              <button type="button" className="settings-btn" disabled={!idle} onClick={() => void signIn.run('signin', onSignIn)}>
                Sign in
              </button>
            )}
            {managed && state.action === 'sign-out' && onSignOut && (
              <button type="button" className="settings-btn" disabled={!idle} onClick={() => void signIn.run('signout', onSignOut)}>
                Sign out
              </button>
            )}
          </>
        }
      />

      <ExecutableSubRow label={cli.label} config={config} onSave={(binaryPath) => onSaveConfig({ binaryPath })} />

      {enabled && <ModelsSubRow models={models} onRefresh={onRefreshModels} />}

      <SettingsAdvanced>
        <ArgsSubRow config={config} onSave={(args) => onSaveConfig({ args })} />
        <EnvSubRow config={config} onSave={(env) => onSaveConfig({ env })} />
      </SettingsAdvanced>

      <SettingsRow
        indent
        title="Remove provider"
        description={withError(`Keeps ${cli.label} installed`, removal.error)}
        control={
          <RemoveButton disabled={removal.busy !== null} onRemove={() => void removal.run('remove', onRemove)} />
        }
      />
    </>
  )
}

function blurOnEnter(event: React.KeyboardEvent<HTMLInputElement>) {
  if (event.key === 'Enter') event.currentTarget.blur()
}

function ExecutableSubRow({
  label,
  config,
  onSave
}: {
  label: string
  config?: CliProviderConfig
  onSave: (binaryPath: string | null) => Promise<void>
}) {
  const { busy, error, run } = useAsyncAction()
  const saved = config?.binaryPath ?? ''
  const [draft, setDraft] = useState(saved)
  useEffect(() => setDraft(saved), [saved])
  const save = (binaryPath: string | null) => void run('path', () => onSave(binaryPath))
  const commit = () => {
    const next = draft.trim()
    if (next !== saved) save(next || null)
  }
  return (
    <SettingsRow
      indent
      title="Executable"
      description={withError(busy === 'path' ? 'Checking the executable…' : undefined, error)}
      control={
        <span className="settings-icon-actions">
          {saved && (
            <button type="button" className="settings-icon-btn" title="Use the default executable" aria-label="Reset" disabled={busy !== null} onClick={() => save(null)}>
              <RotateCcw size={14} />
            </button>
          )}
          <input
            className="settings-input prov-mono prov-wide"
            value={draft}
            disabled={!config || busy !== null}
            placeholder={config ? config.resolvedBinaryPath ?? 'Not found' : ''}
            title={config?.resolvedBinaryPath}
            aria-label="Executable path"
            aria-invalid={error ? true : undefined}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={blurOnEnter}
          />
          <BrowseButton
            title={`Choose the ${label} executable`}
            defaultPath={draft.trim() || config?.resolvedBinaryPath}
            disabled={!config || busy !== null}
            onPick={(path) => {
              setDraft(path)
              if (path !== saved) save(path)
            }}
          />
        </span>
      }
    />
  )
}

function ArgsSubRow({ config, onSave }: { config?: CliProviderConfig; onSave: (args: string[]) => Promise<void> }) {
  const { error, run } = useAsyncAction()
  const saved = formatArgs(config?.args ?? [])
  const [draft, setDraft] = useState(saved)
  useEffect(() => setDraft(saved), [saved])
  const commit = () => {
    const next = parseArgs(draft)
    if (formatArgs(next) !== saved) void run('args', () => onSave(next))
  }
  return (
    <SettingsRow
      indent
      title="Launch arguments"
      description={withError(undefined, error)}
      control={
        <input
          className="settings-input prov-mono prov-wide"
          value={draft}
          disabled={!config}
          placeholder="None"
          aria-label="Launch arguments"
          aria-invalid={error ? true : undefined}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={blurOnEnter}
        />
      }
    />
  )
}

interface EnvDraft {
  uid: number
  key: string
  value: string
}

function draftEntries(rows: EnvDraft[]): Array<[string, string]> {
  return rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value])
}

function EnvSubRow({ config, onSave }: { config?: CliProviderConfig; onSave: (env: Record<string, string>) => Promise<void> }) {
  const { error, run } = useAsyncAction()
  const nextUid = useRef(0)
  const toDraft = (env: Record<string, string>): EnvDraft[] =>
    Object.entries(env).map(([key, value]) => ({ uid: nextUid.current++, key, value }))
  const saved = JSON.stringify(Object.entries(config?.env ?? {}))
  const [rows, setRows] = useState<EnvDraft[]>(() => toDraft(config?.env ?? {}))
  // Take outside changes, but keep rows still being typed (a blank name is not saved yet).
  useEffect(() => {
    setRows((current) => (JSON.stringify(draftEntries(current)) === saved ? current : toDraft(config?.env ?? {})))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved])

  const commit = (next: EnvDraft[]) => {
    const entries = draftEntries(next)
    if (JSON.stringify(entries) !== saved) void run('env', () => onSave(Object.fromEntries(entries)))
  }
  const update = (uid: number, patch: Partial<EnvDraft>) =>
    setRows((current) => current.map((row) => (row.uid === uid ? { ...row, ...patch } : row)))

  return (
    <SettingsRow
      indent
      title="Environment variables"
      description={withError(undefined, error)}
      control={
        <button
          type="button"
          className="settings-icon-btn primary"
          title="Add variable"
          aria-label="Add variable"
          disabled={!config}
          onClick={() => setRows((current) => [...current, { uid: nextUid.current++, key: '', value: '' }])}
        >
          <Plus size={14} />
        </button>
      }
    >
      {rows.length > 0 && (
        <div className="prov-env">
          {rows.map((row) => (
            <div key={row.uid} className="prov-env-row">
              <input
                className="settings-input prov-mono"
                value={row.key}
                placeholder="NAME"
                aria-label="Variable name"
                spellCheck={false}
                onChange={(event) => update(row.uid, { key: event.target.value })}
                onBlur={() => commit(rows)}
                onKeyDown={blurOnEnter}
              />
              <input
                className="settings-input prov-mono"
                value={row.value}
                placeholder="value"
                aria-label={`Value of ${row.key || 'variable'}`}
                spellCheck={false}
                onChange={(event) => update(row.uid, { value: event.target.value })}
                onBlur={() => commit(rows)}
                onKeyDown={blurOnEnter}
              />
              <button
                type="button"
                className="settings-icon-btn danger"
                aria-label={`Remove ${row.key || 'variable'}`}
                title="Remove"
                onClick={() => {
                  const next = rows.filter((item) => item.uid !== row.uid)
                  setRows(next)
                  commit(next)
                }}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </SettingsRow>
  )
}
