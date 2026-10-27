import { createHash } from 'node:crypto'
import { isAbsolute, win32 } from 'node:path'
import { NetError, type NodeId } from '../../../shared/net'
import type { NodeCapability } from '../../../shared/net'
import {
  ROUTED_FORBIDDEN_KEYS,
  ROUTED_LEDGER_RESULT_MAX_BYTES,
  ROUTED_LOCAL_LIST_FIELDS,
  ROUTED_QUEUE_LIST_FIELD,
  ROUTED_METHODS,
  routedNetMethod,
  type RoutedReply,
  type RoutedRefusal,
  type RoutedRow
} from '../../../shared/bridge/routed'
import { WORKFLOW_RUN_CAPABILITY } from '../../../shared/workflowRunPlatform'
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
import type { RpcContext, RpcDispatcher, RpcMethod } from '../../net/contracts'
import type { SqliteBridgeAudit } from '../../net/store/audit'
import type { SqliteNodePolicy } from '../../net/store/nodePolicy'
import { MmsRemoteBackend } from '../remote/MmsBackend'
import type { BridgeOrdinaryMethod } from '../remote/capabilities'
import { mmsJson } from '../remote/jsonOutput'

/** Ids are text of this length at most, as in the protocol handlers. */
const ID_MAX = 256
/** An ephemeral result larger than this cannot be an RPC reply; `routed.page` carries it in a later change. */
const REPLY_MAX_BYTES = 63 * 1024

export interface OwnerRoutesOptions {
  services: MmsProfileServices
  rpc: RpcDispatcher
  /** What this computer lets each device do here. */
  policy: Pick<SqliteNodePolicy, 'get'>
  audit: Pick<SqliteBridgeAudit, 'record' | 'countRead'>
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
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= ID_MAX && !value.includes('\0')

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
  for (const key of row.required ?? [])
    if (value[key] === undefined) throw new NetError('bad_request', `${method} needs ${key}.`)
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
  constructor(private readonly options: OwnerRoutesOptions) {
    this.backend = new MmsRemoteBackend(options.services, () => options.services.protocolSequence())
  }

  register(): void {
    for (const [method, row] of Object.entries(ROUTED_METHODS))
      this.options.rpc.register(this.methodFor(method, row))
  }

  methodFor(method: string, row: RoutedRow): RpcMethod {
    return {
      method: routedNetMethod(method),
      family: 'routed',
      capability: row.capability as NodeCapability,
      requires: ['settings'],
      ...(row.terminal ? { needsTerminal: true } : {}),
      mutating: row.durable,
      ...(row.durable
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
    params: Record<string, unknown>,
    context: RpcContext
  ): Promise<RoutedReply> {
    const { audit } = this.options
    const node = context.caller.node
    const named = params[row.threadIds?.[0] ?? 'threadId']
    const thread = typeof named === 'string' ? named : undefined
    let project = typeof params.projectId === 'string' ? params.projectId : undefined
    // `projects.open` names a path of the owner's disk: the audit keeps the project it opened, or a short
    // hash of the path it was refused, never the path itself.
    if (method === 'projects.open' && typeof params.path === 'string')
      project = `path:${createHash('sha256').update(params.path).digest('hex').slice(0, 12)}`
    try {
      // Nothing has run yet: a call that was cancelled before it started is a refusal, not an unknown outcome.
      if (context.signal.aborted)
        throw new DomainRpcError('cancelled', 'The request was cancelled before it started.')
      await this.assertOwned(method, row, params)
      const result = await this.dispatch(method, row, params, context)
      if (method === 'projects.open')
        project = (result as { project?: { id?: string } }).project?.id ?? project
      const reply: RoutedReply = {
        ok: true,
        result: row.durable ? withoutLocalLists(method, result) : result
      }
      const bytes = byteLength(reply)
      // A read keeps nothing on disk and has no artifact to carry a larger reply (paging is a later change).
      if (!row.durable && bytes > REPLY_MAX_BYTES) throw new NetError('too_large')
      if (row.durable)
        audit.record({ node, method, thread, project, outcome: 'ok', kind: 'change' })
      else audit.countRead(node, bytes)
      return reply
    } catch (error) {
      const refusal = refusalOf(error)
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
      else audit.countRead(node, 0)
      return { ok: false, error: refusal }
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
    if (
      row.target === 'folder' &&
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

  private async dispatch(
    method: string,
    row: RoutedRow,
    params: Record<string, unknown>,
    context: RpcContext
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
    return mmsJson(await dispatchMethod(this.handlerContext(context), method, forwarded))
  }

  /**
   * The connection a routed call runs with: a person on another of the user's computers. It is never
   * `gui` (so nothing meant for a window on this computer, such as direct saves, opens to it), holds
   * the capability a `/workflow` command needs, and carries the computer's limit for turns and rules.
   */
  private handlerContext(context: RpcContext): HandlerContext {
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
        maxPermissionMode: policy.get(node).maxPermissionMode
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
