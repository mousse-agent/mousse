import { useEffect, useMemo, useState } from 'react'
import type { HarnessCaps } from '../../shared/harness/types'
import type { ContextUsageSnapshot } from '../../shared/types'
import { chatStatusFromPhase, mousseToUIMessages } from '../chat/adapters/mousseToUI'
import { MousseAgentChatShell } from '../chat/components/MousseAgentChatShell'
import { RefreshCw, X } from '../lib/icons'
import type { ProviderWithStatus } from '../lib/providerSnapshots'
import { useCommand } from '../commands/commandRegistry'
import { pausedStatusLabel } from '../lib/pausedRun'
import {
  abortRemoteTurn,
  clearRemoteUnsent,
  refreshRemoteThread,
  remoteQuestionCount,
  remoteSlashCommand,
  remoteUnsupported,
  setRemoteModel,
  setRemoteNotice,
  submitRemoteMessage,
  useRemoteThreads,
  type RemoteImage,
  type RemoteThreadEntry
} from '../lib/remoteThreadStore'
import { useAppStore } from '../stores/appStore'
import { filesToImagePayloads } from '../utils/imageAttachments'
import { ChatComposer, type AttachedFile, type VoiceMessage } from './ChatComposer'
import '../chat/components/agent-elements/agent-ui.css'
import '../styles/compact-composer.css'
import './remoteThread.css'

const EMPTY_CONTEXT_USAGE: ContextUsageSnapshot = {
  percent: 0, used: 0, limit: 128_000, modelName: null, source: 'estimated', categories: []
}
// The target does not report context use to this window, so the picker hides the gauge.
const NO_CONTEXT_GAUGE = { contextUsage: 'none' } as HarnessCaps
const NO_VOICE: VoiceMessage[] = []

/** An image that did not go out, as the composer holds an attached file. */
function attachedImage(image: RemoteImage): AttachedFile {
  const bytes = Uint8Array.from(atob(image.data), (character) => character.charCodeAt(0))
  const file = new File([bytes], image.name, { type: image.mimeType })
  return { id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file) }
}

/** Drafts survive switching to another thread and back; attached files do not. */
const drafts = new Map<string, string>()

/**
 * A thread that runs on another computer, in the main thread area. The transcript is the
 * target's own display (attached through Bridge); the composer sends, steers and stops
 * through the same connection. Terminal, files, Git and agent questions stay on the target.
 */
export function RemoteThreadView() {
  const entry = useRemoteThreads((state) => (state.activeKey ? state.entries[state.activeKey] : undefined))
  return entry ? <RemoteThread key={entry.key} entry={entry} /> : null
}

