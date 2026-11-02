import { useMemo, useRef, useState } from 'react'
import type { LlmProviderOption } from '../../../shared/settings'
import type { AgentModelRef } from '../../../shared/agents/types'
import { listingServes } from '../../../shared/providerInstances'
import { ModelFamilyMenu } from '../ModelFamilyMenu'
import { ModelFamilySettingsFields } from '../ModelFamilySettingsFields'
import { findModelInCatalog, fieldIdForPointer } from './editorIssues'
import { agentModelLabel } from './agentModelLabel'
import { pickedSelection, pickerModelId, upgradeSelection } from '../../../shared/modelSelection'
import type { AgentEditorCatalogs } from './client'

export function AgentModelPicker({
  catalogs,
  value,
  onChange,
  label = 'Model',
  pointer = '/settings/primaryModel',
  disabled
}: {
  catalogs: AgentEditorCatalogs
  value: AgentModelRef
  onChange: (ref: AgentModelRef) => void
  label?: string
  pointer?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  // The menus show a level as part of the model's id; the ref keeps it in `effort`.
  const pickerId = pickerModelId(upgradeSelection({ model: value.modelId, ...(value.effort ? { effort: value.effort } : {}) }))
  /** The ref with the model and level a menu's id names; no level is the model's default. */
  const withPick = (ref: AgentModelRef, id: string): AgentModelRef => {
    const { effort: _effort, ...rest } = ref
    const pick = pickedSelection(id)
    return { ...rest, modelId: pick.model, ...(pick.effort ? { effort: pick.effort } : {}) }
  }
  const available = findModelInCatalog(catalogs, value.providerId, value.modelId, value.instanceId)
  const missing = Boolean(value.providerId && value.modelId && !available)
  const provider = catalogs.providers.find((entry) => listingServes(entry, { instanceId: value.instanceId, llmProvider: value.providerId }))
  const buttonLabel = value.modelId
    ? `${available?.providerLabel ?? provider?.label ?? value.providerId} · ${agentModelLabel(value, catalogs.providers)}`
    : 'Choose a model'

  const modelsForFields: LlmProviderOption['models'] = useMemo(
    () => provider?.models ?? [],
    [provider]
  )

  return (
    <div id={fieldIdForPointer(pointer)} data-model-picker={pointer}>
      <div className="agent-field">
        <span>{label}</span>
        <button
          ref={buttonRef}
          type="button"
          className="btn"
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
        >
          {buttonLabel}
        </button>
        {open && !disabled ? (
          <ModelFamilyMenu
            providers={catalogs.providers}
            selectedProviderId={value.providerId}
            selectedInstanceId={value.instanceId}
            selectedModelId={pickerId}
            anchorRef={buttonRef}
            onSelect={(providerId, modelId, instanceId) => {
              // The whole selection: a listing without an instance drops the earlier one.
              const next: AgentModelRef = { ...withPick(value, modelId), providerId, instanceId }
              if (!instanceId) delete next.instanceId
              onChange(next)
              setOpen(false)
            }}
          />
        ) : null}
        {missing ? (
          <p className="agent-field-error" role="alert">
            This selected model is no longer in the shared catalog. The draft keeps it so you can repair the
            choice. Publishing and try-run stay blocked.
          </p>
        ) : null}
        {catalogs.providers.length === 0 ? (
          <small>No providers are connected in this profile session.</small>
        ) : (
          <small>
            Models are shared across profiles. Personal favorites in this menu currently use a global browser
            store; do not add another one here.
          </small>
        )}
      </div>
      {provider && value.modelId ? (
        <ModelFamilySettingsFields
          providerId={value.providerId}
          modelId={pickerId}
          models={modelsForFields}
          onChange={(modelId) => onChange(withPick(value, modelId))}
        />
      ) : null}
    </div>
  )
}
