import { useEffect, useState, type ReactNode } from 'react'
import type { InstanceSnapshot, StatusDescription } from '../../../shared/harness/status'
import type { ModelPrefsPatch, ProviderOperationEvent } from '../../../shared/harness/types'
import { ChevronRight } from '../../lib/icons'
import { ProviderIcon } from '../../lib/providerIcons'
import { SettingsAdvanced, SettingsRow } from '../settings/SettingsRow'
import { AccountRow, ArgsRow, BinaryRow, EnvRow, ExecutableRow, HomeRow, SetupRow, UpdateRow, type InstanceActions } from './CliSections'
import { ProviderModelsSection, modelsSummary } from './ProviderModelsSection'
import { EditorSection, RemoveButton, useAsyncAction } from './parts'
import { DRIVER_INFO, formatVersion, iconIdOf } from './providerView'

/**
 * Provider setup is per machine, as in T3 Code: only the on/off switch has a project override. In
 * a project scope the device-wide sections say so.
 */
const DEVICE_WIDE = 'Applies to this device, in every project.'

function deviceWideNote(snapshot: InstanceSnapshot): string | undefined {
  return snapshot.scope.kind === 'project' ? DEVICE_WIDE : undefined
}

/**
 * The editor's heading, as in T3 Code: the provider's logo and name, its version and delete on the
 * right. The status lives in Setup → Status; renaming lives under Advanced.
 */
export function EditorHeader({
  snapshot,
  removeLabel,
  removeHint,
  onRemove
}: {
  snapshot: InstanceSnapshot
  removeLabel?: string
  removeHint?: string
  onRemove?: () => Promise<void>
}) {
  const removal = useAsyncAction()
  const version = formatVersion(snapshot.binary?.version)
  return (
    <section className="settings-group prov-editor-section">
      <div className="settings-group-head">
        <div className="settings-group-head-text">
          <h3 className="settings-group-title">
            <ProviderIcon providerId={iconIdOf(snapshot)} size={18} />
            {snapshot.displayName}
          </h3>
          {removal.error && <p className="settings-group-desc prov-error">{removal.error}</p>}
        </div>
        <div className="settings-group-action">
          {version && <code className="prov-version">{version}</code>}
          {onRemove && removeLabel && (
            <span title={removeHint}>
              <RemoveButton label={removeLabel} disabled={removal.busy !== null} onRemove={() => void removal.run('remove', onRemove)} />
            </span>
          )}
        </div>
      </div>
    </section>
  )
}

/** Renames the instance; empty clears it back to the default. */
function DisplayNameRow({ snapshot, onRename }: { snapshot: InstanceSnapshot; onRename: (displayName: string | null) => Promise<void> }) {
  const rename = useAsyncAction()
  const [draft, setDraft] = useState(snapshot.displayName)
  useEffect(() => setDraft(snapshot.displayName), [snapshot.displayName])
  const commit = () => {
    const next = draft.trim()
    if (next === snapshot.displayName) return
    void rename.run('rename', () => onRename(next || null))
  }
  return (
    <SettingsRow
      title="Display name"
      description={rename.error ? <span className="prov-error">{rename.error}</span> : deviceWideNote(snapshot)}
      control={
        <input
          className="settings-input"
          value={draft}
          disabled={rename.busy !== null}
          placeholder={DRIVER_INFO[snapshot.driver].label}
          aria-label="Display name"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
      }
    />
  )
}

/**
 * The editor of one agent instance: Setup (name, status, next step, account) and Models up front;
 * the rest (the executable Mousse resolved, updates, path and arguments, home, environment) under a
 * collapsed Advanced, so most people never meet it.
 */
