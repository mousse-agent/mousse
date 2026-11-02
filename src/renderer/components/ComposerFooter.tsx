import { useCallback, useEffect, useRef } from 'react'
import { ArrowUp, Mic, Paperclip, Square, Zap } from '../lib/icons'
import { showsContextGauge, type ProviderWithStatus } from '../lib/providerSnapshots'
import type { PermissionMode } from '../../shared/permissionMode'
import type { ContextUsageSnapshot } from '../../shared/types'
import { listingServes } from '../../shared/providerInstances'
import { getModelSpeedOptions, parseThinkingSuffixFromModelId } from '../../shared/modelVariants'
import { shortModelName } from '../../shared/modelNames'
import { carryReasoningLevel, ComposerRunMenu, PermissionMenuButton, ReasoningColumn, hasReasoningLevels, runFasterSpeed, runLevelText, shownReasoningLevel, SpeedToggle, type RunSettingsTarget } from './ComposerEffortPicker'
import type { PermissionControl } from './ComposerPermissionPicker'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import { getGroupedModelButtonParts, ModelFamilyMenu, type ModelPickTarget } from './ModelFamilyMenu'
import { ProviderIcon } from '../lib/providerIcons'
import { ContextUsagePopover, ContextUsageRing } from './ContextUsagePopover'

function useMenuScrollFade() {
  const scrollFadeTimerRef = useRef<number | null>(null)

  const handleMenuScroll = useCallback((event: React.UIEvent<HTMLElement>) => {
    const container = event.currentTarget
    container.classList.add('is-scrolling')
    if (scrollFadeTimerRef.current !== null) {
      window.clearTimeout(scrollFadeTimerRef.current)
    }
    scrollFadeTimerRef.current = window.setTimeout(() => {
      container.classList.remove('is-scrolling')
      scrollFadeTimerRef.current = null
    }, 900)
  }, [])

  useEffect(() => {
    return () => {
      if (scrollFadeTimerRef.current !== null) {
        window.clearTimeout(scrollFadeTimerRef.current)
      }
    }
  }, [])

  return handleMenuScroll
}

export interface ComposerFooterProps {
  /** Picker entries; `caps` and `status` come from the instance snapshots. */
  providers: ProviderWithStatus[]
  selectedProviderId: string
  /** The selection's instance, when it names one: two accounts of one provider read apart. */
  selectedInstanceId?: string
  selectedModelId: string
  modelMenuOpen: boolean
  onModelMenuOpenChange: (open: boolean) => void
  onModelSelect: (providerId: string, modelId: string) => void
  modelReadOnly?: boolean
  onOpenSettings: () => void
  contextUsage: ContextUsageSnapshot
  contextOpen: boolean
  onContextOpenChange: (open: boolean) => void
  onAttachClick: () => void
  loading?: boolean
  disabled?: boolean
  canSend?: boolean
  isRecording?: boolean
  recordingPending?: boolean
  /** A recording is being turned into text; the microphone and send buttons wait. */
  transcribing?: boolean
  onSend?: () => void
  onStop?: () => void
  onStartRecording?: () => void
  onStopRecording?: () => void
  primaryAction?: 'send' | 'implement-plan'
  onImplementPlan?: () => void
  implementPlanDisabled?: boolean
  /** When true, file attach stays enabled during an active turn (queued sends). */
  allowAttachWhileLoading?: boolean
  /** The thread's permission mode and how to change it; without it the footer has no such control. */
  permission?: {
    mode: PermissionMode
    /** The most the picker offers: a subagent's lineage ceiling, or the limit a thread's computer gives this device. */
    ceiling?: PermissionMode
    /** Why nothing above `ceiling` is offered, when it is not a lineage. */
    ceilingReason?: string
    onSelect: (mode: PermissionMode) => void
  }
}

