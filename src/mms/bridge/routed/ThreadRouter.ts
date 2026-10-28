import {
  ROUTED_FORBIDDEN_KEYS,
  ROUTED_METHODS,
  type RoutedRow
} from '../../../shared/bridge/routed'
import {
  outgoingMessageText,
  qualifyRoutedResult,
  unqualifyRoutedParams,
  type QualifyContext
} from '../../../shared/bridge/routedIds'
import type { NodeDelegation, NodeId, Roster } from '../../../shared/net'
import { isId } from '../../../shared/net'
import { parseQualifiedId, qualifyId } from '../../../shared/threadRef'
import type { MmsProfileServices } from '../../MmsProfileServices'
import type { NetService } from '../../net/NetService'
import { DomainRpcError } from '../../protocol/domainRegistry'
import type { HandlerContext } from '../../protocol/handlers'
import type { ThreadRouterPort } from '../../protocol/threadRouterPort'
import { listedProjectsFor, listedThreadsFor } from '../../protocol/threadVisibility'
import type { BridgeHub } from '../hub'
import { isListedComputer } from './listRows'
import type { MergedLists } from './mergedLists'
import {
  mixedComputers,
  notAvailableRemotely,
  translateNetError,
  type ComputerRef
} from './computerErrors'
import { RoutedClient } from './RoutedClient'
import { RoutedStager } from './stager'
import { AttachedThreads } from './attachedThreads'
import { AttachedTerminals } from './attachedTerminals'
import { deviceNameOf } from './deviceName'

/** Methods whose result on this computer carries the complete list of threads or projects. */
const RESULT_WITH_THREADS = new Set([
  'threads.create',
  'threads.delete',
  'threads.rename',
  'threads.pin',
  'threads.settle',
  'threads.regenerateTitle',
  'threads.setModel',
  'threads.setWorktreeEnabled',
  'threads.setPermissionMode',
  'pullRequests.link',
  'pullRequests.startThread',
  'pullRequests.unlink',
  'pullRequests.watch'
])
const RESULT_WITH_PROJECTS = new Set(['projects.open', 'projects.remove', 'projects.rename', 'projects.pin'])
/** Git actions that report progress; it travels on the channel stream to the window that started the action. */
const GIT_PROGRESS = new Set([
  'git.checkout',
  'git.commit',
  'git.push',
  'git.fetch',
  'git.pull',
  'git.createBranch',
  'git.renameBranch',
  'git.deleteBranch'
])
/** Methods a person uses to send a message: the thread they are sent in moves to the front. */
const SENDS = new Set(['orchestrator.send', 'queue.enqueue'])
/** Methods whose request id the caller supplies, so a retry of the same request reaches the same execution. */
const REQUEST_ID_IS_IDEM = new Set(['orchestrator.send', 'queue.enqueue'])

/** Keys a window sends that name this computer's own binding; the owner supplies its own. */
const LOCAL_BINDING_KEYS = ['profileId', 'expectedProfileId']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export interface ThreadRouterOptions {
  services: MmsProfileServices
  net: Pick<NetService, 'session' | 'featureEnabled' | 'runtime'>
  hub: BridgeHub
  /** Ends every wait when the profile closes. */
  signal: AbortSignal
  /** Tests inject a client with other timings. */
  client?: RoutedClient
  /** How long a thread nobody has in view stays attached (default 10 minutes). */
  idleMs?: number
  /** Threads attached at once per computer (default 16) and in all (default 32). */
  maxPerComputer?: number
  maxTotal?: number
}

/**
 * Sends a call that names a thread or project of another of the user's computers to the computer that
 * runs it, and brings back what it answers as if this computer had run it.
 *
 * It serves windows only (`gui` connections): the CLI and the agents of this computer never route, so
 * an agent cannot act on another computer's threads through the daemon of this one. A call names its
 * computer by qualified ids (`<node>:<thread>`); a call that names two computers, or one and this
 * one, is refused. The call is a row of the routed table, so it reaches only what the owner offers.
 */
