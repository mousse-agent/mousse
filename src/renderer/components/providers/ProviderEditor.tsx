import { useEffect, useState, type ReactNode } from 'react'
import type { InstanceSnapshot, StatusDescription } from '../../../shared/harness/status'
import type { ModelPrefsPatch, ProviderOperationEvent } from '../../../shared/harness/types'
import { ProviderIcon } from '../../lib/providerIcons'
import { SettingsRow } from '../settings/SettingsRow'
import { AccountRow, ArgsRow, BinaryRow, EnvRow, ExecutableRow, HomeRow, SetupRow, UpdateRow, type InstanceActions } from './CliSections'
import { ProviderModelsSection } from './ProviderModelsSection'
import { EditorSection, RemoveButton, useAsyncAction } from './parts'
import { DRIVER_INFO, formatVersion, iconIdOf } from './providerView'

/**
 * The editor's first section, as in T3 Code: the provider's logo and name as the heading, its
 * version and delete on the right, then the Display name row. The status lives in Setup → Status.
 */
export function EditorHeader({
  snapshot,
  removeLabel,
  removeHint,
  onRemove,
  onRename
}: {
  snapshot: InstanceSnapshot
  removeLabel?: string
  removeHint?: string
  onRemove?: () => Promise<void>
  /** Saves the display name; empty clears it back to the default. */
  onRename?: (displayName: string | null) => Promise<void>
}) {
  const removal = useAsyncAction()
  const rename = useAsyncAction()
  const [draft, setDraft] = useState(snapshot.displayName)
  useEffect(() => setDraft(snapshot.displayName), [snapshot.displayName])
  const version = formatVersion(snapshot.binary?.version)
  const commit = () => {
    const next = draft.trim()
    if (next === snapshot.displayName || !onRename) return
    void rename.run('rename', () => onRename(next || null))
  }
  return (
    <EditorSection
      title={
        <>
          <ProviderIcon providerId={iconIdOf(snapshot)} size={18} />
          {snapshot.displayName}
        </>
      }
      action={
        <>
          {version && <code className="prov-version">{version}</code>}
          {onRemove && removeLabel && (
            <span title={removeHint}>
              <RemoveButton label={removeLabel} disabled={removal.busy !== null} onRemove={() => void removal.run('remove', onRemove)} />
            </span>
          )}
        </>
      }
    >
      <SettingsRow
        title="Display name"
        description={(removal.error ?? rename.error) && <span className="prov-error">{removal.error ?? rename.error}</span>}
        control={
          <input
            className="settings-input"
            value={draft}
            readOnly={!onRename}
            disabled={!onRename || rename.busy !== null}
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
    </EditorSection>
  )
}

/**
 * The editor of one agent instance: Setup (status, next step, account), Runtime (the executable
 * Mousse resolved, updates, path and arguments, home), Environment and Models.
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
        removeHint={onRemove ? 'Removes this instance and its private home' : undefined}
        onRemove={onRemove}
        onRename={(displayName) => actions.configure({ displayName })}
      />
      <EditorSection title="Setup">
        <SetupRow snapshot={snapshot} status={status} operation={operation?.kind === 'update' ? undefined : operation} actions={actions} />
        <AccountRow snapshot={snapshot} actions={actions} />
      </EditorSection>
      <EditorSection title="Runtime">
        <BinaryRow snapshot={snapshot} />
        <UpdateRow snapshot={snapshot} operation={operation} actions={actions} />
        <ExecutableRow snapshot={snapshot} label={info.label} onSave={(binaryPath) => actions.configure({ binaryPath })} />
        <ArgsRow snapshot={snapshot} onSave={(args) => actions.configure({ args })} />
        <HomeRow snapshot={snapshot} />
      </EditorSection>
      <EditorSection title="Environment">
        <EnvRow snapshot={snapshot} onSave={(env) => actions.configure({ env })} />
      </EditorSection>
      <ModelsEditorSection snapshot={snapshot} onSave={onSaveModelPrefs} onRefresh={onRefreshModels} />
    </>
  )
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
  return (
    <EditorSection title="Models" description="Favorites show first in the model picker. Hidden models are not offered anywhere in Mousse.">
      <div className="prov-models-wrap">
        <ProviderModelsSection
          snapshot={snapshot}
          allowCustom={DRIVER_INFO[snapshot.driver].customModels}
          onSave={onSave}
          onRefresh={onRefresh}
        />
      </div>
    </EditorSection>
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
