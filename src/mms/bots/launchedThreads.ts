import type { EventEmitter } from 'node:events'
import { BOT_LAUNCHED_ENDED_SHOWN, compareLaunched, launchedGoing, type BotLaunchedThread } from '../../shared/bots/personal/chat'
import type { EffectRecord, RunRecord, ThreadEvent } from '../run/types'
import type { RunEngine } from '../run/RunEngine'
import { subagentDescendantsIn } from '../../shared/threadLineage'
import { listPendingQueue } from '../queue/ThreadMessageQueue'
import type { ChatMessage, PendingUserQuestions, QueuedMessage, Thread, ThreadActivitySnapshot, ThreadActivityState, ThreadLineage } from '../../shared/types'
import { withoutStandingRules } from '../orchestrator/UserQuestionService'
import type { BotThreadAsk } from '../../shared/bots/personal/jobs'
import { jobResultOf, type JobThreadView } from './jobs'
import type { RemoteListsPort } from '../protocol/remoteListsPort'

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
  /** `Thread.archivedAt`: set while the thread is archived. An archived thread never goes, whatever runs it left. */
  archivedAt?: string
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
 * How a run that has not ended stands, for the threads a bot started (`runStanding`):
 * - `goes`: it works, or something moves it on by itself: a usage-limit pause whose timer resumes it, or a Resume now on
 *   its way; a queued run whose `turn.start` waits or runs, or one that stands in for a remote subagent.
 * - `waits`: a queued run with no `turn.start` yet: it waits in the message queue, behind a turn, a pause, a compaction
 *   or another process's lease, or its send has not recorded the effect yet. It goes once what is ahead of it does.
 * - `held`: only a person moves it on: a pause with no timer (automatic resume is off, or the timer was dropped as
 *   stale) and no Resume now on its way; a queued run whose message a Stop held (Send now); or a queue that stopped at
 *   a message whose turn could not start (a thread waiting on workspace recovery refuses it, and the drain gives the
 *   message back and tries no more): that message's run, and every run waiting behind it.
 * - `never`: a queued run whose `turn.start` came and went (every one ended) and whose message is not waiting in the
 *   queue: nothing will start it.
 */
export type RunStanding = 'goes' | 'waits' | 'held' | 'never'

/**
 * Every thread started by any of `creators` (`Thread.createdByThreadId`), hidden ones too: what a bot manages beside
 * its own work, and what it managed. Each says how it stands: its run works, waits its turn, is held (a usage limit it
 * resumes from by itself), or waits on the owner (a question or approval in it or in a subagent below it, as the sidebar
 * rolls it up); or its own run ended while subagents below it still have runs going (`subagents`); or nothing in it or
 * below it moves until a person continues it (`on_hold`, `RunStanding` `held`): a pause only Resume now ends, messages
 * a Stop held, or a queue stopped at a message whose turn could not start (workspace recovery); or, with nothing going, it never ran (`idle`) or its last run finished (`done`), failed or was stopped
 * (`compareLaunched`). Those that work come first (oldest first), then those that wait on the owner (on hold too), then
 * idle ones, then ended ones (most recently updated first); of those not going, at most `BOT_LAUNCHED_ENDED_SHOWN`, and
 * with `doneSince` (the bot's "Recent" list) only those not archived and updated at or after it (`BOT_LAUNCHED_RECENT_MS`).
 * `activeRuns`: the profile's runs not ended; `lastRun`: a thread's newest run; `standing`: how a run of a thread the bot
 * started, or of a subagent below one, stands (`runStanding`). A run nothing will start does not make its thread go, a
 * run waiting in the queue behind a run only a person moves on is on hold with it, and an archived thread (or subagent)
 * never goes, whatever runs or questions it left: either reads as its last run ended. A thread on hold lists with what
 * waits on the owner but never keeps the bot busy (`launchedActive`).
 */
