import type { EventEmitter } from 'node:events'
import { BOT_LAUNCHED_ENDED_SHOWN, compareLaunched, type BotLaunchedThread } from '../../shared/bots/personal/chat'
import type { RunRecord, ThreadEvent } from '../run/types'
import type { RunEngine } from '../run/RunEngine'
import { subagentDescendantsIn } from '../../shared/threadLineage'
import type { ThreadLineage } from '../../shared/types'

/** What the launched-thread lookup reads of a thread: its title, project, times and the thread that started it. */
export interface LaunchedThreadMeta {
  id: string
  name?: string
  projectId?: string
  createdAt?: string
  updatedAt?: string
  createdByThreadId?: string
  /** `Thread.hidden`: out of the owner's sidebar, so this list is where the owner finds it. */
  hidden?: true
  /** `Thread.settledAt`: set while the thread is archived. An archived thread never goes, whatever runs it left. */
  settledAt?: string
  /** `Thread.lineage`: set on a subagent's thread, naming the thread that started it. */
  lineage?: ThreadLineage
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
 * waits on the owner (a question or approval in it or in a subagent below it, as the sidebar rolls it up); or its own run
 * ended while subagents below it still have runs going (`subagents`); or, with nothing going, it never ran (`idle`) or
 * its last run finished (`done`), failed or was stopped (`compareLaunched`). Those that work come first (oldest first), then those that
 * wait on the owner, then idle ones, then ended ones (most recently updated first); of those not going, at most
 * `BOT_LAUNCHED_ENDED_SHOWN`. `activeRuns`: the profile's runs not ended; `lastRun`: a thread's newest run;
 * `willStart`: whether a queued run is still on its way (`queuedRunWillStart`). A queued run nothing will start (its
 * start already came and went) does not make its thread go, and an archived thread (or subagent) never goes, whatever
 * runs or questions it left: either reads as its last run ended.
 */
export function launchedThreadsOf(input: {
  creators: ReadonlySet<string>
  threads: readonly LaunchedThreadMeta[]
  activeRuns: readonly RunRecord[]
  lastRun(threadId: string): RunRecord | undefined
  asks(threadId: string): boolean
  willStart(run: RunRecord): boolean
  projectName?(projectId: string): string | undefined
}): BotLaunchedThread[] {
  if (!input.creators.size) return []
  const active = new Map<string, RunRecord>()
  for (const run of input.activeRuns) {
    if (active.has(run.threadId) || (run.status === 'queued' && !input.willStart(run))) continue
    active.set(run.threadId, run)
  }
  const mine = input.threads.filter((thread) => thread.createdByThreadId !== undefined && input.creators.has(thread.createdByThreadId))
  const below = subagentDescendantsIn(input.threads)
  // An archived subagent counts for nothing either: its leftovers never keep the thread above it going.
  const archived = new Set(input.threads.filter((thread) => thread.settledAt).map((thread) => thread.id))
  const subagentsAsk = (threadId: string) => below(threadId).some((id) => !archived.has(id) && input.asks(id))
  const subagentsWork = (threadId: string) => below(threadId).some((id) => !archived.has(id) && active.has(id))
  const goes = (thread: LaunchedThreadMeta) => !thread.settledAt && (active.has(thread.id) || input.asks(thread.id) || subagentsWork(thread.id) || subagentsAsk(thread.id))
  const going = mine.filter(goes)
  // Of the rest only the most recently updated are shown: their runs are read, never every thread the bot ever started.
  const goingIds = new Set(going.map((thread) => thread.id))
  const rest = mine.filter((thread) => !goingIds.has(thread.id))
    .sort((a, b) => (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? ''))
    .slice(0, BOT_LAUNCHED_ENDED_SHOWN)
  const launched = [...going, ...rest].map((thread): BotLaunchedThread => {
    const run = thread.settledAt ? undefined : active.get(thread.id)
    const last = run ?? input.lastRun(thread.id)
    const status: BotLaunchedThread['status'] = !goes(thread) ? endedAs(last)
      : input.asks(thread.id) || subagentsAsk(thread.id) ? 'needs_input'
        : run ? (run.status === 'queued' ? 'queued' : run.status === 'paused' ? 'paused' : 'running')
          : 'subagents'
    const created = thread.createdAt ?? last?.requestedAt ?? new Date(0).toISOString()
    const project = thread.projectId ? input.projectName?.(thread.projectId) : undefined
    return {
      threadId: thread.id,
      title: thread.name?.trim() || 'Untitled thread',
      ...(project ? { project } : {}),
      status,
      startedAt: run ? run.startedAt ?? run.requestedAt : created,
      updatedAt: latest(thread.updatedAt, created, last?.requestedAt, last?.startedAt, last?.completedAt) ?? created,
      ...(thread.hidden ? { hidden: true as const } : {})
    }
  })
  return launched.sort(compareLaunched)
}

/**
 * Whether a queued run is still on its way to starting. Only a run whose `turn.start` came and went (every one ended)
 * is not: the stranded case. One with no `turn.start` yet still counts, as `strandedQueuedRuns` reads it: it waits on
 * the message queue (behind a pause, a compaction or another process's lease) or its send has not recorded the effect yet.
 * A queued run that stands in for a remote subagent goes on on another computer.
 */
export function queuedRunWillStart(engine: Pick<RunEngine, 'outbox' | 'remoteSubagents'>, run: Pick<RunRecord, 'runId'>): boolean {
  if (engine.remoteSubagents.getByChildRun(run.runId)) return true
  const starts = engine.outbox.listForRun(run.runId).filter((effect) => effect.kind === 'turn.start')
  return starts.length === 0 || starts.some((effect) => effect.status === 'pending' || effect.status === 'running')
}

/**
 * Calls `changed` with the thread that started a thread when it is made, whenever its run, or a run of a subagent below it, changes status, a question or
 * approval in it opens or closes, or its place in the lists changes (hidden or shown, archived): a bot that started it
 * reads its summary again, so its header goes busy or back to free and its list shows the thread as it is. Threads no
 * thread started are ignored. Returns the unsubscribe. Never throws into the emitters.
 */
export function watchLaunchedThreads(input: {
  /** The run engine (`event`) and the questions service (`pending`, `cleared`). */
  runs: Pick<EventEmitter, 'on' | 'off'>
  questions: Pick<EventEmitter, 'on' | 'off'>
  /** The thread store (`created`, with the thread; `list-changed`, with the thread's id). */
  threads?: Pick<EventEmitter, 'on' | 'off'>
  thread(threadId: string): LaunchedThreadMeta | undefined
  changed(creatorThreadId: string): void
}): () => void {
  // A subagent's change reaches the thread that started the top of its chain: that thread shows it waits on its subagents.
  const touch = (threadId: unknown) => {
    if (typeof threadId !== 'string') return
    try {
      const seen = new Set<string>()
      for (let thread = input.thread(threadId); thread && !seen.has(thread.id); thread = thread.lineage ? input.thread(thread.lineage.parentThreadId) : undefined) {
        seen.add(thread.id)
        if (thread.createdByThreadId) input.changed(thread.createdByThreadId)
      }
    } catch { /* a refresh never fails a run or a question */ }
  }
  const onRun = (event: ThreadEvent) => { if (event.type === 'run.status') touch((event.payload as RunRecord | undefined)?.threadId) }
  const onAsk = (event: { threadId?: unknown }) => touch(event?.threadId)
  const onListed = (change: { id?: unknown } | undefined) => touch(change?.id)
  input.runs.on('event', onRun)
  input.questions.on('pending', onAsk)
  input.questions.on('cleared', onAsk)
  // A thread it just started is listed at once, before its first message runs (or when it has none).
  input.threads?.on('created', onListed)
  input.threads?.on('list-changed', onListed)
  return () => {
    input.runs.off('event', onRun)
    input.questions.off('pending', onAsk)
    input.questions.off('cleared', onAsk)
    input.threads?.off('created', onListed)
    input.threads?.off('list-changed', onListed)
  }
}
