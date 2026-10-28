import { createHash } from 'node:crypto'
import { isAbsolute, win32 } from 'node:path'
import { NetError, isBlobId, isId, type NodeId, type RpcArtifactRef } from '../../../shared/net'
import type { NodeCapability } from '../../../shared/net'
import {
  ROUTED_FORBIDDEN_KEYS,
  ROUTED_LARGE_READS,
  ROUTED_LARGE_READS_PER_CALLER,
  ROUTED_LEDGER_RESULT_MAX_BYTES,
  ROUTED_LOCAL_LIST_FIELDS,
  ROUTED_PTY_INPUT_MAX_CHARS,
  ROUTED_PTY_MAX_COLS,
  ROUTED_PTY_MAX_ROWS,
  ROUTED_QUEUE_LIST_FIELD,
  ROUTED_METHODS,
  ROUTED_REPLY_MAX_BYTES,
  ROUTED_SNAPSHOT_MESSAGE_BYTES,
  ROUTED_STAGED_KEY,
  ROUTED_STAGED_MAX_PER_CALL,
  ROUTED_STREAM_KINDS,
  ROUTED_TRANSPORT_METHODS,
  isStageId,
  routedNetMethod,
  type RoutedPage,
  type RoutedPagedReply,
  type RoutedReply,
  type RoutedRefusal,
  type RoutedRow,
  type RoutedStreamKind,
  type RoutedStreamOpened
} from '../../../shared/bridge/routed'
import { WORKFLOW_RUN_CAPABILITY } from '../../../shared/workflowRunPlatform'
import { isProjectShellAgentId } from '../../../shared/types'
import {
  AppError,
  errorDiagnostic,
  knownAppError,
  normalizeAppError,
  serializeAppError
} from '../../../shared/errors'
import type { ProtocolConnectionEventType } from '../../protocol/types'
import { GIT_OPERATIONS_CAPABILITY } from '../../protocol/types'
import { DomainRpcError, type DomainConnectionContext } from '../../protocol/domainRegistry'
import { dispatchMethod, type HandlerContext } from '../../protocol/handlers'
import { resolveThreadProjectPath } from '../../data/resolveActiveProjectPath'
import { CommandRejection } from '../../run/db/RunStoreError'
import { QueueConflictError, QueueValidationError } from '../../queue/ThreadMessageQueue'
import type { MmsProfileServices } from '../../MmsProfileServices'
import type { Clock, RpcContext, RpcDispatcher, RpcMethod } from '../../net/contracts'
import { systemClock } from '../../net/clock'
import type { SqliteBridgeAudit } from '../../net/store/audit'
import type { SqliteNodePolicy } from '../../net/store/nodePolicy'
import { MmsRemoteBackend, withImageBudget, withoutImageData } from '../remote/MmsBackend'
import type { BridgeOrdinaryMethod } from '../remote/capabilities'
import { mmsJson } from '../remote/jsonOutput'
import { newestMessages } from '../../protocol/transcriptPaging'
import { ReplyPages } from './pages'
import { cleanUpBlockedDevice } from './blockCleanup'
import type { RoutedStaging } from './staging'
import { RoutedTerminals, type TerminalClaim } from './terminals'

/** Ids are text of this length at most, as in the protocol handlers. */
const ID_MAX = 256

/** The private streams a computer can open on this one. Implemented by the Bridge profile service. */
export interface RoutedStreamsPort {
  /** Opens (or reopens) the stream `caller` reads and nobody else may. */
  open(
    caller: NodeId,
    request: { kind: RoutedStreamKind; threadId?: string; ptyId?: string }
  ): RoutedStreamOpened
  /** Stops serving the stream `caller` opened, which it no longer reads. Its records stay; it can open it again. */
  close(caller: NodeId, request: { kind: RoutedStreamKind; threadId?: string; ptyId?: string }): void
  /** Where the stream `caller` holds open for `threadId` is now, if it holds one. */
  head(caller: NodeId, threadId: string): { stream: string; epoch: number; seq: number } | undefined
}

