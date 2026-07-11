import { useCallback, useEffect, useRef, useState } from 'react'

import { X, Mic } from 'lucide-react'

import type { LlmProviderOption } from '../../shared/settings'

import type { ContextUsageSnapshot, PlanCardMetadata, PendingUserQuestions } from '../../shared/types'

import { DEFAULT_CHAT_MODE } from '../../shared/types'

import type { SkillDescriptor } from '../../shared/integrations'

import { isToolTimelineMessage } from '../../shared/types'

import { useAppStore } from '../stores/appStore'

import { ChatMessageContent } from './ChatMessageContent'

import { ComposerFooter } from './ComposerFooter'

import { ComposerQuestionModal } from './ComposerQuestionModal'

import { PreThinkingBlock } from './PreThinkingBlock'

import { FileAttachmentPill } from './FileAttachmentPill'



const EMPTY_CONTEXT_USAGE: ContextUsageSnapshot = {

  percent: 0,

  used: 0,

  limit: 128_000,

  modelName: null,

  source: 'estimated',

  categories: []

}



const STICKY_USER_DEBOUNCE_MS = 60



interface AttachedFile {

  id: string

  file: File

}



interface VoiceMessage {

  id: string

  blob: Blob

  duration: number

  url: string

}



function formatDuration(seconds: number): string {

  const m = Math.floor(seconds / 60)

  const s = Math.floor(seconds % 60)

  return `${m}:${s.toString().padStart(2, '0')}`

}