export function ComposerFooter({
  providers,
  selectedProviderId,
  selectedInstanceId,
  selectedModelId,
  modelMenuOpen,
  onModelMenuOpenChange,
  onModelSelect,
  modelReadOnly = false,
  onOpenSettings,
  contextUsage,
  contextOpen,
  onContextOpenChange,
  onAttachClick,
  loading = false,
  disabled = false,
  canSend = false,
  isRecording = false,
  recordingPending = false,
  transcribing = false,
  onSend,
  onStop,
  onStartRecording,
  onStopRecording,
  primaryAction = 'send',
  onImplementPlan,
  implementPlanDisabled = false,
  allowAttachWhileLoading = false,
  permission
}: ComposerFooterProps) {
  const modelPickerRef = useRef<HTMLDivElement>(null)
  const modelButtonRef = useRef<HTMLButtonElement>(null)
  const modelMenuContentRef = useRef<HTMLDivElement>(null)
  const contextBtnRef = useRef<HTMLButtonElement>(null)
  const handleMenuScroll = useMenuScrollFade()
  const namedParts = getGroupedModelButtonParts(selectedProviderId, selectedModelId, providers, false, selectedInstanceId)
  const selectedProvider = providers.find((entry) => entry.id === selectedProviderId)
  const providerModels = selectedProvider?.models ?? []
  // A selected instance that needs a step (signed out, not found) says so on the model button.
  const providerAttention = selectedProvider?.status && selectedProvider.status.tone !== 'ready' ? selectedProvider.status : null
  // The permission mode belongs to the thread; what it can be depends on the agent serving the model.
  const permissionFor = (listing: ProviderWithStatus | undefined): PermissionControl | undefined =>
    permission && { ...permission, agent: listing?.label ?? 'The agent', caps: listing?.caps, limits: listing?.permissionLimits }
  const permissionControl = permissionFor(selectedProvider)
  const selection = { providerId: selectedProviderId, modelId: selectedModelId, models: providerModels }
  const levelText = runLevelText(selection)
  // A Fast (or faster) thread shows a lightning icon after the model name, in place of the name's "(fast)";
  // the label says the word.
  const fasterSpeed = runFasterSpeed(selection)
  const modelButtonParts = fasterSpeed ? [namedParts[0]!.replace(/\s*\((?:ultra)?fast\)$/i, ''), ...namedParts.slice(1)] : namedParts
  const modelButtonLabel = modelButtonParts.join(' · ')
  const buttonText = [modelButtonLabel, fasterSpeed, levelText].filter(Boolean).join(' ')
  const buttonLabel = `${modelReadOnly ? 'Assigned model' : 'Model'}: ${buttonText}`
  const modelButtonTitle = providerAttention ? `${buttonLabel} · ${selectedProvider?.label}: ${providerAttention.headline}` : buttonLabel
  // An assigned model (a subagent's) cannot change; its permission mode still can.
  const runOnly = modelReadOnly && Boolean(permissionControl)
  const pickerDisabled = modelReadOnly && !runOnly
  const closePicker = () => {
    onModelMenuOpenChange(false)
    modelButtonRef.current?.focus()
  }

  // The picker's run settings column: the highlighted model's, with the chosen level carried over.
  // With no level chosen (or one this model does not offer) none is carried: the next model runs at its own default.
  const chosen = parseThinkingSuffixFromModelId(selectedModelId).effort
  const carried = chosen && chosen === shownReasoningLevel(selection) ? chosen : undefined
  const listingOf = (target: ModelPickTarget) => providers.find((entry) => listingServes(entry, { instanceId: target.instanceId, llmProvider: target.providerId }))
  const resolveTarget = (target: ModelPickTarget): RunSettingsTarget => {
    const pick = { providerId: target.providerId, modelId: target.modelId, models: listingOf(target)?.models ?? [] }
    if (target.selected) return { ...pick, instanceId: target.instanceId, selected: true }
    const { modelId, dropped } = carryReasoningLevel(pick, carried)
    return { ...pick, modelId, instanceId: target.instanceId, selected: false, ...(dropped ? { dropped } : {}) }
  }
  const runSettings = {
    pick: (target: ModelPickTarget) => resolveTarget(target).modelId,
    // Beside the list: the highlighted model's reasoning levels, whenever any model the picker lists has
    // levels, so the column stays in place while you search or switch providers.
    render: (target: ModelPickTarget | undefined, all: ModelPickTarget[]) => {
      if (!all.some((entry) => hasReasoningLevels(resolveTarget(entry)))) return null
      return <ReasoningColumn key={target ? `${target.instanceId ?? target.providerId}:${target.label}` : 'none'} target={target && resolveTarget(target)} label={target && shortModelName(target.label)} onSelect={onModelSelect} onClose={closePicker} />
    },
    // Under the picker: the highlighted model's speed on the left, the thread's permission mode on the right.
    footer: (target: ModelPickTarget | undefined) => {
      const resolved = target ? resolveTarget(target) : undefined
      const speeds = resolved ? getModelSpeedOptions(resolved.providerId, resolved.modelId, resolved.models) : undefined
      if (!speeds && !permissionControl) return null
      return <>
        <div className="model-picker-footer-start">
          {resolved && speeds ? <SpeedToggle key={`${resolved.instanceId ?? resolved.providerId}:${resolved.modelId}`} target={resolved} onSelect={onModelSelect} onClose={closePicker} /> : null}
        </div>
        {permissionControl ? <PermissionMenuButton control={permissionControl} onClose={closePicker} /> : null}
      </>
    }
  }
  const emptyModelMenuStyle = useFloatingPosition({
    open: modelMenuOpen && providers.length === 0,
    anchorRef: modelButtonRef,
    contentRef: modelMenuContentRef,
    placement: 'above-start'
  })

  useEffect(() => {
    if (!modelMenuOpen) return
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (
        modelPickerRef.current?.contains(target) ||
        modelMenuContentRef.current?.contains(target)
      ) {
        return
      }
      onModelMenuOpenChange(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      onModelMenuOpenChange(false)
      modelButtonRef.current?.focus()
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [modelMenuOpen, onModelMenuOpenChange])

  const handleModelMenuToggle = () => {
    onModelMenuOpenChange(!modelMenuOpen)
  }

  const handleActionClick = () => {
    if (primaryAction === 'implement-plan') {
      onImplementPlan?.()
      return
    }
    // Prefer send (including queue-while-loading) when the composer has content.
    if (canSend) {
      onSend?.()
      return
    }
    if (loading) {
      onStop?.()
      return
    }
    if (!isRecording) {
      onStartRecording?.()
    }
  }

  return (
    <div className="composer-footer">
      <div className="composer-footer-left">
        <div className="composer-run-controls">
          <div className="composer-model-picker" ref={modelPickerRef}>
            {modelMenuOpen && runOnly && permissionControl ? (
              <ComposerRunMenu
                selection={selection}
                permission={permissionControl}
                anchorRef={modelButtonRef}
                contentRef={modelMenuContentRef}
                onClose={closePicker}
              />
            ) : null}
            {!modelReadOnly && modelMenuOpen && (
              <>
                {providers.length === 0 ? (
                  <FloatingPortal>
                    <div
                      ref={modelMenuContentRef}
                      className="composer-model-picker-shell composer-model-picker-shell-empty composer-model-picker-shell-floating"
                      role="listbox"
                      aria-label="Select model"
                      style={emptyModelMenuStyle}
                    >
                      <div className="composer-model-menu scrollbar-ultra-thin">
                        <div className="composer-model-menu-empty">
                          <p>No providers connected.</p>
                          <button
                            type="button"
                            className="composer-model-menu-settings"
                            onClick={() => {
                              onModelMenuOpenChange(false)
                              onOpenSettings()
                            }}
                          >
                            Open Settings
                          </button>
                        </div>
                      </div>
                    </div>
                  </FloatingPortal>
                ) : (
                  <ModelFamilyMenu
                    providers={providers}
                    selectedProviderId={selectedProviderId}
                    selectedInstanceId={selectedInstanceId}
                    selectedModelId={selectedModelId}
                    onSelect={onModelSelect}
                    onMenuScroll={handleMenuScroll}
                    anchorRef={modelButtonRef}
                    contentRef={modelMenuContentRef}
                    runSettings={runSettings}
                  />
                )}
              </>
            )}
            <button
              ref={modelButtonRef}
              type="button"
              className={`composer-model-btn${modelMenuOpen ? ' open' : ''}`}
              aria-expanded={pickerDisabled ? undefined : modelMenuOpen}
              aria-haspopup={pickerDisabled ? undefined : runOnly ? 'menu' : 'listbox'}
              aria-label={buttonLabel}
              title={modelButtonTitle}
              disabled={pickerDisabled}
              onClick={pickerDisabled ? undefined : handleModelMenuToggle}
            >
              {selectedProviderId ? (
                <ProviderIcon providerId={selectedProviderId} size={14} />
              ) : null}
              <span className="composer-model-btn-label">
                <span className="composer-model-btn-name">{modelButtonParts[0]}</span>
                {modelButtonParts.length > 1 ? ` · ${modelButtonParts.slice(1).join(' · ')}` : null}
                {fasterSpeed ? <Zap size={12} aria-hidden="true" className="composer-model-btn-speed" /> : null}
                {levelText ? <span className="composer-model-btn-level">{levelText}</span> : null}
              </span>
              {providerAttention && (providerAttention.tone === 'warning' || providerAttention.tone === 'error') ? (
                <span className={`composer-model-btn-dot is-${providerAttention.tone}`} aria-label={providerAttention.headline} />
              ) : null}
            </button>
          </div>
        </div>
      </div>

      <div className="composer-footer-right">
        {showsContextGauge(selectedProvider) && <div className="composer-context-anchor">
          <ContextUsageRing
            percent={contextUsage.percent}
            capacityKnown={contextUsage.limit > 0}
            onClick={() => onContextOpenChange(!contextOpen)}
            active={contextOpen}
            ref={contextBtnRef}
          />
          <ContextUsagePopover
            open={contextOpen}
            onClose={() => onContextOpenChange(false)}
            usage={contextUsage}
            providerId={selectedProviderId}
            anchorRef={contextBtnRef}
          />
        </div>}

        <button
          type="button"
          className="composer-icon-btn"
          title="Attach files"
          aria-label="Attach files"
          onClick={onAttachClick}
          disabled={disabled || (loading && !allowAttachWhileLoading)}
        >
          <Paperclip size={16} strokeWidth={2} />
        </button>

        {primaryAction === 'implement-plan' ? (
          <button
            type="button"
            className="composer-implement-btn"
            onClick={handleActionClick}
            disabled={implementPlanDisabled || loading}
          >
            Implement plan
          </button>
        ) : isRecording ? (
          <button
            type="button"
            className="composer-action-btn composer-action-btn-recording"
            title="Stop recording"
            aria-label="Stop recording"
            onClick={onStopRecording}
          >
            <Square size={14} strokeWidth={2} fill="currentColor" />
          </button>
        ) : canSend ? (
          <button
            type="button"
            className="composer-action-btn composer-action-btn-active"
            title={loading ? 'Queue message' : 'Send message'}
            aria-label={loading ? 'Queue message' : 'Send message'}
            onClick={handleActionClick}
            disabled={disabled}
          >
            <ArrowUp size={16} strokeWidth={2} />
          </button>
        ) : loading ? (
          <button
            type="button"
            className="composer-action-btn composer-action-btn-stop"
            title="Stop"
            aria-label="Stop generation"
            onClick={handleActionClick}
            disabled={disabled}
          >
            <Square size={14} strokeWidth={2} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            className="composer-action-btn"
            title="Voice input"
            aria-label="Voice input"
            aria-busy={recordingPending || transcribing}
            onClick={handleActionClick}
            disabled={disabled || recordingPending || transcribing}
          >
            <Mic size={16} strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  )
}