export interface OwnerRoutesOptions {
  services: MmsProfileServices
  rpc: RpcDispatcher
  /** What this computer lets each device do here. */
  policy: Pick<SqliteNodePolicy, 'get' | 'list' | 'onChange'>
  audit: Pick<SqliteBridgeAudit, 'record' | 'countRead' | 'has'>
  /** Keeps a call owned by the profile, so it drains when the profile closes. */
  track<T>(work: Promise<T>): Promise<T>
  /**
   * Delivers a connection event (a Git action's progress) to the window of the calling computer that
   * started it. Absent until the caller's private channel exists; then a routed Git action runs
   * without progress, and the call's own reply still carries the outcome.
   */
  connectionEvent?: (
    caller: { node: NodeId },
    type: ProtocolConnectionEventType,
    data: unknown,
    signal?: AbortSignal
  ) => Promise<void>
  clock?: Pick<Clock, 'now'>
  /** Where a read too large for one reply waits to be fetched in pages. */
  pages?: ReplyPages
  /** Large values sent ahead of a call. Without it a call cannot stage, and `routed.stage` is not offered. */
  staging?: RoutedStaging
  /** Private streams. Without them `routed.stream.open` is not offered. */
  streams?: RoutedStreamsPort
  /** Whether a session with `node` is open now: a device that has been away too long has its terminals ended. */
  connected?: (node: NodeId) => boolean
  /** The name this computer knows a device by. */
  deviceName?: (node: NodeId) => string
  /**
   * The first terminal a device ever opens here. Where a window of this computer can show a desktop
   * notification it does (the daemon sends the event); a computer with no window has the audit row only.
   */
  onFirstTerminal?: (info: { node: NodeId; name: string; threadId: string }) => void
  /**
   * The first time a device changes something on a thread here: a desktop notice for the owner, who is told
   * what that computer can now do and where to limit it. Written to the audit too (`thread.first_use`).
   */
  onFirstUse?: (info: { node: NodeId; name: string; threadId?: string }) => void
  /**
   * The first folder a device registers as a project here (`projects.open`): a desktop notice for the owner, and a
   * row of its own in the audit (`project.first_open`). It stands in for the first-use notice when both are due.
   */
  onFirstProject?: (info: { node: NodeId; name: string; projectName?: string }) => void
  /** How long a device may be away before its terminals end, and how often that is looked at (tests shorten them). */
  terminalAwayMs?: number
  terminalSweepMs?: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= ID_MAX && !value.includes('\0')

/** A transport call takes exactly its keys: the object, no key the method does not name, and every key it requires. */
function exactKeys(
  method: string,
  keys: readonly string[],
  value: unknown
): Record<string, unknown> {
  if (!isPlainObject(value)) throw new NetError('bad_request', 'A routed call takes an object.')
  for (const key of Object.keys(value))
    if (!keys.includes(key) || key === '__proto__' || key === 'constructor')
      throw new NetError('bad_request', `routed.${method} does not take ${key}.`)
  const required = (ROUTED_TRANSPORT_METHODS[method]?.required ?? []) as readonly string[]
  for (const key of required)
    if (value[key] === undefined)
      throw new NetError('bad_request', `routed.${method} needs ${key}.`)
  return value
}

/** A path given as a path of the caller's own disk, which a routed call never takes (only `projects.open` names one). */
function looksAbsolute(path: string): boolean {
  return (
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    /^[a-zA-Z]:/.test(path) ||
    path.startsWith('\\\\') ||
    path.startsWith('//')
  )
}

/**
 * Checks a routed call's params against its row before it is admitted: exactly the row's keys (many
 * handlers ignore extra keys, so the owner does not rely on them), the keys no routed call may carry,
 * the ids the row's target needs, and no absolute path.
 */
export function validateRoutedParams(
  method: string,
  row: RoutedRow,
  value: unknown
): Record<string, unknown> {
  if (!isPlainObject(value)) throw new NetError('bad_request', 'A routed call takes an object.')
  for (const key of Object.keys(value)) {
    if ((ROUTED_FORBIDDEN_KEYS as readonly string[]).includes(key) || !row.keys.includes(key))
      throw new NetError('bad_request', `${method} does not take ${key}.`)
    if (key === '__proto__' || key === 'constructor' || key === 'prototype')
      throw new NetError('bad_request')
  }
  const staged = value[ROUTED_STAGED_KEY]
  if (staged !== undefined) {
    // A value is either in the call or staged for it, never both, and only the values the row names may be staged.
    if (
      !isPlainObject(staged) ||
      !Object.keys(staged).length ||
      Object.keys(staged).length > ROUTED_STAGED_MAX_PER_CALL
    )
      throw new NetError(
        'bad_request',
        `${ROUTED_STAGED_KEY} names the values staged for the call.`
      )
    for (const [key, id] of Object.entries(staged))
      if (!row.stageable?.includes(key) || value[key] !== undefined || !isStageId(id))
        throw new NetError('bad_request', `${method} cannot stage ${key}.`)
  }
  for (const key of row.required ?? [])
    if (value[key] === undefined && !(isPlainObject(staged) && Object.hasOwn(staged, key)))
      throw new NetError('bad_request', `${method} needs ${key}.`)
  const threadKey = row.threadIds?.[0] ?? 'threadId'
  switch (row.target) {
    case 'thread':
      if (!text(value[threadKey]))
        throw new NetError('bad_request', `${method} needs ${threadKey}.`)
      break
    case 'project':
      if (!text(value.projectId)) throw new NetError('bad_request', `${method} needs projectId.`)
      break
    case 'folder': {
      // A thread or a project, never both and never neither: there is no home folder to fall back to.
      const thread = value.threadId !== undefined,
        project = value.projectId !== undefined
      if (thread === project)
        throw new NetError('bad_request', `${method} needs a threadId or a projectId.`)
      if (thread ? !text(value.threadId) : !text(value.projectId)) throw new NetError('bad_request')
      break
    }
    case 'computer':
      break
  }
  for (const key of [
    'threadId',
    'projectId',
    'originThreadId',
    'sourceThreadId',
    'forkThreadId',
    'runId',
    'ptyId'
  ])
    if (value[key] !== undefined && !text(value[key]))
      throw new NetError('bad_request', `${key} is not valid.`)
  if (!row.absolutePath)
    for (const key of ['path', 'oldPath'])
      if (
        value[key] !== undefined &&
        (typeof value[key] !== 'string' ||
          (value[key] as string).includes('\0') ||
          looksAbsolute(value[key] as string))
      )
        throw new NetError('bad_request', `${key} must be a path inside the thread's folder.`)
  if (row.sequenced) {
    if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 1)
      throw new NetError('bad_request', `${method} needs a number (seq) of 1 or more.`)
    if (
      value.data !== undefined &&
      (typeof value.data !== 'string' || value.data.length > ROUTED_PTY_INPUT_MAX_CHARS)
    )
      throw new NetError('bad_request', `data is a text of at most ${ROUTED_PTY_INPUT_MAX_CHARS} characters.`)
    for (const [key, max] of [
      ['cols', ROUTED_PTY_MAX_COLS],
      ['rows', ROUTED_PTY_MAX_ROWS]
    ] as const)
      if (
        value[key] !== undefined &&
        (!Number.isSafeInteger(value[key]) || (value[key] as number) < 1 || (value[key] as number) > max)
      )
        throw new NetError('bad_request', `${key} is a whole number from 1 to ${max}.`)
    if (method === 'pty.resize' && (value.cols === undefined || value.rows === undefined))
      throw new NetError('bad_request', 'pty.resize needs cols and rows.')
  }
  // A terminal opened from another computer is a project shell, like the ones its own panel opens.
  if (method === 'pty.create' && !isProjectShellAgentId(String(value.agentId)))
    throw new NetError('bad_request', 'A terminal from another computer is a project shell.')
  return value
}

