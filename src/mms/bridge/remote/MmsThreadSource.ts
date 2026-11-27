import { withoutStandingRules } from '../../orchestrator/UserQuestionService'
import type { PermissionMode } from '../../../shared/permissionMode'
import { subagentAncestorsOf, subagentParentsOfEvent } from '../../run/delegation/subagentEvents'
import type { MmsProfileServices } from '../../MmsProfileServices'
import { mmsJson } from './jsonOutput'
import { cursorIndex } from '../../../shared/pageCursor'
import { withLegacySettledAt } from '../../../shared/archivedAt'
import { withHiddenBots } from './botReach'
import { MmsRemoteBackend, remoteThreadEventData } from './MmsBackend'
import type {
  ThreadDeltaEvent,
  ThreadDisplayEvent,
  ThreadSourcePort,
  ThreadSourceEvent
} from './ThreadStreamAdapter'
/**
 * Where the last snapshot of a private stream began: the cursor of the oldest message its reader was given
 * (`earlier.before`), or undefined when it was given the whole transcript. Kept per stream, across the sources made for
 * it, so a later sync of the whole transcript sends the reader only the messages it holds and newer ones.
 */
export interface SnapshotBoundary {
  before?: string
}

export interface MmsThreadSourceOptions {
  /**
   * The source of one computer of the user's private stream, not of a phone's. Its questions keep
   * "Always for this thread" where the device's permission limit allows the rule, it is given the
   * newest 200 messages (16 MiB at most) of a long transcript, and it also carries what a
   * window of this computer would be told about the thread: its subagents, agents, tasks, pull
   * request and saved files and workspace.
   */
  private?: {
    limit(): PermissionMode
    /** The computer that reads the stream: a thread a bot started names that bot only if it reaches it. */
    reader?: string
    /** Where this stream's last snapshot began; set by `snapshot`, read by the transcript syncs `onThread` sends. */
    boundary?: SnapshotBoundary
  }
  /**
   * The backend to read through. Sources that share one share the pages `warm` read ahead, so a source made for one
   * open finds the page another warmed (`PrivateSources` makes a source per call).
   */
  backend?: MmsRemoteBackend
}

/** Actual thread events/snapshots from the already-owned profile, never the old global event ring. */
export class MmsThreadSource implements ThreadSourcePort {
  private readonly backend: MmsRemoteBackend
  constructor(
    private readonly services: MmsProfileServices,
    revision?: () => number,
    private readonly options: MmsThreadSourceOptions = {}
  ) {
    this.backend = options.backend ?? new MmsRemoteBackend(services, revision)
  }
  snapshot(threadId: string): unknown {
    const snapshot = this.backend.snapshot(
      threadId,
      this.options.private
        ? { newestOnly: true, deviceLimit: this.options.private.limit(), ...(this.options.private.reader ? { reader: this.options.private.reader } : {}) }
        : undefined
    )
    const boundary = this.options.private?.boundary
    if (boundary) {
      const before = (snapshot as { earlier?: { before?: unknown } }).earlier?.before
      boundary.before = typeof before === 'string' ? before : undefined
    }
    return snapshot
  }
  warm(threadId: string): Promise<void> {
    return this.backend.warm(threadId, this.options.private ? { newestOnly: true } : {})
  }
  onThread(
    threadId: string,
    listener: (event: ThreadSourceEvent) => void,
    onError?: (error: unknown) => void
  ): () => void {
    const deliver = (
      type: (ThreadDisplayEvent | ThreadDeltaEvent)['type'],
      data: unknown,
      ephemeral = false
    ): void => {
      try {
        listener({
          type,
          data: mmsJson(remoteThreadEventData(data)),
          ...(ephemeral ? { ephemeral: true } : {})
        } as ThreadSourceEvent)
      } catch (error) {
        if (onError) onError(error)
        else throw error
      }
    }
    const mappings = [
      ['thread-message', 'thread.message'],
      ['thread-message-updated', 'thread.message-updated'],
      ['thread-messages', 'thread.messages'],
      ['queue-updated', 'queue.updated'],
      ['turn-started', 'turn.started'],
      ['turn-completed', 'turn.completed'],
      ['turn-interrupted', 'turn.interrupted'],
      ['turn-aborted', 'turn.aborted'],
      ['turn-state', 'turn.state'],
      ['turn-steered', 'turn.steered'],
      ['connection-failed', 'connection.failed']
    ] as const
    const disposers: Array<() => void> = []
    const boundary = this.options.private?.boundary
    for (const [source, type] of mappings) {
      const handle = (data: { threadId?: string; message?: { streaming?: boolean } }): void => {
        if (data?.threadId !== threadId) return
        if (type === 'thread.messages' && boundary) {
          const sync = fromBoundary(data as TranscriptSync, boundary)
          // The message the reader's part begins at is gone: a fresh snapshot says where its part begins now.
          if (!sync) return listener({ snapshot: true })
          return deliver(type, sync)
        }
        deliver(type, data, data.message?.streaming === true)
      }
      this.services.orchestrator.on(source, handle)
      disposers.push(() => this.services.orchestrator.off(source, handle))
    }
    // Pending questions change rarely and are memory-only; remote readers get the full list live. A phone's
    // list has no "Always for this thread"; another computer's keeps it where its device may make the rule.
    const pending = (): unknown[] =>
      this.options.private
        ? this.services.questions.listPendingForDevice(threadId, this.options.private.limit())
        : this.services.questions.listPendingForThread(threadId).map(withoutStandingRules)
    const questions = (data: { threadId?: string }): void => {
      if (data?.threadId !== threadId) return
      deliver('questions.updated', { threadId, pending: pending() }, true)
    }
    for (const event of ['pending', 'cleared'] as const) {
      this.services.questions.on(event, questions)
      disposers.push(() => this.services.questions.off(event, questions))
    }
    let lastMetadata: string | undefined
    const metadata = (thread: { id: string }): void => {
      if (thread.id !== threadId) return
      // A shared stream (any device may read it) names a bot that started the thread only if every device reaches it.
      // An older computer or phone reads the archive time only as `settledAt`.
      const data = { thread: withLegacySettledAt(withHiddenBots(thread, this.services.botReach?.hiddenFor(this.options.private?.reader))) },
        fingerprint = JSON.stringify(data)
      if (fingerprint === lastMetadata) return
      lastMetadata = fingerprint
      deliver('thread.metadata', data)
    }
    this.services.threads.on('updated', metadata)
    disposers.push(() => this.services.threads.off('updated', metadata))
    const lists = (data: unknown): void => {
      const rows = Array.isArray(data) ? data : (data as { threads?: unknown[] })?.threads
      if (!Array.isArray(rows)) return
      const thread = rows.find((row) => (row as { id?: string })?.id === threadId)
      if (thread) metadata(thread as { id: string })
    }
    this.services.events.on('threads:updated', lists)
    disposers.push(() => this.services.events.off('threads:updated', lists))
    if (this.options.private) disposers.push(...this.privateNotes(threadId, deliver))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }

