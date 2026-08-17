import type { TurnPhase } from '../../shared/types'

export const isResponseActive = (phase: TurnPhase) =>
  (['queued', 'thinking', 'streaming', 'tool_running', 'finalizing'] as TurnPhase[]).includes(phase)

export const showPreThinking = (phase: TurnPhase, hasThinking: boolean) =>
  phase === 'queued' || (phase === 'thinking' && !hasThinking)

export const isStreamingMessage = (phase: TurnPhase, msgId: string, activeId?: string) =>
  phase === 'streaming' && msgId === activeId

export const isAwaitingInput = (phase: TurnPhase) => phase === 'awaiting_input'

export const toActivity = (phase: TurnPhase) =>
  isAwaitingInput(phase) ? 'awaiting_input' : isResponseActive(phase) ? 'processing' : phase === 'completed' ? 'completed' : 'idle'

export const selectTurnPhase = (snapshot: Record<string, any>, threadId: string | null) =>
  threadId ? (snapshot[threadId]?.phase ?? 'idle') : 'idle'
