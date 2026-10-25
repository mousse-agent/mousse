import { useEffect, useRef, useState } from 'react'
import type { LlmProviderOption } from '../../../shared/settings'
import { ChevronDown } from '../../lib/icons'
import { ProviderIcon } from '../../lib/providerIcons'
import { listingServes } from '../../../shared/providerInstances'
import { ComposerEffortPicker } from '../ComposerEffortPicker'
import { getGroupedModelButtonParts, ModelFamilyMenu } from '../ModelFamilyMenu'
import '../../styles/settingsModelPicker.css'

/**
 * One settings control for a model choice: the composer's model menu plus its
 * reasoning/speed menu, joined into a single 28px control. Provider, model,
 * context, effort and speed all land in one `(providerId, modelId)` pair, with
 * the instance serving it when the listing names one.
 */
export function SettingsModelPicker({
  providers,
  providerId,
  instanceId,
  modelId,
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
  modelId: string
  onSelect: (providerId: string, modelId: string, instanceId?: string) => void
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
  const parts = selected ? getGroupedModelButtonParts(providerId, modelId, providers, false, instanceId) : [placeholder]
  const label = parts.join(' · ')
  const listing = providers.find((provider) => listingServes(provider, { instanceId, llmProvider: providerId }))
  const models = listing?.models ?? []

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
      {selected && (
        <ComposerEffortPicker
          providerId={providerId}
          modelId={modelId}
          models={models}
          readOnly={Boolean(disabled)}
          onSelect={(nextProviderId, nextModelId) => onSelect(nextProviderId, nextModelId, listing?.instanceId)}
        />
      )}
      {open && !disabled && (
        <ModelFamilyMenu
          providers={providers}
          selectedProviderId={providerId}
          selectedInstanceId={instanceId}
          selectedModelId={modelId}
          anchorRef={buttonRef}
          contentRef={menuRef}
          onSelect={(nextProviderId, nextModelId, nextInstanceId) => {
            setOpen(false)
            onSelect(nextProviderId, nextModelId, nextInstanceId)
            buttonRef.current?.focus()
          }}
        />
      )}
    </div>
  )
}
