import type { EventEmitter } from 'node:events'
import type { BotLaunchedThread } from '../../shared/bots/personal/chat'
import type { RunRecord, ThreadEvent } from '../run/types'

/** What the launched-thread lookup reads of a thread: its title and the thread that started it. */
export interface LaunchedThreadMeta {
  name?: string
  createdByThreadId?: string
}

/**
 * The threads started by any of `creators` (`Thread.createdByThreadId`) whose run has not ended, hidden ones too,
 * oldest first: what a bot manages beside its own work. Each says whether it works, waits its turn, is held (a usage
 * limit) or asks the owner (a question or approval waits in it). `runs`: the profile's runs not ended.
 */
export function launchedThreadsOf(input: {
  creators: ReadonlySet<string>
  runs: readonly RunRecord[]
  thread(threadId: string): LaunchedThreadMeta | undefined
  asks(threadId: string): boolean
}): BotLaunchedThread[] {
  if (!input.creators.size) return []
  const runs = new Map<string, RunRecord>()
  for (const run of input.runs) if (!runs.has(run.threadId)) runs.set(run.threadId, run)
  const launched: BotLaunchedThread[] = []
  for (const [threadId, run] of runs) {
    const thread = input.thread(threadId)
    if (!thread?.createdByThreadId || !input.creators.has(thread.createdByThreadId)) continue
    const status = input.asks(threadId) ? 'needs_input' as const : run.status === 'queued' ? 'queued' as const : run.status === 'paused' ? 'paused' as const : 'running' as const
    launched.push({ threadId, title: thread.name?.trim() || 'Untitled thread', status, startedAt: run.startedAt ?? run.requestedAt })
  }
  return launched.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.threadId.localeCompare(b.threadId))
}

/**
 * Calls `changed` with the thread that started a thread whenever that thread's run changes status, or a question or
 * approval in it opens or closes: a bot that started it reads its summary again, so its header goes busy or back to
 * free. Threads no thread started are ignored. Returns the unsubscribe. Never throws into the emitters.
 */
export function watchLaunchedThreads(input: {
  /** The run engine (`event`) and the questions service (`pending`, `cleared`). */
  runs: Pick<EventEmitter, 'on' | 'off'>
  questions: Pick<EventEmitter, 'on' | 'off'>
  thread(threadId: string): LaunchedThreadMeta | undefined
  changed(creatorThreadId: string): void
}): () => void {
  const touch = (threadId: unknown) => {
    if (typeof threadId !== 'string') return
    try {
      const creator = input.thread(threadId)?.createdByThreadId
      if (creator) input.changed(creator)
    } catch { /* a refresh never fails a run or a question */ }
  }
  const onRun = (event: ThreadEvent) => { if (event.type === 'run.status') touch((event.payload as RunRecord | undefined)?.threadId) }
  const onAsk = (event: { threadId?: unknown }) => touch(event?.threadId)
  input.runs.on('event', onRun)
  input.questions.on('pending', onAsk)
  input.questions.on('cleared', onAsk)
  return () => {
    input.runs.off('event', onRun)
    input.questions.off('pending', onAsk)
    input.questions.off('cleared', onAsk)
  }
}