export function launchedThreadsOf(input: {
  creators: ReadonlySet<string>
  threads: readonly LaunchedThreadMeta[]
  activeRuns: readonly RunRecord[]
  lastRun(threadId: string): RunRecord | undefined
  asks(threadId: string): boolean
  standing(run: RunRecord): RunStanding
  projectName?(projectId: string): string | undefined
  /** An ISO time: of the threads not going, only those not archived and updated since then are listed. Absent: every one. */
  doneSince?: string
}): BotLaunchedThread[] {
  if (!input.creators.size) return []
  const mine = input.threads.filter((thread) => thread.createdByThreadId !== undefined && input.creators.has(thread.createdByThreadId))
  const below = subagentDescendantsIn(input.threads)
  // Only runs of these threads and the subagents below them are looked at, never every run of the profile.
  const relevant = new Set(mine.flatMap((thread) => [thread.id, ...below(thread.id)]))
  // Per thread, its first run (by ordinal) that goes on by itself, and its first that only a person moves on.
  const active = new Map<string, RunRecord>()
  const held = new Map<string, RunRecord>()
  const waiting = new Map<string, RunRecord>()
  for (const run of input.activeRuns) {
    if (!relevant.has(run.threadId)) continue
    const standing = input.standing(run)
    const into = standing === 'goes' ? active : standing === 'held' ? held : standing === 'waits' ? waiting : undefined
    if (into && !into.has(run.threadId)) into.set(run.threadId, run)
  }
  // A run waiting in the queue goes once what is ahead of it does: behind a run only a person moves on, it waits for them too.
  for (const [threadId, run] of waiting) if (!active.has(threadId) && !held.has(threadId)) active.set(threadId, run)
  // An archived subagent counts for nothing either: its leftovers never keep the thread above it going.
  const archived = new Set(input.threads.filter((thread) => thread.archivedAt).map((thread) => thread.id))
  const subagentsAsk = (threadId: string) => below(threadId).some((id) => !archived.has(id) && input.asks(id))
  const subagentsWork = (threadId: string) => below(threadId).some((id) => !archived.has(id) && active.has(id))
  const subagentsHeld = (threadId: string) => below(threadId).some((id) => !archived.has(id) && held.has(id))
  const asks = (thread: LaunchedThreadMeta) => input.asks(thread.id) || subagentsAsk(thread.id)
  const works = (thread: LaunchedThreadMeta) => active.has(thread.id) || subagentsWork(thread.id)
  const onHold = (thread: LaunchedThreadMeta) => held.has(thread.id) || subagentsHeld(thread.id)
  const goes = (thread: LaunchedThreadMeta) => !thread.archivedAt && (works(thread) || asks(thread) || onHold(thread))
  const going = mine.filter(goes)
  // Of the rest only the most recently updated are shown: their runs are read, never every thread the bot ever started.
  const goingIds = new Set(going.map((thread) => thread.id))
  const since = input.doneSince
  const done = (thread: LaunchedThreadMeta) => since === undefined || (!thread.archivedAt && (thread.updatedAt ?? thread.createdAt ?? '') >= since)
  const rest = mine.filter((thread) => !goingIds.has(thread.id) && done(thread))
    .sort((a, b) => (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? ''))
    .slice(0, BOT_LAUNCHED_ENDED_SHOWN)
  const launched = [...going, ...rest].map((thread): BotLaunchedThread => {
    const working = thread.archivedAt ? undefined : active.get(thread.id)
    const run = working ?? (thread.archivedAt ? undefined : held.get(thread.id))
    const last = run ?? input.lastRun(thread.id)
    const status: BotLaunchedThread['status'] = !goes(thread) ? endedAs(last)
      : asks(thread) ? 'needs_input'
        : working ? (working.status === 'queued' ? 'queued' : working.status === 'paused' ? 'paused' : 'running')
          : subagentsWork(thread.id) ? 'subagents'
            : 'on_hold'
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
 * How a run that has not ended stands (`RunStanding`), read from the Run Engine and, only for a run that may wait on a
 * person, the thread's message queue (`queue`, a read of its saved queue; one that cannot be read holds nothing).
 * A paused run goes when its pause ends by itself (automatic resume on, and the timer not dropped as stale) or a resume
 * is on its way (its `run.resume` waits or runs, or the continue message it queued is still in the queue); otherwise only
 * Resume now ends it. A queued run whose every `turn.start` ended is never started, unless its message is back in the
 * queue: the turn could not start and the queue stopped there, for a person. One with no `turn.start` yet waits in the
 * queue, unless a Stop held its message there (`QueuedMessage.heldAfterStop`) or it waits behind a message whose turn
 * could not start. A queued run that stands in for a remote subagent goes on on another computer.
 */
export function runStanding(
  engine: Pick<RunEngine, 'outbox' | 'remoteSubagents'>,
  run: RunRecord,
  queue: (threadId: string) => readonly QueuedMessage[]
): RunStanding {
  if (run.status === 'paused') return pauseEndsByItself(engine, run, queue) ? 'goes' : 'held'
  if (run.status !== 'queued') return 'goes'
  if (engine.remoteSubagents.getByChildRun(run.runId)) return 'goes'
  const started = startOf(engine, run.runId)
  if (started === 'on_its_way') return 'goes'
  // The person's messages waiting in the queue, in the order they run.
  const waiting = listPendingQueue([...queue(run.threadId)]).filter((item) => item.intent === 'normal' && item.state === 'pending')
  const own = waiting.findIndex((item) => item.runId === run.runId)
  if (started === 'ended') return own >= 0 ? 'held' : 'never'
  if (waiting[own]?.heldAfterStop) return 'held'
  const ahead = own >= 0 ? waiting.slice(0, own) : waiting
  return ahead.some((item) => item.runId !== undefined && startOf(engine, item.runId) === 'ended') ? 'held' : 'waits'
}

/** Where a run's `turn.start` stands: none yet, one waits or runs, or every one it had ended. */
function startOf(engine: Pick<RunEngine, 'outbox'>, runId: string): 'none' | 'on_its_way' | 'ended' {
  const starts = engine.outbox.listForRun(runId).filter((effect) => effect.kind === 'turn.start')
  if (!starts.length) return 'none'
  return starts.some((effect) => effect.status === 'pending' || effect.status === 'running') ? 'on_its_way' : 'ended'
}

/** Whether a paused run continues without a person: its timer resumes it, or a resume (a person's or the timer's) is under way. */
function pauseEndsByItself(engine: Pick<RunEngine, 'outbox'>, run: RunRecord, queue: (threadId: string) => readonly QueuedMessage[]): boolean {
  const pause = run.outcome?.pause
  if (!pause || (pause.autoResume && !pause.stale)) return true
  if (engine.outbox.listForRun(run.runId).some((effect) => effect.kind === 'run.resume' && (effect.status === 'pending' || effect.status === 'running'))) return true
  const item = pause.resumeItemId
  return item !== undefined && queue(run.threadId).some((queued) => queued.id === item && (queued.state === 'pending' || queued.state === 'claimed'))
}

/**
 * The threads `creators` started, as the service lists them for a bot: read from the profile's threads, Run Engine and
 * questions, each queue read at most once and only for a run that may wait on a person (`runStanding`).
 */
export function launchedThreadsIn(profile: {
  threads: { listAllThreads(): readonly LaunchedThreadMeta[]; loadMessageQueue(threadId: string): QueuedMessage[] }
  engine: Pick<RunEngine, 'store' | 'outbox' | 'remoteSubagents'>
  asks(threadId: string): boolean
  projectName?(projectId: string): string | undefined
}, creators: ReadonlySet<string>, options: { doneSince?: string } = {}): BotLaunchedThread[] {
  if (!creators.size) return []
  const queues = new Map<string, readonly QueuedMessage[]>()
  const queue = (threadId: string): readonly QueuedMessage[] => {
    let items = queues.get(threadId)
    if (!items) {
      try {
        items = profile.threads.loadMessageQueue(threadId)
      } catch {
        // A queue that cannot be read holds nothing: its runs read as waiting in it, as they did before it was read.
        items = []
      }
      queues.set(threadId, items)
    }
    return items
  }
  return launchedThreadsOf({
    creators,
    threads: profile.threads.listAllThreads(),
    activeRuns: profile.engine.store.listNonTerminalRuns(),
    lastRun: (id) => profile.engine.store.listRuns(id, { limit: 1 })[0],
    asks: profile.asks,
    standing: (run) => runStanding(profile.engine, run, queue),
    ...(profile.projectName ? { projectName: profile.projectName } : {}),
    ...(options.doneSince ? { doneSince: options.doneSince } : {})
  })
}

/** How a thread of another computer stands by its status in the merged lists (`ThreadActivityState`). */
function remoteStatus(state: ThreadActivityState | undefined, row: Pick<Thread, 'offline' | 'notShared'>): BotLaunchedThread['status'] {
  switch (state) {
    case 'processing': return 'running'
    // Its turn ended, but its subagents or background work still report back to it.
    case 'waiting': return 'subagents'
    case 'awaiting_input': return 'needs_input'
    case 'paused': return 'paused'
    case 'completed': return 'done'
    // Not working there; while that computer cannot be reached nothing is known of how its last turn went.
    default: return row.offline || row.notShared ? 'idle' : 'done'
  }
}

/**
 * The threads `creators` started on the user's other computers (`thread_create` with `computer`), as the bot's list
 * shows them beside its threads here: the rows of the merged lists a bot started from this computer (`startedByBot`,
 * set by the lists from `startedFrom.agent`, never on a remote subagent) whose launcher is one of `creators`, each
 * standing by its status there (`activity`, by qualified id). Subagents and, with `doneSince`, archived rows and rows
 * not going that were not updated since then, are left out. Its project names the computer: "app on AEONIX".
 */
export function remoteLaunchedThreadsOf(input: {
  creators: ReadonlySet<string>
  rows: readonly Thread[]
  activity: ThreadActivitySnapshot
  computerName?(node: string): string | undefined
  projectName?(projectId: string): string | undefined
  doneSince?: string
}): BotLaunchedThread[] {
  if (!input.creators.size) return []
  const out: BotLaunchedThread[] = []
  for (const row of input.rows) {
    const launcher = row.startedByBot ? row.startedFrom?.agent?.thread : undefined
    if (!row.node || row.lineage || !launcher || !input.creators.has(launcher)) continue
    const status = row.archivedAt ? remoteStatus(undefined, row) : remoteStatus(input.activity[row.id], row)
    const updatedAt = latest(row.updatedAt, row.createdAt) ?? new Date(0).toISOString()
    const going = launchedGoing({ status })
    if (!going && input.doneSince !== undefined && (row.archivedAt || updatedAt < input.doneSince)) continue
    const project = row.projectId ? input.projectName?.(row.projectId) : undefined
    const computer = input.computerName?.(row.node)
    const where = project && computer ? `${project} on ${computer}` : project ?? (computer ? `on ${computer}` : undefined)
    out.push({
      threadId: row.id,
      title: row.name?.trim() || 'Untitled thread',
      ...(where ? { project: where } : {}),
      status,
      startedAt: row.startedAt || row.createdAt || updatedAt,
      updatedAt,
      // Out of the sidebar there and here (`Thread.hidden`, from that computer's lists): "Hidden", as for its threads here.
      ...(row.hidden ? { hidden: true as const } : {})
    })
  }
  return out
}

/**
 * The bot's threads here and on other computers in one list (`compareLaunched`), at most `BOT_LAUNCHED_ENDED_SHOWN` of
 * those not going, as `launchedThreadsOf` keeps.
 */
export function withRemoteLaunched(local: readonly BotLaunchedThread[], remote: readonly BotLaunchedThread[]): BotLaunchedThread[] {
  if (!remote.length) return [...local]
  const all = [...local, ...remote].sort(compareLaunched)
  let ended = 0
  return all.filter((thread) => launchedGoing(thread) || ++ended <= BOT_LAUNCHED_ENDED_SHOWN)
}

/**
 * The bot's list as its summary carries it: `local`, its threads here (`launchedThreadsIn`), with those it started on the
 * user's other computers read from the merged lists (`lists`, absent while Bridge is off). The other computers' rows never
 * fail the list: a read that throws leaves only the threads here.
 */
export function launchedHereAndThere(local: readonly BotLaunchedThread[], lists: Pick<RemoteListsPort, 'threads' | 'projects' | 'activity' | 'computerName'> | undefined, creators: ReadonlySet<string>, options: {
  doneSince?: string
  /** This computer's project names, for a row that names one of them. */
  projectName?(projectId: string): string | undefined
} = {}): BotLaunchedThread[] {
  if (!lists || !creators.size) return [...local]
  try {
    const projects = new Map(lists.projects().map((project) => [project.id, project.name]))
    return withRemoteLaunched(local, remoteLaunchedThreadsOf({
      creators,
      rows: lists.threads(),
      activity: lists.activity(),
      computerName: (node) => lists.computerName?.(node),
      projectName: (id) => projects.get(id) ?? options.projectName?.(id),
      ...(options.doneSince ? { doneSince: options.doneSince } : {})
    }))
  } catch {
    return [...local]
  }
}

/** A request the thread waits on, as its job view lists it: an approval without the "Always" option, which is the owner's. */
function threadAsk(pending: PendingUserQuestions): BotThreadAsk {
  const entry = withoutStandingRules(pending)
  return {
    requestId: entry.requestId,
    approval: entry.approval !== undefined,
    questions: entry.questions.map((question) => ({ id: question.id, text: question.prompt, options: question.options.map((option) => ({ id: option.id, label: option.label })) }))
  }
}

/**
 * One thread a bot handed a job to, as the ledger reads it (`JobThreadView`): how it stands, by the same rules as the
 * bot's list (`launchedThreadsOf`, its subagents rolled up), its title, its last run's answer (`result`) once its turn
 * ended, and what it waits on (`asks`). `gone` when the thread no longer exists (deleted, or in the trash: `trashed`).
 */
export function jobThreadIn(profile: Parameters<typeof launchedThreadsIn>[0] & {
  trashed?(threadId: string): boolean
  /** What a run kept as its result (`readRunResultText`), when it kept one. */
  recorded?(threadId: string, runId: string): string | undefined
  /** The thread's transcript, for the reply its last run ended on (`jobResultOf`). */
  messages?(threadId: string): readonly ChatMessage[]
  /** The thread's own requests it waits on (not its subagents'): `UserQuestionService.listPendingForThread`. */
  pending?(threadId: string): ReadonlyArray<PendingUserQuestions & { threadId: string }>
}, threadId: string): JobThreadView {
  const all = profile.threads.listAllThreads()
  const thread = all.find((candidate) => candidate.id === threadId)
  if (!thread || profile.trashed?.(threadId)) return { status: 'gone' }
  const title = thread.name?.trim() || undefined
  // Only the thread and the subagents below it are read: the lookup never lists every thread its creator started.
  const creator = thread.createdByThreadId ?? `job:${threadId}`
  const own = { ...thread, createdByThreadId: creator }
  const below = all.filter((candidate) => candidate.lineage?.rootThreadId === threadId)
  const listed = launchedThreadsIn({ ...profile, threads: { listAllThreads: () => [own, ...below], loadMessageQueue: (id) => profile.threads.loadMessageQueue(id) } }, new Set([creator]))[0]
  if (!listed) return { status: 'idle', ...(title ? { title } : {}) }
  const ended = listed.status === 'done' || listed.status === 'failed' || listed.status === 'stopped'
  const run = ended ? profile.engine.store.listRuns(threadId, { limit: 1 })[0] : undefined
  // The reply that run ended on, by its id, never a progress message or an earlier turn's reply (`jobResultOf`).
  const result = run ? jobResultOf(profile.recorded?.(threadId, run.runId), profile.messages?.(threadId) ?? [], run.runId) : undefined
  const asks = listed.status === 'needs_input' ? profile.pending?.(threadId).map(threadAsk) : undefined
  return { status: listed.status, ...(title ? { title } : {}), ...(result?.trim() ? { result } : {}), ...(asks?.length ? { asks } : {}) }
}

/**
 * Calls `changed` with the thread that started a thread when it is made, whenever its run, or a run of a subagent below it, changes status, a run's
 * `turn.start` ends (a turn that could not start leaves its queue stopped with no run changing status), a question or
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
  /** `threadId`: the thread its creator started, at the top of the subagent chain the change came from. */
  changed(creatorThreadId: string, threadId: string): void
}): () => void {
  // A subagent's change reaches the thread that started the top of its chain: that thread shows it waits on its subagents.
  const touch = (threadId: unknown) => {
    if (typeof threadId !== 'string') return
    try {
      const seen = new Set<string>()
      for (let thread = input.thread(threadId); thread && !seen.has(thread.id); thread = thread.lineage ? input.thread(thread.lineage.parentThreadId) : undefined) {
        seen.add(thread.id)
        if (thread.createdByThreadId) input.changed(thread.createdByThreadId, thread.id)
      }
    } catch { /* a refresh never fails a run or a question */ }
  }
  const onRun = (event: ThreadEvent) => {
    if (event.type === 'run.status') touch((event.payload as RunRecord | undefined)?.threadId)
    // A turn that could not start changes no run's status: its `turn.start` ending is what tells (its message may be back
    // in the queue, which stopped there).
    else if (event.type === 'effect.status') {
      const effect = event.payload as Pick<EffectRecord, 'kind' | 'status'> | undefined
      if (effect?.kind === 'turn.start' && effect.status !== 'pending' && effect.status !== 'running') touch(event.threadId)
    }
  }
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
