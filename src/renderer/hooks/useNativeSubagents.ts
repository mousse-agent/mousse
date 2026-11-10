import { useMemo, useRef } from 'react'
import { isTurnActivePhase } from '../../shared/types'
import { nativeSubagentsOfMessages } from '../chat/adapters/nativeSubagents'
import type { SubagentCardModel } from '../chat/adapters/subagentCards'
import { useAppStore } from '../stores/appStore'

const NONE: SubagentCardModel[] = []

/**
 * The subagents the open thread's runtime started with its own tool (Claude Code's `Agent`), read from
 * its loaded transcript. Empty for a thread that is not the open one: only that one's messages are loaded.
 */
export function useNativeSubagents(threadId: string | null | undefined): SubagentCardModel[] {
  const messages = useAppStore((s) => (threadId && s.activeThreadId === threadId ? s.messages : undefined))
  const turnActive = useAppStore((s) => (threadId ? isTurnActivePhase(s.turnStates[threadId]?.phase ?? 'idle') : false))
  const waiting = useAppStore((s) => (threadId ? s.threadActivity[threadId] === 'waiting' : false))
  const backgroundLive = turnActive || waiting
  // A streamed reply changes the messages on every delta but rarely a subagent: the same list keeps Lineage from rendering again.
  const previous = useRef<SubagentCardModel[]>(NONE)
  return useMemo(() => {
    const rows = messages?.length ? nativeSubagentsOfMessages(messages, backgroundLive) : NONE
    const next = rows.length ? rows : NONE
    if (JSON.stringify(next) === JSON.stringify(previous.current)) return previous.current
    previous.current = next
    return next
  }, [messages, backgroundLive])
}
