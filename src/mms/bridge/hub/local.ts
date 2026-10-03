import { NetError, isId } from '../../../shared/net'
import type {
  BridgeHubLocalMethod,
  BridgeHubLocalParams,
  BridgeHubRequestOptions,
  BridgeDisplayEvent,
  BridgeEntityRef
} from '../../../shared/bridge'
import { BRIDGE_HUB_LOCAL_METHODS } from '../../../shared/bridge'
import { validateHubParams } from './validation'
import type { BridgeHub } from './service'
function invalid(): never {
  throw new NetError('bad_request')
}
function object(
  value: unknown,
  required: string[],
  optional: string[] = []
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const row = value as Record<string, unknown>
  if (
    required.some((key) => !Object.hasOwn(row, key)) ||
    Object.keys(row).some((key) => !required.includes(key) && !optional.includes(key))
  )
    return invalid()
  return row
}
function options(value: unknown): BridgeHubRequestOptions {
  const row = object(value, [], ['id', 'idem', 'deadlineMs'])
  if (
    (row.id !== undefined && !isId('rpc', row.id)) ||
    (row.idem !== undefined &&
      (typeof row.idem !== 'string' || !row.idem.length || row.idem.length > 256)) ||
    (row.deadlineMs !== undefined &&
      (!Number.isSafeInteger(row.deadlineMs) ||
        Number(row.deadlineMs) < 1 ||
        Number(row.deadlineMs) > 86400000))
  )
    return invalid()
  return row as BridgeHubRequestOptions
}
function ref(value: unknown): BridgeEntityRef {
  const row = object(value, ['nodeId', 'entityId'])
  if (!isId('node', row.nodeId)) return invalid()
  validateHubParams('threads.get', { threadId: row.entityId })
  return row as unknown as BridgeEntityRef
}
/** Exact local DTOs. This is not a general remote-method forwarding endpoint. */
export function validateBridgeHubLocal<M extends BridgeHubLocalMethod>(
  method: M,
  value: unknown
): BridgeHubLocalParams[M] {
  if (!BRIDGE_HUB_LOCAL_METHODS.includes(method)) throw new NetError('forbidden')
  const fields: Record<BridgeHubLocalMethod, [string[], string[]]> = {
    'bridge.hub.projects': [['target'], []],
    'bridge.hub.threads': [['target'], ['projectId']],
    'bridge.hub.get': [['ref'], []],
    'bridge.hub.search': [['target', 'query'], ['limit']],
    'bridge.hub.create': [
      ['target', 'name'],
      ['projectId', 'options']
    ],
    'bridge.hub.send': [['ref', 'content'], ['options']],
    'bridge.hub.steer': [['ref', 'run', 'text'], ['options']],
    'bridge.hub.abort': [['ref', 'run'], ['options']],
    'bridge.hub.attach': [['ref'], []],
    'bridge.hub.detach': [['ref'], []],
    'bridge.hub.dispatch': [['target', 'input'], ['options']],
    'bridge.hub.result': [['id'], []],
    'bridge.hub.cancel': [['id'], []],
    'bridge.hub.requests': [[], ['target']]
  }
  const [required, optional] = fields[method]
  const row = object(value, required, optional)
  if (row.target !== undefined && !isId('node', row.target)) return invalid()
  if (row.ref !== undefined) ref(row.ref)
  if (row.id !== undefined && !isId('rpc', row.id)) return invalid()
  if (row.options !== undefined) options(row.options)
  if (method === 'bridge.hub.threads')
    validateHubParams(
      'threads.list',
      row.projectId === undefined ? {} : { projectId: row.projectId }
    )
  if (method === 'bridge.hub.search')
    validateHubParams('threads.search', {
      query: row.query,
      ...(row.limit === undefined ? {} : { limit: row.limit })
    })
  if (method === 'bridge.hub.create')
    validateHubParams('threads.create', {
      name: row.name,
      ...(row.projectId === undefined ? {} : { projectId: row.projectId })
    })
  if (method === 'bridge.hub.send')
    validateHubParams('orchestrator.send', {
      threadId: ref(row.ref).entityId,
      content: row.content
    })
  if (method === 'bridge.hub.steer')
    validateHubParams('orchestrator.steer', {
      threadId: ref(row.ref).entityId,
      run: row.run,
      text: row.text
    })
  if (method === 'bridge.hub.abort')
    validateHubParams('orchestrator.abort', { threadId: ref(row.ref).entityId, run: row.run })
  if (method === 'bridge.hub.dispatch') validateHubParams('bridge.dispatch', row.input)
  return structuredClone(row) as BridgeHubLocalParams[M]
}
export interface BridgeHubLocalEvents {
  /** Trusted local connection identifier, not a renderer supplied field. */
  owner: string
  thread(event: BridgeDisplayEvent): void | Promise<void>
  error?(ref: BridgeEntityRef, code: string): void
}
/** Root routes this only after trusted profile/capability binding; events are profile scoped. */
export async function executeBridgeHubLocal(
  hub: BridgeHub,
  method: BridgeHubLocalMethod,
  value: unknown,
  events?: BridgeHubLocalEvents
): Promise<unknown> {
  const row = validateBridgeHubLocal(method, value) as unknown as Record<string, any>
  switch (method) {
    case 'bridge.hub.projects':
      return hub.projects(row.target)
    case 'bridge.hub.threads':
      return hub.threads(row.target, row.projectId)
    case 'bridge.hub.get':
      return hub.get(row.ref)
    case 'bridge.hub.search':
      return hub.search(row.target, row.query, row.limit)
    case 'bridge.hub.create':
      return hub.create(row.target, row.name, row.options, row.projectId)
    case 'bridge.hub.send':
      return hub.send(row.ref, row.content, row.options)
    case 'bridge.hub.steer':
      return hub.steer(row.ref, row.run, row.text, row.options)
    case 'bridge.hub.abort':
      return hub.abort(row.ref, row.run, row.options)
    case 'bridge.hub.dispatch':
      return hub.dispatch(row.target, row.input, row.options)
    case 'bridge.hub.result':
      return hub.query(row.id)
    case 'bridge.hub.cancel':
      await hub.cancel(row.id)
      return { cancelled: true }
    case 'bridge.hub.requests':
      return hub.requests(row.target)
    case 'bridge.hub.detach':
      if (!events) throw new NetError('forbidden')
      hub.detachFor(events.owner, row.ref)
      return { detached: true }
    case 'bridge.hub.attach': {
      if (!events) throw new NetError('forbidden')
      const attached = await hub.attachFor(
        events.owner,
        row.ref,
        (update, position) => events.thread({ ref: row.ref, ...position, update }),
        (code) => events.error?.(row.ref, code)
      )
      return { ref: row.ref, descriptor: attached.descriptor }
    }
  }
}