export class ThreadRouter implements ThreadRouterPort {
  readonly client: RoutedClient
  readonly attached: AttachedThreads
  /** The terminals this computer opened on other computers: their output and their numbered input. */
  readonly terminals: AttachedTerminals
  /** Git actions in progress on another computer, with the window that started each. */
  private readonly git = new Map<string, { connection: string; emit: NonNullable<HandlerContext['connection']>['emitConnectionEvent']; until?: number }>()

  constructor(private readonly options: ThreadRouterOptions) {
    const { services, net } = options
    this.client =
      options.client ??
      new RoutedClient({
        session: (node) => net.session(node),
        computer: (node) => this.computer(node),
        signal: options.signal,
        stager: new RoutedStager({
          identity: net.runtime().identity,
          keys: net.runtime().keys,
          clock: { now: () => Date.now() }
        })
      })
    this.attached = new AttachedThreads({
      services,
      hub: options.hub,
      client: this.client,
      self: () => net.runtime().identity.self()?.node,
      idleMs: options.idleMs,
      maxPerComputer: options.maxPerComputer,
      maxTotal: options.maxTotal,
      onGit: (node, data) => this.gitProgress(data),
      onMetadata: (node, thread) => this.lists?.applyMetadata(node, thread),
      computer: (node) => this.computer(node)
    })
    this.terminals = new AttachedTerminals({ services, hub: options.hub, client: this.client })
    // A window that goes away takes its leases with it.
    this.offClosed = services.domains?.onConnectionClosed((id) => this.connectionClosed(id))
  }
  private offClosed?: () => void
  /** Window bindings whose end is already watched. */
  private readonly watched = new WeakSet<AbortSignal>()

  /** Whether routing is on for this profile: Bridge is on and so is the routing flag. */
  enabled(): boolean {
    const { net } = this.options
    return net.featureEnabled('netBridge') && net.featureEnabled('netBridgeThreads')
  }

  computer(node: NodeId): ComputerRef {
    return { node, name: this.nameOf(node) }
  }

  /** The merged lists of the other computers, told what a person does here (opens, sends). */
  setLists(lists: Pick<MergedLists, 'noteOpened' | 'noteSent' | 'applyMetadata'> | undefined): void {
    this.lists = lists
  }
  private lists?: Pick<MergedLists, 'noteOpened' | 'noteSent' | 'applyMetadata'>

  /**
   * The other computers of the user whose threads are listed: devices of the roster that are not this one, not
   * revoked, not blocked here, and not phones. The kind the authority recorded wins; a device of unknown kind
   * counts only if its signed delegation holds "Works on threads". `undefined` when the roster cannot be read.
   */
  pairedComputers(): ComputerRef[] | undefined {
    try {
      const rt = this.options.net.runtime()
      const identity = rt.identity
      const self = identity.self()
      const root = self && identity.pinnedRootKey(self.user)
      const signed = self && identity.roster(self.user)
      if (!self || !root || !signed) return undefined
      const roster = identity.verifySigned<Roster>(signed, root)
      const latest = new Map<string, NodeDelegation>()
      for (const row of roster.nodes) {
        const found = identity.verifySigned<NodeDelegation>(row, root)
        const known = latest.get(found.subject)
        if (!known || found.keyEpoch > known.keyEpoch || (found.keyEpoch === known.keyEpoch && found.issuedAt > known.issuedAt))
          latest.set(found.subject, found)
      }
      return [...latest.values()]
        .filter(
          (found) =>
            found.subject !== self.node &&
            !roster.revoked.some((row) => row.subject === found.subject && row.throughKeyEpoch >= found.keyEpoch) &&
            !rt.policy.get(found.subject as NodeId).blocked &&
            isListedComputer(rt.enrollment.nodeKind(found.subject as NodeId), found.caps)
        )
        .map((found) => ({ node: found.subject as NodeId, name: found.name || 'the other computer' }))
    } catch {
      return undefined
    }
  }

  /** Whether a session with `node` is open. */
  isOnline(node: NodeId): boolean {
    try {
      this.options.net.session(node)
      return true
    } catch {
      return false
    }
  }

