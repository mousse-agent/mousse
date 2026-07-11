import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { LlmProviderOption } from '../../shared/settings'
import {
  groupProviderModels,
  parseModelVariant,
  parseThinkingSuffixFromModelId,
  resolveModelVariant,
  type ModelFamily
} from '../../shared/modelVariants'
import { ProviderIcon } from '../lib/providerIcons'

interface ModelFamilyMenuProps {
  providers: LlmProviderOption[]
  selectedProviderId: string
  selectedModelId: string
  onSelect: (providerId: string, modelId: string) => void
  onMenuScroll?: (event: React.UIEvent<HTMLElement>) => void
  emptyState?: React.ReactNode
}

function getInitialVariantOptions(
  family: ModelFamily,
  selectedModelId: string
): { context?: string; effort?: string; speed?: string } {
  const { baseId, effort: effortFromId } = parseThinkingSuffixFromModelId(selectedModelId)
  const selected =
    family.variants.find((variant) => variant.id === selectedModelId) ??
    family.variants.find((variant) => variant.id === baseId)

  if (!selected) {
    return {
      context: family.contexts[0],
      effort: effortFromId ?? family.efforts[0],
      speed: family.speeds[0]
    }
  }

  return {
    context: selected.context ?? family.contexts[0],
    effort: effortFromId ?? selected.effort ?? family.efforts[0],
    speed: selected.speed ?? family.speeds[0]
  }
}

