import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, X } from 'lucide-react'
import type { LlmProviderOption } from '../../shared/settings'
import type {
  BrowserElementAttachment,
  ChatMode,
  ContextUsageSnapshot,
  SkillChatMode
} from '../../shared/types'
import type { SkillDescriptor } from '../../shared/integrations'
import {
  filterComposerCommandSuggestions,
  filterSkillSuggestions,
  findInlineSkillToken,
  parseSkillsPickerQuery,
  removeInlineSkillToken,
  type ChannelCommandDef
} from '../../shared/channelCommands'
import { ComposerFooter } from './ComposerFooter'
import { BrowserElementPill } from './BrowserElementPill'
import { FileAttachment } from './agent-elements/input/file-attachment'
import { formatBrowserElementBlock } from '../utils/messageAttachments'
import { collectImageFilesFromDataTransfer } from '../utils/imageAttachments'

export interface AttachedFile {
  id: string
  file: File
  previewUrl?: string
}

export interface VoiceMessage {
  id: string
  blob: Blob
  duration: number
  url: string
}

export interface ChatComposerProps {
  input: string
  onInputChange: (value: string) => void
  attachedFiles: AttachedFile[]
  onAttachedFilesChange: (files: AttachedFile[]) => void
  voiceMessages: VoiceMessage[]
  onVoiceMessagesChange: (voices: VoiceMessage[]) => void
  browserElements?: BrowserElementAttachment[]
  onRemoveBrowserElement?: (id: string) => void
  chatMode: ChatMode
  onChatModeChange: (mode: ChatMode) => void
  enabledSkills: SkillDescriptor[]
  providers: LlmProviderOption[]
  selectedProviderId: string
  selectedModelId: string
  modelMenuOpen: boolean
  onModelMenuOpenChange: (open: boolean) => void
  onModelSelect: (providerId: string, modelId: string) => void
  /** Display the selected model without allowing this composer to mutate it. */
  modelReadOnly?: boolean
  onOpenSettings: () => void
  contextUsage: ContextUsageSnapshot
  contextOpen: boolean
  onContextOpenChange: (open: boolean) => void
  loading?: boolean
  disabled?: boolean
  placeholder?: string
  /** Receives the inline `@skill` token (if any) so the parent can send this
   * prompt in skill mode without flipping the global chat mode. */
  onSend: (skillMode?: SkillChatMode) => void
  onStop?: () => void
  hideModePicker?: boolean
  /** When true, `/skills` is treated as literal text instead of opening the skill picker.
   * Defaults to `hideModePicker` (subagent composers never switch the global chat mode). */
  disableSkillsPicker?: boolean
  showWorktreeToggle?: boolean
  worktreeEnabled?: boolean
  onWorktreeEnabledChange?: (enabled: boolean) => void
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function ChatComposer({
  input,
  onInputChange,
  attachedFiles,
  onAttachedFilesChange,
  voiceMessages,
  onVoiceMessagesChange,
  browserElements = [],
  onRemoveBrowserElement = () => {},
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
  loading = false,
  disabled = false,
  placeholder = 'What do you to want to build?',
  onSend,
  onStop,
  hideModePicker = false,
  disableSkillsPicker,
  showWorktreeToggle = false,
  worktreeEnabled = false,
  onWorktreeEnabledChange
}: ChatComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordingChunksRef = useRef<Blob[]>([])
  const recordingTimerRef = useRef<number | null>(null)
  const recordingStartRef = useRef<number>(0)
  const composerInputRef = useRef<HTMLTextAreaElement>(null)
  const suggestionRefs = useRef(new Map<number, HTMLButtonElement>())
  const [isRecording, setIsRecording] = useState(false)
  const [recordingDuration, setRecordingDuration] = useState(0)
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false)
  const [selectedSuggestion, setSelectedSuggestion] = useState(0)
  // Subagent composers (hideModePicker) never switch the global chat mode:
  // `/skills` stays literal text so it is sent to the agent as a prompt.
  const skillsPickerDisabled = disableSkillsPicker ?? hideModePicker
  // Inline `@skill` token embedded in the typed text (painted as a pill by
  // the input backdrop). The global chat mode is untouched: the skill applies
  // to the submitted prompt only (passed to onSend as a mode override), and
  // the token is stripped from the sent text. Backspace deletes it like text.
  const skillToken = skillsPickerDisabled
    ? null
    : findInlineSkillToken(input, enabledSkills)
  const backdropRef = useRef<HTMLDivElement>(null)

