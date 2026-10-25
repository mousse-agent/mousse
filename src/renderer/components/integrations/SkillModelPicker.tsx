import { useEffect, useRef, useState } from 'react'
import type { LlmProviderOption } from '../../../shared/settings'
import { listingServes } from '../../../shared/providerInstances'
import { getGroupedModelButtonParts, ModelFamilyMenu } from '../ModelFamilyMenu'

/** `instanceId` tells apart two accounts of one provider; absent on older records. */
export interface SkillModelChoice { instanceId?: string; llmProvider: string; model: string }

/** Settings-side default model per skill (`integrations.skills.model[skillId]`). */
export interface SkillModelBinding {
  providers: LlmProviderOption[]
  get: (skillId: string) => SkillModelChoice | undefined
  /** `null` returns the skill to the default model. */
  set: (skillId: string, value: SkillModelChoice | null) => Promise<void>
}

/** The composer's model picker, for one skill's optional default model. */
export function SkillModelPicker({ skillId, binding, disabled }: { skillId: string; binding: SkillModelBinding; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const value = binding.get(skillId)
  const providers = binding.providers
  const provider = value ? providers.find((entry) => listingServes(entry, value)) : undefined
  const label = value
    ? `${provider?.label ?? value.llmProvider} · ${getGroupedModelButtonParts(value.llmProvider, value.model, providers, true, value.instanceId).join(' · ')}`
    : 'Default model'

  useEffect(() => {
    if (!open) return
    const pointer = (event: MouseEvent) => {
      const target = event.target as Node
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    // Capture so the dialog around the picker stays open on Escape.
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation()
      setOpen(false); buttonRef.current?.focus()
    }
    document.addEventListener('mousedown', pointer)
    window.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('mousedown', pointer)
      window.removeEventListener('keydown', key, true)
    }
  }, [open])

  const save = (next: SkillModelChoice | null) => {
    setError(null)
    void binding.set(skillId, next).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }

  if (!providers.length) return <p className="integration-help">Connect a provider to choose a model for this skill.</p>
  return <div className="skill-model-picker">
    <div className="skill-model-picker__controls">
      <button
        ref={buttonRef}
        type="button"
        className="btn btn-sm skill-model-picker__button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Model for this skill: ${label}`}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >{label}</button>
      {value ? <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => save(null)}>Use default</button> : null}
    </div>
    {open && !disabled ? <ModelFamilyMenu
      providers={providers}
      selectedProviderId={value?.llmProvider ?? ''}
      selectedInstanceId={value?.instanceId}
      selectedModelId={value?.model ?? ''}
      anchorRef={buttonRef}
      contentRef={menuRef}
      onSelect={(llmProvider, model, instanceId) => { setOpen(false); save({ ...(instanceId ? { instanceId } : {}), llmProvider, model }) }}
    /> : null}
    {error ? <p className="integration-error" role="alert">{error}</p> : null}
  </div>
}
