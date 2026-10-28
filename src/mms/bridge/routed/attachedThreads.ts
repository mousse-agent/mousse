import { qualifyRoutedEvent, qualifyRoutedResult, type QualifyContext } from '../../../shared/bridge/routedIds'
import { NetError, type NodeId, type StreamDescriptor } from '../../../shared/net'
import { qualifyId } from '../../../shared/threadRef'
import type { MmsProfileServices } from '../../MmsProfileServices'
import { DomainRpcError } from '../../protocol/domainRegistry'
import type { BridgeHub } from '../hub'
import type { ThreadDisplayUpdate } from '../remote/ThreadDisplayProjection'
import { computerOffline, type ComputerRef } from './computerErrors'
import type { RoutedClient } from './RoutedClient'
import { RemoteThreadView, type ViewChange } from './threadView'

type Json = Record<string, unknown>
const isRecord = (value: unknown): value is Json =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** The stream every computer of the user reads for the progress of the Git actions it starts. */
export const CHANNEL_ENTITY = 'mousse:channel'

const IDLE_MS = 10 * 60_000
const PER_COMPUTER = 16
const IN_TOTAL = 32
/** How long a snapshot of a thread waits for its stream to deliver the first snapshot. */
const READY_MS = 15_000

export interface AttachedThreadsOptions {
  services: MmsProfileServices
  hub: BridgeHub
  client: RoutedClient
  self(): string | undefined
  computer(node: NodeId): ComputerRef
  /** Progress of a Git action, from the channel stream of `node`. */
  onGit(node: NodeId, data: unknown): void
  idleMs?: number
  maxPerComputer?: number
  maxTotal?: number
}

interface Attachment {
  node: NodeId
  /** The thread's id on its own computer. */
  threadId: string
  qualified: string
  view: RemoteThreadView
  handle?: { close(): void; descriptor: StreamDescriptor }
  attaching?: Promise<void>
  /** Resolves when the stream's snapshot has been installed. */
  ready: Promise<void>
  markReady(): void
  /** The sequence of the newest event pushed to this computer's windows for the thread, once applied. */
  revision: number
  lastUsed: number
  idle?: ReturnType<typeof setTimeout>
  /** The view came from the copy kept on disk, not from the computer. */
  replica: boolean
  /** The snapshot has been installed before, so a new one is a resync of the windows. */
  installed: boolean
  /**
   * Windows were answered without the live stream (a whole routed read, or the copy on disk): what they
   * were told about prompts and the turn, so the stream's first snapshot can put right what differs.
   */
  served?: { questions: string[]; active: boolean }
  /** The attachment was let go of; an attach still on its way closes what it opens. */
  dropped?: boolean
  retries?: number
}

/** A local protocol event for a thread of another computer. */
interface LocalEvent {
  type: string
  data: unknown
  threadId?: string
}

/**
 * The threads of other computers that windows of this one have in view, or had in the last ten
 * minutes. Each is attached to a stream only this computer reads, and kept as a `RemoteThreadView`.
 *
 * - A window that keeps a thread in view holds a lease on it (`threads.focus`). Two windows share
 *   one stream. A thread nobody has in view stays attached for ten minutes, then lets go.
 * - A computer keeps 16 threads attached at once, and this one 32 in all; the one used longest ago
 *   (unfocused ones first) gives way to a new one.
 * - Everything the stream says reaches the view. What reaches the windows is the events of the
 *   stream with ids qualified, pushed into this daemon's own ring: all of it for a thread in view,
 *   and only the settled records for one that is not, so a thread nobody watches cannot push the
 *   ring past the point where a window has to ask for a snapshot again.
 */
export class AttachedThreads {
  private readonly threads = new Map<string, Attachment>()
  private readonly leases = new Map<string, Set<string>>()
  private readonly channels = new Map<NodeId, Promise<void>>()
  private readonly channelHandles = new Map<NodeId, { close(): void }>()
  /** Streams being closed on the owner, by thread; a stream for the same thread is not opened until it is done. */
  private readonly closing = new Map<string, Promise<void>>()
  private closed = false

