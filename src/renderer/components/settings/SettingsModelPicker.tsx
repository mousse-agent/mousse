import { pickedSelection, pickerModelId, type ModelPick } from '../../../shared/modelSelection'
import { useEffect, useRef, useState } from 'react'
import type { LlmProviderOption } from '../../../shared/settings'
import { ChevronDown } from '../../lib/icons'
import { ProviderIcon } from '../../lib/providerIcons'
import { listingServes } from '../../../shared/providerInstances'
import { modelPickerRunSettings, runFasterSpeed, runLevelText } from '../ComposerEffortPicker'
import { getGroupedModelButtonParts, ModelFamilyMenu } from '../ModelFamilyMenu'
import '../../styles/settingsModelPicker.css'

/**
 * One settings control for a model choice: the composer's model menu, with the highlighted model's
 * reasoning levels beside the list and its speeds under it, so model, level and speed are one choice.
 * A choice lands as the provider, the model with its reasoning level apart, and the instance serving it
 * when the listing names one.
 */
export function SettingsModelPicker({
  providers,
  providerId,
  instanceId,
  modelId,
  effort,
  onSelect,
  placeholder = 'Select model',
  ariaLabel = 'Model',
  id,
  disabled
}: {
  providers: LlmProviderOption[]
  providerId: string
  /** The selection's instance; tells apart two accounts of one provider. */
  instanceId?: string
  /** The model as listed; its reasoning level is `effort` (absent = the model's default). */
  modelId: string
  effort?: string
  onSelect: (providerId: string, pick: ModelPick, instanceId?: string) => void
  /** Shown when nothing is selected, e.g. "Automatic". */
  placeholder?: string
  ariaLabel?: string
  id?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const selected = Boolean(providerId && modelId)
  // The menus offer each level of a model as an id of its own.
  const pickerId = pickerModelId({ model: modelId, effort })
  const listing = providers.find((provider) => listingServes(provider, { instanceId, llmProvider: providerId }))
  const selection = { providerId, modelId: pickerId, models: listing?.models ?? [] }
  // The level and a faster speed follow the model's name ("Opus 5.5 · High · Fast"); the name drops its "(fast)".
  const faster = selected ? runFasterSpeed(selection) : ''
  const named = selected ? getGroupedModelButtonParts(providerId, pickerId, providers, false, instanceId) : [placeholder]
  const parts = faster ? [named[0]!.replace(/\s*\((?:ultra)?fast\)$/i, ''), ...named.slice(1)] : named
  const label = [...parts, selected ? runLevelText(selection) : '', faster].filter(Boolean).join(' · ')

  useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent) => {
      const target = event.target as Node
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('mousedown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  const close = () => {
    setOpen(false)
    buttonRef.current?.focus()
  }
  const choose = (nextProviderId: string, nextModelId: string, nextInstanceId?: string) =>
    onSelect(nextProviderId, pickedSelection(nextModelId), nextInstanceId)

  return (
    <div className="settings-model-picker">
      <button
        ref={buttonRef}
        id={id}
        type="button"
        className={`settings-model-btn${open ? ' open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${ariaLabel}: ${label}`}
        title={label}
        disabled={disabled || providers.length === 0}
        onClick={() => setOpen((current) => !current)}
      >
        {selected && <ProviderIcon providerId={providerId} size={14} />}
        <span className="settings-model-btn-label">{label}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && !disabled && (
        <ModelFamilyMenu
          providers={providers}
          selectedProviderId={providerId}
          selectedInstanceId={instanceId}
          selectedModelId={pickerId}
          anchorRef={buttonRef}
          contentRef={menuRef}
          runSettings={modelPickerRunSettings({ providers, selection, onSelect: choose, onClose: close })}
          onSelect={(nextProviderId, nextModelId, nextInstanceId) => {
            close()
            choose(nextProviderId, nextModelId, nextInstanceId)
          }}
        />
      )}
    </div>
  )
}
