import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  ChevronDown,
  Hammer,
  Infinity,
  Mic,
  Paperclip,
  Square,
  Sparkles,
  ClipboardList
} from 'lucide-react'
import type { LlmProviderOption } from '../../shared/settings'
import type { ChatMode } from '../../shared/types'
import type { SkillDescriptor } from '../../shared/integrations'
import type { ContextUsageSnapshot } from '../../shared/types'
import { chatModeEquals, getChatModeLabel } from '../../shared/chatMode'
import { DEFAULT_CHAT_MODE } from '../../shared/types'
import {
  applyEffortToModelId,
  formatEffortLabel,
  getCurrentEffort,
  getEffortsForModel
} from '../../shared/modelVariants'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import { getGroupedModelButtonLabel, ModelFamilyMenu } from './ModelFamilyMenu'
import { ProviderIcon } from '../lib/providerIcons'
import { ContextUsagePopover, ContextUsageRing } from './ContextUsagePopover'

const BUILTIN_CHAT_MODES = ['plan', 'agent', 'build'] as const

function getModeIcon(mode: ChatMode) {
  if (mode === 'plan') return ClipboardList
  if (mode === 'build') return Hammer
  if (mode === 'agent') return Infinity
  return Sparkles
}

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
  chatMode: ChatMode
  onChatModeChange: (mode: ChatMode) => void
  enabledSkills: SkillDescriptor[]
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
  onSend?: () => void
  onStop?: () => void
  onStartRecording?: () => void
  onStopRecording?: () => void
  primaryAction?: 'send' | 'implement-plan'
  onImplementPlan?: () => void
  implementPlanDisabled?: boolean
  /** Hide mode picker (e.g. Mousse subagent always implements work). */
  hideModePicker?: boolean
  /** When true, file attach stays enabled during an active turn (queued sends). */
  allowAttachWhileLoading?: boolean
}

