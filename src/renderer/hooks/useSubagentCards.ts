import { useEffect, useMemo, useRef } from 'react'
import type { UIMessage } from 'ai'
import { collectSubagentCalls, joinSubagentCards, type SubagentCardModel } from '../chat/adapters/subagentCards'
import { collectNativeSubagentCards } from '../chat/adapters/nativeSubagents'
import { isTurnActivePhase } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { useBackgroundLive } from './useNativeSubagents'
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
  // Background agents a settled turn left running are still going while the thread waits on background work.
  const backgroundLive = useBackgroundLive(threadId)
  const previous = useRef<ReadonlyMap<string, SubagentCardModel>>(NONE)
  const cards = useMemo(() => {
    const calls = collectSubagentCalls(messages)
    const joined = calls.length === 0 ? NONE : joinSubagentCards(calls, subagents, { loaded, previous: previous.current, turnActive })
    const native = collectNativeSubagentCards(messages, backgroundLive, turnActive)
    const next = native.size === 0 ? joined : new Map([...joined, ...native])
    // A streamed delta changes no card: the same map keeps every row that reads it from rendering again.
    return sameCards(previous.current, next) ? previous.current : next
  }, [messages, subagents, loaded, turnActive, backgroundLive])
  // Remembered once the render is committed, so a render never writes it.
  useEffect(() => {
    previous.current = cards
  }, [cards])
  return cards
}

function sameCards(a: ReadonlyMap<string, SubagentCardModel>, b: ReadonlyMap<string, SubagentCardModel>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [key, card] of b) {
    const before = a.get(key)
    if (!before) return false
    if (before !== card && JSON.stringify(before) !== JSON.stringify(card)) return false
  }
  return true
}
