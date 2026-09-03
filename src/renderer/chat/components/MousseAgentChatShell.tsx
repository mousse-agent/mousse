import { createContext, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { UIMessage, ChatStatus } from 'ai'
import { AgentChat } from './agent-elements/agent-chat'
import type { CustomToolRendererProps } from './agent-elements/types'
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
  return <div className="shrink-0">{composer}</div>
}

interface MousseAgentChatShellProps {
  messages: UIMessage[]
  status: ChatStatus
  onSend: (message: { role: 'user'; content: string }) => void
  onStop: () => void
  error?: Error
  toolRenderers?: Record<string, React.ComponentType<CustomToolRendererProps>>
  /** Mousse composer block (ChatComposer + QueuedMessages/modals/pills). */
  composer: ReactNode
}

export function MousseAgentChatShell({
  messages,
  status,
  onSend,
  onStop,
  error,
  toolRenderers,
  composer,
}: MousseAgentChatShellProps) {
  const slots = useMemo(
    () => ({ InputBar: MousseInputBarSlot as never }),
    []
  )
  return (
    <MousseComposerContext.Provider value={composer}>
      <AgentChat
        messages={messages}
        status={status}
        onSend={onSend}
        onStop={onStop}
        error={error}
        toolRenderers={toolRenderers}
        slots={slots}
        showCopyToolbar
        enableImagePreview={false}
      />
    </MousseComposerContext.Provider>
  )
}
