import { useEffect, useMemo, useRef } from 'react'
import type { UIMessage } from 'ai'
import { collectSubagentCalls, joinSubagentCards, type SubagentCardModel } from '../chat/adapters/subagentCards'
import { isTurnActivePhase } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { useSubagents } from './useSubagents'

const NONE: ReadonlyMap<string, SubagentCardModel> = new Map()

/**
 * The subagent cards of `threadId`'s transcript: each call that started a task, joined to what the
 * daemon reports about that task. A card stays once it exists, even if its subagent later drops out
 * of the list (a trashed thread), so a finished card never turns back into a raw row.
 */
export function useSubagentCardModels(threadId: string | null | undefined, messages: readonly UIMessage[]): ReadonlyMap<string, SubagentCardModel> {
  const subagents = useSubagents(threadId)
  const loaded = useAppStore((s) => (threadId ? s.subagentsByParent[threadId] !== undefined : false))
  const turnActive = useAppStore((s) => (threadId ? isTurnActivePhase(s.turnStates[threadId]?.phase ?? 'idle') : false))
  const previous = useRef<ReadonlyMap<string, SubagentCardModel>>(NONE)
  const cards = useMemo(() => {
    const calls = collectSubagentCalls(messages)
    return calls.length === 0 ? NONE : joinSubagentCards(calls, subagents, { loaded, previous: previous.current, turnActive })
  }, [messages, subagents, loaded, turnActive])
  // Remembered once the render is committed, so a render never writes it.
  useEffect(() => {
    previous.current = cards
  }, [cards])
  return cards
}
