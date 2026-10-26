import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { InstanceSnapshot } from '../../../shared/harness/status'
import type { RegistryAgentView, RemoveInstallResult } from '../../../shared/harness/types'
import { Trash2 } from '../../lib/icons'
import { ProviderIcon } from '../../lib/providerIcons'
import { Modal } from '../ui/Modal'
import { SettingsRow } from '../settings/SettingsRow'
import type { InstanceActions } from './CliSections'
import { errorText, useAsyncAction } from './parts'
import {
  UNVERIFIED_NOTE,
  checksumLabel,
  formatArgs,
  formatMegabytes,
  formatVersion,
  needsConsent,
  registryAgentMeta,
  registrySourceLabel,
  registrySourceOf,
  registryUpdateOf,
  usedByLabel
} from './providerView'

/**
 * ACP agents Mousse installs from the registry: the Add dialog's searchable list and its confirm
 * panel, and the editor's source, update, downloaded files and remove rows. Icons are the generic
 * ACP logo; nothing is loaded from the registry's own icon URLs.
 */

type UsedBy = Extract<RemoveInstallResult, { removed: false }>['usedBy']

const SEARCH_DEBOUNCE_MS = 250

/** The registry's agents for `query`, debounced; a failed load keeps its error until retried. */
function useRegistrySearch(query: string) {
  const [agents, setAgents] = useState<RegistryAgentView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      window.mousse.providers.registry.search(query.trim()).then(
        (found) => {
          if (cancelled) return
          setAgents(found)
          setError(null)
        },
        (failure: unknown) => {
          if (cancelled) return
          setAgents(null)
          setError(errorText(failure))
        }
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, attempt])
  const retry = () => {
    setError(null)
    setAttempt((value) => value + 1)
  }
  return { agents, error, retry }
}

/** The Add dialog's last step: search the registry, then pick an agent. */
export function RegistryAgentList({
  iconId,
  query,
  onQuery,
  selectedId,
  disabled,
  onSelect
}: {
  iconId: string
  query: string
  onQuery: (query: string) => void
  selectedId: string | null
  disabled: boolean
  onSelect: (agent: RegistryAgentView) => void
}) {
  const { agents, error, retry } = useRegistrySearch(query)
  return (
    <>
      <input
        className="settings-input prov-wizard-search"
        value={query}
        autoFocus
        placeholder="Search ACP agents"
        aria-label="Search ACP agents"
        spellCheck={false}
        onChange={(event) => onQuery(event.target.value)}
      />
      {error ? (
        <div className="prov-load-error">
          <p className="prov-error">The ACP registry isn&apos;t available: {error}</p>
          <button type="button" className="settings-btn" onClick={retry}>
            Try again
          </button>
        </div>
      ) : agents === null ? (
        <p className="settings-muted prov-empty">Loading the ACP registry…</p>
      ) : agents.length === 0 ? (
        <p className="settings-muted prov-empty">{query.trim() ? 'No matches' : 'The registry lists no agents for this computer'}</p>
      ) : (
        <RegistryAgentRows agents={agents} iconId={iconId} selectedId={selectedId} disabled={disabled} onSelect={onSelect} />
      )}
    </>
  )
}

