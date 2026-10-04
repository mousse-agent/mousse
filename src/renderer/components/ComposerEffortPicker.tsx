import { useEffect, useRef, useState } from 'react'
import type { LlmModelOption } from '../../shared/settings'
import { applyEffortToModelId, findModelFamily, formatEffortLabel, getCurrentEffort, getEffortsForModel, getModelFastToggle, parseModelVariant, parseThinkingSuffixFromModelId, resolveModelVariant } from '../../shared/modelVariants'
import { ChevronDown } from '../lib/icons'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'

export function ComposerEffortPicker({ providerId, modelId, models, readOnly, onSelect }: {
  providerId: string
  modelId: string
  models: LlmModelOption[]
  readOnly: boolean
  onSelect: (providerId: string, modelId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const efforts = getEffortsForModel(providerId, modelId, models)
  const effort = getCurrentEffort(modelId, models, providerId)
  const fast = getModelFastToggle(providerId, modelId, models)
  const style = useFloatingPosition({ open, anchorRef, contentRef, placement: 'above-start', deps: [modelId] })
  useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent) => {
      if (!anchorRef.current?.contains(event.target as Node) && !contentRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); anchorRef.current?.focus() } }
    document.addEventListener('mousedown', dismiss)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', dismiss); document.removeEventListener('keydown', escape) }
  }, [open])
  const select = (id: string) => { onSelect(providerId, id); setOpen(false); anchorRef.current?.focus() }
  const selectEffort = (value: string) => {
    const family = findModelFamily(providerId, models, modelId)
    const baseId = parseThinkingSuffixFromModelId(modelId).baseId
    const current = models.find((model) => model.id === modelId || model.id === baseId)
    const variant = current ? parseModelVariant(current) : undefined
    const resolved = family && resolveModelVariant(family, { context: variant?.context, speed: variant?.speed, effort: value })
    select(value === 'off' ? `${parseThinkingSuffixFromModelId(resolved?.id ?? modelId).baseId}:off` : resolved?.id ?? applyEffortToModelId(modelId, value))
  }
  if (!efforts.length && !fast) return null
  return <div className="composer-effort-picker">
    <button ref={anchorRef} type="button" className={`composer-pill-btn${open ? ' open' : ''}`} disabled={readOnly} aria-label="Reasoning effort and speed" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span>{effort ? formatEffortLabel(effort) : 'Effort'}{fast?.active ? ' · Fast' : ''}</span><ChevronDown size={12} />
    </button>
    {open && !readOnly && <FloatingPortal><div ref={contentRef} style={style} className="composer-mode-menu composer-mode-menu-floating" role="menu" aria-label="Reasoning effort and speed">
      {efforts.length > 0 && <div className="composer-mode-menu-section" role="group" aria-label="Reasoning">
        <div className="composer-mode-menu-heading">Reasoning</div>
        {['off', ...efforts.filter((value) => value !== 'off')].map((value) => <button key={value} type="button" role="menuitemradio" aria-checked={effort === value} className={`composer-mode-menu-item${effort === value ? ' selected' : ''}`} onClick={() => selectEffort(value)}>{value === 'xhigh' ? 'Extra high' : formatEffortLabel(value)}</button>)}
      </div>}
      {fast && <div className="composer-mode-menu-section composer-mode-menu-group" role="group" aria-label="Speed">
        <div className="composer-mode-menu-heading">Speed</div>
        {[false, true].map((enabled) => <button key={String(enabled)} type="button" role="menuitemradio" aria-checked={fast.active === enabled} className={`composer-mode-menu-item${fast.active === enabled ? ' selected' : ''}`} onClick={() => { if (fast.active !== enabled) select(effort === 'off' ? `${parseThinkingSuffixFromModelId(fast.targetModelId).baseId}:off` : fast.targetModelId); else setOpen(false) }}>{enabled ? 'Fast' : 'Standard'}</button>)}
      </div>}
    </div></FloatingPortal>}
  </div>
}