  /**
   * What a window on this computer learns about a thread besides its messages. Each is a note that
   * something changed, sent as a display-only delta (it is never stored or replayed; a reader that
   * attaches fetches the state), and the new state where that is small.
   */
  private privateNotes(
    threadId: string,
    deliver: (type: (ThreadDisplayEvent | ThreadDeltaEvent)['type'], data: unknown, ephemeral?: boolean) => void
  ): Array<() => void> {
    const s = this.services
    const disposers: Array<() => void> = []
    const on = (target: { on: Function; off: Function }, event: string, handler: (...args: any[]) => void): void => {
      target.on(event, handler)
      disposers.push(() => target.off(event, handler))
    }
    // The subagent list of a thread changes with its delegations, its children's runs, inbox rows, questions and
    // titles, and a change low in the tree changes every ancestor's row. The reader refetches `subagents.list`.
    const subagents = (parents: readonly string[]): void => {
      if (parents.includes(threadId)) deliver('subagents.updated', { parentThreadId: threadId }, true)
    }
    on(s.orchestrator, 'run-event', (event: Parameters<typeof subagentParentsOfEvent>[1]) => {
      try {
        subagents(subagentParentsOfEvent(s.runEngine.delegations, event))
      } catch {
        // A note that cannot be derived is not worth failing the stream for; the reader refetches on attach.
      }
    })
    for (const name of ['pending', 'cleared'] as const)
      on(s.questions, name, (payload: { threadId: string }) =>
        subagents(subagentAncestorsOf(s.runEngine.delegations, payload.threadId))
      )
    on(s.threads, 'updated', (thread: { id?: string; lineage?: { parentThreadId: string; relationship: string } }) => {
      if (thread.lineage?.relationship !== 'subagent') return
      subagents([thread.lineage.parentThreadId, ...(thread.id ? subagentAncestorsOf(s.runEngine.delegations, thread.id) : [])])
    })
    for (const [source, type] of [['agents.updated', 'agents.updated'], ['tasks.updated', 'tasks.updated']] as const)
      on(s.threadRuntimes, source, (payload: { threadId?: string }) => {
        if (payload?.threadId === threadId) deliver(type, payload, true)
      })
    on(s.pullRequestWatch, 'updated', (payload: { threadId?: string }) => {
      if (payload?.threadId === threadId) deliver('pullRequests.updated', payload, true)
    })
    on(s.orchestrator, 'thread-title-generation-failed', (payload: { threadId?: string }) => {
      if (payload?.threadId === threadId) deliver('thread.title-generation-failed', payload, true)
    })
    // A Send now click's outcome, for the window on another computer that clicked it (`orchestrator.steerNow`).
    on(s.orchestrator, 'steer-now', (payload: { threadId?: string; requestId?: string; outcome?: string }) => {
      if (payload?.threadId === threadId) deliver('steer.now', { requestId: payload.requestId, outcome: payload.outcome }, true)
    })
    // Saves, Undo and workspace changes raise these through the protocol server, whichever window or computer asked.
    on(s.events, 'thread:event', (event: { type?: string; data?: unknown; threadId?: string }) => {
      if (event?.threadId !== threadId) return
      if (event.type === 'actions.updated' || event.type === 'workspace.updated' || event.type === 'git.selectionChanged')
        deliver(event.type, event.data, true)
    })
    return disposers
  }
}

type TranscriptSync = { threadId?: string; messages?: Array<{ id: string }>; replace?: boolean }

/**
 * A sync of the whole transcript (`thread-messages`) as a private stream's reader is sent it: from the message its
 * snapshot began at, so a reader given the newest part of a long thread is not sent the older messages it pages
 * itself, and its `earlier` stays right. A replacement goes whole (the reader then holds everything). Undefined when
 * the message the snapshot began at is no longer in the transcript.
 */
function fromBoundary(sync: TranscriptSync, boundary: SnapshotBoundary): TranscriptSync | undefined {
  if (sync.replace === true) {
    boundary.before = undefined
    return sync
  }
  if (boundary.before === undefined || !Array.isArray(sync.messages)) return sync
  const at = cursorIndex(sync.messages, boundary.before)
  if (at < 0) return undefined
  return at === 0 ? sync : { ...sync, messages: sync.messages.slice(at) }
}