/**
 * The owner side of the routed API: every row of `ROUTED_METHODS` is a Net method `routed.<method>`
 * that runs the same protocol handler a Mousse window on this computer would, as a person on another
 * of the user's computers (`clientType: 'bridge'`).
 *
 * Who may call is decided before a handler runs, by the `routed` family checks in `NetService` (the
 * "Works on threads" grant, not blocked here, the owner's switch, the terminal switch). This class
 * decides what a call may touch: the row's exact keys, a thread or project that is in this profile,
 * and secondary ids that belong to the thread.
 */
export class OwnerRoutes {
  private readonly backend: MmsRemoteBackend
  readonly pages: ReplyPages
  /** The terminals other computers opened here, who opened them, and when each has to end. */
  readonly terminals: RoutedTerminals
  private readonly clock: Pick<Clock, 'now'>
  constructor(private readonly options: OwnerRoutesOptions) {
    this.backend = new MmsRemoteBackend(
      options.services,
      () => options.services.protocolSequence(),
      undefined,
      (node) => options.policy.get(node).maxPermissionMode
    )
    this.clock = options.clock ?? systemClock
    this.pages = options.pages ?? new ReplyPages(this.clock)
    this.terminals = new RoutedTerminals({
      services: options.services,
      audit: options.audit,
      clock: this.clock,
      connected: options.connected,
      name: options.deviceName,
      awayMs: options.terminalAwayMs,
      sweepMs: options.terminalSweepMs
    })
    options.services.routedTerminals = this.terminals
  }

  register(): void {
    for (const [method, row] of Object.entries(ROUTED_METHODS))
      this.options.rpc.register(this.methodFor(method, row))
    this.registerTransport()
    const stops = [
      this.options.policy.onChange((event) => {
        // The device's terminals end the moment its terminal switch goes off, or it is blocked: a shell
        // that was already open must not outlive the permission that opened it.
        if (event.before.terminal && !event.after.terminal)
          this.terminals.end('terminal_off', event.node)
        if (!event.after.blocked || event.before.blocked) return
        this.terminals.end('blocked', event.node)
        // A device that is blocked has nothing held for it: the results waiting to be fetched and the
        // values it staged go with it.
        this.pages.dropCaller(event.node)
        this.options.staging?.dropCaller(event.node)
        // What the device queued, made a rule of and started is taken away too.
        this.cleanUp(event.node)
      })
    ]
    // Values staged before a restart that nobody came back for are looked for now, and then every minute.
    if (this.options.staging) stops.push(this.options.staging.start())
    this.stops = stops
  }

  /**
   * Stops serving. A device's terminal still open ends first and is written to the audit, so turning Net or
   * Bridge off (or closing the profile) leaves no shell running for a device that can no longer be answered for.
   */
  async close(): Promise<void> {
    for (const stop of this.stops.splice(0)) stop()
    if (this.options.services.routedTerminals === this.terminals)
      this.options.services.routedTerminals = undefined
    await this.terminals.close()
  }
  private stops: Array<() => void> = []

