import { useMemo, useRef } from 'react'
import { isThreadActivityActive, isTurnActivePhase } from '../../shared/types'
import { nativeSubagentsOfMessages } from '../chat/adapters/nativeSubagents'
import type { SubagentCardModel } from '../chat/adapters/subagentCards'
import { useAppStore } from '../stores/appStore'

const NONE: SubagentCardModel[] = []

/**
 * Whether background agents a turn left running may still be going: a turn is running, or the thread's
 * work cycle has not finished (Working or Waiting). A turn's end reaches the window before the thread's
 * activity turns from Working to Waiting, so Working counts too: only the activity's own end (Done or
 * idle) closes a background row, never the turn's end alone.
 */
export function useBackgroundLive(threadId: string | null | undefined): boolean {
  const turnActive = useAppStore((s) => (threadId ? isTurnActivePhase(s.turnStates[threadId]?.phase ?? 'idle') : false))
  const working = useAppStore((s) => (threadId ? isThreadActivityActive(s.threadActivity[threadId]) : false))
  return turnActive || working
}

/**
 * The subagents the open thread's runtime started with its own tool (Claude Code's `Agent`), read from
 * its loaded transcript. Empty for a thread that is not the open one: only that one's messages are loaded.
 */
export function useNativeSubagents(threadId: string | null | undefined): SubagentCardModel[] {
  const messages = useAppStore((s) => (threadId && s.activeThreadId === threadId ? s.messages : undefined))
  const turnActive = useAppStore((s) => (threadId ? isTurnActivePhase(s.turnStates[threadId]?.phase ?? 'idle') : false))
  const backgroundLive = useBackgroundLive(threadId)
  // A streamed reply changes the messages on every delta but rarely a subagent: the same list keeps Lineage from rendering again.
  const previous = useRef<SubagentCardModel[]>(NONE)
  return useMemo(() => {
    const rows = messages?.length ? nativeSubagentsOfMessages(messages, backgroundLive, turnActive) : NONE
    const next = rows.length ? rows : NONE
    if (JSON.stringify(next) === JSON.stringify(previous.current)) return previous.current
    previous.current = next
    return next
  }, [messages, backgroundLive, turnActive])
}