  constructor(private readonly options: AttachedThreadsOptions) {}

  private key(node: NodeId, threadId: string): string {
    return `${node}|${threadId}`
  }

  private focused(attachment: Attachment): boolean {
    const key = this.key(attachment.node, attachment.threadId)
    for (const held of this.leases.values()) if (held.has(key)) return true
    return false
  }

  private context(node: NodeId): QualifyContext {
    return { node, self: this.options.self() }
  }

  // ------------------------------------------------------------------ leases

  async focus(lease: string, node: NodeId, threadId: string): Promise<void> {
    const key = this.key(node, threadId)
    let held = this.leases.get(lease)
    if (!held) this.leases.set(lease, (held = new Set()))
    held.add(key)
    const attachment = this.obtain(node, threadId)
    this.touch(attachment)
    // A computer that is offline keeps the lease; the thread is attached when it is back.
    await this.attach(attachment).catch(() => undefined)
  }

  unfocus(lease: string, node: NodeId, threadId: string): void {
    const held = this.leases.get(lease)
    held?.delete(this.key(node, threadId))
    if (held && !held.size) this.leases.delete(lease)
    const attachment = this.threads.get(this.key(node, threadId))
    if (attachment && !this.focused(attachment)) this.touch(attachment)
  }

  /** The window is gone: every lease it held ends. */
  dropLeases(lease: string): void {
    const held = this.leases.get(lease)
    if (!held) return
    this.leases.delete(lease)
    for (const key of held) {
      const attachment = this.threads.get(key)
      if (attachment && !this.focused(attachment)) this.touch(attachment)
    }
  }

  /** Threads that are attached or leased, for tests and the device screens. */
  state(): Array<{ node: NodeId; threadId: string; focused: boolean; attached: boolean }> {
    return [...this.threads.values()].map((attachment) => ({
      node: attachment.node,
      threadId: attachment.threadId,
      focused: this.focused(attachment),
      attached: !!attachment.handle
    }))
  }

  // ------------------------------------------------------------------ attachments

  private obtain(node: NodeId, threadId: string): Attachment {
    const key = this.key(node, threadId)
    const known = this.threads.get(key)
    if (known) return known
    this.makeRoom(node)
    let markReady!: () => void
    const ready = new Promise<void>((resolve) => (markReady = resolve))
    const attachment: Attachment = {
      node,
      threadId,
      qualified: qualifyId(node, threadId),
      view: new RemoteThreadView(),
      ready,
      markReady,
      revision: 0,
      lastUsed: Date.now(),
      replica: false,
      installed: false
    }
    this.threads.set(key, attachment)
    return attachment
  }

  /** Lets the one used longest ago go, unfocused ones first, when `node` or this computer is full. */
  private makeRoom(node: NodeId): void {
    const perComputer = this.options.maxPerComputer ?? PER_COMPUTER,
      total = this.options.maxTotal ?? IN_TOTAL
    const evict = (candidates: Attachment[]): void => {
      const [oldest] = [...candidates].sort(
        (a, b) => Number(this.focused(a)) - Number(this.focused(b)) || a.lastUsed - b.lastUsed
      )
      if (oldest) this.drop(oldest)
    }
    const here = [...this.threads.values()].filter((item) => item.node === node)
    if (here.length >= perComputer) evict(here)
    if (this.threads.size >= total) evict([...this.threads.values()])
  }

  private touch(attachment: Attachment): void {
    attachment.lastUsed = Date.now()
    if (attachment.idle) clearTimeout(attachment.idle)
    attachment.idle = undefined
    if (this.focused(attachment) || this.closed) return
    // Nobody has it in view: it stays for ten minutes, then the stream is let go.
    attachment.idle = setTimeout(() => {
      if (!this.focused(attachment)) this.drop(attachment)
    }, this.options.idleMs ?? IDLE_MS)
    attachment.idle.unref?.()
  }