  /**
   * The methods that carry the API itself. They hold to the same checks as a row (the grant, the
   * block, the owner's switch), and each reply is a `RoutedReply`, so a caller handles refusals once.
   */
  private registerTransport(): void {
    const { rpc, track } = this.options
    const common = { family: 'routed' as const, requires: ['settings'] as NodeCapability[] }
    rpc.register({
      ...common,
      method: routedNetMethod('page'),
      capability: ROUTED_TRANSPORT_METHODS.page.capability,
      mutating: false,
      ephemeral: true,
      validate: (params) => {
        const value = exactKeys('page', ROUTED_TRANSPORT_METHODS.page.keys, params)
        if (
          typeof value.id !== 'string' ||
          value.id.length > 64 ||
          !Number.isSafeInteger(value.index) ||
          (value.index as number) < 0
        )
          throw new NetError('bad_request')
        return { id: value.id, index: value.index }
      },
      handle: (params, context) => {
        const { id, index } = params as { id: string; index: number }
        const page: RoutedPage | undefined = this.pages.page(context.caller.node, id, index)
        return Promise.resolve(
          page
            ? ({ ok: true, result: page } satisfies RoutedReply)
            : ({
                ok: false,
                error: {
                  code: 'page_expired',
                  message: 'That result is no longer held. Ask for it again.'
                }
              } satisfies RoutedReply)
        )
      }
    })
    if (this.options.streams) {
      const validateStream = (name: 'stream.open' | 'stream.close') => (params: unknown) => {
        const value = exactKeys(name, ROUTED_TRANSPORT_METHODS[name].keys, params)
        if (!(ROUTED_STREAM_KINDS as readonly unknown[]).includes(value.kind))
          throw new NetError('bad_request', 'That is not a kind of stream.')
        for (const key of ['threadId', 'ptyId'])
          if (value[key] !== undefined && !text(value[key]))
            throw new NetError('bad_request', `${key} is not valid.`)
        return value
      }
      rpc.register({
        ...common,
        method: routedNetMethod('stream.open'),
        capability: ROUTED_TRANSPORT_METHODS['stream.open'].capability,
        mutating: false,
        ephemeral: true,
        validate: validateStream('stream.open'),
        handle: (params, context) => track(this.openStream(params as never, context))
      })
      rpc.register({
        ...common,
        method: routedNetMethod('stream.close'),
        capability: ROUTED_TRANSPORT_METHODS['stream.close'].capability,
        mutating: false,
        ephemeral: true,
        validate: validateStream('stream.close'),
        handle: (params, context) =>
          track(
            Promise.resolve().then(() => {
              this.options.streams!.close(context.caller.node, params as never)
              return { ok: true, result: { closed: true } } satisfies RoutedReply
            })
          )
      })
    }
    if (this.options.staging)
      rpc.register({
        ...common,
        method: routedNetMethod('stage'),
        capability: ROUTED_TRANSPORT_METHODS.stage.capability,
        mutating: true,
        uploadEnabled: true,
        validate: (params) => {
          const value = exactKeys('stage', ROUTED_TRANSPORT_METHODS.stage.keys, params)
          const input = value.input as Partial<RpcArtifactRef> | undefined
          if (
            !isPlainObject(input) ||
            Object.keys(input).sort().join() !== 'blob,event,stream' ||
            !isId('stream', input.stream) ||
            !isId('event', input.event) ||
            !isBlobId(input.blob)
          )
            throw new NetError('bad_request')
          return { input: { stream: input.stream, event: input.event, blob: input.blob } }
        },
        handle: (params, context) =>
          track(
            Promise.resolve(
              this.options.staging!.stage(
                (params as { input: RpcArtifactRef }).input,
                context.caller.node,
                context
              )
            )
          )
      })
  }

  private async openStream(
    request: { kind: RoutedStreamKind; threadId?: string; ptyId?: string },
    context: RpcContext
  ): Promise<RoutedReply> {
    const { services, audit, policy, streams } = this.options
    const node = context.caller.node
    try {
      const need = (key: 'threadId' | 'ptyId', wanted: boolean): void => {
        if ((request[key] !== undefined) !== wanted)
          throw new NetError(
            'bad_request',
            `A ${request.kind} stream ${wanted ? 'needs' : 'takes no'} ${key}.`
          )
      }
      need('threadId', request.kind === 'thread' || request.kind === 'terminal')
      need('ptyId', request.kind === 'terminal')
      if (request.threadId && !services.threads.getThread(request.threadId))
        throw new DomainRpcError('thread_not_found', 'Thread not found', {
          threadId: request.threadId
        })
      if (request.kind === 'terminal') {
        // The device's terminal switch decides whether it may see terminal output, here and on every record.
        if (!policy.get(node).terminal)
          throw new NetError('forbidden', undefined, { details: { reason: 'terminal_off' } })
        if (
          !(await this.belongs('pty', request.ptyId!, request.threadId!)) ||
          !this.terminals.owns(node, request.ptyId!, request.threadId!)
        )
          throw notFoundFor('pty', request.ptyId!, request.threadId!)
      }
      const opened = streams!.open(node, request)
      audit.countRead(node, 0)
      return { ok: true, result: opened }
    } catch (error) {
      const refusal = refusalOf(error)
      if (!refusal) throw error
      audit.countRead(node, 0)
      return { ok: false, error: refusal }
    }
  }

  methodFor(method: string, row: RoutedRow): RpcMethod {
    return {
      method: routedNetMethod(method),
      family: 'routed',
      capability: row.capability as NodeCapability,
      requires: ['settings'],
      ...(row.terminal ? { needsTerminal: true } : {}),
      // A numbered change changes something but keeps nothing in the ledger; a read keeps nothing either.
      mutating: row.durable || row.sequenced === true,
      ...(row.sequenced
        ? { sequenced: true }
        : row.durable
          ? { ledgerResultMaxBytes: ROUTED_LEDGER_RESULT_MAX_BYTES }
          : { ephemeral: true }),
      validate: (params) => validateRoutedParams(method, row, params),
      handle: (params, context) =>
        this.options.track(this.run(method, row, params as Record<string, unknown>, context))
    }
  }

