import { useEffect, useMemo, useRef } from 'react'
import type { UIMessage } from 'ai'
import type { SubagentSummary } from '../../shared/subagents'
import { collectSubagentCalls, joinSubagentCards, nameRemovedSubagents, type SubagentCardModel } from '../chat/adapters/subagentCards'
import { collectNativeSubagentCards } from '../chat/adapters/nativeSubagents'
import { isTurnActivePhase } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { useBackgroundLive } from './useNativeSubagents'
import { useSubagents } from './useSubagents'

const NONE: ReadonlyMap<string, SubagentCardModel> = new Map()
const NO_ROWS: SubagentSummary[] = []

/**
 * The subagent cards of `threadId`'s transcript: each call that started a task, joined to what the
 * daemon reports about that task. A subagent whose thread is gone still has its cards, from what the
 * daemon kept of its tasks (`removed`), and a card stays once it exists, so a finished card never
 * turns back into a raw row.
 */
export function useSubagentCardModels(threadId: string | null | undefined, messages: readonly UIMessage[]): ReadonlyMap<string, SubagentCardModel> {
  const live = useSubagents(threadId)
  const removed = useAppStore((s) => (threadId ? s.removedSubagentsByParent[threadId] : undefined) ?? NO_ROWS)
  const loaded = useAppStore((s) => (threadId ? s.subagentsByParent[threadId] !== undefined : false))
  const turnActive = useAppStore((s) => (threadId ? isTurnActivePhase(s.turnStates[threadId]?.phase ?? 'idle') : false))
  // Background agents a settled turn left running are still going while the thread waits on background work.
  const backgroundLive = useBackgroundLive(threadId)
  const previous = useRef<ReadonlyMap<string, SubagentCardModel>>(NONE)
  const cards = useMemo(() => {
    const calls = collectSubagentCalls(messages)
    // A removed subagent has lost its thread's name: the transcript's notices give it back.
    const subagents = removed.length === 0 ? live : [...live, ...nameRemovedSubagents(removed, messages)]
    const joined = calls.length === 0 ? NONE : joinSubagentCards(calls, subagents, { loaded, previous: previous.current, turnActive })
    const native = collectNativeSubagentCards(messages, backgroundLive, turnActive)
    const next = native.size === 0 ? joined : new Map([...joined, ...native])
    // A streamed delta changes no card: the same map keeps every row that reads it from rendering again.
    return sameCards(previous.current, next) ? previous.current : next
  }, [messages, live, removed, loaded, turnActive, backgroundLive])
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