  private drop(attachment: Attachment): void {
    if (attachment.idle) clearTimeout(attachment.idle)
    const held = attachment.handle
    held?.close()
    attachment.handle = undefined
    attachment.dropped = true
    this.threads.delete(this.key(attachment.node, attachment.threadId))
    // The owner keeps the room a stream holds until it is told, or ten idle minutes pass.
    if (held) this.tellOwnerClosed(attachment)
  }

  /** Closes the stream on the owner. A stream for the same thread opens only after this is done. */
  private tellOwnerClosed(attachment: Attachment): void {
    if (this.closed) return
    const key = this.key(attachment.node, attachment.threadId)
    const closing: Promise<void> = this.options.client
      .closeStream(attachment.node, { kind: 'thread', threadId: attachment.threadId })
      .catch(() => undefined)
      .finally(() => {
        if (this.closing.get(key) === closing) this.closing.delete(key)
      })
    this.closing.set(key, closing)
  }

  /** A focused thread whose stream failed is attached again, a few times, before it waits for the next use. */
  private reattachSoon(attachment: Attachment): void {
    if (this.closed || attachment.dropped || !this.focused(attachment)) return
    const attempt = (attachment.retries ?? 0) + 1
    if (attempt > 3) return
    attachment.retries = attempt
    const timer = setTimeout(() => {
      if (this.closed || attachment.dropped || attachment.handle || attachment.attaching) return
      void this.attach(attachment).then(
        () => {
          attachment.retries = 0
        },
        () => this.reattachSoon(attachment)
      )
    }, 1000 * attempt)
    timer.unref?.()
  }

  private attach(attachment: Attachment): Promise<void> {
    if (attachment.handle) return Promise.resolve()
    if (attachment.attaching) return attachment.attaching
    const { hub, client } = this.options
    attachment.attaching = (async () => {
      // A stream let go of a moment ago is closed on the owner first, or the close would catch the new one.
      await this.closing.get(this.key(attachment.node, attachment.threadId))
      const handle = await hub.attach(
        { nodeId: attachment.node, entityId: attachment.threadId },
        (value) => this.onUpdate(attachment, value),
        () => {
          // The hub detached it after an error: it is attached again shortly, and by the next use.
          attachment.handle = undefined
          this.reattachSoon(attachment)
        },
        {
          open: async () => {
            const opened = await client.openStream(attachment.node, {
              kind: 'thread',
              threadId: attachment.threadId
            })
            return {
              descriptor: opened.descriptor as StreamDescriptor,
              head: opened.head
            }
          }
        },
        (type, data) => this.onNote(attachment, type, data)
      )
      if (this.closed || this.threads.get(this.key(attachment.node, attachment.threadId)) !== attachment) {
        handle.close()
        // Nothing else holds the stream if no newer attachment of the thread exists: the owner is told.
        if (!this.threads.has(this.key(attachment.node, attachment.threadId))) this.tellOwnerClosed(attachment)
        return
      }
      attachment.handle = handle
    })().finally(() => {
      attachment.attaching = undefined
    })
    return attachment.attaching
  }

  /** A session with `node` opened: the threads windows have in view there are attached again. */
  async nodeOnline(node: NodeId): Promise<void> {
    for (const attachment of this.threads.values())
      if (attachment.node === node && this.focused(attachment) && !attachment.handle)
        await this.attach(attachment).catch(() => undefined)
  }

  // ------------------------------------------------------------------ the stream's records

  private onUpdate(attachment: Attachment, update: ThreadDisplayUpdate): void {
    if (update.kind === 'snapshot') {
      // What the windows were last told: the view's, or what a whole read or the copy on disk gave them.
      const known = attachment.view.read()
      const before = known
        ? {
            questions: known.pendingQuestions.map((row) => String(row.requestId)),
            active: known.activeTurn.active === true
          }
        : attachment.served
      const resync = attachment.installed || before !== undefined
      attachment.replica = false
      attachment.served = undefined
      attachment.view.install(update.value)
      attachment.installed = true
      attachment.markReady()
      // The first live snapshot after a whole read or the offline copy, and any snapshot after the first (the
      // computer restarted, or the link was lost for long), replaces what windows hold.
      if (resync && this.focused(attachment)) this.pushResync(attachment, before)
      attachment.revision = this.sequence()
      return
    }
    this.apply(attachment, update.type, update.data, false)
  }

