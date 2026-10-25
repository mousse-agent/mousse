import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { InstanceSnapshot, StatusDescription } from '../../../shared/harness/status'
import type { InstanceConfigPatch, ProviderOperationEvent } from '../../../shared/harness/types'
import { Download, Plus, RotateCcw, X } from '../../lib/icons'
import { SettingsRow } from '../settings/SettingsRow'
import { BrowseButton, CommandBox, RefreshButton, displayLabel, statusText, useAsyncAction } from './parts'
import {
  DRIVER_INFO,
  binaryOverrideOf,
  binarySourceLabel,
  formatArgs,
  formatVersion,
  instanceConfigOf,
  parseArgs
} from './providerView'

/** Description slot: the error replaces the description while it lasts. */
function withError(description: ReactNode, error: string | null): ReactNode {
  return error ? <span className="prov-error">{error}</span> : description
}

function blurOnEnter(event: React.KeyboardEvent<HTMLInputElement>) {
  if (event.key === 'Enter') event.currentTarget.blur()
}

/** What the editor can do for an instance; each rejects with the daemon's message. */
export interface InstanceActions {
  enable: () => Promise<void>
  install: () => Promise<void>
  cancelInstall: (operationId: string) => Promise<void>
  update: () => Promise<void>
  /** Starts the sign-in; its prompts open the sign-in dialog. */
  signIn: () => Promise<void>
  signOut: () => Promise<void>
  recheck: () => Promise<void>
  configure: (patch: InstanceConfigPatch) => Promise<void>
}

function progressText(snapshot: InstanceSnapshot, operation: ProviderOperationEvent | undefined): string | null {
  const live = operation?.phase === 'progress' ? operation : undefined
  const progress = live ?? snapshot.install.progress
  if (!progress) return null
  const percent = progress.fraction !== undefined ? ` (${Math.round(progress.fraction * 100)}%)` : ''
  return `${progress.message}${percent}`
}

/**
 * The Setup row: the status in T3 Code's words and the one next step it names. Buttons follow the
 * snapshot, so Install and Sign in are ready as soon as the instance's own state is known.
 */
export function SetupRow({
  snapshot,
  status,
  operation,
  actions
}: {
  snapshot: InstanceSnapshot
  status: StatusDescription
  /** The install or update this page saw start, for live progress. */
  operation?: ProviderOperationEvent
  actions: InstanceActions
}) {
  const { busy, error, run } = useAsyncAction()
  const step = status.nextStep
  const installing = snapshot.install.state === 'installing'
  const progress = installing ? progressText(snapshot, operation) : null
  const checking = !snapshot.checkedAt && !snapshot.stale
  const idle = busy === null

  const button = (key: string, label: string, action: () => Promise<void>) => (
    <button type="button" className="settings-btn" disabled={!idle} onClick={() => void run(key, action)}>
      {label}
    </button>
  )

  let control: ReactNode = null
  let below: ReactNode = null
  if (step) {
    switch (step.action) {
      case 'enable':
        control = button('enable', step.label, actions.enable)
        break
      case 'install':
        control = button('install', step.label, actions.install)
        break
      case 'cancel_install': {
        const operationId = snapshot.install.operationId
        control = operationId ? button('cancel', step.label, () => actions.cancelInstall(operationId)) : null
        break
      }
      case 'fix_override':
        control = (
          <>
            <button type="button" className="settings-btn" disabled={!idle} onClick={() => void run('clear', () => actions.configure({ binaryPath: null }))}>
              Use the default
            </button>
            <BrowseButton
              title={step.label}
              defaultPath={snapshot.binary?.path}
              disabled={!idle}
              onPick={(binaryPath) => void run('path', () => actions.configure({ binaryPath }))}
            />
          </>
        )
        break
      case 'sign_in':
        if (step.command) {
          below = (
            <>
              <span className="prov-command-hint">Run this in a terminal, then check again.</span>
              <CommandBox command={step.command} />
            </>
          )
        } else control = button('signin', step.label, actions.signIn)
        break
      case 'update':
        if (step.command) below = <CommandBox command={step.command} label="Copy update command" />
        else control = button('update', step.label, actions.update)
        break
      case 'recheck':
        break
    }
  }

  // Checking again is always at hand once a check has finished (a terminal sign-in, an install elsewhere).
  const recheck = !checking && !installing && (
    <RefreshButton label="Check again" busy={busy === 'recheck'} disabled={!idle} onClick={() => void run('recheck', actions.recheck)} />
  )

  return (
    <SettingsRow
      title="Status"
      description={withError(progress ?? statusText(status), error)}
      control={
        <>
          {recheck}
          {control}
        </>
      }
    >
      {below}
    </SettingsRow>
  )
}

/** The signed-in account, keyed by id; sign-out only where the daemon says Mousse owns the sign-in. */
export function AccountRow({ snapshot, actions }: { snapshot: InstanceSnapshot; actions: InstanceActions }) {
  const { busy, error, run } = useAsyncAction()
  const { auth } = snapshot
  if (auth.state !== 'signed_in' && auth.state !== 'expired') return null
  const who = auth.account?.label ?? auth.account?.id
  const description = displayLabel([who, auth.methodLabel].filter(Boolean).join(' · ') || 'Signed in')
  return (
    <SettingsRow
      title="Account"
      description={withError(description, error)}
      control={
        auth.canSignOut ? (
          <button type="button" className="settings-btn" disabled={busy !== null} onClick={() => void run('signout', actions.signOut)}>
            Sign out
          </button>
        ) : undefined
      }
    />
  )
}

