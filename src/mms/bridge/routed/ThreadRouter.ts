import {
  ROUTED_FORBIDDEN_KEYS,
  ROUTED_METHODS,
  type RoutedRow
} from '../../../shared/bridge/routed'
import {
  qualifyRoutedEvent,
  qualifyRoutedResult,
  unqualifyRoutedParams,
  type QualifyContext
} from '../../../shared/bridge/routedIds'
import type { Roster, NodeDelegation, NodeId } from '../../../shared/net'
import { isId } from '../../../shared/net'
import { parseQualifiedId, qualifyId } from '../../../shared/threadRef'
import type { MmsProfileServices } from '../../MmsProfileServices'
import type { NetService } from '../../net/NetService'
import { DomainRpcError } from '../../protocol/domainRegistry'
import type { HandlerContext } from '../../protocol/handlers'
import type { ThreadRouterPort } from '../../protocol/threadRouterPort'
import { visibleThreadsFor } from '../../protocol/threadVisibility'
import type { BridgeHub } from '../hub'
import {
  mixedComputers,
  notAvailableRemotely,
  translateNetError,
  type ComputerRef
} from './computerErrors'
import { RoutedClient } from './RoutedClient'
import { RoutedStager } from './stager'
import { AttachedThreads } from './attachedThreads'

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
      computer: (node) => this.computer(node)
    })
    // A window that goes away takes its leases with it.
    this.offClosed = services.domains?.onConnectionClosed((id) => this.connectionClosed(id))
  }
  private offClosed?: () => void

  /** Whether routing is on for this profile: Bridge is on and so is the routing flag. */
  enabled(): boolean {
    const { net } = this.options
    return net.featureEnabled('netBridge') && net.featureEnabled('netBridgeThreads')
  }

  computer(node: NodeId): ComputerRef {
    return { node, name: this.nameOf(node) }
  }

  private nameOf(node: NodeId): string {
    try {
      const identity = this.options.net.runtime().identity
      const self = identity.self()
      const root = self && identity.pinnedRootKey(self.user)
      const signed = self && identity.roster(self.user)
      if (root && signed) {
        const roster = identity.verifySigned<Roster>(signed, root)
        const found = roster.nodes
          .map((row) => identity.verifySigned<NodeDelegation>(row, root))
          .filter((row) => row.subject === node)
          .sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0]
        if (found?.name) return found.name
      }
    } catch {
      // The name is only for the message.
    }
    return 'the other computer'
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
    // `threads.focus` is the router's own method: the handler calls `focus` below.
    if (method === 'threads.focus' || !this.enabled() || !isRecord(params)) return undefined
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
    const owner = this.ownerParams(method, row, split.params)
    const context: QualifyContext = { node, self: this.selfNode() }

    if (method === 'thread.snapshot') {
      const threadId = owner.threadId as string
      const qualified = qualifyId(node, threadId)
      return { result: await this.attached.snapshot(node, threadId, qualified) }
    }
    if (method === 'git.cancelOperation') return { result: this.cancelGit(ctx, owner, node, method) }

    const progress = GIT_PROGRESS.has(method) ? this.followGit(ctx, owner) : undefined
    if (progress) await this.attached.channel(node).catch(() => undefined)
    let raw: unknown
    try {
      raw = await this.client.call(node, method, owner, { idem: this.idemOf(method, params) })
    } catch (error) {
      progress?.end()
      throw error
    } finally {
      progress?.release()
    }
    progress?.end()
    let result = qualifyRoutedResult(method, raw, context)
    if (isRecord(result)) result = this.withLocalLists(ctx, method, result)
    return { result }
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
    given: Record<string, unknown>
  ): Record<string, unknown> {
    const params: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(given)) {
      if (value === undefined || key === 'node') continue
      if (LOCAL_BINDING_KEYS.includes(key)) continue
      // A window labels a send `gui`; the owner decides the source of a routed call itself.
      if (key === 'source' && value === 'gui') continue
      // The owner answers a send once the turn is admitted, however long the turn runs.
      if (key === 'await' && method === 'orchestrator.send') continue
      if ((ROUTED_FORBIDDEN_KEYS as readonly string[]).includes(key) || !row.keys.includes(key))
        throw new DomainRpcError('invalid_params', `${method} does not take ${key} for a thread on another computer.`)
      params[key] = value
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
    if (RESULT_WITH_THREADS.has(method)) {
      const all = services.threads.listAllThreads()
      out.threads = visibleThreadsFor(ctx.connection, all, all)
    }
    if (RESULT_WITH_PROJECTS.has(method)) out.projects = services.projects.listProjects()
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
      .call(node, method, owner)
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
  }

  close(): void {
    this.offClosed?.()
    this.attached.close()
    this.git.clear()
  }
}