  private async run(
    method: string,
    row: RoutedRow,
    sent: Record<string, unknown>,
    context: RpcContext
  ): Promise<RoutedReply | RoutedPagedReply> {
    const { audit, staging } = this.options
    const node = context.caller.node
    let params = sent
    // The staged values this call uses; they are used up once the call has gone through.
    let stagedIds: string[] = []
    let consumed = false
    let entered = false
    let savingLarge = false
    // Where the stream of this computer is before the snapshot is read, so no record is marked as already
    // applied that the snapshot does not hold.
    const head =
      method === 'thread.snapshot' && typeof params.threadId === 'string'
        ? this.options.streams?.head(node, params.threadId)
        : undefined
    const named = params[row.threadIds?.[0] ?? 'threadId']
    const thread = typeof named === 'string' ? named : undefined
    let project = typeof params.projectId === 'string' ? params.projectId : undefined
    // `projects.open` names a path of the owner's disk: the audit keeps the project it opened, or a short
    // hash of the path it was refused, never the path itself.
    if (method === 'projects.open' && typeof params.path === 'string')
      project = `path:${createHash('sha256').update(params.path).digest('hex').slice(0, 12)}`
    // The first terminal a device opens here is worth telling the owner (below). Read before this call's own row is written.
    const firstTerminal = method === 'pty.create' && !audit.has(node, 'pty.create')
    // The first folder it registers as a project here, in the same way.
    const firstFolder = method === 'projects.open' && !audit.has(node, 'project.first_open')
    // The first change a device makes on a thread here, in any form (a send, a rename, a save, a Git action).
    const firstUse =
      row.durable && !row.sequenced && !row.terminal && !this.toldFirstUse.has(node) && !audit.has(node, 'thread.first_use')
    let slot: TerminalClaim | undefined
    try {
      // Nothing has run yet: a call that was cancelled before it started is a refusal, not an unknown outcome.
      if (context.signal.aborted)
        throw new DomainRpcError('cancelled', 'The request was cancelled before it started.')
      // Reads whose result can be megabytes build several copies of it; a computer may have two under way.
      if (ROUTED_LARGE_READS.includes(method)) {
        this.enterLargeRead(node)
        entered = true
      }
      // A save sent staged is a large one (up to 25 MiB): its text, its bytes and the file it replaces are all in memory
      // together, so a computer saves one at a time. A refusal, not a wait: the caller tries again when the first is done.
      if (
        method === 'files.write' &&
        isPlainObject(params[ROUTED_STAGED_KEY]) &&
        Object.hasOwn(params[ROUTED_STAGED_KEY] as object, 'content')
      ) {
        if (this.largeSaves.has(node))
          throw new DomainRpcError(
            'rate_limited',
            'Another large save from this computer is still being written. Try again when it is done.'
          )
        this.largeSaves.add(node)
        savingLarge = true
      }
      if (params[ROUTED_STAGED_KEY] !== undefined) {
        const unstaged = this.unstage(params, node)
        params = unstaged.params
        stagedIds = unstaged.ids
      }
      await this.assertOwned(method, row, params)
      // Terminals: a device types into, resizes and stops only the ones it opened, takes a slot before it starts one,
      // and each numbered input is applied once.
      if (method === 'pty.create') slot = this.terminals.claim(node, thread!, String(params.agentId))
      // A device reads, types into, resizes and stops only the terminals it opened.
      if (row.terminal && typeof params.ptyId === 'string') {
        const ptyId = params.ptyId
        if (!this.terminals.owns(node, ptyId, thread!)) throw notFoundFor('pty', ptyId, thread!)
        if (method === 'pty.kill') this.terminals.markKilled(ptyId)
      }
      let result: unknown
      if (row.sequenced) {
        const verdict = await this.terminals.admitInput(node, params.ptyId as string, params.seq as number)
        // A resend of a number that was applied: answered with where this computer is, and not typed again.
        if (verdict.duplicate)
          return {
            ok: true,
            result: { ok: true, duplicate: true, lastSeq: verdict.lastSeq }
          } satisfies RoutedReply
        const sent = typeof params.data === 'string' ? Buffer.byteLength(params.data) : 0
        result = await verdict.apply(sent, () => this.dispatch(method, row, params, context, head))
      } else result = await this.dispatch(method, row, params, context, head, slot)
      if (method === 'projects.open')
        project = (result as { project?: { id?: string } }).project?.id ?? project
      if (method === 'pty.create') {
        const cancelled = slot!.cancelled
        slot!.finish()
        // The device lost its right while the shell was starting: the shell was stopped as it appeared.
        if (cancelled)
          throw new DomainRpcError(
            'terminal_ended',
            'This device may no longer have a terminal here, so the one that was starting was stopped.'
          )
      }
      const reply: RoutedReply = {
        ok: true,
        result: row.durable
          ? withoutLocalLists(method, result)
          : this.withTerminalState(method, result)
      }
      const bytes = byteLength(reply)
      if (stagedIds.length) {
        staging?.consume(stagedIds)
        consumed = true
      }
      // A numbered change is not audited call by call (that would be a row per key press): the terminal's
      // opening, its end and the bytes it carried are.
      if (row.sequenced) return reply
      if (row.durable)
        audit.record({ node, method, thread, project, outcome: 'ok', kind: 'change' })
      else audit.countRead(node, bytes)
      if (firstUse) {
        this.toldFirstUse.add(node)
        audit.record({ node, method: 'thread.first_use', thread, project, outcome: 'first_use', kind: 'change' })
        // Registering a folder says more than "is working on threads", so its notice is the one shown.
        if (!firstFolder)
          try {
            this.options.onFirstUse?.({
              node,
              name: this.options.deviceName?.(node) ?? 'Another computer',
              ...(thread ? { threadId: thread } : {})
            })
          } catch {
            // A notice that cannot be shown does not undo the change.
          }
      }
      if (firstFolder) {
        audit.record({ node, method: 'project.first_open', project, outcome: 'first_folder', kind: 'change' })
        try {
          const projectName = project ? this.options.services.projects.getProject(project)?.name : undefined
          this.options.onFirstProject?.({
            node,
            name: this.options.deviceName?.(node) ?? 'Another computer',
            ...(projectName ? { projectName } : {})
          })
        } catch {
          // A notice that cannot be shown does not undo the open.
        }
      }
      // The first terminal a device opens is a row of its own, and a desktop notification where a window can show one.
      if (firstTerminal) {
        audit.record({ node, method: 'pty.first_open', thread, outcome: 'first_terminal', kind: 'change' })
        try {
          this.options.onFirstTerminal?.({
            node,
            name: this.options.deviceName?.(node) ?? 'Another computer',
            threadId: thread!
          })
        } catch {
          // A notice that cannot be shown does not undo the terminal.
        }
      }
      // A read has no ledger and no artifact to carry a reply that does not fit one RPC reply: the
      // owner keeps it for a minute and the caller fetches it in pages. A durable result goes through
      // the artifact publisher.
      if (!row.durable && bytes > ROUTED_REPLY_MAX_BYTES)
        return { ok: true, paged: this.pages.hold(node, reply) }
      return reply
    } catch (error) {
      const refusal = refusalOf(error)
      // A numbered call has no ledger to leave "uncertain": a shell that cannot take the input says so.
      if (!refusal && row.sequenced && !(error instanceof NetError)) {
        // Fixed words: what the shell said can name folders and internals of this computer, and stays in its log.
        console.error(
          'Routed terminal input failed',
          errorDiagnostic(normalizeAppError(error, 'handler_error'), method)
        )
        return {
          ok: false,
          error: { code: 'pty_unavailable', message: 'The terminal cannot take that input.' }
        } satisfies RoutedReply
      }
      if (!refusal) {
        // Not something the handler refused on purpose: it may have made part of its change. The ledger
        // records `outcome_uncertain` for a durable call, the audit says so, and the owner keeps the diagnostic.
        if (!(error instanceof NetError))
          console.error(
            'Routed request failed',
            errorDiagnostic(normalizeAppError(error, 'handler_error'), method)
          )
        if (row.durable)
          audit.record({ node, method, thread, project, outcome: 'uncertain', kind: 'change' })
        throw error
      }
      // A refused read is only counted: a device cannot fill the audit with reads it knows will fail.
      if (row.durable)
        audit.record({ node, method, thread, project, outcome: refusal.code, kind: 'refused' })
      else if (!row.sequenced) audit.countRead(node, 0)
      return { ok: false, error: refusal }
    } finally {
      // A terminal that did not start gives its slot back.
      slot?.abandon()
      // A call that did not use its staged values up gives them back, so they can be sent in a call that does.
      if (stagedIds.length && !consumed) staging?.release(stagedIds)
      if (entered) this.leaveLargeRead(node)
      if (savingLarge) this.largeSaves.delete(node)
    }
  }

