import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { UIMessage, ChatStatus } from 'ai'
import { useAppStore } from '../../stores/appStore'
import { X } from '../../lib/icons'
import { PromptUndoProvider } from '../../components/PromptUndoControls'
import { useSubagentCardModels } from '../../hooks/useSubagentCards'
import { AgentChat } from './agent-elements/agent-chat'
import { watchComposerStackHeight } from './agent-elements/composer-stack-height'
import { WorkspaceRecoveryBanner } from './WorkspaceRecoveryBanner'
import { SubagentCardsContext, SubagentInheritedProviderContext } from './agent-elements/tools/subagent-cards-context'
import { useThreadProviderId } from '../../components/SubagentAvatar'
import type { CustomToolRendererProps } from './agent-elements/types'
import {
  QuickActionApprovalContext,
  type QuickActionApproval,
} from './agent-elements/tools/quick-action-approval'
import { PermissionRequestContext, type PermissionRequestControls } from './agent-elements/tools/permission-request'
import { TurnActionsContext, type TurnActions } from './agent-elements/turn-actions'
import { TurnProgressContext, type TurnProgressState } from './agent-elements/turn-progress'
import { QueuedMessages } from '../../components/QueuedMessages'
import type { ThreadQueue } from '../../hooks/useThreadQueue'
import './agent-elements/agent-ui.css'

/**
 * Provider -> standardize -> render shell.
 *
 * - messages: already standardized via mousseToUIMessages() (ChatMessage -> UIMessage parts)
 * - scheme: shadcn-style AgentChatProps (messages/status/onSend/onStop/toolRenderers/slots)
 * - render: 21st.dev Agent Elements (MessageList + ToolRenderer dispatch inside AgentChat)
 *
 * The composer stays Mousse-owned (ChatComposer: model/mode/skills/voice/browser
 * pills/context ring/questions). It is injected via slots.InputBar so
 * AgentChat owns the MessageList + turn grouping + tool-card dispatch while
 * Mousse keeps every composer feature with zero rewrites.
 */

const MousseComposerContext = createContext<ReactNode>(null)
const NO_PERMISSION_REQUESTS: Readonly<Record<string, PermissionRequestControls>> = {}

// Stable component type — reading the composer from context avoids remounting
// (and losing textarea focus) on every parent render.
function MousseInputBarSlot() {
  const composer = useContext(MousseComposerContext)
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const shell = el?.closest('.mousse-chat-shell')
    if (!el || !(shell instanceof HTMLElement)) return
    return watchComposerStackHeight(el, shell)
  }, [])
  return <div ref={ref} className="chat-composer-stack shrink-0">{composer}</div>
}

/**
 * The last turn of a stopped run; Continue picks the work up again. A run a restart left `uncertain` (SPEC §16.4) may
 * have run tools without a recorded result: Continue names them first, and only a confirm continues the run.
 */
export function RunInterruptedNotice({ onContinue, uncertain, onContinueUncertain }: {
  onContinue?: () => void
  uncertain?: { runId: string; tools: string[] }
  onContinueUncertain?: (runId: string) => void
}) {
  const [confirming, setConfirming] = useState(false)
  // Focus follows the row: Continue anyway when it opens, Continue… again when it is cancelled.
  const confirmRef = useRef<HTMLButtonElement>(null)
  const askRef = useRef<HTMLButtonElement>(null)
  const opened = useRef(false)
  useEffect(() => {
    if (confirming) {
      opened.current = true
      confirmRef.current?.focus()
    } else if (opened.current) askRef.current?.focus()
  }, [confirming])
  const tools = uncertain?.tools.length ? uncertain.tools.join(', ') : 'unknown tools'
  const detail = `May have run without a result: ${tools}. Check before continuing.`
  return <div className="chat-run-interrupted" role="status">
    <span className="chat-run-interrupted-label">
      <X size={12} strokeWidth={1.8} aria-hidden="true" />
      {uncertain && confirming
        ? <>
            <span title={detail}>May have run: {tools}</span>
            {onContinueUncertain && <button ref={confirmRef} type="button" className="chat-run-interrupted-action" onClick={() => { opened.current = false; setConfirming(false); onContinueUncertain(uncertain.runId) }}>Continue anyway</button>}
            <button type="button" className="chat-run-interrupted-action" onClick={() => setConfirming(false)}>Cancel</button>
          </>
        : <>
            <span>Run interrupted</span>
            {uncertain
              ? onContinueUncertain && <button ref={askRef} type="button" className="chat-run-interrupted-action" title={detail} onClick={() => setConfirming(true)}>Continue…</button>
              : onContinue && <button type="button" className="chat-run-interrupted-action" onClick={onContinue}>Continue</button>}
          </>}
    </span>
  </div>
}

