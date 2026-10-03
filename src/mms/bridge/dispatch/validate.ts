import { NetError, isId, isBlobId, type RpcArtifactRef } from '../../../shared/net'
import type { DispatchRequest } from './types'
import { COMMIT, REPO_ID } from './repository'

const fields = (value: unknown, names: string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !names.includes(key))) throw new NetError('bad_request')
  return value as Record<string, unknown>
}
export function artifact(value: unknown): RpcArtifactRef {
  const row = fields(value, ['stream', 'event', 'blob'])
  if (!isId('stream', row.stream) || !isId('event', row.event) || !isBlobId(row.blob)) throw new NetError('bad_request')
  return row as unknown as RpcArtifactRef
}
export function dispatchRequest(value: unknown): DispatchRequest {
  const row = fields(value, ['repoId', 'baseCommit', 'agent', 'prompt', 'limits', 'inputBundle', 'fetch', 'push'])
  if (typeof row.repoId !== 'string' || !REPO_ID.test(row.repoId) || typeof row.baseCommit !== 'string' || !COMMIT.test(row.baseCommit) || typeof row.agent !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.agent)) throw new NetError('bad_request')
  if (typeof row.prompt !== 'string' || !row.prompt.length || Buffer.byteLength(row.prompt) > 64 * 1024) throw new NetError('bad_request')
  const limits = fields(row.limits, ['maxTurns', 'maxToolCalls', 'maxElapsedMs', 'maxInputTokens', 'maxOutputTokens', 'maxCostUsd'])
  for (const key of ['maxTurns', 'maxToolCalls', 'maxElapsedMs']) if (!Number.isSafeInteger(limits[key]) || Number(limits[key]) < 1) throw new NetError('bad_request')
  if (Number(limits.maxTurns) > 1000 || Number(limits.maxToolCalls) > 10_000 || Number(limits.maxElapsedMs) > 24 * 3600_000) throw new NetError('bad_request')
  for (const key of ['maxInputTokens', 'maxOutputTokens']) if (limits[key] !== undefined && (!Number.isSafeInteger(limits[key]) || Number(limits[key]) < 0)) throw new NetError('bad_request')
  if (limits.maxCostUsd !== undefined && (typeof limits.maxCostUsd !== 'number' || !Number.isFinite(limits.maxCostUsd) || limits.maxCostUsd < 0)) throw new NetError('bad_request')
  for (const key of ['fetch', 'push']) if (row[key] !== undefined && typeof row[key] !== 'boolean') throw new NetError('bad_request')
  if (row.inputBundle !== undefined) artifact(row.inputBundle)
  return structuredClone(row) as unknown as DispatchRequest
}
