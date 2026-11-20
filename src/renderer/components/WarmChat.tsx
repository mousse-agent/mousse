import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { ChatWallpaper } from './ChatWallpaper'
import { ChatComposer } from './ChatComposer'
import { AmbientGlow } from './AmbientGlow'
import { EmptyThreadHeading } from './EmptyThreadHeading'
import { EmptyThreadAddProject, offersAddProject } from './EmptyThreadAddProject'
import { ComposerProjectPicker, ComposerThreadSettings } from './ComposerWorkspaceToolbar'
import { MousseAgentChatShell } from '../chat/components/MousseAgentChatShell'
import { mousseToUIMessages } from '../chat/adapters/mousseToUI'
import { CHAT_TOOL_RENDERERS } from './automations/inbox/ChatDraftCard'
import { SecretRequestRow } from './secrets/SecretRequestRow'
import { LOADER_DELAY_MS, useShownAfter } from './ui/DelayedLoader'
import { RefreshCw } from '../lib/icons'
import { composerWorkspaceFor, isNewEmptyThread } from '../lib/newThread'
import { localProjectsOf } from '../hooks/useLocalProjects'
import { emptyThreadHeadline } from '../utils/emptyThreadHeadline'
import { noteWarmEmptyView, noteWarmScroll, readWarmScroll } from '../lib/warmHandover'
import './warm-chat.css'

const TOOL_RENDERERS = { ...CHAT_TOOL_RENDERERS, secret_request: SecretRequestRow }
const NO_FILES: never[] = []
const noop = (): void => undefined
const noopAsync = async (): Promise<undefined> => undefined

/**
 * The open thread as this window showed it last time (`showWarmView`), until the workspace is ready and the real chat
 * takes its place. The transcript reads and the composer takes typing (its draft is the thread's own, so the real
 * composer keeps it); Send is held until the window is connected. Nothing here asks the service.
 *
 * It looks as the real chat will: a new chat shows the same greeting, glow, project and settings rows around the
 * composer (shown, not usable, until connected), and the real chat carries on from where this one was scrolled and
 * where its glow was (`warmHandover`).
 */
export function WarmChat({ error, onRetry }: { error?: string | null; onRetry?: () => void }) {
  const threadId = useAppStore((s) => s.activeThreadId)
  const messages = useAppStore((s) => s.messages)
  const activeThread = useAppStore((s) => s.threads.find((thread) => thread.id === s.activeThreadId))
  const projects = useAppStore((s) => s.projects)
  const workspaceDraft = useAppStore((s) => s.composerWorkspaceDrafts[s.activeThreadId ?? '__blank__'])
  const newChatAnimations = useAppStore((s) => s.newChatAnimations)
  const input = useAppStore((s) => s.composerDrafts[s.activeThreadId ?? '__blank__'] ?? '')
  const sendHeld = useAppStore((s) => s.warmSendThreadId !== null)
  // A start that connects at once shows no line at all.
  const lineShown = useShownAfter(LOADER_DELAY_MS)
  const uiMessages = useMemo(() => mousseToUIMessages(messages), [messages])
  const setInput = (value: string) => useAppStore.getState().setComposerDraft(threadId, value)
  const send = () => {
    if (input.trim() && threadId) useAppStore.getState().holdWarmSend(threadId)
  }

  // As the real chat decides it (OrchestratorChat's `emptyThread` and `newChat`): a thread not started yet, or none.
  const threadKey = threadId ?? '__blank__'
  const newChat = messages.length === 0 && isNewEmptyThread(threadId, activeThread, 0)
  const workspace = composerWorkspaceFor(workspaceDraft, activeThread, projects)
  const toolbarProjects = useMemo(() => localProjectsOf(projects), [projects])
  const headline = useMemo(() => emptyThreadHeadline(new Date(), threadKey), [threadKey])
  // When this empty chat's glow started: the real chat's glow carries on from it.
  const [glowSince] = useState(() => (newChat ? noteWarmEmptyView(threadKey) : undefined))

  // Where the transcript is read, kept as it scrolls: the real one opens at the same place.
  const rootRef = useRef<HTMLDivElement>(null)
  // The composer has focus from the start, as the real chat gives it when nothing else has it: the caret and the
  // composer's size do not change at the handover.
  useEffect(() => {
    if (document.activeElement === document.body) rootRef.current?.querySelector<HTMLElement>('.composer-input')?.focus()
  }, [])
  useEffect(() => {
    const root = rootRef.current
    if (!root || !threadId) return
    const note = () => {
      const list = root.querySelector<HTMLElement>('.an-message-list')
      if (list) noteWarmScroll(readWarmScroll(threadId, list))
    }
    note()
    // Scroll events do not bubble: the transcript's are caught on their way down.
    root.addEventListener('scroll', note, { capture: true, passive: true })
    return () => root.removeEventListener('scroll', note, { capture: true })
  }, [threadId])

  const line = error
    ? <div className="warm-chat-line" role="alert" title={error}>
        <span>Could not connect to workspace</span>
        <button type="button" className="warm-chat-retry" onClick={onRetry}><RefreshCw size={12} aria-hidden="true" />Retry</button>
      </div>
    : (lineShown || sendHeld) && <div className="warm-chat-line" role="status">{sendHeld ? 'Sends when connected' : 'Connecting…'}</div>

  return (
    <div ref={rootRef} data-mousse="chat" data-warm-start="" className={`chat${newChat ? ' chat--empty' : ''}`} data-new-chat-motion={newChat && !newChatAnimations ? 'off' : undefined} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <ChatWallpaper />
      {newChat && newChatAnimations && <AmbientGlow since={glowSince} />}
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
            {newChat && <EmptyThreadHeading headline={headline} animate={newChatAnimations} />}
            {/* Shown as the real chat shows them, not usable until connected; their Git and computer reads wait for it. */}
            {newChat && <div inert style={{ display: 'contents' }}>
              <ComposerProjectPicker projects={toolbarProjects} workspace={workspace} disabled={false} onChange={noop} onOpenProject={noopAsync} onError={noop} />
            </div>}
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
            {newChat && <div inert style={{ display: 'contents' }}>
              <ComposerThreadSettings workspace={workspace} disabled={false} readsGit={false} onChange={noop} onPrivateChange={noop} onExpiryChange={noop} />
              {offersAddProject(projects.length, workspace.node) && <EmptyThreadAddProject onAdd={noop} />}
            </div>}
          </div>
        )}
      />
    </div>
  )
}
