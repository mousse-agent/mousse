import { isAbsolute } from 'node:path'
import { AppError } from '../../../shared/errors'
import { isId, NetError, NET_ERRORS } from '../../../shared/net'
import {
  SPACE_ARCHIVE_METHODS,
  type SpaceArchiveMethod,
  type SpaceArchiveParams
} from '../../../shared/spaces/archive'
import { DomainHandlerRegistry, domainObject } from '../../protocol/domainRegistry'
export interface SpaceArchiveLocalPort {
  request<K extends SpaceArchiveMethod>(
    method: K,
    params: SpaceArchiveParams[K]
  ): unknown | Promise<unknown>
}
const fields: Record<SpaceArchiveMethod, string[]> = {
  'spaces.archive.freeze': ['space', 'reason'],
  'spaces.archive.export': ['space', 'path'],
  'spaces.archive.retire': ['space'],
  'spaces.archive.import': ['path', 'mode'],
  'spaces.archive.activate': ['space'],
  'spaces.archive.status': ['space', 'after', 'limit']
}
function invalid(): never {
  throw new NetError('bad_request')
}
export function validateSpaceArchive<K extends SpaceArchiveMethod>(
  method: K,
  value: unknown
): SpaceArchiveParams[K] {
  let row: Record<string, unknown>
  try {
    row = domainObject(value ?? {}, fields[method])
  } catch {
    return invalid()
  }
  if (
    method !== 'spaces.archive.import' &&
    method !== 'spaces.archive.status' &&
    !isId('space', row.space)
  )
    invalid()
  for (const key of ['space', 'after'])
    if (row[key] !== undefined && !isId('space', row[key])) invalid()
  if (
    row.path !== undefined &&
    (typeof row.path !== 'string' ||
      !isAbsolute(row.path) ||
      Buffer.byteLength(row.path) > 4096 ||
      /[\x00-\x1f\x7f]/.test(row.path))
  )
    invalid()
  if (['spaces.archive.export', 'spaces.archive.import'].includes(method) && row.path === undefined)
    invalid()
  if (method === 'spaces.archive.import' && !['restore', 'move'].includes(row.mode as string))
    invalid()
  if (
    method === 'spaces.archive.freeze' &&
    (typeof row.reason !== 'string' ||
      !row.reason.trim() ||
      row.reason !== row.reason.trim() ||
      Buffer.byteLength(row.reason) > 1024 ||
      /[\x00-\x1f\x7f]/.test(row.reason))
  )
    invalid()
  if (
    row.limit !== undefined &&
    (!Number.isSafeInteger(row.limit) || Number(row.limit) < 1 || Number(row.limit) > 32)
  )
    invalid()
  if (
    method === 'spaces.archive.status' &&
    row.space !== undefined &&
    (row.after !== undefined || row.limit !== undefined)
  )
    invalid()
  return row as unknown as SpaceArchiveParams[K]
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
export function registerSpaceArchiveMethods(
  registry: DomainHandlerRegistry,
  forProfile: (id: string) => SpaceArchiveLocalPort | Promise<SpaceArchiveLocalPort>
): void {
  for (const method of SPACE_ARCHIVE_METHODS)
    registry.register({
      method,
      scope: 'profile',
      capability: 'net.v1',
      requiredCapabilities: ['net.v1'],
      validate: (value) => {
        try {
          return validateSpaceArchive(method, value)
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
