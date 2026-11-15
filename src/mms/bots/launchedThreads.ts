import type { EventEmitter } from 'node:events'
import { BOT_LAUNCHED_ENDED_SHOWN, compareLaunched, type BotLaunchedThread } from '../../shared/bots/personal/chat'
import type { RunRecord, ThreadEvent } from '../run/types'

/** What the launched-thread lookup reads of a thread: its title, project, times and the thread that started it. */
export interface LaunchedThreadMeta {
  id: string
  name?: string
  projectId?: string
  createdAt?: string
  updatedAt?: string
  createdByThreadId?: string
}

/** How a thread's last run ended, when none runs now: finished, failed, stopped (or cut off), or it never ran. */
function endedAs(run: RunRecord | undefined): BotLaunchedThread['status'] {
  if (!run) return 'idle'
  if (run.status === 'completed') return 'done'
  if (run.status === 'failed') return 'failed'
  return 'stopped'
}

/** The latest of some times (ISO strings), ignoring absent ones. */
function latest(...times: Array<string | null | undefined>): string | undefined {
  return times.filter((time): time is string => Boolean(time)).sort().at(-1)
}

/**
 * Every thread started by any of `creators` (`Thread.createdByThreadId`), hidden ones too: what a bot manages beside
 * its own work, and what it managed. Each says how it stands: its run works, waits its turn, is held (a usage limit), or
 * waits on the owner (a question or approval in it); or, with no run going, it never ran (`idle`) or its last run
 * finished (`done`), failed or was stopped (`compareLaunched`). Those that work come first (oldest first), then those that
 * wait on the owner, then idle ones, then ended ones (most recently updated first); of those not going, at most
 * `BOT_LAUNCHED_ENDED_SHOWN`. `activeRuns`: the profile's runs not ended; `lastRun`: a thread's newest run.
 */
export function launchedThreadsOf(input: {
  creators: ReadonlySet<string>
  threads: readonly LaunchedThreadMeta[]
  activeRuns: readonly RunRecord[]
  lastRun(threadId: string): RunRecord | undefined
  asks(threadId: string): boolean
  projectName?(projectId: string): string | undefined
}): BotLaunchedThread[] {
  if (!input.creators.size) return []
  const active = new Map<string, RunRecord>()
  for (const run of input.activeRuns) if (!active.has(run.threadId)) active.set(run.threadId, run)
  const mine = input.threads.filter((thread) => thread.createdByThreadId !== undefined && input.creators.has(thread.createdByThreadId))
  const going = mine.filter((thread) => active.has(thread.id) || input.asks(thread.id))
  // Of the rest only the most recently updated are shown: their runs are read, never every thread the bot ever started.
  const goingIds = new Set(going.map((thread) => thread.id))
  const rest = mine.filter((thread) => !goingIds.has(thread.id))
    .sort((a, b) => (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? ''))
    .slice(0, BOT_LAUNCHED_ENDED_SHOWN)
  const launched = [...going, ...rest].map((thread): BotLaunchedThread => {
    const run = active.get(thread.id)
    const last = run ?? input.lastRun(thread.id)
    const status: BotLaunchedThread['status'] = input.asks(thread.id) ? 'needs_input'
      : run ? (run.status === 'queued' ? 'queued' : run.status === 'paused' ? 'paused' : 'running')
        : endedAs(last)
    const created = thread.createdAt ?? last?.requestedAt ?? new Date(0).toISOString()
    const project = thread.projectId ? input.projectName?.(thread.projectId) : undefined
    return {
      threadId: thread.id,
      title: thread.name?.trim() || 'Untitled thread',
      ...(project ? { project } : {}),
      status,
      startedAt: run ? run.startedAt ?? run.requestedAt : created,
      updatedAt: latest(thread.updatedAt, created, last?.requestedAt, last?.startedAt, last?.completedAt) ?? created
    }
  })
  return launched.sort(compareLaunched)
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
