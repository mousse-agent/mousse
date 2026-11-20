import { useMemo } from 'react'
import { useAppStore } from '../stores/appStore'
import { ChatWallpaper } from './ChatWallpaper'
import { ChatComposer } from './ChatComposer'
import { MousseAgentChatShell } from '../chat/components/MousseAgentChatShell'
import { mousseToUIMessages } from '../chat/adapters/mousseToUI'
import { CHAT_TOOL_RENDERERS } from './automations/inbox/ChatDraftCard'
import { SecretRequestRow } from './secrets/SecretRequestRow'
import { LOADER_DELAY_MS, useShownAfter } from './ui/DelayedLoader'
import { RefreshCw } from '../lib/icons'
import './warm-chat.css'

const TOOL_RENDERERS = { ...CHAT_TOOL_RENDERERS, secret_request: SecretRequestRow }
const NO_FILES: never[] = []
const noop = (): void => undefined

/**
 * The open thread as this window showed it last time (`showWarmView`), until the workspace is ready and the real chat
 * takes its place. The transcript reads and the composer takes typing (its draft is the thread's own, so the real
 * composer keeps it); Send is held until the window is connected. Nothing here asks the service.
 */
export function WarmChat({ error, onRetry }: { error?: string | null; onRetry?: () => void }) {
  const threadId = useAppStore((s) => s.activeThreadId)
  const messages = useAppStore((s) => s.messages)
  const input = useAppStore((s) => s.composerDrafts[s.activeThreadId ?? '__blank__'] ?? '')
  const sendHeld = useAppStore((s) => s.warmSendThreadId !== null)
  // A start that connects at once shows no line at all.
  const lineShown = useShownAfter(LOADER_DELAY_MS)
  const uiMessages = useMemo(() => mousseToUIMessages(messages), [messages])
  const setInput = (value: string) => useAppStore.getState().setComposerDraft(threadId, value)
  const send = () => {
    if (input.trim() && threadId) useAppStore.getState().holdWarmSend(threadId)
  }

  const line = error
    ? <div className="warm-chat-line" role="alert" title={error}>
        <span>Could not connect to workspace</span>
        <button type="button" className="warm-chat-retry" onClick={onRetry}><RefreshCw size={12} aria-hidden="true" />Retry</button>
      </div>
    : (lineShown || sendHeld) && <div className="warm-chat-line" role="status">{sendHeld ? 'Sends when connected' : 'Connecting…'}</div>

  return (
    <div data-mousse="chat" data-warm-start="" className="chat" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <ChatWallpaper />
      {/* No thread id: the transcript's own readers (workspace recovery, steer, turn progress) wait for the real chat. */}
      <MousseAgentChatShell
        threadId={null}
        messages={uiMessages}
        status="ready"
        toolRenderers={TOOL_RENDERERS}
        onSend={noop}
        onStop={noop}
        composer={(
          <div className="chat-input-area">
            {/* Above the composer's top edge, outside its layout: the composer does not move when the line goes. */}
            {line}
            <ChatComposer
              input={input}
              onInputChange={setInput}
              attachedFiles={NO_FILES}
              onAttachedFilesChange={noop}
              voiceMessages={NO_FILES}
              onVoiceMessagesChange={noop}
              enabledSkills={NO_FILES}
              slashCommands={false}
              disableSkillsPicker
              // No model picker: the thread's model shows once the window is connected, without a placeholder first.
              onSend={send}
              sendBlocked={sendHeld ? 'Sends when connected' : null}
            />
          </div>
        )}
      />
    </div>
  )
}