function RemoteThread({ entry }: { entry: RemoteThreadEntry }) {
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen)
  const [input, setInputState] = useState(() => drafts.get(entry.key) ?? '')
  const [files, setFiles] = useState<AttachedFile[]>([])
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const setInput = (value: string) => {
    if (value) drafts.set(entry.key, value)
    else drafts.delete(entry.key)
    setInputState(value)
  }

  const messages = entry.view?.messages
  const uiMessages = useMemo(() => mousseToUIMessages(messages ?? []), [messages])
  const working = entry.sending || entry.view?.active === true
  const chatStatus = entry.error ? 'error' : chatStatusFromPhase(working ? (entry.view?.active ? 'streaming' : 'queued') : 'idle')

  const providers = useMemo<ProviderWithStatus[]>(
    () => (entry.options?.providers ?? []).map((provider) => ({ ...provider, caps: NO_CONTEXT_GAUGE })),
    [entry.options?.providers]
  )
  const selection = entry.view?.thread.modelOverride ?? entry.options?.defaultModel ?? undefined
  const selectedProvider = selection && (
    providers.find((provider) => selection.instanceId && provider.instanceId === selection.instanceId) ??
    providers.find((provider) => provider.id === selection.llmProvider)
  )

  const send = async () => {
    const attached = files
    const text = input.trim()
    // The same commands as the local composer: Stop ends the running turn, Steer guides it.
    const command = remoteSlashCommand(text)
    if (command?.kind === 'stop') {
      setInput('')
      void abortRemoteTurn(entry.key)
      return
    }
    const content = command?.kind === 'steer' ? command.text : text
    if (command?.kind === 'steer' && !content) return
    if (attached.some((file) => !file.file.type.startsWith('image/'))) {
      setRemoteNotice(entry.key, 'Only images can be attached to a thread on another computer.')
      return
    }
    if (!content && attached.length === 0) return
    const images = await filesToImagePayloads(attached.map((file) => file.file))
    setInput('')
    setFiles([])
    // A message that does not go out comes back through `entry.unsent`, below.
    void submitRemoteMessage(entry.key, { content, images })
  }

  // Text and images of a message that did not go out (a refusal, a failed upload) are put back.
  const unsent = entry.unsent
  useEffect(() => {
    if (!unsent) return
    clearRemoteUnsent(entry.key)
    setInputState((current) => {
      const restored = current && current !== unsent.content ? `${unsent.content}\n${current}` : unsent.content
      if (restored) drafts.set(entry.key, restored)
      return restored
    })
    if (unsent.images.length) setFiles((current) => [...unsent.images.map(attachedImage), ...current])
  }, [unsent, entry.key])

  // The Stop shortcut acts on this thread, not on the local one kept behind it.
  useCommand('run.stop', () => void abortRemoteTurn(entry.key), () => working)

  const device = entry.deviceName
  const questions = remoteQuestionCount(entry)
  const paused = entry.view?.active ? undefined : entry.view?.paused
  const stale = !entry.live && !entry.error
  return (
    <div className="chat remote-thread" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <MousseAgentChatShell
        key={entry.key}
        threadId={null}
        busy={working}
        messages={uiMessages}
        status={chatStatus}
        onSend={() => void send()}
        onStop={() => void abortRemoteTurn(entry.key)}
        composer={(
          <div className="chat-input-area">
            {entry.error && (
              <div className="connection-failed-pill" role="alert">
                <span>{entry.error}</span>
                <button type="button" onClick={() => refreshRemoteThread(entry.key)}>Retry</button>
              </div>
            )}
            {stale && <div className="remote-thread-status" role="status">
              <RefreshCw size={12} aria-hidden="true" />
              <span>Connecting to {device ?? 'the other computer'}</span>
            </div>}
            {entry.notice && (
              <div className="steer-pill" role="status">
                <span className="steer-pill-text">{entry.notice}</span>
                <button type="button" className="steer-pill-dismiss" aria-label="Dismiss notice" onClick={() => setRemoteNotice(entry.key, '')}><X size={12} aria-hidden="true" /></button>
              </div>
            )}
            {paused && (
              <div className="remote-thread-unsupported" role="status">
                <strong>{pausedStatusLabel(paused, Date.now())}</strong>
                <span>A usage limit paused this run{paused.autoResume ? ' and it will continue by itself' : ''}. Resume or cancel it on {device ?? 'the other computer'}.</span>
              </div>
            )}
            {questions > 0 && (
              <div className="remote-thread-unsupported" role="status">
                <strong>{remoteUnsupported('questions', device).title}</strong>
                <span>{remoteUnsupported('questions', device).detail}</span>
              </div>
            )}
            <ChatComposer
              input={input}
              onInputChange={setInput}
              attachedFiles={files}
              onAttachedFilesChange={setFiles}
              voiceMessages={NO_VOICE}
              onVoiceMessagesChange={() => {}}
              enabledSkills={[]}
              disableSkillsPicker
              providers={providers}
              selectedProviderId={selectedProvider?.id ?? ''}
              selectedModelId={selection?.model ?? ''}
              modelMenuOpen={modelMenuOpen}
              onModelMenuOpenChange={setModelMenuOpen}
              onModelSelect={(providerId, modelId) => {
                const provider = providers.find((entryProvider) => entryProvider.id === providerId)
                void setRemoteModel(entry.key, {
                  ...(provider?.instanceId ? { instanceId: provider.instanceId } : {}),
                  llmProvider: providerId,
                  model: modelId
                })
              }}
              onOpenSettings={() => setSettingsOpen(true)}
              contextUsage={EMPTY_CONTEXT_USAGE}
              contextOpen={contextOpen}
              onContextOpenChange={setContextOpen}
              loading={working}
              loadingPlaceholder="Running… send steers the turn"
              onSend={() => void send()}
              onStop={() => void abortRemoteTurn(entry.key)}
            />
          </div>
        )}
      />
    </div>
  )
}

/** Covers the app panel while a remote thread is shown: its terminal, files and Git are on the other computer. */
export function RemoteUnsupportedPanel() {
  const entry = useRemoteThreads((state) => (state.activeKey ? state.entries[state.activeKey] : undefined))
  if (!entry) return null
  const message = remoteUnsupported('panel', entry.deviceName)
  return (
    <div className="remote-thread-unsupported-panel" role="status">
      <strong>{message.title}</strong>
      <span>{message.detail}</span>
    </div>
  )
}
