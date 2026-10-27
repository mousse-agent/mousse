import { useMemo, useState } from 'react'
import type { HarnessCaps } from '../../shared/harness/types'
import type { ContextUsageSnapshot } from '../../shared/types'
import { chatStatusFromPhase, mousseToUIMessages } from '../chat/adapters/mousseToUI'
import { MousseAgentChatShell } from '../chat/components/MousseAgentChatShell'
import { RefreshCw, X } from '../lib/icons'
import type { ProviderWithStatus } from '../lib/providerSnapshots'
import {
  abortRemoteTurn,
  refreshRemoteThread,
  remoteUnsupported,
  setRemoteModel,
  setRemoteNotice,
  submitRemoteMessage,
  useRemoteThreads,
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
    if (attached.some((file) => !file.file.type.startsWith('image/'))) {
      setRemoteNotice(entry.key, 'Only images can be attached to a thread on another computer.')
      return
    }
    if (!text && attached.length === 0) return
    const images = await filesToImagePayloads(attached.map((file) => file.file))
    setInput('')
    setFiles([])
    void submitRemoteMessage(entry.key, { content: text, images })
  }

  const device = entry.deviceName
  const questions = entry.view?.questions ?? 0
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
