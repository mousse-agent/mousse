import { createContext, useContext, useLayoutEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import type { UIMessage, ChatStatus } from 'ai'
import { useAppStore } from '../../stores/appStore'
import { X } from '../../lib/icons'
import { PromptUndoProvider } from '../../components/PromptUndoControls'
import { AgentChat } from './agent-elements/agent-chat'
import type { CustomToolRendererProps } from './agent-elements/types'
import {
  QuickActionApprovalContext,
  type QuickActionApproval,
} from './agent-elements/tools/quick-action-approval'
import './agent-elements/agent-ui.css'

/**
 * Provider -> standardize -> render shell.
 *
 * - messages: already standardized via mousseToUIMessages() (ChatMessage -> UIMessage parts)
 * - scheme: shadcn-style AgentChatProps (messages/status/onSend/onStop/toolRenderers/slots)
 * - render: 21st.dev Agent Elements (MessageList + ToolRenderer dispatch inside AgentChat)
 *
 * The composer stays Mousse-owned (ChatComposer: model/mode/skills/voice/browser
 * pills/context ring/queue/questions). It is injected via slots.InputBar so
 * AgentChat owns the MessageList + turn grouping + tool-card dispatch while
 * Mousse keeps every composer feature with zero rewrites.
 */

const MousseComposerContext = createContext<ReactNode>(null)

// Stable component type — reading the composer from context avoids remounting
// (and losing textarea focus) on every parent render.
function MousseInputBarSlot() {
  const composer = useContext(MousseComposerContext)
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const shell = el?.closest('.mousse-chat-shell')
    if (!el || !(shell instanceof HTMLElement)) return
    const apply = () => {
      shell.style.setProperty('--chat-composer-stack', `${el.offsetHeight}px`)
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(el)
    return () => {
      observer.disconnect()
      shell.style.removeProperty('--chat-composer-stack')
    }
  }, [])
  return <div ref={ref} className="chat-composer-stack shrink-0">{composer}</div>
}

interface MousseAgentChatShellProps {
  threadId?: string | null
  busy?: boolean
  messages: UIMessage[]
  status: ChatStatus
  onSend: (message: { role: 'user'; content: string }) => void
  onStop: () => void
  error?: Error
  toolRenderers?: Record<string, React.ComponentType<CustomToolRendererProps>>
  /** Mousse composer block (ChatComposer + QueuedMessages/modals/pills). */
  composer: ReactNode
  /** Inline quick-action approval bridged to the matching card. Null = generic question UI. */
  quickActionApproval?: QuickActionApproval | null
}

export function MousseAgentChatShell({
  threadId,
  busy = false,
  messages,
  status,
  onSend,
  onStop,
  error,
  toolRenderers,
  composer,
  quickActionApproval,
}: MousseAgentChatShellProps) {
  const profileId = useAppStore(state => state.profileId)
  const interrupted = useAppStore(state => Boolean(threadId && state.turnStates[threadId]?.phase === 'stopped'))
  const slots = useMemo(
    () => ({ InputBar: MousseInputBarSlot as never }),
    []
  )
  return (
    <MousseComposerContext.Provider value={composer}>
      <PromptUndoProvider key={`${profileId}:${threadId ?? ""}`} threadId={threadId} busy={busy} revision={messages}>
      <QuickActionApprovalContext.Provider value={quickActionApproval ?? null}>
        <AgentChat
          className="mousse-chat-shell"
          messages={messages}
          status={status}
          onSend={onSend}
          onStop={onStop}
          error={error}
          toolRenderers={toolRenderers}
          slots={slots}
          lastTurnNotice={interrupted ? <div className="chat-run-interrupted" role="status">
            <span className="chat-run-interrupted-label">
              <X size={12} strokeWidth={1.8} aria-hidden="true" />
              <span>Run interrupted</span>
            </span>
          </div> : undefined}
          showCopyToolbar
          enableImagePreview
        />
      </QuickActionApprovalContext.Provider>
      </PromptUndoProvider>
    </MousseComposerContext.Provider>
  )
}
