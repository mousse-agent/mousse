import { useMemo, useRef, useState } from 'react'
import type { LlmProviderOption } from '../../../shared/settings'
import type { AgentModelRef } from '../../../shared/agents/types'
import { ModelFamilyMenu } from '../ModelFamilyMenu'
import { ModelFamilySettingsFields } from '../ModelFamilySettingsFields'
import { findModelInCatalog, fieldIdForPointer } from './editorIssues'
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
  const available = findModelInCatalog(catalogs, value.providerId, value.modelId)
  const missing = Boolean(value.providerId && value.modelId && !available)
  const provider = catalogs.providers.find((entry) => entry.id === value.providerId)
  const buttonLabel = available
    ? `${available.providerLabel} · ${available.modelLabel}`
    : value.modelId
      ? `${value.providerId}/${value.modelId}`
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
            selectedModelId={value.modelId}
            anchorRef={buttonRef}
            onSelect={(providerId, modelId) => {
              onChange({ ...value, providerId, modelId })
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
          modelId={value.modelId}
          models={modelsForFields}
          onChange={(modelId) => onChange({ ...value, modelId })}
        />
      ) : null}
    </div>
  )
}