  const hasAttachments = attachedFiles.length > 0 || voiceMessages.length > 0 || browserElements.length > 0
  const trimmedInput = removeInlineSkillToken(input, skillsPickerDisabled ? [] : enabledSkills).trim()
  const skillsPickerQuery = skillsPickerDisabled ? null : parseSkillsPickerQuery(input)
  const skillSuggestions =
    skillsPickerQuery !== null ? filterSkillSuggestions(enabledSkills, skillsPickerQuery) : []
  const showSkillsPicker = !disabled && !suggestionsDismissed && skillsPickerQuery !== null
  const suggestions = showSkillsPicker ? [] : filterComposerCommandSuggestions(input).filter((command) => !skillsPickerDisabled || command.name !== 'skills')
  const showSuggestions = !disabled && !suggestionsDismissed && suggestions.length > 0
  const pickerItemCount = showSkillsPicker ? skillSuggestions.length : suggestions.length
  // `/skills` is a local UI command — never send it as a chat message.
  // While a turn is active, ordinary sends are still allowed (they stack on the per-thread queue).
  const canSend =
    (trimmedInput.length > 0 || hasAttachments) &&
    !isRecording &&
    !disabled &&
    skillsPickerQuery === null

  useEffect(() => {
    if (!showSuggestions && !showSkillsPicker) return
    setSelectedSuggestion((current) =>
      pickerItemCount === 0 ? 0 : Math.min(current, pickerItemCount - 1)
    )
  }, [showSuggestions, showSkillsPicker, pickerItemCount])

  useEffect(() => {
    if (showSuggestions || showSkillsPicker) {
      suggestionRefs.current.get(selectedSuggestion)?.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedSuggestion, showSuggestions, showSkillsPicker])

  useEffect(() => {
    return () => {
      if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current)
      mediaRecorderRef.current?.stream.getTracks().forEach((t) => t.stop())
    }
  }, [])

  const addFiles = useCallback(
    (files: File[]) => {
      if (!files.length) return
      const next: AttachedFile[] = files.map((file) => ({
        id: crypto.randomUUID(),
        file,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined
      }))
      onAttachedFilesChange([...attachedFiles, ...next])
    },
    [attachedFiles, onAttachedFilesChange]
  )

  const removeFile = (id: string) => {
    const target = attachedFiles.find((f) => f.id === id)
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
    onAttachedFilesChange(attachedFiles.filter((f) => f.id !== id))
  }

