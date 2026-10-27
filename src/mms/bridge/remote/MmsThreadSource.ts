import { withoutStandingRules } from '../../orchestrator/UserQuestionService'
import type { PermissionMode } from '../../../shared/permissionMode'
import { subagentAncestorsOf, subagentParentsOfEvent } from '../../run/delegation/subagentEvents'
import type { MmsProfileServices } from '../../MmsProfileServices'
import { mmsJson } from './jsonOutput'
import { MmsRemoteBackend, remoteThreadEventData } from './MmsBackend'
import type {
  ThreadDeltaEvent,
  ThreadDisplayEvent,
  ThreadSourcePort,
  ThreadSourceEvent
} from './ThreadStreamAdapter'
export interface MmsThreadSourceOptions {
  /**
   * The source of one computer of the user's private stream, not of a phone's. Its questions keep
   * "Always for this thread" where the device's permission limit allows the rule, it is given the
   * newest 16 MiB of a long transcript instead of failing past 32 MiB, and it also carries what a
   * window of this computer would be told about the thread: its subagents, agents, tasks, pull
   * request and saved files and workspace.
   */
  private?: { limit(): PermissionMode }
}

/** Actual thread events/snapshots from the already-owned profile, never the old global event ring. */
export class MmsThreadSource implements ThreadSourcePort {
  private readonly backend: MmsRemoteBackend
  constructor(
    private readonly services: MmsProfileServices,
    revision?: () => number,
    private readonly options: MmsThreadSourceOptions = {}
  ) {
    this.backend = new MmsRemoteBackend(services, revision)
  }
  snapshot(threadId: string): unknown {
    return this.backend.snapshot(
      threadId,
      32 * 1024 * 1024,
      this.options.private
        ? { newestOnly: true, deviceLimit: this.options.private.limit() }
        : undefined
    )
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
    for (const [source, type] of mappings) {
      const handle = (data: { threadId?: string; message?: { streaming?: boolean } }): void => {
        if (data?.threadId === threadId) deliver(type, data, data.message?.streaming === true)
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
      const data = { thread },
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
    // Saves, Undo and workspace changes raise these through the protocol server, whichever window or computer asked.
    on(s.events, 'thread:event', (event: { type?: string; data?: unknown; threadId?: string }) => {
      if (event?.threadId !== threadId) return
      if (event.type === 'actions.updated' || event.type === 'workspace.updated')
        deliver(event.type, event.data, true)
    })
    return disposers
  }
}
