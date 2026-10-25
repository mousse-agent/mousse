import { useCallback, useEffect, useRef } from 'react'
import { ArrowUp, ChevronDown, Mic, Paperclip, Square } from '../lib/icons'
import type { LlmProviderOption } from '../../shared/settings'
import type { ContextUsageSnapshot } from '../../shared/types'
import { ComposerEffortPicker } from './ComposerEffortPicker'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import { getGroupedModelButtonParts, ModelFamilyMenu } from './ModelFamilyMenu'
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
  providers: LlmProviderOption[]
  selectedProviderId: string
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
}

export function ComposerFooter({
  providers,
  selectedProviderId,
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
  allowAttachWhileLoading = false
}: ComposerFooterProps) {
  const modelPickerRef = useRef<HTMLDivElement>(null)
  const modelButtonRef = useRef<HTMLButtonElement>(null)
  const modelMenuContentRef = useRef<HTMLDivElement>(null)
  const contextBtnRef = useRef<HTMLButtonElement>(null)
  const handleMenuScroll = useMenuScrollFade()
  const modelButtonParts = getGroupedModelButtonParts(selectedProviderId, selectedModelId, providers, false)
  const modelButtonLabel = modelButtonParts.join(' · ')
  const selectedProvider = providers.find((entry) => entry.id === selectedProviderId)
  const providerModels = selectedProvider?.models ?? []
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
      if (event.key === 'Escape') onModelMenuOpenChange(false)
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
        <div className="composer-model-picker" ref={modelPickerRef}>
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
                  selectedModelId={selectedModelId}
                  onSelect={onModelSelect}
                  onMenuScroll={handleMenuScroll}
                  anchorRef={modelButtonRef}
                  contentRef={modelMenuContentRef}
                />
              )}
            </>
          )}
          <button
            ref={modelButtonRef}
            type="button"
            className={`composer-model-btn${modelMenuOpen ? ' open' : ''}`}
            aria-expanded={modelReadOnly ? undefined : modelMenuOpen}
            aria-haspopup={modelReadOnly ? undefined : 'listbox'}
            aria-label={`${modelReadOnly ? 'Assigned model' : 'Model'}: ${modelButtonLabel}`}
            title={modelReadOnly ? `Assigned model: ${modelButtonLabel}` : modelButtonLabel}
            disabled={modelReadOnly}
            onClick={modelReadOnly ? undefined : handleModelMenuToggle}
          >
            {selectedProviderId ? (
              <ProviderIcon providerId={selectedProviderId} size={14} />
            ) : null}
            <span className="composer-model-btn-label">
              <span className="composer-model-btn-name">{modelButtonParts[0]}</span>
              {modelButtonParts.length > 1 ? ` · ${modelButtonParts.slice(1).join(' · ')}` : null}
            </span>
            {!modelReadOnly && <ChevronDown size={12} strokeWidth={2} />}
          </button>
        </div>
        <ComposerEffortPicker providerId={selectedProviderId} modelId={selectedModelId} models={providerModels} readOnly={modelReadOnly} onSelect={onModelSelect} />
      </div>

      <div className="composer-footer-right">
        {selectedProviderId !== 'antigravity' && <div className="composer-context-anchor">
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