export function ComposerFooter({
  chatMode,
  onChatModeChange,
  enabledSkills,
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
  onSend,
  onStop,
  onStartRecording,
  onStopRecording,
  primaryAction = 'send',
  onImplementPlan,
  implementPlanDisabled = false,
  hideModePicker = false,
  allowAttachWhileLoading = false
}: ComposerFooterProps) {
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const modelPickerRef = useRef<HTMLDivElement>(null)
  const modelButtonRef = useRef<HTMLButtonElement>(null)
  const modelMenuContentRef = useRef<HTMLDivElement>(null)
  const modePickerRef = useRef<HTMLDivElement>(null)
  const modeButtonRef = useRef<HTMLButtonElement>(null)
  const modeMenuContentRef = useRef<HTMLDivElement>(null)
  const contextBtnRef = useRef<HTMLButtonElement>(null)
  const handleMenuScroll = useMenuScrollFade()
  const modelButtonLabel = getGroupedModelButtonLabel(selectedProviderId, selectedModelId, providers)
  const selectedProvider = providers.find((entry) => entry.id === selectedProviderId)
  const providerModels = selectedProvider?.models ?? []
  const availableEfforts = getEffortsForModel(
    selectedProviderId,
    selectedModelId,
    providerModels
  )
  const currentEffort = getCurrentEffort(selectedModelId, providerModels, selectedProviderId)
  const currentEffortLabel = currentEffort ? formatEffortLabel(currentEffort) : null
  const ModeIcon = getModeIcon(chatMode)
  const activeSkill = typeof chatMode === 'object'
    ? enabledSkills.find((skill) => skill.id === chatMode.skillId)
    : undefined
  const modeLabel = getChatModeLabel(chatMode, activeSkill?.name)
  const modeButtonLabel =
    currentEffortLabel && availableEfforts.length > 0
      ? `${currentEffortLabel} · ${modeLabel}`
      : modeLabel
  const accessibleModeLabel =
    currentEffortLabel && availableEfforts.length > 0
      ? `${modeLabel} mode, ${currentEffortLabel} thinking`
      : `${modeLabel} mode`

  const modeMenuStyle = useFloatingPosition({
    open: modeMenuOpen,
    anchorRef: modeButtonRef,
    contentRef: modeMenuContentRef,
    placement: 'above-start',
    deps: [modeButtonLabel, availableEfforts.length]
  })

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

  useEffect(() => {
    if (!modeMenuOpen) return
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (
        modePickerRef.current?.contains(target) ||
        modeMenuContentRef.current?.contains(target)
      ) {
        return
      }
      setModeMenuOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setModeMenuOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [modeMenuOpen])

  const handleModeSelect = (mode: ChatMode) => {
    onChatModeChange(mode)
    setModeMenuOpen(false)
  }

  const handleEffortSelect = (effort: string) => {
    if (modelReadOnly || !selectedProviderId || !selectedModelId) return
    const nextModelId = applyEffortToModelId(selectedModelId, effort)
    if (nextModelId !== selectedModelId) {
      onModelSelect(selectedProviderId, nextModelId)
    }
  }

  const handleModelMenuToggle = () => {
    setModeMenuOpen(false)
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
        {!hideModePicker && <div className="composer-mode-picker" ref={modePickerRef}>
          {modeMenuOpen && (
            <FloatingPortal>
              <div
                ref={modeMenuContentRef}
                className="composer-mode-menu composer-mode-menu-floating scrollbar-ultra-thin"
                role="listbox"
                aria-label="Select thinking level and chat mode"
                style={modeMenuStyle}
                onScroll={handleMenuScroll}
              >
                {availableEfforts.length > 0 && (
                  <div className="composer-mode-menu-section" role="group" aria-label="Variant">
                    <div className="composer-mode-menu-heading">Variant</div>
                    {availableEfforts.map((effort) => {
                      const selected = currentEffort === effort
                      return (
                        <button
                          key={effort}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          className={`composer-mode-menu-item${selected ? ' selected' : ''}`}
                          disabled={modelReadOnly}
                          onClick={() => handleEffortSelect(effort)}
                        >
                          {formatEffortLabel(effort)}
                        </button>
                      )
                    })}
                  </div>
                )}
                <div
                  className={`composer-mode-menu-section${availableEfforts.length > 0 ? ' composer-mode-menu-group' : ''}`}
                  role="group"
                  aria-label="Agent"
                >
                  <div className="composer-mode-menu-heading">Agent</div>
                  {BUILTIN_CHAT_MODES.map((mode) => {
                    const selected = chatModeEquals(chatMode, mode)
                    const isDefault = mode === DEFAULT_CHAT_MODE
                    return (
                      <button
                        key={mode}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`composer-mode-menu-item${selected ? ' selected' : ''}`}
                        onClick={() => handleModeSelect(mode)}
                      >
                        <span>{getChatModeLabel(mode)}</span>
                        {isDefault ? (
                          <span className="composer-mode-menu-item-meta">Default</span>
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              </div>
            </FloatingPortal>
          )}
          <button
            ref={modeButtonRef}
            type="button"
            className={`composer-pill-btn${modeMenuOpen ? ' open' : ''}`}
            aria-expanded={modeMenuOpen}
            aria-haspopup="listbox"
            aria-label={accessibleModeLabel}
            title={accessibleModeLabel}
            onClick={() => {
              onModelMenuOpenChange(false)
              setModeMenuOpen((open) => !open)
            }}
          >
            <ModeIcon size={14} strokeWidth={2} />
            <span className="composer-pill-btn-label">{modeButtonLabel}</span>
            <ChevronDown size={12} strokeWidth={2} />
          </button>
        </div>}

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
            <span className="composer-model-btn-label">{modelButtonLabel}</span>
            {!modelReadOnly && <ChevronDown size={12} strokeWidth={2} />}
          </button>
        </div>
      </div>

      <div className="composer-footer-right">
        <div className="composer-context-anchor">
          <ContextUsageRing
            percent={contextUsage.percent}
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
        </div>

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
            onClick={handleActionClick}
            disabled={disabled}
          >
            <Mic size={16} strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  )
}