export function AgentEditor({
  snapshot,
  status,
  operation,
  actions,
  onRemove,
  onSaveModelPrefs,
  onRefreshModels
}: {
  snapshot: InstanceSnapshot
  status: StatusDescription
  operation?: ProviderOperationEvent
  actions: InstanceActions
  onRemove?: () => Promise<void>
  onSaveModelPrefs: (patch: ModelPrefsPatch) => Promise<void>
  onRefreshModels: () => Promise<void>
}) {
  const info = DRIVER_INFO[snapshot.driver]
  return (
    <>
      <EditorHeader
        snapshot={snapshot}
        removeLabel={onRemove ? 'Remove provider' : undefined}
        removeHint={
          !onRemove
            ? undefined
            : snapshot.config?.home === 'private'
              ? 'Deletes this provider and the sign-in Mousse kept for it. Add it again any time.'
              : 'Deletes this provider from Mousse. Your CLI and its sign-in stay; add it again any time.'
        }
        onRemove={onRemove}
      />
      <EditorSection title="Setup">
        <DisplayNameRow snapshot={snapshot} onRename={(displayName) => actions.configure({ displayName })} />
        <SetupRow snapshot={snapshot} status={status} operation={operation?.kind === 'update' ? undefined : operation} actions={actions} />
        <AccountRow snapshot={snapshot} actions={actions} />
      </EditorSection>
      <ModelsEditorSection snapshot={snapshot} onSave={onSaveModelPrefs} onRefresh={onRefreshModels} />
      <SettingsAdvanced>
        <EditorSection title="Runtime" description={deviceWideNote(snapshot)}>
          <BinaryRow snapshot={snapshot} />
          <UpdateRow snapshot={snapshot} operation={operation} actions={actions} />
          <ExecutableRow snapshot={snapshot} label={info.label} onSave={(binaryPath) => actions.configure({ binaryPath })} />
          <ArgsRow snapshot={snapshot} onSave={(args) => actions.configure({ args })} />
          <HomeRow snapshot={snapshot} />
        </EditorSection>
        <EditorSection title="Environment" description={deviceWideNote(snapshot)}>
          <EnvRow snapshot={snapshot} onSave={(env) => actions.configure({ env })} />
        </EditorSection>
      </SettingsAdvanced>
    </>
  )
}

/** Custom models only where the runtime can run one by id: the daemon says so; older daemons by driver. */
export function allowsCustomModels(snapshot: InstanceSnapshot): boolean {
  return snapshot.models.canAddCustom ?? DRIVER_INFO[snapshot.driver].customModels
}

export function ModelsEditorSection({
  snapshot,
  onSave,
  onRefresh
}: {
  snapshot: InstanceSnapshot
  onSave: (patch: ModelPrefsPatch) => Promise<void>
  onRefresh: () => Promise<void>
}) {
  // Collapsed by default, like Advanced; the summary keeps the counts in view while it is closed.
  return (
    <details className="settings-advanced prov-models-section">
      <summary>
        <ChevronRight size={14} aria-hidden="true" className="settings-advanced-chevron" />
        Models
        <span className="prov-models-summary">{modelsSummary(snapshot.models.entries)}</span>
      </summary>
      <div className="settings-advanced-body">
        <section className="settings-group prov-editor-section">
          <p className="settings-group-desc">
            Favorites show first in the model picker. Hidden models are not offered anywhere in Mousse.
            {snapshot.scope.kind === 'project' ? ` ${DEVICE_WIDE}` : ''}
          </p>
          <div className="settings-group-rows">
            <div className="prov-models-wrap">
              <ProviderModelsSection
                snapshot={snapshot}
                allowCustom={allowsCustomModels(snapshot)}
                onSave={onSave}
                onRefresh={onRefresh}
              />
            </div>
          </div>
        </section>
      </div>
    </details>
  )
}

/** The editor of a model API: header, its Setup row, then Models. */
export function ApiEditor({
  snapshot,
  setup,
  removeHint,
  onRemove,
  onSaveModelPrefs,
  onRefreshModels
}: {
  snapshot: InstanceSnapshot
  setup: ReactNode
  removeHint?: string
  onRemove: () => Promise<void>
  onSaveModelPrefs: (patch: ModelPrefsPatch) => Promise<void>
  onRefreshModels: () => Promise<void>
}) {
  return (
    <>
      <EditorHeader snapshot={snapshot} removeLabel="Remove provider" removeHint={removeHint} onRemove={onRemove} />
      <EditorSection title="Setup">{setup}</EditorSection>
      <ModelsEditorSection snapshot={snapshot} onSave={onSaveModelPrefs} onRefresh={onRefreshModels} />
    </>
  )
}
