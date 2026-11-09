import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Mic, Paperclip, Square, Zap } from '../lib/icons'
import { showsContextGauge, type ProviderWithStatus } from '../lib/providerSnapshots'
import type { PermissionMode } from '../../shared/permissionMode'
import type { ContextUsageSnapshot } from '../../shared/types'
import { modelPickerRunSettings, PermissionChip, runFasterSpeed, runLevelText } from './ComposerEffortPicker'
import type { PermissionControl } from './ComposerPermissionPicker'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import { motionScale, scaleMotionMs } from '../lib/motion'
import { getGroupedModelButtonParts, ModelFamilyMenu } from './ModelFamilyMenu'
import { ProviderIcon } from '../lib/providerIcons'
import { contextCompaction, ContextUsagePopover, ContextUsageRing, contextUsageKnown, type ContextCacheLine } from './ContextUsagePopover'
import { IdleCompactionChip } from './IdleCompactionChip'
import { cacheGoneCold, contextTokens, idleCompactionChip, promptCacheState, promptCacheText, suggestsCompaction, uncachedCostText, useMinuteClock } from '../lib/promptCache'
import type { ContextSettings } from '../../shared/settings'
import { formatBinding } from '../../shared/commands'
import { useCommandBindings } from '../commands/commandRegistry'
import { useAppStore } from '../stores/appStore'

/** Alt+Enter in the composer while a run is going sends the text as a steer. */
export const STEER_BINDING = 'Alt+Enter'

/** The model picker's fade-out, before the speed scale; matches its close animation in composer-run-controls.css. */
const MODEL_PICKER_EXIT_MS = 90

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

/**
 * A thread's run settings in the footer: the model picker (with the permission chip) and the context
 * ring. A bot's composer has none: a bot picks its own model.
 */
export interface ComposerRunProps {
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
  /** The Compact context setting; the ring marks where it compacts once it is read. */
  contextCompactionSetting?: ContextSettings
  contextOpen: boolean
  onContextOpenChange: (open: boolean) => void
  /** Compacts the thread's context now (`threads.compact`); absent where the composer cannot (a new chat). */
  onCompactNow?: () => void
  /** A compaction the person started is running: the chip reads "Compacting…". */
  compacting?: boolean
}

/** The thread's permission mode and how to change it; it shows beside the model button. */
export interface ComposerPermissionProps {
  mode: PermissionMode
  /** The most the picker offers: a subagent's lineage ceiling, or the limit a thread's computer gives this device. */
  ceiling?: PermissionMode
  /** Why nothing above `ceiling` is offered, when it is not a lineage. */
  ceilingReason?: string
  onSelect: (mode: PermissionMode) => void
}

export interface ComposerFooterProps {
  /** The model picker and context ring; without it the footer has neither (a bot's composer). */
  run?: ComposerRunProps
  onAttachClick: () => void
  loading?: boolean
  /** A run Stop can end, including one waiting on an approval or an answer; defaults to `loading`. */
  stoppable?: boolean
  disabled?: boolean
  canSend?: boolean
  isRecording?: boolean
  recordingPending?: boolean
  /** A recording is being turned into text; the microphone and send buttons wait. */
  transcribing?: boolean
  onSend?: () => void
  /** What the send button says it does, when not "Send message" / "Queue message": answering open questions, or "Deny and send" while an approval waits. */
  sendLabel?: string
  onStop?: () => void
  onStartRecording?: () => void
  onStopRecording?: () => void
  primaryAction?: 'send' | 'implement-plan'
  onImplementPlan?: () => void
  implementPlanDisabled?: boolean
  /** When true, file attach stays enabled during an active turn (queued sends). */
  allowAttachWhileLoading?: boolean
  /** The thread's permission mode and how to change it; without it (or `run`) the footer has no such control. */
  permission?: ComposerPermissionProps
}

