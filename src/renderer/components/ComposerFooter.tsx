import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  Brain,
  ChevronDown,
  GitBranch,
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
  /** Show the isolated-worktree toggle (new chats only, OFF by default). */
  showWorktreeToggle?: boolean
  worktreeEnabled?: boolean
  onWorktreeEnabledChange?: (enabled: boolean) => void
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
  allowAttachWhileLoading = false,
  showWorktreeToggle = false,
  worktreeEnabled = false,
  onWorktreeEnabledChange
}: ComposerFooterProps) {
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const [effortMenuOpen, setEffortMenuOpen] = useState(false)
  const modelPickerRef = useRef<HTMLDivElement>(null)
  const modelButtonRef = useRef<HTMLButtonElement>(null)
  const modelMenuContentRef = useRef<HTMLDivElement>(null)
  const modePickerRef = useRef<HTMLDivElement>(null)
  const modeButtonRef = useRef<HTMLButtonElement>(null)
  const modeMenuContentRef = useRef<HTMLDivElement>(null)
  const effortPickerRef = useRef<HTMLDivElement>(null)
  const effortButtonRef = useRef<HTMLButtonElement>(null)
  const effortMenuContentRef = useRef<HTMLDivElement>(null)
  const contextBtnRef = useRef<HTMLButtonElement>(null)
  const handleMenuScroll = useMenuScrollFade()
  const modelButtonLabel = getGroupedModelButtonLabel(selectedProviderId, selectedModelId, providers)
  const selectedProvider = providers.find((entry) => entry.id === selectedProviderId)
  const availableEfforts = useMemo(
    () =>
      getEffortsForModel(
        selectedProviderId,
        selectedModelId,
        selectedProvider?.models ?? []
      ),
    [selectedModelId, selectedProvider?.models, selectedProviderId]
  )
  const currentEffort = useMemo(
    () =>
      getCurrentEffort(selectedModelId, selectedProvider?.models ?? [], selectedProviderId) ??
      availableEfforts[0],
    [availableEfforts, selectedModelId, selectedProvider?.models, selectedProviderId]
  )
  const showEffortPicker = availableEfforts.length > 0
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
    deps: [modeLabel]
  })

  const emptyModelMenuStyle = useFloatingPosition({
    open: modelMenuOpen && providers.length === 0,
    anchorRef: modelButtonRef,
    contentRef: modelMenuContentRef,
    placement: 'above-start'
  })

  const effortMenuStyle = useFloatingPosition({
    open: effortMenuOpen,
    anchorRef: effortButtonRef,
    contentRef: effortMenuContentRef,
    placement: 'above-start',
    deps: [availableEfforts.length, currentEffort]
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

  useEffect(() => {
    if (!effortMenuOpen) return
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (
        effortPickerRef.current?.contains(target) ||
        effortMenuContentRef.current?.contains(target)
      ) {
        return
      }
      setEffortMenuOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setEffortMenuOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [effortMenuOpen])

  useEffect(() => {
    if (!showEffortPicker && effortMenuOpen) setEffortMenuOpen(false)
  }, [effortMenuOpen, showEffortPicker])

  const handleModeSelect = (mode: ChatMode) => {
    onChatModeChange(mode)
    setModeMenuOpen(false)
  }

  const handleEffortSelect = (effort: string) => {
    if (!selectedProviderId || !selectedModelId) return
    const nextModelId = applyEffortToModelId(selectedModelId, effort)
    setEffortMenuOpen(false)
    if (nextModelId !== selectedModelId) {
      onModelSelect(selectedProviderId, nextModelId)
    }
  }

  const handleModelMenuToggle = () => {
    setEffortMenuOpen(false)
    setModeMenuOpen(false)
    onModelMenuOpenChange(!modelMenuOpen)
  }

  const handleEffortMenuToggle = () => {
    onModelMenuOpenChange(false)
    setModeMenuOpen(false)
    setEffortMenuOpen((open) => !open)
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
            onClick={() => {
              setEffortMenuOpen(false)
              onModelMenuOpenChange(false)
              setModeMenuOpen((open) => !open)
            }}
          >
            <ModeIcon size={14} strokeWidth={2} />
            <span className="composer-pill-btn-label">{modeLabel}</span>
            <ChevronDown size={12} strokeWidth={2} />
          </button>
        </div>}

        {showWorktreeToggle && (
          <button
            type="button"
            role="switch"
            aria-checked={worktreeEnabled}
            aria-label="Isolated worktree for this thread"
            title={worktreeEnabled ? 'Worktree on — this thread runs in an isolated git worktree' : 'Worktree off — this thread runs on the primary checkout'}
            className={`composer-icon-btn${worktreeEnabled ? ' active' : ''}`}
            onClick={() => onWorktreeEnabledChange?.(!worktreeEnabled)}
          >
            <GitBranch
              size={16}
              strokeWidth={2}
              fill={worktreeEnabled ? 'currentColor' : 'none'}
              aria-hidden="true"
            />
          </button>
        )}

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

        {showEffortPicker ? (
          <div className="composer-effort-picker" ref={effortPickerRef}>
            {!modelReadOnly && effortMenuOpen && (
              <FloatingPortal>
                <div
                  ref={effortMenuContentRef}
                  className="composer-effort-menu composer-effort-menu-floating scrollbar-ultra-thin"
                  role="listbox"
                  aria-label="Select thinking effort"
                  style={effortMenuStyle}
                  onScroll={handleMenuScroll}
                >
                  {availableEfforts.map((effort) => (
                    <button
                      key={effort}
                      type="button"
                      role="option"
                      aria-selected={currentEffort === effort}
                      className={`composer-effort-menu-item${
                        currentEffort === effort ? ' selected' : ''
                      }`}
                      onClick={() => handleEffortSelect(effort)}
                    >
                      {formatEffortLabel(effort)}
                    </button>
                  ))}
                </div>
              </FloatingPortal>
            )}
            <button
              ref={effortButtonRef}
              type="button"
              className={`composer-pill-btn composer-effort-btn${effortMenuOpen ? ' open' : ''}`}
              aria-expanded={effortMenuOpen}
              aria-haspopup="listbox"
              aria-label={`Thinking effort: ${formatEffortLabel(currentEffort ?? 'medium')}`}
              title={`${modelReadOnly ? 'Assigned thinking effort' : 'Thinking effort'}: ${formatEffortLabel(currentEffort ?? 'medium')}`}
              disabled={modelReadOnly}
              onClick={modelReadOnly ? undefined : handleEffortMenuToggle}
            >
              <Brain size={14} strokeWidth={2} />
              <span className="composer-pill-btn-label">
                {formatEffortLabel(currentEffort ?? availableEfforts[0] ?? 'medium')}
              </span>
              {!modelReadOnly && <ChevronDown size={12} strokeWidth={2} />}
            </button>
          </div>
        ) : null}
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