  private onNote(attachment: Attachment, type: string, data: unknown): void {
    this.apply(attachment, type, data, true)
  }

  private apply(attachment: Attachment, type: string, data: unknown, note: boolean): void {
    const change = attachment.view.apply(type, data)
    // A thread nobody has in view forwards only settled records, never the notes.
    if (note && !this.focused(attachment)) return
    for (const event of this.translate(attachment, type, data, change)) this.push(attachment, event)
    attachment.revision = this.sequence()
  }

  private sequence(): number {
    return this.options.services.protocolSequence()
  }

  private push(attachment: Attachment, event: LocalEvent): void {
    this.options.services.events.emit({
      channel: 'protocol:event',
      data: {
        type: event.type,
        data: event.data,
        threadId: event.threadId ?? attachment.qualified
      }
    })
  }

  /** The events a window of this computer is given for one record or note of the stream. */
  private translate(
    attachment: Attachment,
    type: string,
    data: unknown,
    change: ViewChange | undefined
  ): LocalEvent[] {
    const context = this.context(attachment.node)
    const owner = attachment.threadId
    const qualified = (eventType: string, value: unknown): unknown =>
      qualifyRoutedEvent(eventType, value, context)
    switch (type) {
      case 'thread.message':
      case 'thread.message-updated':
        return isRecord(data) ? [{ type, data: qualified(type, { message: data.message }) }] : []
      case 'thread.messages':
        return isRecord(data)
          ? [
              {
                type,
                data: qualified(type, {
                  messages: data.messages,
                  ...(data.replace ? { replace: true } : {})
                })
              }
            ]
          : []
      case 'queue.updated':
        return isRecord(data) ? [{ type, data: qualified(type, { items: data.items }) }] : []
      case 'turn.started':
      case 'turn.completed':
      case 'turn.interrupted':
      case 'turn.aborted':
      case 'turn.state':
      case 'connection.failed':
        return [{ type, data: qualified(type, isRecord(data) ? { threadId: owner, ...data } : data) }]
      case 'turn.steered':
        return isRecord(data) ? [{ type, data: qualified(type, { text: data.text }) }] : []
      case 'questions.updated': {
        const out: LocalEvent[] = []
        for (const row of change?.questions?.added ?? [])
          out.push({ type: 'questions.pending', data: qualified('questions.pending', { threadId: owner, ...row }) })
        for (const requestId of change?.questions?.removed ?? [])
          out.push({ type: 'questions.cleared', data: qualified('questions.cleared', { requestId, threadId: owner }) })
        return out
      }
      case 'subagents.updated': {
        const parent = isRecord(data) && typeof data.parentThreadId === 'string' ? data.parentThreadId : owner
        return [{ type, data: qualified(type, { parentThreadId: parent }), threadId: qualifyId(attachment.node, parent) }]
      }
      case 'agents.updated':
      case 'tasks.updated':
      case 'pullRequests.updated':
      case 'actions.updated':
      case 'workspace.updated':
      case 'thread.title-generation-failed':
        return [{ type, data: qualified(type, isRecord(data) ? { threadId: owner, ...data } : data) }]
      // The thread's row is part of the merged lists, which the lists stream feeds.
      case 'thread.metadata':
      default:
        return []
    }
  }