/** The permission chip and the model button with its picker. */
function ComposerRunControls({ run, permission }: { run: ComposerRunProps; permission?: ComposerPermissionProps }) {
  const {
    providers,
    selectedProviderId,
    selectedInstanceId,
    selectedModelId,
    modelMenuOpen,
    onModelMenuOpenChange,
    onModelSelect,
    modelReadOnly = false,
    onOpenSettings
  } = run
  const modelPickerRef = useRef<HTMLDivElement>(null)
  const modelButtonRef = useRef<HTMLButtonElement>(null)
  const modelMenuContentRef = useRef<HTMLDivElement>(null)
  // After closing, the picker stays a moment to fade out (none with motion off). Set while rendering, so
  // it never unmounts for a frame in between.
  const [modelMenuLeaving, setModelMenuLeaving] = useState(false)
  const [modelMenuWasOpen, setModelMenuWasOpen] = useState(modelMenuOpen)
  if (modelMenuWasOpen !== modelMenuOpen) {
    setModelMenuWasOpen(modelMenuOpen)
    setModelMenuLeaving(!modelMenuOpen && motionScale() > 0)
  }
  useEffect(() => {
    if (!modelMenuLeaving) return
    const timer = window.setTimeout(() => setModelMenuLeaving(false), scaleMotionMs(MODEL_PICKER_EXIT_MS))
    return () => window.clearTimeout(timer)
  }, [modelMenuLeaving])
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
  // An assigned model (a subagent's) cannot change: the button only names it. Its permission mode still can, on the chip.
  const pickerDisabled = modelReadOnly
  const closePicker = () => {
    onModelMenuOpenChange(false)
    modelButtonRef.current?.focus()
  }

  // The picker's run settings: the highlighted model's level and speed, with the chosen level carried over.
  // The permission mode has its own chip beside the model button, so the picker's footer holds only the speed.
  const runSettings = modelPickerRunSettings({ providers, selection, onSelect: onModelSelect, onClose: closePicker })
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

  return (
    <div className="composer-run-controls">
      {permissionControl ? <PermissionChip control={permissionControl} /> : null}
      <div className="composer-model-picker" ref={modelPickerRef}>
        {!modelReadOnly && (modelMenuOpen || modelMenuLeaving) && (
          <>
            {providers.length === 0 ? (modelMenuOpen &&
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
                closing={!modelMenuOpen}
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
          aria-haspopup={pickerDisabled ? undefined : 'listbox'}
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
  )
}

/**
 * The context ring and its popover, while the context's fill is known, and left of it the Full/Compact chip
 * once the prompt cache has gone cold.
 */
function ComposerContextRing({ run, runActive }: { run: ComposerRunProps; runActive: boolean }) {
  const { providers, selectedProviderId, contextUsage, contextCompactionSetting, contextOpen, onContextOpenChange, onCompactNow, compacting = false } = run
  const cache = contextUsage.promptCache
  const now = useMinuteClock(Boolean(cache), cache?.lastRequestAt)
  const idleSetting = contextCompactionSetting?.idleCompaction ?? 'suggest'
  const contextBtnRef = useRef<HTMLButtonElement>(null)
  const selectedProvider = providers.find((entry) => entry.id === selectedProviderId)
  // No ring while the context's fill is unknown: a new chat, a provider that reports none, no capacity.
  const contextShown = showsContextGauge(selectedProvider) && contextUsageKnown(contextUsage)
  const compaction = contextCompactionSetting ? contextCompaction(contextCompactionSetting, contextUsage) : undefined
  // The popover goes with the ring, so it does not reopen by itself when the ring comes back.
  useEffect(() => {
    if (!contextShown && contextOpen) onContextOpenChange(false)
  }, [contextShown, contextOpen, onContextOpenChange])
  if (!contextShown) return null
  const cacheState = cache ? promptCacheState(cache, now) : undefined
  const canCompact = Boolean(onCompactNow)
  const chip = idleCompactionChip({ usage: contextUsage, now, setting: idleSetting, canCompact, runActive, compacting })
  const historyTokens = contextTokens(contextUsage)
  const cacheLine: ContextCacheLine | undefined = cacheState && {
    text: promptCacheText(cacheState),
    tone: cacheState.kind === 'warm' ? 'warm' : cacheGoneCold(cacheState) ? 'cold' : 'unknown',
    ...(canCompact && !runActive && !compacting && suggestsCompaction(contextUsage, now, idleSetting) ? { onCompactNow } : {})
  }
  return (<>
    {chip && cache && cacheLine ? (
      <IdleCompactionChip
        state={chip}
        historyTokens={historyTokens}
        cacheText={cacheLine.text}
        costText={uncachedCostText(cache, historyTokens)}
        onCompact={() => onCompactNow?.()}
      />
    ) : null}
    <div className="composer-context-anchor">
      <ContextUsageRing
        usage={contextUsage}
        onClick={() => onContextOpenChange(!contextOpen)}
        active={contextOpen}
        ref={contextBtnRef}
      />
      <ContextUsagePopover
        open={contextOpen}
        onClose={() => onContextOpenChange(false)}
        usage={contextUsage}
        compaction={compaction}
        providerId={selectedProviderId}
        anchorRef={contextBtnRef}
        cache={cacheLine}
      />
    </div>
  </>)
}

export function ComposerFooter({
  run,
  onAttachClick,
  loading = false,
  stoppable = loading,
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
  permission,
  sendLabel
}: ComposerFooterProps) {
  const bindings = useCommandBindings()
  const platform = useAppStore((state) => state.appInfo?.platform) ?? ''
  const stopBinding = bindings['run.stop']
  const stopTitle = stopBinding ? `Stop · ${formatBinding(stopBinding, platform)}` : 'Stop'
  const queueTitle = `Queue · ${formatBinding('Enter', platform)} — Steer · ${formatBinding(STEER_BINDING, platform)}`

  const handleActionClick = () => {
    if (primaryAction === 'implement-plan') {
      onImplementPlan?.()
      return
    }
    if (canSend) onSend?.()
  }
  // The send slot is Send, Queue, Stop or Stop recording. While a run goes and the box has text, Stop
  // sits left of it, so Queue and Stop are both one click and the slot never moves.
  const stopInSlot = stoppable && !canSend
  const stopButton = (className: string) => (
    <button type="button" className={className} title={stopTitle} aria-label="Stop run" onClick={onStop} disabled={disabled}>
      <Square size={14} strokeWidth={2} fill="currentColor" />
    </button>
  )

  return (
    <div className="composer-footer">
      <div className="composer-footer-left">
        {run ? <ComposerRunControls run={run} permission={permission} /> : null}
      </div>

      <div className="composer-footer-right">
        {run ? <ComposerContextRing run={run} runActive={stoppable} /> : null}

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

        {primaryAction !== 'implement-plan' && !stoppable && !isRecording && onStartRecording ? (
          <button
            type="button"
            className="composer-icon-btn composer-dictate-btn"
            title="Dictate"
            aria-label="Dictate"
            aria-busy={recordingPending || transcribing}
            onClick={onStartRecording}
            disabled={disabled || recordingPending || transcribing}
          >
            <Mic size={16} strokeWidth={2} />
          </button>
        ) : null}

        {primaryAction !== 'implement-plan' && !isRecording && stoppable && canSend ? stopButton('composer-icon-btn composer-stop-btn') : null}

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
        ) : stopInSlot ? (
          stopButton('composer-action-btn composer-action-btn-stop')
        ) : (
          <button
            type="button"
            className={`composer-action-btn${canSend ? ' composer-action-btn-active' : ''}`}
            title={sendLabel ?? (loading ? queueTitle : 'Send')}
            aria-label={sendLabel ?? (loading ? 'Queue message' : 'Send message')}
            onClick={handleActionClick}
            disabled={disabled || !canSend}
          >
            <ArrowUp size={16} strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  )
}