/** One row per agent: name and version, then licence, how it is fetched and the checksum label. */
export function RegistryAgentRows({
  agents,
  iconId,
  selectedId,
  disabled,
  onSelect
}: {
  agents: readonly RegistryAgentView[]
  iconId: string
  selectedId: string | null
  disabled: boolean
  onSelect: (agent: RegistryAgentView) => void
}) {
  return (
    <div className="prov-registry-list" role="radiogroup" aria-label="ACP agents">
      {agents.map((agent) => {
        const checked = agent.id === selectedId
        return (
          <button
            key={agent.id}
            type="button"
            role="radio"
            aria-checked={checked}
            className={`prov-choice prov-registry-row${checked ? ' is-checked' : ''}`}
            title={agent.description || undefined}
            disabled={disabled || Boolean(agent.unsupported)}
            onClick={() => onSelect(agent)}
          >
            <ProviderIcon providerId={iconId} size={16} />
            <span className="prov-registry-text">
              <span className="prov-registry-title">
                <span className="prov-choice-label">{agent.name}</span>
                <code className="prov-version">{formatVersion(agent.version) ?? agent.version}</code>
              </span>
              <span className="prov-registry-meta">{registryAgentMeta(agent)}</span>
              {agent.unsupported && <span className="prov-registry-meta">{agent.unsupported}</span>}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** A yes the user gives before Mousse installs a download it cannot verify. */
function ConsentCheck({ checked, disabled, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <label className="prov-check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

/** The checksum label, with the unverified sentence under it when the registry gives none. */
function ChecksumText({ checksum, unverified }: { checksum: RegistryAgentView['checksum']; unverified: boolean }) {
  return (
    <span className="prov-source">
      <span>{checksumLabel(checksum)}</span>
      {unverified && <span className="prov-warning-text">{UNVERIFIED_NOTE}</span>}
    </span>
  )
}

/**
 * The confirm panel of a registry agent: what Mousse downloads, what it starts with, and the
 * checksum. A download without a checksum needs its own yes before "Add and install".
 */
export function RegistryConfirmStep({
  agent,
  busy,
  disabled,
  error,
  onConfirm
}: {
  agent: RegistryAgentView
  busy: boolean
  disabled: boolean
  error: string | null
  onConfirm: () => void
}) {
  const [accepted, setAccepted] = useState(false)
  const consent = needsConsent(agent)
  const canAdd = !disabled && (!consent || accepted)
  const env = Object.entries(agent.env)
  const about = [agent.description, agent.authors.length ? `By ${agent.authors.join(', ')}` : ''].filter(Boolean).join(' · ')
  return (
    <>
      <SettingsRow title={`${agent.name} ${formatVersion(agent.version) ?? agent.version}`} description={about || undefined} />
      {agent.distribution === 'binary' ? (
        <SettingsRow title="Download" description={<code className="prov-registry-code">{agent.artifactUrl ?? 'Unknown'}</code>} />
      ) : (
        <SettingsRow title="npm package" description={<code className="prov-registry-code">{agent.package ?? 'Unknown'}</code>} />
      )}
      <SettingsRow title="Checksum" description={<ChecksumText checksum={agent.checksum} unverified={consent} />} />
      <SettingsRow
        title="Arguments"
        description={agent.args.length ? <code className="prov-registry-code">{formatArgs(agent.args)}</code> : 'None'}
      />
      <SettingsRow
        title="Variables"
        description={
          env.length ? (
            <span className="prov-source">
              {env.map(([name, value]) => (
                <code key={name} className="prov-registry-code">
                  {name}={value}
                </code>
              ))}
            </span>
          ) : (
            'None'
          )
        }
      />
      <SettingsRow
        title="Add"
        description={
          error ? <span className="prov-error">{error}</span> : busy ? 'Adding and installing…' : 'Mousse adds it as a provider and installs it.'
        }
        control={
          <>
            {consent && <ConsentCheck checked={accepted} disabled={disabled} label="Install without a checksum" onChange={setAccepted} />}
            <button type="button" className="settings-btn" disabled={!canAdd} onClick={onConfirm}>
              {busy ? 'Adding…' : 'Add and install'}
            </button>
          </>
        }
      />
    </>
  )
}

/**
 * The editor's Source row of a registry entry: the agent and version, the checksum label and any
 * advisory. When the registry lists another version, "Update to vX" (with its own yes when that
 * download has no checksum) records it and installs it.
 */
export function RegistrySourceRow({
  snapshot,
  source,
  actions
}: {
  snapshot: InstanceSnapshot
  source: { agentId: string; version: string }
  actions: Pick<InstanceActions, 'configure' | 'install'>
}) {
  const [update, setUpdate] = useState<RegistryAgentView | undefined>()
  const [confirming, setConfirming] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const { busy, error, run } = useAsyncAction()
  const { agentId, version } = source
  useEffect(() => {
    let cancelled = false
    setUpdate(undefined)
    setConfirming(false)
    // A failed lookup only means no update is offered; the entry itself is fine.
    window.mousse.providers.registry
      .search(agentId)
      .then((agents) => {
        if (!cancelled) setUpdate(registryUpdateOf({ agentId, version }, agents))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [agentId, version])

  const installing = snapshot.install.state === 'installing'
  const target = update ? (formatVersion(update.version) ?? update.version) : undefined
  const apply = () => {
    const next = update ? registrySourceOf(update) : undefined
    if (!next) return
    void run('update', async () => {
      await actions.configure({ source: next })
      await actions.install()
      setConfirming(false)
    })
  }
  const { checksum, advisory } = snapshot.install
  const description: ReactNode = (
    <span className="prov-source">
      <span>{[registrySourceLabel(source), checksum ? checksumLabel(checksum) : undefined].filter(Boolean).join(' · ')}</span>
      {advisory && <span className="prov-warning-text">{advisory}</span>}
      {error && <span className="prov-error">{error}</span>}
    </span>
  )
  return (
    <SettingsRow
      title="Source"
      description={description}
      control={
        update &&
        !confirming && (
          <button
            type="button"
            className="settings-btn"
            disabled={busy !== null || installing}
            onClick={() => (needsConsent(update) ? setConfirming(true) : apply())}
          >
            {busy === 'update' ? 'Updating…' : `Update to ${target}`}
          </button>
        )
      }
    >
      {update && confirming && (
        <span className="prov-confirm">
          <span className="prov-warning-text">
            {target} has no registry checksum. {UNVERIFIED_NOTE}
          </span>
          <span className="prov-confirm-actions">
            <ConsentCheck checked={accepted} disabled={busy !== null} label="Install without a checksum" onChange={setAccepted} />
            <button type="button" className="settings-btn" disabled={busy !== null} onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button type="button" className="settings-btn" disabled={busy !== null || !accepted || installing} onClick={apply}>
              {busy === 'update' ? 'Updating…' : `Update to ${target}`}
            </button>
          </span>
        </span>
      )}
    </SettingsRow>
  )
}

/** Lists the profiles whose entries still use the files. */
function UsedByList({ usedBy }: { usedBy: UsedBy }) {
  return (
    <ul className="prov-used-by">
      {usedBy.map((entry) => (
        <li key={entry.profileId}>{usedByLabel(entry)}</li>
      ))}
    </ul>
  )
}

/**
 * "Delete downloaded files (N MB)". Other entries using the same files (in any profile) block it; the
 * confirm lists them and "Delete anyway" deletes the files regardless.
 */
export function DownloadedFilesRow({
  snapshot,
  bytes,
  onRemoveInstall
}: {
  snapshot: InstanceSnapshot
  bytes: number
  onRemoveInstall: (force: boolean) => Promise<RemoveInstallResult>
}) {
  const [usedBy, setUsedBy] = useState<UsedBy | null>(null)
  const { busy, error, run } = useAsyncAction()
  const size = formatMegabytes(bytes)
  const remove = (force: boolean) =>
    void run(force ? 'force' : 'delete', async () => {
      const result = await onRemoveInstall(force)
      setUsedBy(result.removed ? null : result.usedBy)
    })
  return (
    <>
      <SettingsRow
        title="Downloaded files"
        description={error && !usedBy ? <span className="prov-error">{error}</span> : `${size} on this computer. Install downloads them again.`}
        control={
          <button type="button" className="settings-btn" disabled={busy !== null || snapshot.install.state === 'installing'} onClick={() => remove(false)}>
            {busy === 'delete' ? 'Deleting…' : `Delete downloaded files (${size})`}
          </button>
        }
      />
      {usedBy && (
        <Modal
          open
          title="Delete downloaded files?"
          onClose={() => setUsedBy(null)}
          footer={
            <>
              <button type="button" className="btn" disabled={busy !== null} onClick={() => setUsedBy(null)}>
                Cancel
              </button>
              <button type="button" className="btn prov-btn-danger" disabled={busy !== null} onClick={() => remove(true)}>
                {busy === 'force' ? 'Deleting…' : 'Delete anyway'}
              </button>
            </>
          }
        >
          <div className="prov-wizard-panel">
            {error && <p className="prov-error">{error}</p>}
            <p>Other entries use the files of {snapshot.displayName}, in these profiles:</p>
            <UsedByList usedBy={usedBy} />
            <p className="settings-muted">Those entries stop working until they install it again.</p>
          </div>
        </Modal>
      )}
    </>
  )
}

export interface RemoveOptions {
  /** Delete the files Mousse downloaded for the entry before removing it. */
  deleteFiles: boolean
}

/** The trash button of an entry with downloaded files: removing asks whether to delete them too. */
export function RemoveWithFilesButton({
  snapshot,
  bytes,
  label,
  onRemove
}: {
  snapshot: InstanceSnapshot
  bytes: number
  label: string
  onRemove: (options: RemoveOptions) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="settings-icon-btn danger" title={label} aria-label={label} onClick={() => setOpen(true)}>
        <Trash2 size={14} />
      </button>
      {open && <RemoveProviderDialog snapshot={snapshot} bytes={bytes} onRemove={onRemove} onClose={() => setOpen(false)} />}
    </>
  )
}

export function RemoveProviderDialog({
  snapshot,
  bytes,
  onRemove,
  onClose
}: {
  snapshot: InstanceSnapshot
  bytes: number
  onRemove: (options: RemoveOptions) => Promise<void>
  onClose: () => void
}) {
  const [deleteFiles, setDeleteFiles] = useState(false)
  const { busy, error, run } = useAsyncAction()
  const mounted = useRef(true)
  useEffect(() => () => {
    mounted.current = false
  }, [])
  const confirm = () =>
    void run('remove', async () => {
      await onRemove({ deleteFiles })
      // Removing unmounts the editor; close only if this dialog is still there.
      if (mounted.current) onClose()
    })
  return (
    <Modal
      open
      title={`Remove ${snapshot.displayName}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" disabled={busy !== null} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn prov-btn-danger" disabled={busy !== null} onClick={confirm}>
            {busy ? 'Removing…' : 'Remove'}
          </button>
        </>
      }
    >
      <div className="prov-wizard-panel">
        {error && <p className="prov-error">{error}</p>}
        <p>Mousse deletes this provider. Add it again any time.</p>
        <ConsentCheck
          checked={deleteFiles}
          disabled={busy !== null}
          label={`Delete downloaded files (${formatMegabytes(bytes)})`}
          onChange={setDeleteFiles}
        />
      </div>
    </Modal>
  )
}