  const removeVoice = (id: string) => {
    const voice = voiceMessages.find((v) => v.id === id)
    if (voice) URL.revokeObjectURL(voice.url)
    onVoiceMessagesChange(voiceMessages.filter((v) => v.id !== id))
  }

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (!files?.length) return
    addFiles(Array.from(files))
    event.target.value = ''
  }

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = collectImageFilesFromDataTransfer(event.clipboardData)
    if (images.length === 0) return
    event.preventDefault()
    addFiles(images)
  }

  const stopRecordingTimer = () => {
    if (recordingTimerRef.current) {
      window.clearInterval(recordingTimerRef.current)
      recordingTimerRef.current = null
    }
  }

  const startRecording = async () => {
    // Voice capture is still blocked during an active turn (queue accepts text/images only).
    if (loading || isRecording || disabled) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      recordingChunksRef.current = []
      mediaRecorderRef.current = recorder

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordingChunksRef.current.push(e.data)
      }

      recorder.onstop = () => {
        stopRecordingTimer()
        setIsRecording(false)
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(recordingChunksRef.current, { type: 'audio/webm' })
        const duration = Math.max(1, Math.floor((Date.now() - recordingStartRef.current) / 1000))
        const url = URL.createObjectURL(blob)
        onVoiceMessagesChange([
          ...voiceMessages,
          { id: crypto.randomUUID(), blob, duration, url }
        ])
        mediaRecorderRef.current = null
      }

      recordingStartRef.current = Date.now()
      setRecordingDuration(0)
      setIsRecording(true)
      recorder.start()
      recordingTimerRef.current = window.setInterval(() => {
        setRecordingDuration(Math.floor((Date.now() - recordingStartRef.current) / 1000))
      }, 200)
    } catch {
      setIsRecording(false)
    }
  }

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop()
    }
  }

  const applySuggestion = (command: ChannelCommandDef) => {
    if (command.name === 'skills') {
      // Keep the slash token so the skills picker opens immediately.
      onInputChange('/skills ')
      setSuggestionsDismissed(false)
      setSelectedSuggestion(0)
      requestAnimationFrame(() => composerInputRef.current?.focus())
      return
    }
    onInputChange(`/${command.name}${command.argsHint ? ' ' : ''}`)
    setSuggestionsDismissed(true)
    requestAnimationFrame(() => composerInputRef.current?.focus())
  }

  const applySkill = (skillId: string) => {
    // Embed as an inline `@skill` token instead of switching the global chat
    // mode. The `/skills …` command becomes the token; other text is kept so
    // the skill sits between the user's typing.
    const skill =
      enabledSkills.find((entry) => entry.id === skillId) ??
      enabledSkills.find((entry) => entry.name === skillId)
    const name = skill?.name ?? skillId
    const node = composerInputRef.current
    if (parseSkillsPickerQuery(input) !== null) {
      onInputChange(`@${name} `)
    } else {
      const caret = node?.selectionStart ?? input.length
      const caretEnd = node?.selectionEnd ?? caret
      const before = input.slice(0, caret)
      const after = input.slice(caretEnd)
      const sepBefore = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
      const sepAfter = after.length > 0 && !/^\s/.test(after) ? ' ' : ''
      onInputChange(`${before}${sepBefore}@${name}${sepAfter}${after}`)
      const nextCaret = (before + sepBefore + `@${name}` + sepAfter).length
      requestAnimationFrame(() => {
        const target = composerInputRef.current
        if (!target) return
        target.focus()
        target.setSelectionRange(nextCaret, nextCaret)
      })
    }
    setSuggestionsDismissed(true)
    setSelectedSuggestion(0)
    requestAnimationFrame(() => composerInputRef.current?.focus())
  }

  const submit = () => {
    if (!canSend) return
    const skillMode: SkillChatMode | undefined = skillToken
      ? { type: 'skill', skillId: skillToken.skillId }
      : undefined
    onSend(skillMode)
  }

  const handleChatModeChange = (mode: ChatMode) => {
    // Explicit mode switches drop the inline skill token.
    if (skillToken) {
      onInputChange(input.slice(0, skillToken.index) + input.slice(skillToken.index + skillToken.length))
    }
    onChatModeChange(mode)
  }

  const handleInputScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    // The token backdrop paints behind the textarea: keep it scroll-locked.
    if (backdropRef.current) backdropRef.current.scrollTop = e.currentTarget.scrollTop
  }

  const renderInputBackdrop = () => {
    if (!skillToken) return input.endsWith('\n') ? <>{input}{ '\u200B'}</> : input
    const before = input.slice(0, skillToken.index)
    const tokenText = input.slice(skillToken.index, skillToken.index + skillToken.length)
    const after = input.slice(skillToken.index + skillToken.length)
    return (
      <>
        {before}
        <span className="composer-token-chip">{tokenText}</span>
        {after}
        {input.endsWith('\n') ? '\u200B' : null}
      </>
    )
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSkillsPicker) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (skillSuggestions.length === 0) return
        setSelectedSuggestion((current) => (current + 1) % skillSuggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (skillSuggestions.length === 0) return
        setSelectedSuggestion((current) => (current - 1 + skillSuggestions.length) % skillSuggestions.length)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSuggestionsDismissed(true)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        const skill = skillSuggestions[selectedSuggestion]
        if (skill) applySkill(skill.id)
        return
      }
    }
    if (showSuggestions) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedSuggestion((current) => (current + 1) % suggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedSuggestion((current) => (current - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSuggestionsDismissed(true)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        const suggestion = suggestions[selectedSuggestion]!
        // An exact no-argument command is already complete: execute it instead of
        // making users press Enter twice (first to re-apply the same suggestion).
        if (!suggestion.argsHint && input.trim().toLowerCase() === `/${suggestion.name}`) {
          submit()
        } else {
          applySuggestion(suggestion)
        }
        return
      }
    }
    if (e.key === 'Backspace' && input.length === 0 && browserElements.length > 0) {
      e.preventDefault()
      onRemoveBrowserElement(browserElements[browserElements.length - 1].id)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const handleStop = () => {
    onStop?.()
  }

  return (
    <div className="composer">
      {(hasAttachments || isRecording) && (
        <div className="composer-attachments">
          <div className="composer-attachments-scroll">
            {isRecording && (
              <div className="composer-attachment-pill composer-attachment-pill-recording">
                <Mic size={12} strokeWidth={2} />
                <span>Recording {formatDuration(recordingDuration)}</span>
              </div>
            )}
            {attachedFiles.map(({ id, file, previewUrl }) => (
              <FileAttachment
                key={id}
                id={id}
                filename={file.name}
                size={file.size}
                isImage={previewUrl !== undefined}
                url={previewUrl}
                onRemove={() => removeFile(id)}
              />
            ))}
            {browserElements.map((element) => (
              <BrowserElementPill
                key={element.id}
                element={element}
                onRemove={() => onRemoveBrowserElement(element.id)}
              />
            ))}
            {voiceMessages.map(({ id, duration }) => (
              <div key={id} className="composer-attachment-pill composer-attachment-pill-voice">
                <Mic size={12} strokeWidth={2} />
                <span>Voice {formatDuration(duration)}</span>
                <button
                  type="button"
                  className="composer-attachment-remove"
                  onClick={() => removeVoice(id)}
                  aria-label="Remove voice message"
                >
                  <X size={12} strokeWidth={2} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="composer-input-wrap">
        <div ref={backdropRef} className="composer-input-backdrop" aria-hidden="true">
          {renderInputBackdrop()}
        </div>
        <textarea
          ref={composerInputRef}
          className="composer-input"
          value={input}
          onChange={(e) => {
            setSuggestionsDismissed(false)
            setSelectedSuggestion(0)
            onInputChange(e.target.value)
          }}
          onKeyDown={handleKeyDown}
          onScroll={handleInputScroll}
          onPaste={handlePaste}
          placeholder={
            loading
              ? 'Running… send queues next'
              : placeholder
          }
          rows={3}
          disabled={disabled}
          aria-expanded={showSuggestions || showSkillsPicker}
          aria-controls={
            showSuggestions || showSkillsPicker ? 'composer-command-suggestions' : undefined
          }
          aria-activedescendant={
            showSuggestions || showSkillsPicker
              ? `composer-command-suggestion-${selectedSuggestion}`
              : undefined
          }
        />
      </div>

      {showSkillsPicker && (
        <div
          id="composer-command-suggestions"
          className="composer-command-suggestions scrollbar-ultra-thin"
          role="listbox"
          aria-label="Skill suggestions"
        >
          {skillSuggestions.length === 0 ? (
            <div className="composer-command-suggestion-empty">
              {enabledSkills.length === 0
                ? 'No skills enabled. Enable skills in Settings.'
                : 'No skills match that filter.'}
            </div>
          ) : (
            skillSuggestions.map((skill, index) => (
              <button
                key={skill.id}
                ref={(element) => {
                  if (element) suggestionRefs.current.set(index, element)
                  else suggestionRefs.current.delete(index)
                }}
                id={`composer-command-suggestion-${index}`}
                className={`composer-command-suggestion${index === selectedSuggestion ? ' selected' : ''}`}
                type="button"
                role="option"
                aria-selected={index === selectedSuggestion}
                onMouseEnter={() => setSelectedSuggestion(index)}
                onClick={() => applySkill(skill.id)}
              >
                <span className="composer-command-suggestion-name">{skill.name}</span>
                <span className="composer-command-suggestion-description">
                  {skill.description || skill.id}
                </span>
              </button>
            ))
          )}
        </div>
      )}

      {showSuggestions && (
        <div
          id="composer-command-suggestions"
          className="composer-command-suggestions scrollbar-ultra-thin"
          role="listbox"
          aria-label="Slash command suggestions"
        >
          {suggestions.map((command, index) => (
            <button
              key={command.name}
              ref={(element) => {
                if (element) suggestionRefs.current.set(index, element)
                else suggestionRefs.current.delete(index)
              }}
              id={`composer-command-suggestion-${index}`}
              className={`composer-command-suggestion${index === selectedSuggestion ? ' selected' : ''}`}
              type="button"
              role="option"
              aria-selected={index === selectedSuggestion}
              onMouseEnter={() => setSelectedSuggestion(index)}
              onClick={() => applySuggestion(command)}
            >
              <span className="composer-command-suggestion-name">
                /{command.name}{command.argsHint ? ` ${command.argsHint}` : ''}
              </span>
              <span className="composer-command-suggestion-description">{command.description}</span>
            </button>
          ))}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="*/*"
        className="composer-file-input"
        onChange={handleFileSelect}
        aria-hidden="true"
        tabIndex={-1}
      />

      <ComposerFooter
        chatMode={chatMode}
        onChatModeChange={handleChatModeChange}
        enabledSkills={enabledSkills}
        providers={providers}
        selectedProviderId={selectedProviderId}
        selectedModelId={selectedModelId}
        modelMenuOpen={modelMenuOpen}
        onModelMenuOpenChange={onModelMenuOpenChange}
        onModelSelect={onModelSelect}
        modelReadOnly={modelReadOnly}
        onOpenSettings={onOpenSettings}
        contextUsage={contextUsage}
        contextOpen={contextOpen}
        onContextOpenChange={onContextOpenChange}
        onAttachClick={() => fileInputRef.current?.click()}
        loading={loading}
        disabled={disabled}
        canSend={canSend}
        isRecording={isRecording}
        onSend={submit}
        onStop={handleStop}
        onStartRecording={() => void startRecording()}
        onStopRecording={stopRecording}
        hideModePicker={hideModePicker}
        allowAttachWhileLoading
        showWorktreeToggle={showWorktreeToggle}
        worktreeEnabled={worktreeEnabled}
        onWorktreeEnabledChange={onWorktreeEnabledChange}
      />
    </div>
  )
}

export function formatVoiceDuration(seconds: number): string {
  return formatDuration(seconds)
}

export function buildComposerMessageContent(
  input: string,
  attachedFiles: AttachedFile[],
  voiceMessages: VoiceMessage[],
  browserElements: BrowserElementAttachment[] = []
): string {
  const parts: string[] = []
  if (input.trim()) parts.push(input.trim())

  if (attachedFiles.length) {
    const fileList = attachedFiles.map((f) => f.file.name).join(', ')
    parts.push(`[Attached files: ${fileList}]`)
  }

  if (voiceMessages.length) {
    const voiceList = voiceMessages
      .map((v) => `Voice message (${formatDuration(v.duration)})`)
      .join(', ')
    parts.push(`[${voiceList}]`)
  }

  if (browserElements.length) {
    parts.push(browserElements.map((element) => formatBrowserElementBlock(element)).join('\n\n'))
  }

  return parts.join('\n\n')
}