export function OrchestratorChat() {

  const messages = useAppStore((s) => s.messages)

  const loading = useAppStore((s) => s.loading)

  const setLoading = useAppStore((s) => s.setLoading)

  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)

  const chatMode = useAppStore((s) => s.chatMode)

  const setChatMode = useAppStore((s) => s.setChatMode)

  const [input, setInput] = useState('')

  const [providers, setProviders] = useState<LlmProviderOption[]>([])

  const [selectedProviderId, setSelectedProviderId] = useState('')

  const [selectedModelId, setSelectedModelId] = useState('')

  const [enabledSkills, setEnabledSkills] = useState<SkillDescriptor[]>([])

  const [modelMenuOpen, setModelMenuOpen] = useState(false)

  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])

  const [voiceMessages, setVoiceMessages] = useState<VoiceMessage[]>([])

  const [isRecording, setIsRecording] = useState(false)

  const [recordingDuration, setRecordingDuration] = useState(0)

  const [contextOpen, setContextOpen] = useState(false)

  const [contextUsage, setContextUsage] = useState<ContextUsageSnapshot>(EMPTY_CONTEXT_USAGE)

  const [stickyUserId, setStickyUserId] = useState<string | null>(null)

  const [pendingQuestions, setPendingQuestions] = useState<PendingUserQuestions | null>(null)



  const messagesRef = useRef<HTMLDivElement>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)

  const recordingChunksRef = useRef<Blob[]>([])

  const recordingTimerRef = useRef<number | null>(null)

  const stickyUpdateTimerRef = useRef<number | null>(null)

  const scrollFadeTimerRef = useRef<number | null>(null)

  const recordingStartRef = useRef<number>(0)



  const hasAttachments = attachedFiles.length > 0 || voiceMessages.length > 0

  const hasActiveThinking = messages.some(
    (message) => message.kind === 'thinking' && message.thinking?.status === 'processing'
  )

  const hasStreamingAssistant = messages.some(
    (message) => message.role === 'assistant' && message.streaming
  )

  const showPreThinking = loading && !hasActiveThinking && !hasStreamingAssistant

  const canSend = (input.trim().length > 0 || hasAttachments) && !loading && !isRecording



  const updateStickyUser = useCallback(() => {

    const container = messagesRef.current

    if (!container) return



    const stickyThreshold = container.scrollTop + 1

    let nextStickyId: string | null = null



    for (const message of container.querySelectorAll<HTMLElement>('[data-message-role="user"]')) {

      if (message.offsetTop <= stickyThreshold) {

        nextStickyId = message.dataset.messageId ?? null

      }

    }



    setStickyUserId((current) => (current === nextStickyId ? current : nextStickyId))

  }, [])



  const scheduleStickyUserUpdate = useCallback(() => {

    if (stickyUpdateTimerRef.current) {

      window.clearTimeout(stickyUpdateTimerRef.current)

    }



    stickyUpdateTimerRef.current = window.setTimeout(() => {

      stickyUpdateTimerRef.current = null

      updateStickyUser()

    }, STICKY_USER_DEBOUNCE_MS)

  }, [updateStickyUser])



  const handleMessagesScroll = useCallback(() => {

    scheduleStickyUserUpdate()



    const container = messagesRef.current

    if (!container) return



    container.classList.add('is-scrolling')

    if (scrollFadeTimerRef.current) {

      window.clearTimeout(scrollFadeTimerRef.current)

    }

    scrollFadeTimerRef.current = window.setTimeout(() => {

      container.classList.remove('is-scrolling')

      scrollFadeTimerRef.current = null

    }, 900)

  }, [scheduleStickyUserUpdate])



  useEffect(() => {

    messagesRef.current?.scrollTo({

      top: messagesRef.current.scrollHeight,

      behavior: 'smooth'

    })

    scheduleStickyUserUpdate()

  }, [messages, scheduleStickyUserUpdate])



  useEffect(() => {

    return () => {

      voiceMessages.forEach((v) => URL.revokeObjectURL(v.url))

      if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current)

      if (stickyUpdateTimerRef.current) window.clearTimeout(stickyUpdateTimerRef.current)

      if (scrollFadeTimerRef.current) window.clearTimeout(scrollFadeTimerRef.current)

      mediaRecorderRef.current?.stream.getTracks().forEach((t) => t.stop())

    }

    // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup on unmount only

  }, [])



  useEffect(() => {
    const unsub = window.mousse.orchestrator.onQuestionsPending((payload) => {
      setPendingQuestions(payload)
    })
    return unsub
  }, [])



  const refreshSelection = useCallback(async () => {

    const [settings, options, skillsSnapshot] = await Promise.all([

      window.mousse.settings.get(),

      window.mousse.settings.getOptions(),

      window.mousse.skills.list()

    ])

    setProviders(options.llmProviders)

    setSelectedProviderId(settings.provider.llmProvider)

    setSelectedModelId(settings.provider.model)



    const enabled = new Set(settings.integrations.skills.enabledSkills)

    setEnabledSkills(

      skillsSnapshot.skills.filter(

        (skill) =>

          skill.isActive !== false &&

          (enabled.size === 0 || enabled.has(skill.id) || enabled.has(skill.name))

      )

    )

  }, [])



  useEffect(() => {

    void refreshSelection()

    const unsubSettings = window.mousse.settings.onChanged(() => {

      void refreshSelection()

    })

    const unsubProviders = window.mousse.providers.onChanged(() => {

      void refreshSelection()

    })

    const unsubSkills = window.mousse.skills.onChanged(() => {

      void refreshSelection()

    })

    return () => {

      unsubSettings()

      unsubProviders()

      unsubSkills()

    }

  }, [refreshSelection])



  const removeFile = (id: string) => {

    setAttachedFiles((files) => files.filter((f) => f.id !== id))

  }



  const removeVoice = (id: string) => {

    setVoiceMessages((voices) => {

      const voice = voices.find((v) => v.id === id)

      if (voice) URL.revokeObjectURL(voice.url)

      return voices.filter((v) => v.id !== id)

    })

  }



  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {

    const files = event.target.files

    if (!files?.length) return

    const next = Array.from(files).map((file) => ({

      id: crypto.randomUUID(),

      file

    }))

    setAttachedFiles((prev) => [...prev, ...next])

    event.target.value = ''

  }



  const stopRecordingTimer = () => {

    if (recordingTimerRef.current) {

      window.clearInterval(recordingTimerRef.current)

      recordingTimerRef.current = null

    }

  }



  const startRecording = async () => {

    if (loading || isRecording) return

    try {

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })

      const recorder = new MediaRecorder(stream)

      recordingChunksRef.current = []

      mediaRecorderRef.current = recorder



      recorder.ondataavailable = (event) => {

        if (event.data.size > 0) recordingChunksRef.current.push(event.data)

      }



      recorder.onstop = () => {

        stream.getTracks().forEach((t) => t.stop())

        stopRecordingTimer()



        const blob = new Blob(recordingChunksRef.current, { type: recorder.mimeType || 'audio/webm' })

        const duration = Math.max(1, Math.round((Date.now() - recordingStartRef.current) / 1000))

        const url = URL.createObjectURL(blob)

        setVoiceMessages((prev) => [

          ...prev,

          { id: crypto.randomUUID(), blob, duration, url }

        ])

        setRecordingDuration(0)

        setIsRecording(false)

        mediaRecorderRef.current = null

      }



      recordingStartRef.current = Date.now()

      recorder.start()

      setIsRecording(true)

      setRecordingDuration(0)

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



  const buildMessageContent = useCallback((): string => {

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

  }, [attachedFiles, input, voiceMessages])



  useEffect(() => {

    let cancelled = false

    const draft = buildMessageContent()



    void window.mousse.orchestrator

      .getContextUsage({ draftInput: draft, mode: chatMode })

      .then((usage) => {

        if (!cancelled) setContextUsage(usage)

      })



    return () => {

      cancelled = true

    }

  }, [

    messages,

    input,

    attachedFiles,

    voiceMessages,

    selectedProviderId,

    selectedModelId,

    chatMode,

    loading,

    buildMessageContent

  ])



  const sendMessage = useCallback(

    async (content: string, mode = chatMode) => {

      if (!content || loading || isRecording) return



      setLoading(true)

      try {

        await window.mousse.orchestrator.send({ content, mode })

      } finally {

        setLoading(false)

      }

    },

    [chatMode, isRecording, loading, setLoading]

  )



  const handleSend = async () => {

    const text = buildMessageContent()

    if (!text || loading || isRecording) return



    setInput('')

    setAttachedFiles([])

    voiceMessages.forEach((v) => URL.revokeObjectURL(v.url))

    setVoiceMessages([])

    await sendMessage(text, chatMode)

  }



  const handleImplementPlan = async (plan: PlanCardMetadata) => {

    const content = [

      'Original request:',

      plan.originalRequest,

      '',

      'Implement the following plan:',

      '',

      plan.planMarkdown

    ].join('\n')



    setChatMode(DEFAULT_CHAT_MODE)

    await sendMessage(content, DEFAULT_CHAT_MODE)

  }



  const handleKeyDown = (e: React.KeyboardEvent) => {

    if (e.key === 'Enter' && !e.shiftKey) {

      e.preventDefault()

      if (canSend) void handleSend()

    }

  }



  const handleModelSelect = async (providerId: string, modelId: string) => {

    setModelMenuOpen(false)

    await window.mousse.settings.set({

      provider: { llmProvider: providerId, model: modelId }

    })

  }



  return (

    <div className="chat">

      <div className="chat-messages" ref={messagesRef} onScroll={handleMessagesScroll}>

        <div className="chat-turn">

          {messages.map((msg) => (

            <div

              key={msg.id}

              className={`message message-${msg.role}${

                msg.role === 'user' && stickyUserId === msg.id ? ' message-user-sticky-active' : ''

              }${isToolTimelineMessage(msg) ? ' message-tool-call' : ''}${

                msg.kind === 'plan_card' ? ' message-plan-card' : ''

              }`}

              data-message-id={msg.id}

              data-message-role={msg.role}

            >

              <ChatMessageContent

                role={msg.role}

                content={msg.content}

                kind={msg.kind}

                planCard={msg.planCard}

                toolCall={msg.toolCall}

                thinking={msg.thinking}

                streaming={msg.streaming}

                onImplementPlan={(plan) => void handleImplementPlan(plan)}

                implementPlanLoading={loading}

              />

              {msg.kind !== 'plan_card' && (

                <div className="message-time">

                  {new Date(msg.timestamp).toLocaleTimeString()}

                </div>

              )}

            </div>

          ))}

          {showPreThinking && (
            <div className="message message-system message-thinking message-pre-thinking">
              <PreThinkingBlock />
            </div>
          )}

        </div>

        <div className="chat-messages-fill" aria-hidden="true" />

      </div>



      <div className="chat-input-area">
        {pendingQuestions && (
          <ComposerQuestionModal
            pending={pendingQuestions}
            onSubmit={(answers) => {
              void window.mousse.orchestrator.answerQuestions(pendingQuestions.requestId, answers)
              setPendingQuestions(null)
            }}
            onDismiss={() => {
              void window.mousse.orchestrator.dismissQuestions(pendingQuestions.requestId)
              setPendingQuestions(null)
            }}
          />
        )}

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

                {attachedFiles.map(({ id, file }) => (

                  <FileAttachmentPill

                    key={id}

                    name={file.name}

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

            className="composer-input"

            value={input}

            onChange={(e) => setInput(e.target.value)}

            onKeyDown={handleKeyDown}

            placeholder="What do you to want to build?"

            rows={3}

            disabled={loading}

          />



          <input

            ref={fileInputRef}

            type="file"

            multiple

            className="composer-file-input"

            onChange={handleFileSelect}

            aria-hidden="true"

            tabIndex={-1}

          />



          <ComposerFooter

            chatMode={chatMode}

            onChatModeChange={setChatMode}

            enabledSkills={enabledSkills}

            providers={providers}

            selectedProviderId={selectedProviderId}

            selectedModelId={selectedModelId}

            modelMenuOpen={modelMenuOpen}

            onModelMenuOpenChange={setModelMenuOpen}

            onModelSelect={(providerId, modelId) => void handleModelSelect(providerId, modelId)}

            onOpenSettings={() => setSettingsOpen(true)}

            contextUsage={contextUsage}

            contextOpen={contextOpen}

            onContextOpenChange={setContextOpen}

            onAttachClick={() => fileInputRef.current?.click()}

            loading={loading}

            canSend={canSend}

            isRecording={isRecording}

            onSend={() => void handleSend()}

            onStartRecording={() => void startRecording()}

            onStopRecording={stopRecording}

          />

        </div>

      </div>

    </div>

  )

}