/**
 * What the line under a running turn's Working reads: the turn's phase and step, and a Stop on its way. They change
 * all through a reply, so only this provider follows them: the chat it wraps stays as it is, and only what reads the
 * context (the progress line, the turn's end mark) renders.
 */
function TurnProgressProvider({ threadId, children }: { threadId?: string | null; children: ReactNode }) {
  const turnPhase = useAppStore(state => (threadId ? state.turnStates[threadId]?.phase : undefined))
  const turnStep = useAppStore(state => (threadId ? state.turnStates[threadId]?.step : undefined))
  const stopping = useAppStore(state => Boolean(threadId && state.stopRequests[threadId]))
  const turnUpdatedAt = useAppStore(state => (threadId ? state.turnStates[threadId]?.updatedAt : undefined))
  const turnProgress = useMemo<TurnProgressState>(
    () => ({ phase: turnPhase, step: turnStep, stopping, threadId, updatedAt: turnUpdatedAt }),
    [turnPhase, turnStep, stopping, threadId, turnUpdatedAt]
  )
  return <TurnProgressContext.Provider value={turnProgress}>{children}</TurnProgressContext.Provider>
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
  /** Mousse composer block (ChatComposer + notices/modals/pills). */
  composer: ReactNode
  /** Inline quick-action approval bridged to the matching card. Null = generic question UI. */
  quickActionApproval?: QuickActionApproval | null
  /** Waiting permission requests this window can answer inline, by request id. */
  permissionRequests?: Readonly<Record<string, PermissionRequestControls>>
  /** Retry after an error and Continue after a stopped run, on the last turn. */
  turnActions?: TurnActions | null
  /** The thread's queued messages, drawn after the last turn. */
  queue?: ThreadQueue
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
  permissionRequests,
  turnActions,
  queue,
}: MousseAgentChatShellProps) {
  const profileId = useAppStore(state => state.profileId)
  const interrupted = useAppStore(state => Boolean(threadId && state.turnStates[threadId]?.phase === 'stopped'))
  const uncertain = useAppStore(state => (threadId ? state.turnStates[threadId]?.uncertain : undefined))
  const slots = useMemo(
    () => ({ InputBar: MousseInputBarSlot as never }),
    []
  )
  const subagentCards = useSubagentCardModels(threadId, messages)
  const threadProvider = useThreadProviderId(threadId)
  const queued = useMemo(() => (queue ? <QueuedMessages queue={queue} /> : null), [queue])
  // The same element while nothing in it changes, so the last turn does not render again with every delta.
  const continueRun = turnActions && !busy ? turnActions.continueRun : undefined
  const continueUncertain = turnActions && !busy ? turnActions.continueUncertain : undefined
  const lastTurnNotice = useMemo(() => <>
    <WorkspaceRecoveryBanner threadId={threadId} />
    {interrupted ? <RunInterruptedNotice onContinue={continueRun} uncertain={uncertain} onContinueUncertain={continueUncertain} /> : undefined}
  </>, [threadId, interrupted, continueRun, uncertain, continueUncertain])
  return (
    <MousseComposerContext.Provider value={composer}>
      <PromptUndoProvider key={`${profileId}:${threadId ?? ""}`} threadId={threadId} busy={busy} revision={messages}>
      <QuickActionApprovalContext.Provider value={quickActionApproval ?? null}>
      <PermissionRequestContext.Provider value={permissionRequests ?? NO_PERMISSION_REQUESTS}>
      <SubagentCardsContext.Provider value={subagentCards}>
      <SubagentInheritedProviderContext.Provider value={threadProvider}>
      <TurnActionsContext.Provider value={turnActions ?? null}>
      <TurnProgressProvider threadId={threadId}>
        <AgentChat
          className="mousse-chat-shell"
          messages={messages}
          status={status}
          onSend={onSend}
          onStop={onStop}
          error={error}
          toolRenderers={toolRenderers}
          slots={slots}
          lastTurnNotice={lastTurnNotice}
          afterTurns={queued}
          showCopyToolbar
          enableImagePreview
          enableFind
        />
      </TurnProgressProvider>
      </TurnActionsContext.Provider>
      </SubagentInheritedProviderContext.Provider>
      </SubagentCardsContext.Provider>
      </PermissionRequestContext.Provider>
      </QuickActionApprovalContext.Provider>
      </PromptUndoProvider>
    </MousseComposerContext.Provider>
  )
}