  /** What a device needs to know about a terminal it reads: where this computer's input numbers are (`lastSeq`). */
  private withTerminalState(method: string, result: unknown): unknown {
    if (!isPlainObject(result)) return result
    if ((method === 'pty.isAlive' || method === 'pty.lookup') && result.alive === true)
      return { ...result, lastSeq: this.terminals.lastSeq(String(result.ptyId)) }
    if (method === 'pty.list' && Array.isArray(result.ptys))
      return {
        ...result,
        ptys: result.ptys.map((entry) =>
          isPlainObject(entry) ? { ...entry, lastSeq: this.terminals.lastSeq(String(entry.ptyId)) } : entry
        )
      }
    return result
  }

  private readonly largeSaves = new Set<NodeId>()
  /** The clean-ups of blocked devices under way. */
  private readonly cleanups = new Set<Promise<void>>()
  private cleanUp(node: NodeId): void {
    const cleanup: Promise<void> = this.options
      .track(cleanUpBlockedDevice(this.options.services, node))
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => this.cleanups.delete(cleanup))
    this.cleanups.add(cleanup)
  }

  /**
   * Cleans up after every device that is blocked now. A block made while Bridge was off, or one whose
   * clean-up a restart cut short, is finished here when Bridge starts. Running it twice does no harm:
   * what it removes is gone the second time.
   */
  cleanUpBlockedDevices(): void {
    for (const row of this.options.policy.list()) if (row.blocked) this.cleanUp(row.node)
  }

  /** Resolves when the clean-up of every device blocked so far is done. */
  async cleanedUp(): Promise<void> {
    while (this.cleanups.size) await Promise.all([...this.cleanups])
  }

  private readonly largeReads = new Map<NodeId, number>()
  private enterLargeRead(node: NodeId): void {
    const running = this.largeReads.get(node) ?? 0
    if (running >= ROUTED_LARGE_READS_PER_CALLER) throw new NetError('rate_limited')
    this.largeReads.set(node, running + 1)
  }
  private leaveLargeRead(node: NodeId): void {
    const running = (this.largeReads.get(node) ?? 1) - 1
    if (running > 0) this.largeReads.set(node, running)
    else this.largeReads.delete(node)
  }

  /**
   * Puts the staged values back into the call, after the row's own checks have passed the call as it was
   * sent. A staged value is the JSON text of the value it stands for, so what the handler gets is what an
   * inline call would have carried, and the handler checks it the same way. The row's checks do not look
   * at a value's content, so a check of that kind added to a row later has to look at staged values too.
   */
  private unstage(
    params: Record<string, unknown>,
    node: NodeId
  ): { params: Record<string, unknown>; ids: string[] } {
    const { staging } = this.options
    if (!staging)
      throw new DomainRpcError('stage_unavailable', 'This computer does not take staged values.')
    const named = params[ROUTED_STAGED_KEY] as Record<string, string>
    const ids = Object.values(named)
    const bytes = staging.resolve(node, ids)
    const { [ROUTED_STAGED_KEY]: _staged, ...rest } = params
    const filled: Record<string, unknown> = { ...rest }
    for (const [key, id] of Object.entries(named)) {
      try {
        filled[key] = JSON.parse(bytes.get(id)!.toString('utf8'))
      } catch {
        staging.release(ids)
        throw new DomainRpcError('stage_invalid', 'A staged value is not what it was said to be.', {
          stage: id
        })
      }
    }
    return { params: filled, ids }
  }

  /**
   * What a routed caller gets of a result that a window would get whole, where whole is too much: a
   * snapshot of a long thread carries the newest messages that fit 16 MiB (and says where the older
   * ones begin), images keep their data only for the newest, and queued images are fetched one at a
   * time (`thread.messageImage`). A caller that holds a private stream for the thread is told where
   * the stream is, so it applies nothing older than that.
   */
  private shape(
    method: string,
    result: unknown,
    head: { stream: string; epoch: number; seq: number } | undefined
  ): unknown {
    if (method !== 'thread.snapshot' || !isPlainObject(result)) return result
    type WithImages = { images?: unknown }
    const snapshot = result as {
      messages?: unknown[]
      queue?: WithImages[]
      claimed?: WithImages[]
    }
    const kept = newestMessages(
      withImageBudget((snapshot.messages ?? []) as Array<{ id: string; images?: unknown }>),
      ROUTED_SNAPSHOT_MESSAGE_BYTES
    )
    return {
      ...snapshot,
      messages: kept.messages,
      ...(Array.isArray(snapshot.queue) ? { queue: snapshot.queue.map(withoutImageData) } : {}),
      ...(Array.isArray(snapshot.claimed)
        ? { claimed: snapshot.claimed.map(withoutImageData) }
        : {}),
      ...(kept.earlier ? { earlier: kept.earlier } : {}),
      ...(head ? { streamHead: head } : {})
    }
  }

  /** The thread, project and secondary ids the call names are this profile's, and the thread's. */
  private async assertOwned(
    method: string,
    row: RoutedRow,
    params: Record<string, unknown>
  ): Promise<void> {
    const { services } = this.options
    const threadKey = row.threadIds?.[0] ?? 'threadId'
    const threadId = params[threadKey]
    const known = (id: string): boolean =>
      Boolean(services.threads.getThread(id)) ||
      // A trashed thread is not listed but can be restored, and its inventory read.
      ((method === 'threads.restore' || method === 'threads.inventory') &&
        Boolean(services.threads.lifecycleStore?.get(id)))
    if (typeof threadId === 'string' && !known(threadId))
      throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
    const projectId = params.projectId
    if (typeof projectId === 'string' && !services.projects.getProject(projectId))
      throw new DomainRpcError('project_not_found', 'Project not found', { projectId })
    // A folder call on a thread without a folder has nothing to read or change; say so instead of failing inside Git.
    // A save names its thread only, but it needs the thread's folder just the same.
    if (
      (row.target === 'folder' || method === 'files.write') &&
      typeof threadId === 'string' &&
      !resolveThreadProjectPath(services.projects, services.threads, threadId)
    )
      throw new DomainRpcError(
        'thread_has_no_folder',
        'This thread has no folder on this computer.',
        { threadId }
      )
    if (
      typeof params.originThreadId === 'string' &&
      !services.threads.getThread(params.originThreadId)
    )
      throw new DomainRpcError('thread_not_found', 'Thread not found', {
        threadId: params.originThreadId
      })
    for (const [key, kind] of Object.entries(row.owned ?? {})) {
      const id = params[key]
      if (typeof id !== 'string' || kind === 'thread') continue
      if (typeof threadId !== 'string') throw new NetError('bad_request')
      if (!(await this.belongs(kind, id, threadId))) throw notFoundFor(kind, id, threadId)
    }
  }

  private async belongs(
    kind: 'question' | 'run' | 'workflowRun' | 'pty',
    id: string,
    threadId: string
  ): Promise<boolean> {
    const { services } = this.options
    switch (kind) {
      case 'question':
        // A saved request that was already settled still names its thread, so the caller learns who answered first.
        return services.questions.getRequest(id)?.threadId === threadId
      case 'run':
        return services.runEngine.getRun(id)?.threadId === threadId
      case 'pty': {
        const found = services.ptyManager.lookup(id)
        return found.alive && found.threadId === threadId
      }
      case 'workflowRun':
        try {
          return (
            (
              await services.platform.workflowRuns.runtime.get(id, {
                profileId: services.profileId
              })
            ).manifest.threadId === threadId
          )
        } catch {
          return false
        }
    }
  }

  /** Devices the owner was told about in this run, so the audit is read once for each. */
  private readonly toldFirstUse = new Set<NodeId>()

  private async dispatch(
    method: string,
    row: RoutedRow,
    params: Record<string, unknown>,
    context: RpcContext,
    head?: { stream: string; epoch: number; seq: number },
    slot?: TerminalClaim
  ): Promise<unknown> {
    const { services } = this.options
    const forwarded: Record<string, unknown> = { ...params }
    for (const key of row.routeOnly ?? []) delete forwarded[key]
    // A domain method is bound to the profile by the connection; the caller never names it.
    if (row.via === 'domain') forwarded.profileId = services.profileId
    // A routed send returns once the turn is admitted, however long the turn runs.
    if (method === 'orchestrator.send') forwarded.await = 'ack'
    if (row.via === 'backend') {
      // The backend answers without the request barrier of the protocol handlers; hold it here.
      const result = await services.runOwnedRequest(routedNetMethod(method), () =>
        this.backend.execute(method as BridgeOrdinaryMethod, forwarded, {
          node: context.caller.node
        })
      )
      if (method !== 'projects.open') return result
      // A folder the backend will not register answers `{ ok: false, error }` inside a successful result so a
      // phone sees the reason; here it is a refusal like any other.
      const opened = result as { ok?: boolean; error?: string; project?: unknown }
      if (opened.ok === false)
        throw new DomainRpcError(
          'project_refused',
          opened.error ?? 'That folder cannot be opened from another computer.'
        )
      return { project: opened.project }
    }
    // Shaped before it is serialized: a long thread is larger than a whole snapshot may be.
    return mmsJson(
      this.shape(
        method,
        await dispatchMethod(this.handlerContext(context, slot), method, forwarded),
        head
      )
    )
  }

  /**
   * The connection a routed call runs with: a person on another of the user's computers. It is never
   * `gui` (so nothing meant for a window on this computer, such as direct saves, opens to it), holds
   * the capability a `/workflow` command needs, and carries the computer's limit for turns and rules.
   */
  private handlerContext(context: RpcContext, slot?: TerminalClaim): HandlerContext {
    const { services, policy, connectionEvent } = this.options
    const node = context.caller.node
    const connection: DomainConnectionContext = {
      // One id per computer: the Git action it starts can be cancelled by it, and by no other.
      id: `bridge:${node}`,
      binding: { profileId: services.profileId, epoch: 1 },
      capabilities: new Set([WORKFLOW_RUN_CAPABILITY, GIT_OPERATIONS_CAPABILITY]),
      // The call itself: it ends when the computer cancels, the deadline passes or its session closes.
      lifetime: context.signal,
      clientType: 'bridge',
      bridgeCaller: {
        node,
        user: context.caller.user,
        maxPermissionMode: policy.get(node).maxPermissionMode,
        // A terminal is the device's from the moment its shell exists, so a block that lands while it starts catches it.
        ...(slot ? { onTerminalCreated: (ptyId: string) => slot.created(ptyId) } : {})
      },
      ...(connectionEvent
        ? {
            emitConnectionEvent: (
              type: ProtocolConnectionEventType,
              data: unknown,
              signal?: AbortSignal
            ) => connectionEvent({ node }, type, data, signal)
          }
        : {})
    }
    return {
      mms: services,
      connection,
      globalSequence: () => services.protocolSequence(),
      // What a handler announces reaches the windows on this computer, as if one of them had asked.
      emitEvent: (type, data, threadId) =>
        services.events.emit({
          channel: 'protocol:event',
          data: { type, data, ...(threadId ? { threadId } : {}) }
        })
    }
  }
}

