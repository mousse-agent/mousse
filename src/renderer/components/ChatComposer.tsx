import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, X } from 'lucide-react'
import type { LlmProviderOption } from '../../shared/settings'
import type { ChatMode, ContextUsageSnapshot } from '../../shared/types'
import type { SkillDescriptor } from '../../shared/integrations'
import {
  filterChannelCommandSuggestions,
  type ChannelCommandDef
} from '../../shared/channelCommands'
import { ComposerFooter } from './ComposerFooter'
import { FileAttachmentPill } from './FileAttachmentPill'
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
  loading?: boolean
  disabled?: boolean
  placeholder?: string
  onSend: () => void
  onStop?: () => void
  hideModePicker?: boolean
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
  loading = false,
  disabled = false,
  placeholder = 'What do you to want to build?',
  onSend,
  onStop,
  hideModePicker = false
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

  const hasAttachments = attachedFiles.length > 0 || voiceMessages.length > 0
  // While loading, allow send only for /steer and /stop control commands.
  const trimmedInput = input.trim()
  const isControlWhileLoading =
    loading &&
    (trimmedInput === '/stop' ||
      trimmedInput.startsWith('/stop ') ||
      trimmedInput.startsWith('/steer ') ||
      trimmedInput === '/steer')
  const canSend =
    (trimmedInput.length > 0 || hasAttachments) &&
    !isRecording &&
    !disabled &&
    (!loading || isControlWhileLoading)
  const suggestions = filterChannelCommandSuggestions(input)
  const showSuggestions = !disabled && !suggestionsDismissed && suggestions.length > 0

  useEffect(() => {
    if (!showSuggestions) return
    setSelectedSuggestion((current) => Math.min(current, suggestions.length - 1))
  }, [showSuggestions, suggestions.length])

  useEffect(() => {
    if (showSuggestions) {
      suggestionRefs.current.get(selectedSuggestion)?.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedSuggestion, showSuggestions])

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
    onInputChange(`/${command.name}${command.argsHint ? ' ' : ''}`)
    setSuggestionsDismissed(true)
    requestAnimationFrame(() => composerInputRef.current?.focus())
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
        applySuggestion(suggestions[selectedSuggestion]!)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (canSend) onSend()
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
              <FileAttachmentPill
                key={id}
                name={file.name}
                previewUrl={previewUrl}
                onRemove={() => removeFile(id)}
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
        onPaste={handlePaste}
        placeholder={
          loading
            ? 'Running… /steer <note> or /stop · stop button cancels'
            : placeholder
        }
        rows={3}
        disabled={disabled}
        aria-expanded={showSuggestions}
        aria-controls={showSuggestions ? 'composer-command-suggestions' : undefined}
        aria-activedescendant={
          showSuggestions ? `composer-command-suggestion-${selectedSuggestion}` : undefined
        }
      />

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
        onChatModeChange={onChatModeChange}
        enabledSkills={enabledSkills}
        providers={providers}
        selectedProviderId={selectedProviderId}
        selectedModelId={selectedModelId}
        modelMenuOpen={modelMenuOpen}
        onModelMenuOpenChange={onModelMenuOpenChange}
        onModelSelect={onModelSelect}
        onOpenSettings={onOpenSettings}
        contextUsage={contextUsage}
        contextOpen={contextOpen}
        onContextOpenChange={onContextOpenChange}
        onAttachClick={() => fileInputRef.current?.click()}
        loading={loading}
        disabled={disabled}
        canSend={canSend}
        isRecording={isRecording}
        onSend={onSend}
        onStop={handleStop}
        onStartRecording={() => void startRecording()}
        onStopRecording={stopRecording}
        hideModePicker={hideModePicker}
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
  voiceMessages: VoiceMessage[]
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

  return parts.join('\n\n')
}