  private nameOf(node: NodeId): string {
    try {
      return deviceNameOf(this.options.net.runtime().identity, node, 'the other computer')
    } catch {
      return 'the other computer'
    }
  }

  private selfNode(): string | undefined {
    try {
      return this.options.net.runtime().identity.self()?.node
    } catch {
      return undefined
    }
  }

  async dispatch(
    ctx: HandlerContext,
    method: string,
    params: unknown
  ): Promise<{ result: unknown } | undefined> {
    // `threads.focus` is the router's own method: the handler calls `focus` below. Reordering is an overlay
    // this computer keeps for itself: the handler places the rows of other computers among its own.
    if (method === 'threads.focus' || !this.enabled() || !isRecord(params)) return undefined
    // A CLI that names a qualified id is still refused below; a window's drag is the handler's to place.
    if ((method === 'threads.reorder' || method === 'projects.reorder') && ctx.connection?.clientType === 'gui')
      return undefined
    const row = ROUTED_METHODS[method]
    const split = unqualifyRoutedParams(params)
    const target = this.targetNode(row, params)
    const nodes = [...new Set([...split.nodes, ...(target ? [target] : [])])]
    if (!nodes.length) return undefined
    // Only a window routes. The CLI and the agents' shells reach the daemon as other kinds of connection.
    if (ctx.connection?.clientType !== 'gui')
      throw new DomainRpcError(
        'forbidden',
        'Only a Mousse window can work on a thread of another computer.'
      )
    if (nodes.length > 1 || split.hasLocal) throw mixedComputers()
    const node = nodes[0] as NodeId
    if (node === this.selfNode())
      throw new DomainRpcError('invalid_params', 'That thread is on this computer. Use its own id.')
    const computer = this.computer(node)
    if (!row) throw notAvailableRemotely(computer, method)
    const context: QualifyContext = { node, self: this.selfNode() }
    const owner = this.ownerParams(method, row, split.params, context)

    if (method === 'thread.snapshot') {
      const threadId = owner.threadId as string
      const qualified = qualifyId(node, threadId)
      return { result: await this.attached.snapshot(node, threadId, qualified) }
    }
    if (method === 'git.cancelOperation') return { result: this.cancelGit(ctx, owner, node, method) }
    // Input and resizes are numbered and go one at a time, in the window's order (see `AttachedTerminals.input`).
    if (row.sequenced)
      return {
        result: await this.terminals.input(
          node,
          owner.threadId as string,
          owner.ptyId as string,
          method as 'pty.write' | 'pty.resize',
          owner,
          ctx.connection?.lifetime ? { signal: ctx.connection.lifetime } : {}
        )
      }

    const progress = GIT_PROGRESS.has(method) ? this.followGit(ctx, owner) : undefined
    if (progress) await this.attached.channel(node).catch(() => undefined)
    let raw: unknown
    try {
      raw = await this.client.call(node, method, owner, {
        idem: this.idemOf(method, params),
        // The window that asked going away (or switching profile) ends the call.
        ...(ctx.connection?.lifetime ? { signal: ctx.connection.lifetime } : {})
      })
    } catch (error) {
      progress?.end()
      // A terminal that is not there any more has nothing left to read.
      if (method === 'pty.kill' && error instanceof DomainRpcError && error.code === 'pty_not_found')
        this.terminals.forget(node, owner.ptyId as string)
      throw error
    } finally {
      progress?.release()
    }
    progress?.end()
    if (method.startsWith('pty.')) this.readTerminals(node, method, owner, raw)
    // A person's send from here moves the thread to the front of its group, as it does on its own computer.
    if (SENDS.has(method) && typeof params.threadId === 'string') this.lists?.noteSent(params.threadId)
    let result = qualifyRoutedResult(method, raw, context)
    if (isRecord(result)) result = this.withLocalLists(ctx, method, result)
    return { result }
  }