/** The executable Mousse resolved: path, version and where it came from. */
export function BinaryRow({ snapshot }: { snapshot: InstanceSnapshot }) {
  const { binary } = snapshot
  const version = formatVersion(binary?.version)
  return (
    <SettingsRow
      title="Executable in use"
      description={
        binary?.path ? (
          <span className="prov-binary">
            <code className="prov-binary-path" title={binary.path}>
              {binary.path}
            </code>
            <span className="prov-binary-meta">{[version, binarySourceLabel(binary)].filter(Boolean).join(' · ')}</span>
          </span>
        ) : snapshot.checkedAt || snapshot.stale ? (
          'Not found'
        ) : (
          'Checking…'
        )
      }
    />
  )
}

/**
 * An available update. One click only when Mousse knows who installed the binary; otherwise the
 * command to run, in its own box, so the two never look alike.
 */
export function UpdateRow({ snapshot, operation, actions }: { snapshot: InstanceSnapshot; operation?: ProviderOperationEvent; actions: InstanceActions }) {
  const { busy, error, run } = useAsyncAction()
  const update = snapshot.update
  if (!update) return null
  const target = formatVersion(update.latestVersion)
  const updating = operation?.kind === 'update' && (operation.phase === 'progress' || operation.phase === 'prompt')
  if (update.kind === 'one_click') {
    return (
      <SettingsRow
        className="prov-update is-one-click"
        title={target ? `Update to ${target}` : 'Update available'}
        description={withError(updating && operation?.phase === 'progress' ? operation.message : 'Mousse updates it the way it was installed.', error)}
        control={
          <button type="button" className="settings-btn prov-update-btn" disabled={busy !== null || updating} onClick={() => void run('update', actions.update)}>
            <Download size={14} />
            {updating ? 'Updating…' : 'Update now'}
          </button>
        }
      />
    )
  }
  return (
    <SettingsRow
      className="prov-update is-advisory"
      title={target ? `${target} is available` : 'Update available'}
      description="Mousse didn't install this copy, so update it yourself in a terminal:"
    >
      <CommandBox command={update.command} label="Copy update command" />
    </SettingsRow>
  )
}

/** Where the instance keeps its sign-in and settings. */
export function HomeRow({ snapshot }: { snapshot: InstanceSnapshot }) {
  const config = instanceConfigOf(snapshot)
  if (!config) return null
  const hint = DRIVER_INFO[snapshot.driver].homeHint
  return (
    <SettingsRow
      title="Account home"
      description={
        config.home === 'private'
          ? 'Private to this provider. It signs in separately from your terminal.'
          : `Shared with your terminal${hint ? ` (${hint})` : ''}, set up the way you use it.`
      }
    />
  )
}

export function ExecutableRow({
  snapshot,
  label,
  onSave
}: {
  snapshot: InstanceSnapshot
  label: string
  onSave: (binaryPath: string | null) => Promise<void>
}) {
  const { busy, error, run } = useAsyncAction()
  const saved = binaryOverrideOf(snapshot) ?? ''
  const [draft, setDraft] = useState(saved)
  useEffect(() => setDraft(saved), [saved])
  const resolved = snapshot.binary?.source === 'override' ? undefined : snapshot.binary?.path
  const save = (binaryPath: string | null) => void run('path', () => onSave(binaryPath))
  const commit = () => {
    const next = draft.trim()
    if (next !== saved) save(next || null)
  }
  return (
    <SettingsRow
      title="Executable path"
      description={withError(busy === 'path' ? 'Checking the executable…' : saved ? undefined : 'Leave empty to use the one Mousse finds.', error)}
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
            disabled={busy !== null}
            placeholder={resolved ?? 'Path to the executable'}
            title={resolved}
            aria-label="Executable path"
            aria-invalid={error ? true : undefined}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={blurOnEnter}
          />
          <BrowseButton
            title={`Choose the ${label} executable`}
            defaultPath={draft.trim() || resolved}
            disabled={busy !== null}
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

const CONFIG_UNREADABLE = "Mousse can't read the saved value yet."

export function ArgsRow({ snapshot, onSave }: { snapshot: InstanceSnapshot; onSave: (args: string[]) => Promise<void> }) {
  const { error, run } = useAsyncAction()
  const config = instanceConfigOf(snapshot)
  const saved = formatArgs(config?.args ?? [])
  const [draft, setDraft] = useState(saved)
  useEffect(() => setDraft(saved), [saved])
  const commit = () => {
    const next = parseArgs(draft)
    if (formatArgs(next) !== saved) void run('args', () => onSave(next))
  }
  return (
    <SettingsRow
      title="Launch arguments"
      description={withError(config ? undefined : CONFIG_UNREADABLE, error)}
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

export function EnvRow({ snapshot, onSave }: { snapshot: InstanceSnapshot; onSave: (env: Record<string, string>) => Promise<void> }) {
  const { error, run } = useAsyncAction()
  const config = instanceConfigOf(snapshot)
  const env = config?.env
  const nextUid = useRef(0)
  const toDraft = (values: Record<string, string>): EnvDraft[] =>
    Object.entries(values).map(([key, value]) => ({ uid: nextUid.current++, key, value }))
  const saved = JSON.stringify(Object.entries(env ?? {}))
  const [rows, setRows] = useState<EnvDraft[]>(() => toDraft(env ?? {}))
  // Take outside changes, but keep rows still being typed (a blank name is not saved yet).
  useEffect(() => {
    setRows((current) => (JSON.stringify(draftEntries(current)) === saved ? current : toDraft(env ?? {})))
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
      title="Variables"
      description={withError(config ? undefined : CONFIG_UNREADABLE, error)}
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
