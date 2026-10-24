import { useEffect, useRef, useState } from 'react'
import type { LlmProviderOption } from '../../../shared/settings'
import { ChevronDown } from '../../lib/icons'
import { ProviderIcon } from '../../lib/providerIcons'
import { ComposerEffortPicker } from '../ComposerEffortPicker'
import { getGroupedModelButtonParts, ModelFamilyMenu } from '../ModelFamilyMenu'
import '../../styles/settingsModelPicker.css'

/**
 * One settings control for a model choice: the composer's model menu plus its
 * reasoning/speed menu, joined into a single 28px control. Provider, model,
 * context, effort and speed all land in one `(providerId, modelId)` pair.
 */
export function SettingsModelPicker({
  providers,
  providerId,
  modelId,
  onSelect,
  placeholder = 'Select model',
  ariaLabel = 'Model',
  id,
  disabled
}: {
  providers: LlmProviderOption[]
  providerId: string
  modelId: string
  onSelect: (providerId: string, modelId: string) => void
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
  const parts = selected ? getGroupedModelButtonParts(providerId, modelId, providers, false) : [placeholder]
  const label = parts.join(' · ')
  const models = providers.find((provider) => provider.id === providerId)?.models ?? []

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
          onSelect={onSelect}
        />
      )}
      {open && !disabled && (
        <ModelFamilyMenu
          providers={providers}
          selectedProviderId={providerId}
          selectedModelId={modelId}
          anchorRef={buttonRef}
          contentRef={menuRef}
          onSelect={(nextProviderId, nextModelId) => {
            setOpen(false)
            onSelect(nextProviderId, nextModelId)
            buttonRef.current?.focus()
          }}
        />
      )}
    </div>
  )
}
