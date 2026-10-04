import { AppError } from '../../shared/errors'
import { isId, NetError, NET_ERRORS } from '../../shared/net'
import {
  SPACES_LOCAL_CAPABILITY,
  SPACES_LOCAL_METHODS,
  type SpacesLocalMethod,
  type SpacesLocalParams
} from '../../shared/spaces/local'
import { DomainHandlerRegistry, DomainRpcError, domainObject } from '../protocol/domainRegistry'

export interface SpacesLocalPort {
  request<K extends SpacesLocalMethod>(
    method: K,
    params: SpacesLocalParams[K]
  ): unknown | Promise<unknown>
}
const fields: Record<SpacesLocalMethod, readonly string[]> = {
  'spaces.create': ['name', 'channelName'],
  'spaces.invite': ['space', 'role', 'uses', 'ttlMs', 'joiner'],
  'spaces.join': ['invite', 'name'],
  'spaces.list': [],
  'spaces.channels': ['space', 'name'],
  'spaces.post': ['stream', 'text', 'mentions'],
  'spaces.tail': ['stream', 'after', 'limit'],
  'spaces.members': ['space'],
  'spaces.leave': ['space'],
  'spaces.outbox': ['stream', 'id', 'after', 'limit', 'states']
}
const invalid = (): never => {
  throw new NetError('bad_request')
}
function name(value: unknown): void {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    !value.length ||
    Array.from(value).length > 256 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    invalid()
}
export function validateSpacesLocal<K extends SpacesLocalMethod>(
  method: K,
  value: unknown
): SpacesLocalParams[K] {
  let row: Record<string, unknown>
  try {
    row = domainObject(value ?? {}, fields[method])
  } catch (error) {
    if (error instanceof DomainRpcError) return invalid()
    throw error
  }
  if (
    ('space' in row && !isId('space', row.space)) ||
    ('stream' in row && !isId('stream', row.stream))
  )
    invalid()
  if (
    ['spaces.invite', 'spaces.channels', 'spaces.members', 'spaces.leave'].includes(method) &&
    !isId('space', row.space)
  )
    invalid()
  if (
    ['spaces.post', 'spaces.tail', 'spaces.outbox'].includes(method) &&
    !isId('stream', row.stream)
  )
    invalid()
  if (method === 'spaces.create') name(row.name)
  for (const field of ['name', 'channelName']) if (row[field] !== undefined) name(row[field])
  if (
    method === 'spaces.join' &&
    (typeof row.invite !== 'string' ||
      !row.invite.startsWith('sj1_') ||
      row.invite.length > 64 * 1024)
  )
    invalid()
  if (row.role !== undefined && !['member', 'admin'].includes(row.role as string)) invalid()
  if (row.joiner !== undefined && !isId('user', row.joiner)) invalid()
  for (const [field, max] of [
    ['uses', 256],
    ['ttlMs', 86400000],
    ['limit', method === 'spaces.outbox' ? 256 : 128]
  ] as const)
    if (
      row[field] !== undefined &&
      (!Number.isSafeInteger(row[field]) || Number(row[field]) < 1 || Number(row[field]) > max)
    )
      invalid()
  if (
    method === 'spaces.post' &&
    (typeof row.text !== 'string' ||
      !row.text.length ||
      Buffer.byteLength(row.text) > 60 * 1024 ||
      Buffer.from(row.text, 'utf8').toString('utf8') !== row.text)
  )
    invalid()
  if (
    row.mentions !== undefined &&
    (!Array.isArray(row.mentions) ||
      row.mentions.length > 16 ||
      new Set(row.mentions).size !== row.mentions.length ||
      row.mentions.some((value) => !isId('bot', value)))
  )
    invalid()
  if (method === 'spaces.outbox') {
    if (
      row.states !== undefined &&
      (!Array.isArray(row.states) ||
        !row.states.length ||
        row.states.length > 4 ||
        new Set(row.states).size !== row.states.length ||
        row.states.some((state) =>
          typeof state !== 'string' || !['pending', 'unknown', 'sent', 'failed'].includes(state)
        ))
    )
      invalid()
    if (
      row.id !== undefined &&
      (!isId('event', row.id) || row.after !== undefined || row.limit !== undefined || row.states !== undefined)
    )
      invalid()
    if (row.after !== undefined && (!Number.isSafeInteger(row.after) || Number(row.after) < 0))
      invalid()
  }
  if (method === 'spaces.tail' && row.after !== undefined) {
    let after: Record<string, unknown>
    try {
      after = domainObject(row.after, ['epoch', 'seq'])
    } catch {
      return invalid()
    }
    if (
      !Number.isSafeInteger(after.epoch) ||
      Number(after.epoch) < 1 ||
      !Number.isSafeInteger(after.seq) ||
      Number(after.seq) < 0
    )
      invalid()
  }
  return row as unknown as SpacesLocalParams[K]
}
function publicError(error: NetError): AppError {
  const info = NET_ERRORS[error.code]
  return new AppError(
    {
      code: error.code,
      message: info.message,
      errorInfo: { category: info.category, retryable: info.retryable }
    },
    error
  )
}
export function registerSpaceMethods(
  registry: DomainHandlerRegistry,
  forProfile: (id: string) => SpacesLocalPort | Promise<SpacesLocalPort>
): void {
  for (const method of SPACES_LOCAL_METHODS)
    registry.register({
      method,
      scope: 'profile',
      capability: SPACES_LOCAL_CAPABILITY,
      requiredCapabilities: [SPACES_LOCAL_CAPABILITY],
      validate: (value) => {
        try {
          return validateSpacesLocal(method, value)
        } catch (error) {
          if (error instanceof NetError) throw publicError(error)
          throw error
        }
      },
      handle: async (_ctx, params, binding) => {
        try {
          return await (await forProfile(binding!.profileId)).request(method, params)
        } catch (error) {
          if (error instanceof NetError) throw publicError(error)
          throw error
        }
      }
    })
}