  /**
   * What a terminal call of this computer's window means for reading the terminal's output: a terminal that was
   * opened, or found alive, starts to be read; one that was stopped is let go of. The output follows on its own
   * stream, so these never wait for it.
   */
  private readTerminals(node: NodeId, method: string, owner: Record<string, unknown>, raw: unknown): void {
    const threadId = owner.threadId as string
    if (!isRecord(raw)) return
    switch (method) {
      case 'pty.create':
        if (typeof raw.ptyId === 'string')
          // Opened here: its input counts from 0.
          this.terminals.ensure(node, threadId, raw.ptyId, typeof owner.agentId === 'string' ? owner.agentId : undefined, 0, true)
        break
      case 'pty.isAlive':
      case 'pty.lookup':
        if (raw.alive === true && typeof owner.ptyId === 'string')
          this.terminals.ensure(node, threadId, owner.ptyId, typeof raw.agentId === 'string' ? raw.agentId : undefined, typeof raw.lastSeq === 'number' ? raw.lastSeq : undefined)
        break
      case 'pty.list':
        for (const entry of Array.isArray(raw.ptys) ? raw.ptys : [])
          if (isRecord(entry) && typeof entry.ptyId === 'string')
            this.terminals.ensure(node, threadId, entry.ptyId, typeof entry.agentId === 'string' ? entry.agentId : undefined, typeof entry.lastSeq === 'number' ? entry.lastSeq : undefined)
        break
      case 'pty.kill':
        if (typeof owner.ptyId === 'string') this.terminals.forget(node, owner.ptyId)
        break
    }
  }

  /** The computer a call names without naming a thread: `threads.create { node }`, `composer.options { node }`. */
  private targetNode(row: RoutedRow | undefined, params: Record<string, unknown>): string | undefined {
    if (row?.target !== 'computer' || typeof params.node !== 'string') return undefined
    if (!isId('node', params.node)) throw new DomainRpcError('invalid_params', 'node is not a computer.')
    return params.node
  }