const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? '')

function withoutLocalLists(method: string, result: unknown): unknown {
  if (!isPlainObject(result)) return result
  const kept: Record<string, unknown> = { ...result }
  for (const key of ROUTED_LOCAL_LIST_FIELDS) delete kept[key]
  if (method.startsWith('queue.')) delete kept[ROUTED_QUEUE_LIST_FIELD]
  return kept
}

function notFoundFor(
  kind: 'question' | 'run' | 'workflowRun' | 'pty',
  id: string,
  threadId: string
): DomainRpcError {
  const what = kind === 'question' ? 'request' : kind === 'workflowRun' ? 'workflow run' : kind
  return new DomainRpcError(
    kind === 'question' ? 'request_not_found' : kind === 'pty' ? 'pty_not_found' : 'run_not_found',
    `No such ${what} in this thread`,
    { id, threadId }
  )
}

/**
 * The refusal an error stands for, as the owner's own window would be told it. The errors a handler
 * raises on purpose; anything else (a bug, a failed disk write) is not one, and leaves the outcome unknown.
 */
export function refusalOf(error: unknown): RoutedRefusal | undefined {
  let shaped: AppError | undefined
  if (error instanceof DomainRpcError)
    shaped = knownAppError({ code: error.code, message: error.message, details: error.details })
  else if (error instanceof CommandRejection)
    shaped = knownAppError({ code: error.reason, message: error.message })
  else if (error instanceof QueueConflictError)
    shaped = knownAppError({ code: error.code, message: error.message, details: error.details })
  else if (error instanceof QueueValidationError)
    shaped = knownAppError({ code: 'queue_change_refused', message: error.message })
  else if (error instanceof AppError) shaped = error
  if (!shaped) return undefined
  const { code, message, details } = serializeAppError(shaped)
  return { code, message, ...(details === undefined ? {} : { details }) }
}
