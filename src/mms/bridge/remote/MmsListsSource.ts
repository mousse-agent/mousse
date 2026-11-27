import type { ChatSummary } from '../../../shared/chats'
import type { BotChip, BotSummary } from '../../../shared/bots/personal/chat'
import type { Project, Thread, ThreadActivityState, TurnState } from '../../../shared/types'
import type { MmsProfileServices } from '../../MmsProfileServices'
import { rollUpActivities, visibleThreads, isLocalOnlyThread } from '../../../shared/threadLineage'
import { mmsJson } from './jsonOutput'
import { remoteBotSummary } from './RemoteBots'
import { withHiddenBots } from './botReach'
import type { BotsSharingPort } from '../../protocol/botsSharingPort'
import type { BotReachPort } from '../../protocol/botReachPort'
import { copyLimits } from '../copyLimits'

/**
 * The reserved display "thread" that carries a computer's sidebar lists. Real thread ids never
 * contain a colon, so this id cannot name a real thread.
 */
export const LISTS_STREAM_THREAD_ID = 'mousse:lists'
/**
 * The lists stream of one device (a phone), which only that device reads: `mousse:lists:<node>`. `bridge.lists.open`
 * opens it for the caller, so the bots in it are the ones that device reaches. Its records carry
 * `LISTS_STREAM_THREAD_ID` as their thread, as the shared stream's do.
 */
const READER_LISTS_PREFIX = `${LISTS_STREAM_THREAD_ID}:`
export const readerListsKey = (node: string): string => `${READER_LISTS_PREFIX}${node}`
/** The device whose own lists stream `key` is, if it is one. */
export const readerOfListsKey = (key: string): string | undefined =>
  key.startsWith(READER_LISTS_PREFIX) && key.length > READER_LISTS_PREFIX.length ? key.slice(READER_LISTS_PREFIX.length) : undefined
const LISTS_VERSION = 1
/** Coalesces bursts (a send renames, reorders and starts a turn) into one published snapshot. */
const SETTLE_MS = 40
/** Catches changes that reach no event (for example a thread another client deleted). */
const RECONCILE_MS = 15_000
/**
 * The lists without the threads' last-update times. A running turn moves its thread's time on every save, every
 * second or so; a change of these alone is published at most once per `listsTimesIntervalMs` (`copyLimits`),
 * since each publish is a whole snapshot, sent to and stored by every reader.
 */
function withoutTimes(snapshot: ListsSnapshot): string {
  return JSON.stringify({
    ...snapshot,
    threads: snapshot.threads.map(({ updatedAt: _updatedAt, ...rest }) => rest)
  })
}
const PREVIEW_CHARS = 280
const ERROR_CHARS = 280
/** A private snapshot above this size leaves out threads archived long ago (see `trimmed`). */
export const PRIVATE_SOFT_LIMIT_BYTES = 256 * 1024
const ARCHIVE_KEEP_MS = 30 * 24 * 60 * 60 * 1000

export type ListsStatusState =
  | 'processing'
  | 'awaiting_input'
  | 'completed'
  | 'failed'
  /** Only in a private lists stream, which carries every state a sidebar row can show. */
  | 'waiting'
  | 'paused'

export interface ListsStatus {
  state: ListsStatusState
  /** When the current turn started, for "Working 3m". */
  since?: string
  error?: string
}

export interface ListsChat {
  id: string
  kind: 'direct' | 'group'
  name: string
  /** The thread that mirrors the chat's messages; absent for Space conversations. */
  threadId?: string
  projectId?: string
  /** A conversation published to a Space; it opens only on the computer. */
  network?: true
  agents: string[]
  updatedAt: string
  preview?: string
  run?: { id: string; state: string; startedAt: string; error?: string }
}

/**
 * One of the owner's personal bots: its summary as the desktop's Bots list has it (no instance id in its error), and
 * `activity`, the live chip of the bot's working activation. Bots are the owner's, and so are the devices that read
 * the lists, so the phone's lists and another computer's both carry them.
 */
export type ListsBot = BotSummary & { activity?: BotChip }