  /** After a new snapshot: the windows are given the whole transcript, queue and questions again. */
  private pushResync(
    attachment: Attachment,
    before?: { questions: string[]; active: boolean }
  ): void {
    const state = attachment.view.read()
    if (!state) return
    const context = this.context(attachment.node)
    const owner = attachment.threadId
    this.push(attachment, {
      type: 'thread.messages',
      data: qualifyRoutedEvent('thread.messages', { messages: state.messages, replace: true }, context)
    })
    this.push(attachment, {
      type: 'queue.updated',
      data: qualifyRoutedEvent('queue.updated', { items: state.queue }, context)
    })
    const now = new Set(state.pendingQuestions.map((row) => String(row.requestId)))
    // A prompt the window still shows that has gone away is cleared.
    for (const requestId of before?.questions ?? [])
      if (!now.has(requestId))
        this.push(attachment, {
          type: 'questions.cleared',
          data: qualifyRoutedEvent('questions.cleared', { requestId, threadId: owner }, context)
        })
    for (const row of state.pendingQuestions)
      this.push(attachment, {
        type: 'questions.pending',
        data: qualifyRoutedEvent('questions.pending', { threadId: owner, ...row }, context)
      })
    // And the turn: started, or ended, as the stream now says.
    const active = state.activeTurn.active === true
    if (active && before?.active !== true)
      this.push(attachment, {
        type: 'turn.started',
        data: qualifyRoutedEvent('turn.started', { threadId: owner }, context)
      })
    else if (!active && before?.active === true)
      this.push(attachment, {
        type: 'turn.completed',
        data: qualifyRoutedEvent('turn.completed', { threadId: owner }, context)
      })
    if (state.turnState)
      this.push(attachment, {
        type: 'turn.state',
        data: qualifyRoutedEvent('turn.state', state.turnState, context)
      })
  }

  // ------------------------------------------------------------------ snapshots

  /**
   * `thread.snapshot` for a thread of another computer. The transcript, queue and questions come from
   * the view the stream feeds; a routed read adds what the stream does not carry (agents, tasks,
   * terminals, claimed messages, activity). A computer that cannot be reached answers from the copy
   * of the stream kept on disk, marked as such.
   */
  async snapshot(node: NodeId, threadId: string, qualified: string): Promise<unknown> {
    const attachment = this.obtain(node, threadId)
    this.touch(attachment)
    let online = true
    let streamed = true
    try {
      await this.attach(attachment)
      await this.waitReady(attachment)
    } catch (error) {
      if (error instanceof DomainRpcError && error.code === 'computer_outdated') {
        // An owner from before the stream API still has the whole read.
        streamed = false
      } else {
        if (error instanceof DomainRpcError && error.code !== 'computer_offline' && error.code !== 'attach_timeout')
          throw error
        online =
          !(error instanceof DomainRpcError && error.code === 'computer_offline') &&
          !(error instanceof NetError && ['peer_offline', 'route_unreachable'].includes(error.code))
        if (!attachment.view.ready) await this.fromReplica(attachment)
      }
    }
    if (!attachment.view.ready || !streamed) {
      if (!online) throw computerOffline(this.options.computer(node))
      return this.wholeRead(attachment, node, threadId)
    }
    let extras: Json = {}
    if (online) {
      try {
        const read = await this.options.client.call(node, 'thread.snapshot', { threadId, transcript: false })
        if (isRecord(read)) extras = read
      } catch (error) {
        if (error instanceof DomainRpcError && error.code === 'computer_outdated')
          // This owner's snapshot has no way to leave the transcript out: it is read whole.
          return this.wholeRead(attachment, node, threadId)
        if (!(error instanceof DomainRpcError && error.code === 'computer_offline')) throw error
        online = false
      }
    }
    // Read after the extras, so the transcript and the queue are never older than what the extras say.
    const state = attachment.view.read()!
    const queued = new Set(state.queue.map((row) => String(row.id)))
    // An item the stream still queues is not also claimed: the stream is the newer of the two.
    const claimed = (Array.isArray(extras.claimed) ? (extras.claimed as Json[]) : []).filter(
      (row) => !queued.has(String(row.id))
    )
    const body: Json = {
      thread: state.thread,
      messages: state.messages,
      ...(state.earlier !== undefined ? { earlier: state.earlier } : {}),
      queue: state.queue,
      claimed,
      agents: extras.agents ?? [],
      tasks: extras.tasks ?? [],
      ptys: extras.ptys ?? [],
      activity: extras.activity ?? (state.activeTurn.active === true ? 'processing' : 'idle'),
      pendingQuestions: state.pendingQuestions,
      activeTurn: state.activeTurn,
      connectionFailed: state.connectionFailed || extras.connectionFailed === true,
      turnState: state.turnState ?? extras.turnState,
      turnSnapshot: extras.turnSnapshot,
      // Events with a higher number than this are not in the snapshot; the ones up to it are.
      revision: attachment.revision || this.sequence()
    }
    const result = qualifyRoutedResult('thread.snapshot', body, this.context(node)) as Json
    return {
      ...result,
      ...(online && !attachment.replica ? {} : { offline: { node, name: this.options.computer(node).name } })
    }
  }

