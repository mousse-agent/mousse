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
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import { getGroupedModelButtonLabel, ModelFamilyMenu } from './ModelFamilyMenu'
import { ProviderIcon } from '../lib/providerIcons'
import { ContextUsagePopover, ContextUsageRing } from './ContextUsagePopover'

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
  hideModePicker = false
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
  const ModeIcon = getModeIcon(chatMode)
  const activeSkill = typeof chatMode === 'object'
    ? enabledSkills.find((skill) => skill.id === chatMode.skillId)
    : undefined
  const modeLabel = getChatModeLabel(chatMode, activeSkill?.name)

  const modeMenuStyle = useFloatingPosition({
    open: modeMenuOpen,
    anchorRef: modeButtonRef,
    contentRef: modeMenuContentRef,
    placement: 'above-start',
    deps: [enabledSkills.length, modeLabel]
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

  const handleActionClick = () => {
    if (primaryAction === 'implement-plan') {
      onImplementPlan?.()
      return
    }
    if (loading) {
      onStop?.()
      return
    }
    if (canSend) {
      onSend?.()
    } else if (!isRecording) {
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
                aria-label="Select chat mode"
                style={modeMenuStyle}
                onScroll={handleMenuScroll}
              >
                {(['plan', 'agent', 'build'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="option"
                    aria-selected={chatModeEquals(chatMode, mode)}
                    className={`composer-mode-menu-item${chatModeEquals(chatMode, mode) ? ' selected' : ''}`}
                    onClick={() => handleModeSelect(mode)}
                  >
                    {getChatModeLabel(mode)}
                  </button>
                ))}
                {enabledSkills.length > 0 && (
                  <div className="composer-mode-menu-group">
                    <div className="composer-mode-menu-heading">Skills</div>
                    {enabledSkills.map((skill) => {
                      const skillMode: ChatMode = { type: 'skill', skillId: skill.id }
                      return (
                        <button
                          key={skill.id}
                          type="button"
                          role="option"
                          aria-selected={chatModeEquals(chatMode, skillMode)}
                          className={`composer-mode-menu-item${chatModeEquals(chatMode, skillMode) ? ' selected' : ''}`}
                          onClick={() => handleModeSelect(skillMode)}
                        >
                          {skill.name}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </FloatingPortal>
          )}
          <button
            ref={modeButtonRef}
            type="button"
            className={`composer-pill-btn${modeMenuOpen ? ' open' : ''}`}
            aria-expanded={modeMenuOpen}
            aria-haspopup="listbox"
            aria-label={`${modeLabel} mode`}
            title={`${modeLabel} mode`}
            onClick={() => setModeMenuOpen((open) => !open)}
          >
            <ModeIcon size={14} strokeWidth={2} />
            <span className="composer-pill-btn-label">{modeLabel}</span>
            <ChevronDown size={12} strokeWidth={2} />
          </button>
        </div>}

        <div className="composer-model-picker" ref={modelPickerRef}>
          {modelMenuOpen && (
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
            aria-expanded={modelMenuOpen}
            aria-haspopup="listbox"
            aria-label={`Model: ${modelButtonLabel}`}
            title={modelButtonLabel}
            onClick={() => onModelMenuOpenChange(!modelMenuOpen)}
          >
            {selectedProviderId ? (
              <ProviderIcon providerId={selectedProviderId} size={14} />
            ) : null}
            <span className="composer-model-btn-label">{modelButtonLabel}</span>
            <ChevronDown size={12} strokeWidth={2} />
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
          disabled={loading || disabled}
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
            className={`composer-action-btn ${canSend ? 'composer-action-btn-active' : ''}`}
            title={canSend ? 'Send message' : 'Voice input'}
            aria-label={canSend ? 'Send message' : 'Voice input'}
            onClick={handleActionClick}
            disabled={disabled}
          >
            {canSend ? (
              <ArrowUp size={16} strokeWidth={2} />
            ) : (
              <Mic size={16} strokeWidth={2} />
            )}
          </button>
        )}
      </div>
    </div>
  )
}