/** What a phone needs to draw the Projects, Threads, Chats and Bots tabs and their status icons. */
export interface ListsSnapshot {
  kind: 'mousse.lists'
  version: number
  projects: Array<Pick<Project, 'id' | 'name' | 'path' | 'order' | 'pinnedAt'>>
  threads: Array<
    Pick<
      Thread,
      | 'id'
      | 'name'
      | 'projectId'
      | 'createdAt'
      | 'updatedAt'
      | 'order'
      | 'pinnedAt'
      | 'archivedAt'
      | 'startedAt'
      | 'worktreeEnabled'
      | 'expiresAt'
      | 'expiryStopsRun'
    > & {
      /** `archivedAt` again, for a reader that runs an older Mousse. */
      settledAt?: string
    } &
      /** Out of the sidebar, and the bot that started it ("a bot" for a reader that may not see that bot). */
      Partial<Pick<Thread, 'hidden' | 'startedByBot'>> &
      /**
       * Only in a private lists stream: the subagent rows' place in the tree, what the thread runs with, and who started
       * it, so another computer lists, nests and links it as this one does.
       */
      Partial<
        Pick<
          Thread,
          | 'lineage'
          | 'permissionMode'
          | 'modelOverride'
          | 'startedFrom'
          | 'sentFrom'
          | 'titleSource'
          | 'createdByThreadId'
          | 'native'
          | 'automationManager'
          | 'runsOn'
        >
      >
  >
  /** Threads that are not idle, by id. */
  status: Record<string, ListsStatus>
  chats: ListsChat[]
  /** Oldest first; empty when the profile's bots are unavailable or this computer does not share them. */
  bots: ListsBot[]
}

/** What the lists read and watch of the profile's personal bots (`BotEngine`). */
export interface ListsBotsPort {
  service: { list(): { bots: BotSummary[] } }
  liveActivity(botId: string): { chip?: BotChip } | undefined
  /** `changed`, `message` and `activity`, as `bots.changed`, `bots.message` and `bots.activity`. */
  events: Emitter
}

/** The profile services the lists read and watch. */
export type ListsServices = Pick<
  MmsProfileServices,
  'projects' | 'threads' | 'orchestrator' | 'questions' | 'events' | 'threadRuntimes'
> & {
  platform: {
    chats: { snapshot(): { chats: ChatSummary[] }; onChange(listener: () => void): () => void }
  }
  personalBots?: ListsBotsPort | null
  /** "Share bots with other devices": while it refuses, the lists carry no bots. */
  botsSharing?: BotsSharingPort
  /** Which devices reach which bot: the lists of one device carry only the bots it reaches. */
  botReach?: BotReachPort
}

interface Emitter {
  on(event: string, listener: (...args: any[]) => void): unknown
  off(event: string, listener: (...args: any[]) => void): unknown
}

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function statusOf(
  activity: ThreadActivityState | undefined,
  turn: TurnState | undefined,
  /** A private stream also reports Waiting and Paused, which a phone's row has no state for. */
  all = false
): ListsStatus | undefined {
  const since = turn?.startedAt
  if (activity === 'processing' || activity === 'awaiting_input')
    return { state: activity, ...(since ? { since } : {}) }
  if (all && (activity === 'waiting' || activity === 'paused'))
    return { state: activity, ...(since ? { since } : {}) }
  if (activity === 'completed') return { state: 'completed' }
  if (turn?.phase === 'failed')
    return {
      state: 'failed',
      ...(clip(turn.error, ERROR_CHARS) ? { error: clip(turn.error, ERROR_CHARS) } : {})
    }
  return undefined
}

function botOf(bot: BotSummary, activity: { chip?: BotChip } | undefined): ListsBot {
  const summary = remoteBotSummary(bot)
  const last = summary.last ? { ...summary.last, text: clip(summary.last.text, PREVIEW_CHARS) ?? '' } : undefined
  return {
    ...summary,
    ...(last ? { last } : {}),
    ...(activity?.chip ? { activity: activity.chip } : {})
  }
}

function chatOf(chat: ChatSummary): ListsChat {
  const agents = chat.participants
    .filter((entry) => entry.kind === 'agent')
    .map((entry) => entry.name)
  if (chat.presentation === 'network')
    return {
      id: chat.id,
      kind: 'group',
      name: chat.name,
      network: true,
      agents,
      updatedAt: chat.updatedAt
    }
  const preview = clip(chat.lastMessage?.text, PREVIEW_CHARS)
  return {
    id: chat.id,
    kind: chat.kind,
    name: chat.name,
    threadId: chat.threadId,
    ...(chat.projectId ? { projectId: chat.projectId } : {}),
    agents,
    updatedAt: chat.updatedAt,
    ...(preview ? { preview } : {}),
    ...(chat.run
      ? {
          run: {
            id: chat.run.id,
            state: chat.run.state,
            startedAt: chat.run.startedAt,
            ...(clip(chat.run.error, ERROR_CHARS)
              ? { error: clip(chat.run.error, ERROR_CHARS) }
              : {})
          }
        }
      : {})
  }
}