function VariantPanel({
  family,
  selectedModelId,
  onSelect
}: {
  family: ModelFamily
  selectedModelId: string
  onSelect: (modelId: string) => void
}) {
  const { context, effort, speed } = getInitialVariantOptions(family, selectedModelId)

  const applyOption = (patch: { context?: string; effort?: string; speed?: string }) => {
    const resolved = resolveModelVariant(family, {
      context: patch.context ?? context,
      effort: patch.effort ?? effort,
      speed: patch.speed ?? speed
    })
    if (resolved) onSelect(resolved.id)
  }

  return (
    <div className="model-family-variant-panel" onMouseDown={(event) => event.stopPropagation()}>
      {family.contexts.length > 0 && (
        <div className="model-family-variant-section">
          <div className="model-family-variant-heading">Context</div>
          <div className="model-family-variant-options">
            {family.contexts.map((option) => (
              <button
                key={option}
                type="button"
                className={`model-family-variant-chip${context === option ? ' selected' : ''}`}
                onClick={() => applyOption({ context: option })}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      )}

      {family.efforts.length > 0 && (
        <div className="model-family-variant-section">
          <div className="model-family-variant-heading">Effort</div>
          <div className="model-family-variant-options">
            {family.efforts.map((option) => (
              <button
                key={option}
                type="button"
                className={`model-family-variant-chip${effort === option ? ' selected' : ''}`}
                onClick={() => applyOption({ effort: option })}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      )}

      {family.speeds.length > 0 && (
        <div className="model-family-variant-section">
          <div className="model-family-variant-heading">Speed</div>
          <div className="model-family-variant-options">
            {family.speeds.map((option) => (
              <button
                key={option}
                type="button"
                className={`model-family-variant-chip${speed === option ? ' selected' : ''}`}
                onClick={() => applyOption({ speed: option })}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function ModelFamilyMenu({
  providers,
  selectedProviderId,
  selectedModelId,
  onSelect,
  onMenuScroll,
  emptyState
}: ModelFamilyMenuProps) {
  const groupedProviders = useMemo(
    () => providers.map((provider) => groupProviderModels(provider.id, provider.label, provider.models)),
    [providers]
  )
  const [activeFamily, setActiveFamily] = useState<{
    providerId: string
    family: ModelFamily
  } | null>(null)
  const [panelTop, setPanelTop] = useState(0)
  const shellRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const variantPanelRef = useRef<HTMLElement>(null)
  const activeRowRef = useRef<HTMLElement | null>(null)
  const hideTimerRef = useRef<number | null>(null)

  const syncPanelPosition = useCallback(() => {
    const shell = shellRef.current
    const row = activeRowRef.current
    const panel = variantPanelRef.current
    const menu = menuRef.current

    if (!shell || !row || !activeFamily) {
      setPanelTop(0)
      return
    }

    const shellRect = shell.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    const menuHeight = menu?.offsetHeight ?? shell.offsetHeight
    const panelHeight = panel?.offsetHeight ?? 0

    let top = rowRect.top - shellRect.top
    if (panelHeight > 0) {
      top = Math.max(0, Math.min(top, menuHeight - panelHeight))
    }

    setPanelTop(top)
  }, [activeFamily])

  useLayoutEffect(() => {
    syncPanelPosition()
    const frame = window.requestAnimationFrame(syncPanelPosition)
    return () => window.cancelAnimationFrame(frame)
  }, [activeFamily, syncPanelPosition])

  const clearHideTimer = () => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }

  const scheduleHide = () => {
    clearHideTimer()
    hideTimerRef.current = window.setTimeout(() => setActiveFamily(null), 180)
  }

  useEffect(() => () => clearHideTimer(), [])

  const handleMenuScroll = (event: React.UIEvent<HTMLElement>) => {
    onMenuScroll?.(event)
    syncPanelPosition()
  }

  if (providers.length === 0) {
    return <>{emptyState}</>
  }

  return (
    <div className="composer-model-picker-shell" ref={shellRef}>
      <div
        ref={menuRef}
        className="composer-model-menu scrollbar-ultra-thin"
        role="listbox"
        aria-label="Select model"
        onScroll={handleMenuScroll}
      >
        {groupedProviders.map((provider) => (
          <div key={provider.providerId} className="composer-model-menu-group">
            <div className="composer-model-menu-heading composer-model-menu-heading-with-icon">
              <ProviderIcon providerId={provider.providerId} size={12} />
              <span>{providers.find((entry) => entry.id === provider.providerId)?.label}</span>
            </div>

            {provider.families.map((family) => {
              const selected =
                provider.providerId === selectedProviderId &&
                (family.variants.some((variant) => variant.id === selectedModelId) ||
                  family.variants.some(
                    (variant) =>
                      variant.id === parseThinkingSuffixFromModelId(selectedModelId).baseId
                  ))

              if (!family.hasSubOptions) {
                const variant = family.variants[0]
                return (
                  <button
                    key={family.familyId}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`composer-model-menu-item${selected ? ' selected' : ''}`}
                    onClick={() => onSelect(provider.providerId, variant.id)}
                    onMouseEnter={() => {
                      clearHideTimer()
                      activeRowRef.current = null
                      setActiveFamily(null)
                    }}
                  >
                    <ProviderIcon providerId={provider.providerId} size={12} />
                    <span>{family.familyLabel}</span>
                  </button>
                )
              }

              const isActive =
                activeFamily?.providerId === provider.providerId &&
                activeFamily.family.familyId === family.familyId

              return (
                <div
                  key={family.familyId}
                  className={`model-family-row${isActive ? ' active' : ''}`}
                  onMouseEnter={(event) => {
                    clearHideTimer()
                    activeRowRef.current = event.currentTarget
                    setActiveFamily({ providerId: provider.providerId, family })
                  }}
                  onMouseLeave={scheduleHide}
                >
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    aria-haspopup="dialog"
                    className={`composer-model-menu-item model-family-row-trigger${selected ? ' selected' : ''}`}
                    onClick={() => {
                      const resolved = resolveModelVariant(
                        family,
                        getInitialVariantOptions(family, selectedModelId)
                      )
                      if (resolved) onSelect(provider.providerId, resolved.id)
                    }}
                  >
                    <ProviderIcon providerId={provider.providerId} size={12} />
                    <span>{family.familyLabel}</span>
                    <ChevronRight size={12} className="model-family-row-chevron" />
                  </button>
                </div>
              )
            })}
          </div>
        ))}
      </div>

      {activeFamily?.family.hasSubOptions && (
        <aside
          ref={variantPanelRef}
          className="composer-model-variant-panel"
          style={{ top: panelTop }}
          onMouseEnter={clearHideTimer}
          onMouseLeave={scheduleHide}
        >
          <VariantPanel
            family={activeFamily.family}
            selectedModelId={selectedModelId}
            onSelect={(modelId) => onSelect(activeFamily.providerId, modelId)}
          />
        </aside>
      )}
    </div>
  )
}

export function getGroupedModelButtonLabel(
  providerId: string,
  modelId: string,
  providers: LlmProviderOption[]
): string {
  if (!providerId) return 'Select model'
  const provider = providers.find((entry) => entry.id === providerId)
  const { baseId, effort: effortFromId } = parseThinkingSuffixFromModelId(modelId)
  const model =
    provider?.models.find((entry) => entry.id === modelId) ??
    provider?.models.find((entry) => entry.id === baseId)
  if (!model) return modelId || provider?.label || 'Select model'

  const parsed = parseModelVariant(model)
  const bits = [parsed.familyLabel]
  if (parsed.context) bits.push(parsed.context)
  if (effortFromId ?? parsed.effort) bits.push(effortFromId ?? parsed.effort!)
  if (parsed.speed) bits.push(parsed.speed)
  return bits.join(' · ')
}