  /** What the owner is asked: its own ids, and none of the keys that only name this computer's binding. */
  private ownerParams(
    method: string,
    row: RoutedRow,
    given: Record<string, unknown>,
    context: QualifyContext
  ): Record<string, unknown> {
    const params: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(given)) {
      if (value === undefined || key === 'node') continue
      if (LOCAL_BINDING_KEYS.includes(key)) continue
      // A window labels a send `gui`; the owner decides the source of a routed call itself.
      if (key === 'source' && value === 'gui') continue
      // The owner answers a send once the turn is admitted, however long the turn runs.
      if (key === 'await' && method === 'orchestrator.send') continue
      // Numbers belong to the router: a window never picks one.
      if ((ROUTED_FORBIDDEN_KEYS as readonly string[]).includes(key) || !row.keys.includes(key) || (key === 'seq' && row.sequenced))
        throw new DomainRpcError('invalid_params', `${method} does not take ${key} for a thread on another computer.`)
      // References in the text name threads the way the owner does.
      params[key] =
        typeof value === 'string' && (key === 'content' || key === 'text' || key === 'message')
          ? outgoingMessageText(value, context)
          : value
    }
    return params
  }

  private idemOf(method: string, params: Record<string, unknown>): string | undefined {
    if (typeof params.clientRequestId === 'string' && params.clientRequestId) return params.clientRequestId
    if (REQUEST_ID_IS_IDEM.has(method) && typeof params.requestId === 'string' && params.requestId)
      return params.requestId
    return undefined
  }

  /** Re-adds the lists a local result carries; the owner's own lists are not sent. */
  private withLocalLists(
    ctx: HandlerContext,
    method: string,
    result: Record<string, unknown>
  ): Record<string, unknown> {
    const { services } = this.options
    const out = { ...result }
    if (RESULT_WITH_THREADS.has(method)) out.threads = listedThreadsFor(ctx, services.threads.listAllThreads())
    if (RESULT_WITH_PROJECTS.has(method)) out.projects = listedProjectsFor(ctx, services.projects.listProjects())
    return out
  }

  // ------------------------------------------------------------------ Git progress

  /** Remembers the window that starts a Git action on another computer, so its progress goes there alone. */
  private followGit(
    ctx: HandlerContext,
    owner: Record<string, unknown>
  ): { end(): void; release(): void } | undefined {
    const operationId = typeof owner.operationId === 'string' ? owner.operationId : undefined
    const emit = ctx.connection?.emitConnectionEvent
    if (!operationId || !emit || !ctx.connection) return undefined
    this.git.set(operationId, { connection: ctx.connection.id, emit })
    return {
      // Progress that is still on its way when the call returns is delivered for a few seconds.
      end: () => {
        const entry = this.git.get(operationId)
        if (entry) entry.until = Date.now() + 5_000
      },
      release: () => {
        const timer = setTimeout(() => {
          const entry = this.git.get(operationId)
          if (entry?.until !== undefined && entry.until <= Date.now()) this.git.delete(operationId)
        }, 5_500)
        timer.unref?.()
      }
    }
  }

  private gitProgress(data: unknown): void {
    const operationId = (data as { event?: { operationId?: unknown } } | null)?.event?.operationId
    if (typeof operationId !== 'string') return
    const entry = this.git.get(operationId)
    if (!entry) return
    void entry.emit?.('git.operation', data).catch(() => undefined)
  }

  /** Only the window that started a Git action can stop it; any other is told it is not running. */
  private cancelGit(
    ctx: HandlerContext,
    owner: Record<string, unknown>,
    node: NodeId,
    method: string
  ): unknown {
    const operationId = typeof owner.operationId === 'string' ? owner.operationId : undefined
    const entry = operationId ? this.git.get(operationId) : undefined
    if (!operationId || !entry || entry.connection !== ctx.connection?.id) return { cancelled: false }
    // The owner stops the action its channel started; the call carries no other identity.
    return this.client
      .call(node, method, owner, ctx.connection?.lifetime ? { signal: ctx.connection.lifetime } : {})
      .then((result) => result)
      .catch((error: unknown) => {
        throw translateNetError(error, this.computer(node), method) ?? error
      })
  }

  // ------------------------------------------------------------------ views

  async focus(
    ctx: HandlerContext,
    threadId: string,
    focused: boolean
  ): Promise<{ routed: boolean; focused: boolean }> {
    const ref = parseQualifiedId(threadId)
    if (!ref || !this.enabled()) return { routed: false, focused: false }
    if (ctx.connection?.clientType !== 'gui')
      throw new DomainRpcError('forbidden', 'Only a Mousse window can work on a thread of another computer.')
    if (ref.node === this.selfNode())
      throw new DomainRpcError('invalid_params', 'That thread is on this computer. Use its own id.')
    const lease = ctx.connection.id
    if (!focused) {
      this.attached.unfocus(lease, ref.node as NodeId, ref.id)
      return { routed: true, focused: false }
    }
    // The lease ends with the window's binding: when the window closes or switches to another profile its
    // signal aborts, and this profile's attachments stop forwarding for it.
    const lifetime = ctx.connection.lifetime
    if (lifetime) {
      if (lifetime.aborted) return { routed: true, focused: false }
      if (!this.watched.has(lifetime)) {
        this.watched.add(lifetime)
        lifetime.addEventListener('abort', () => this.attached.dropLeases(lease), { once: true })
      }
    }
    // A thread opened here notifies for the next seven days.
    this.lists?.noteOpened(threadId)
    await this.attached.focus(lease, ref.node as NodeId, ref.id)
    return { routed: true, focused: true }
  }

  connectionClosed(id: string): void {
    this.attached.dropLeases(id)
    for (const [operation, entry] of this.git) if (entry.connection === id) this.git.delete(operation)
  }

  /** A session with `node` opened: what windows have in view there is attached again. */
  nodeOnline(node: NodeId): void {
    void this.attached.nodeOnline(node)
    this.terminals.nodeOnline(node)
  }

  close(): void {
    this.offClosed?.()
    this.attached.close()
    this.terminals.close()
    this.git.clear()
  }
}