  /** The whole snapshot, read from the owner, for when the stream cannot give the transcript. */
  private async wholeRead(attachment: Attachment, node: NodeId, threadId: string): Promise<unknown> {
    const whole = await this.options.client.call(node, 'thread.snapshot', { threadId })
    // The windows now hold this, not the stream's view: when the stream's snapshot arrives it corrects them.
    if (!attachment.view.ready && isRecord(whole)) {
      const pending = Array.isArray(whole.pendingQuestions) ? (whole.pendingQuestions as Json[]) : []
      attachment.served = {
        questions: pending.map((row) => String(row.requestId)),
        active: isRecord(whole.activeTurn) && whole.activeTurn.active === true
      }
    }
    return {
      ...(qualifyRoutedResult('thread.snapshot', whole, this.context(node)) as Json),
      revision: this.sequence()
    }
  }

  private async waitReady(attachment: Attachment): Promise<void> {
    if (attachment.view.ready) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        attachment.ready,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new DomainRpcError('attach_timeout', 'The thread did not arrive in time.')),
            READY_MS
          )
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** The thread as the copy of its stream on disk last had it, for a computer that is offline. */
  private async fromReplica(attachment: Attachment): Promise<void> {
    const ref = { nodeId: attachment.node, entityId: attachment.threadId }
    const view = new RemoteThreadView()
    let found = false
    const options = { open: () => Promise.reject(new NetError('peer_offline')) }
    try {
      found = await this.options.hub.replay(ref, options, (update) => {
        if (update.kind === 'snapshot') view.install(update.value)
        else view.apply(update.type, update.data)
      })
    } catch {
      found = false
    }
    // The live stream may have delivered its snapshot while the copy was read: the newer one stays.
    if (!found || !view.ready || attachment.view.ready) return
    attachment.view = view
    attachment.replica = true
    const read = view.read()!
    attachment.served = {
      questions: read.pendingQuestions.map((row) => String(row.requestId)),
      active: read.activeTurn.active === true
    }
    attachment.markReady()
  }

  // ------------------------------------------------------------------ the channel stream

  /** The stream this computer reads for the progress of the Git actions it starts on `node`. */
  channel(node: NodeId): Promise<void> {
    let held = this.channels.get(node)
    if (!held) {
      const { hub, client } = this.options
      held = (async () => {
        const handle = await hub.attach(
          { nodeId: node, entityId: CHANNEL_ENTITY },
          (update) => {
            if (update.kind === 'event' && update.type === 'git.operation')
              this.options.onGit(node, update.data)
          },
          () => {
            this.channels.delete(node)
            this.channelHandles.delete(node)
          },
          {
            // Git progress has rooms of its own, so threads in view never crowd it out (nor it them).
            room: 'channel',
            open: async () => {
              const opened = await client.openStream(node, { kind: 'channel' })
              return { descriptor: opened.descriptor as StreamDescriptor, head: opened.head }
            }
          }
        )
        this.channelHandles.set(node, handle)
      })()
      this.channels.set(node, held)
      held.catch(() => this.channels.delete(node))
    }
    return held
  }

  close(): void {
    this.closed = true
    for (const attachment of [...this.threads.values()]) this.drop(attachment)
    for (const handle of this.channelHandles.values()) handle.close()
    this.channelHandles.clear()
    this.channels.clear()
    this.leases.clear()
  }
}