/**
 * Builds the sidebar lists from the profile's own services and reports when they change. A
 * ThreadStreamAdapter publishes each changed snapshot to subscribed phones on a signed display stream.
 */
export class MmsListsSource {
  constructor(
    private readonly services: ListsServices,
    private readonly timers: {
      setTimeout(run: () => void, ms: number): unknown
      clearTimeout(handle: unknown): void
      setInterval(run: () => void, ms: number): unknown
      clearInterval(handle: unknown): void
    } = {
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      setInterval: (run, ms) => setInterval(run, ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
    },
    /**
     * `private`: the lists of one computer of the user rather than of a phone. They keep the subagent
     * rows and each thread's `lineage`, say what each thread runs with and where it came from, and
     * report every state a row can show. The phone's lists stay as they were.
     */
    private readonly options: {
      private?: boolean
      /**
       * The one device that reads these lists (another computer's private lists, a phone's own lists): only the bots it
       * reaches. Absent, lists any device may read (the phones' shared stream): only the bots every device reaches.
       */
      reader?: string
    } = {}
  ) {}

  private chats: ListsChat[] | undefined
  private chatsStale = true
  private bots: ListsBot[] | undefined
  private botsStale = true
  private watchers = 0

  /**
   * The chats are read from disk. While a watcher runs, both `watch` and `snapshot` reuse the last read
   * until a chat signals or the reconcile tick runs; without a watcher nothing signals, so each call reads.
   */
  private currentChats(): ListsChat[] {
    if (this.watchers === 0 || this.chatsStale || !this.chats) {
      try {
        this.chats = this.services.platform.chats.snapshot().chats.map(chatOf)
      } catch {
        // A profile whose chat store cannot be read still lists its projects and threads.
        this.chats = []
      }
      this.chatsStale = false
    }
    return this.chats
  }

  /** Read like the chats: once per bot signal or reconcile tick while a watcher runs, on every call otherwise. */
  private currentBots(): ListsBot[] {
    if (this.watchers === 0 || this.botsStale || !this.bots) {
      const engine = this.services.personalBots
      try {
        // Off: "Share bots with other devices" is off on this computer.
        const hidden = this.services.botReach?.hiddenFor(this.options.reader)
        this.bots = engine && !this.services.botsSharing?.refusal()
          ? engine.service.list().bots.filter((bot) => !hidden?.(bot.id)).map((bot) => botOf(bot, engine.liveActivity(bot.id)))
          : []
      } catch {
        // A profile whose bots cannot be read still lists everything else.
        this.bots = []
      }
      this.botsStale = false
    }
    return this.bots
  }

  snapshot(): ListsSnapshot {
    return this.compose(this.currentChats(), this.currentBots())
  }

  private compose(chats: ListsChat[], bots: ListsBot[]): ListsSnapshot {
    const s = this.services
    const activity = s.threadRuntimes.getActivitySnapshot()
    const turns = s.orchestrator.getTurnSnapshot()
    // Private threads (`Thread.localOnly`) and everything below them never reach another device's lists,
    // nor does a personal bot's thread (`Thread.botOwned`), or its state: the bot's chat shows its work.
    const all = s.threads.listAllThreads()
    const inventory = all.filter((thread) => !thread.botOwned && !isLocalOnlyThread(thread, all))
    const own = this.options.private === true
    // A phone lists threads the way the CLI does: subagents sit under their parent, not beside it. Another
    // computer lists them all, with their lineage, and builds the tree itself like the desktop sidebar.
    // A thread an agent or a bot keeps out of the sidebar (`Thread.hidden`) is listed on every device too, marked hidden,
    // with the subagents below it: All and search find it there as here, and so do the side panel of the thread that
    // started it and the bot's chat.
    const threads = own ? inventory : visibleThreads(inventory)
    const snapshot = this.build(s, inventory, threads, own, activity, turns, chats, bots)
    return own ? this.trimmed(snapshot, inventory) : snapshot
  }

  /**
   * A private snapshot grows with the number of threads. Above `PRIVATE_SOFT_LIMIT_BYTES`, archived threads
   * that were archived more than 30 days ago leave it (with the subagents under them); the Archive view of
   * another computer asks for them with a read when it needs them.
   */
  private trimmed(snapshot: ListsSnapshot, inventory: readonly Thread[]): ListsSnapshot {
    if (Buffer.byteLength(JSON.stringify(snapshot)) <= PRIVATE_SOFT_LIMIT_BYTES) return snapshot
    const cutoff = Date.now() - ARCHIVE_KEEP_MS
    const dropped = new Set<string>()
    for (const thread of inventory)
      if (thread.archivedAt && !thread.lineage && new Date(thread.archivedAt).getTime() < cutoff)
        dropped.add(thread.id)
    if (!dropped.size) return snapshot
    // Whatever hangs below a dropped thread goes with it.
    for (let grew = true; grew;) {
      grew = false
      for (const thread of inventory)
        if (
          thread.lineage &&
          !dropped.has(thread.id) &&
          dropped.has(thread.lineage.parentThreadId)
        ) {
          dropped.add(thread.id)
          grew = true
        }
    }
    const status = { ...snapshot.status }
    for (const id of dropped) delete status[id]
    return {
      ...snapshot,
      threads: snapshot.threads.filter((thread) => !dropped.has(thread.id)),
      status
    }
  }

  private build(
    s: ListsServices,
    inventory: readonly Thread[],
    threads: readonly Thread[],
    own: boolean,
    activity: Record<string, ThreadActivityState>,
    turns: Record<string, TurnState>,
    chats: ListsChat[],
    bots: ListsBot[]
  ): ListsSnapshot {
    // A phone's parent row shows what its subagents are doing; another computer rolls the states up itself.
    const rolledUp = own ? {} : rollUpActivities(inventory, activity)
    const status: Record<string, ListsStatus> = {}
    for (const thread of threads) {
      const entry = statusOf(rolledUp[thread.id] ?? activity[thread.id], turns[thread.id], own)
      if (entry) status[thread.id] = entry
    }
    return mmsJson(
      {
        kind: 'mousse.lists',
        version: LISTS_VERSION,
        projects: s.projects.listProjects().map((project) => ({
          id: project.id,
          name: project.name,
          path: project.path,
          order: project.order,
          pinnedAt: project.pinnedAt
        })),
        // A bot the reader may not see is "a bot" on its threads, with no launcher (`withHiddenBots`).
        threads: withHiddenBots(threads.map((thread) => ({
          id: thread.id,
          name: thread.name,
          projectId: thread.projectId,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          order: thread.order,
          pinnedAt: thread.pinnedAt,
          archivedAt: thread.archivedAt,
          // The same time for a computer or a phone that runs an older Mousse, which reads only `settledAt`.
          ...(thread.archivedAt ? { settledAt: thread.archivedAt } : {}),
          startedAt: thread.startedAt,
          worktreeEnabled: thread.worktreeEnabled,
          // When it archives itself, for the menu's Archive after (a phone keeps "stop a running turn" when it changes the time).
          ...(thread.expiresAt ? { expiresAt: thread.expiresAt } : {}),
          ...(thread.expiresAt && thread.expiryStopsRun ? { expiryStopsRun: true } : {}),
          // Out of the sidebar there as here (`Thread.hidden`): its My threads leaves it out, All lists it. A reader that
          // runs an older Mousse reads no such key and lists it with the rest.
          ...(thread.hidden ? { hidden: true } : {}),
          // The Bot threads filter, the bot's face and its Started-by bar there read the bot (`Thread.startedByBot`).
          ...(thread.startedByBot ? { startedByBot: { botId: thread.startedByBot.botId, name: thread.startedByBot.name } } : {}),
          ...(own
            ? {
                lineage: thread.lineage,
                permissionMode: thread.permissionMode,
                modelOverride: thread.modelOverride,
                // From the same snapshot as the mode and model, so a window conditions its changes on what it shows.
                settingsRevision: thread.settingsRevision ?? 0,
                startedFrom: thread.startedFrom,
                sentFrom: thread.sentFrom,
                // The thread whose agent (or bot) started it: its side panel's Started threads and the Started-by bar
                // there name it, qualified with this computer as the lists are read.
                ...(thread.createdByThreadId ? { createdByThreadId: thread.createdByThreadId } : {}),
                // A native helper's mirror opens watch-only there as here.
                ...(thread.native ? { native: thread.native } : {}),
                // The Automation manager's thread is listed nowhere there either.
                ...(thread.automationManager ? { automationManager: true } : {}),
                // A remote subagent's stand-in still says which computer runs it, and opens its thread there.
                ...(thread.runsOn ? { runsOn: thread.runsOn } : {}),
                // A chat made for its first message: a window binds that message (`Thread.firstSendPending`).
                ...(thread.firstSendPending ? { firstSendPending: true } : {}),
                // A title still being named shows dimmed there as here; the other sources look the same, so only this one is sent.
                ...(thread.titleSource === 'provisional' ? { titleSource: 'provisional' as const } : {})
              }
            : {})
        })), s.botReach?.hiddenFor(this.options.reader)),
        status,
        chats,
        bots
      }
    ) as ListsSnapshot
  }

  /**
   * Calls `changed` shortly after anything the lists show changes. Repeated signals that leave the
   * lists as they were do not call it, and a change that only moves threads' last-update times calls it at most
   * once per `listsTimesIntervalMs`. Returns a function that stops watching.
   */
  watch(changed: () => void, onError?: (error: unknown) => void): () => void {
    const s = this.services
    this.watchers++
    this.chatsStale = true
    this.botsStale = true
    const first = this.snapshot()
    let last = JSON.stringify(first)
    let lastShape = withoutTimes(first)
    let pending: unknown
    /** A change of times alone, waiting for its interval. */
    let held: unknown
    let stopped = false
    const check = (timesDue = false): void => {
      if (stopped) return
      try {
        const snapshot = this.snapshot(),
          next = JSON.stringify(snapshot)
        if (next === last) return
        const shape = withoutTimes(snapshot)
        if (shape === lastShape && !timesDue) {
          held ??= this.timers.setTimeout(() => {
            held = undefined
            check(true)
          }, copyLimits().listsTimesIntervalMs)
          return
        }
        if (held !== undefined) this.timers.clearTimeout(held)
        held = undefined
        last = next
        lastShape = shape
        changed()
      } catch (error) {
        onError?.(error)
      }
    }
    const poke = (): void => {
      if (stopped || pending !== undefined) return
      pending = this.timers.setTimeout(() => {
        pending = undefined
        check()
      }, SETTLE_MS)
    }
    const disposers: Array<() => void> = []
    const on = (target: Emitter, event: string): void => {
      target.on(event, poke)
      disposers.push(() => target.off(event, poke))
    }
    on(s.threads as unknown as Emitter, 'created')
    on(s.threads as unknown as Emitter, 'updated')
    on(s.events as unknown as Emitter, 'threads:updated')
    on(s.events as unknown as Emitter, 'projects:updated')
    for (const event of [
      'thread-started',
      'turn-state',
      'turn-started',
      'turn-completed',
      'turn-failed',
      'turn-aborted',
      'turn-interrupted'
    ])
      on(s.orchestrator as unknown as Emitter, event)
    on(s.threadRuntimes as unknown as Emitter, 'activity')
    on(s.questions as unknown as Emitter, 'pending')
    on(s.questions as unknown as Emitter, 'cleared')
    const chatsChanged = (): void => {
      this.chatsStale = true
      poke()
    }
    disposers.push(s.platform.chats.onChange(chatsChanged))
    const botsChanged = (): void => {
      this.botsStale = true
      poke()
    }
    // A bot's state, its last message and its live chip.
    const bots = s.personalBots?.events
    if (bots)
      for (const event of ['changed', 'message', 'activity']) {
        bots.on(event, botsChanged)
        disposers.push(() => bots.off(event, botsChanged))
      }
    const sharing = s.botsSharing
    if (sharing) disposers.push(sharing.onChange(botsChanged))
    // A bot's Devices choice, a device's switch for bots, or the devices on the account changed.
    const reach = s.botReach
    if (reach) disposers.push(reach.onChange(botsChanged))
    const reconcile = this.timers.setInterval(() => {
      this.botsStale = true
      chatsChanged()
    }, RECONCILE_MS)
    disposers.push(() => this.timers.clearInterval(reconcile))
    return () => {
      if (stopped) return
      stopped = true
      if (--this.watchers === 0) {
        this.chats = undefined
        this.bots = undefined
      }
      if (pending !== undefined) this.timers.clearTimeout(pending)
      if (held !== undefined) this.timers.clearTimeout(held)
      for (const dispose of disposers.splice(0)) dispose()
    }
  }
}
