import { domainObject, DomainRpcError } from '../protocol/domainRegistry'
import { WORKFLOW_UUID_PATTERN } from '../../shared/workflows'
import type { WorkflowRunMethod } from '../../shared/workflowRunPlatform'

type Params = Record<string, unknown>
const fields: Record<WorkflowRunMethod, readonly string[]> = {
  'workflowRuns.start': ['definitionId', 'revisionId', 'draft', 'expectedDraftSemanticHash', 'input', 'threadId', 'projectId', 'requestId'],
  'workflowRuns.get': ['runId'],
  'workflowRuns.list': ['definitionId', 'threadId', 'before', 'limit'],
  'workflowRuns.trace': ['runId', 'afterSequence', 'limit'],
  'workflowRuns.pause': ['runId'], 'workflowRuns.resume': ['runId'],
  'workflowRuns.cancel': ['runId', 'reason'],
  'workflowRuns.approve': ['runId', 'approvalId', 'nodeId', 'instanceKey', 'attempt', 'approved'],
  'workflowRuns.answer': ['runId', 'nodeId', 'instanceKey', 'data'],
  'workflowRuns.reconcile': ['runId', 'nodeId', 'instanceKey', 'attempt', 'decision']
}

/** Bound both shape and traversal cost before interpreting schema-driven inputs. */
function validateJson(value: unknown): void {
  let visited = 0
  const walk = (item: unknown, depth: number): void => {
    if (++visited > 20_000 || depth > 32) throw new DomainRpcError('invalid_params', 'Workflow input is too complex')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (Array.isArray(item)) { for (const child of item) walk(child, depth + 1); return }
    if (item && typeof item === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      for (const [key, child] of Object.entries(item)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new DomainRpcError('invalid_params', 'Reserved workflow input property')
        walk(child, depth + 1)
      }
      return
    }
    throw new DomainRpcError('invalid_params', 'Workflow input must contain JSON values')
  }
  walk(value, 0)
}

export function validateWorkflowRunParams(method: WorkflowRunMethod, value: unknown): Params {
  const p = { ...domainObject(value ?? {}, ['profileId', ...fields[method]]) }
  if (typeof p.profileId !== 'string' || !p.profileId.trim() || p.profileId.includes('\0') || p.profileId.length > 256) throw new DomainRpcError('invalid_params', 'Profile identity is required')
  for (const key of ['runId', 'definitionId', 'approvalId', 'requestId', 'threadId', 'projectId']) {
    if (p[key] !== undefined && (typeof p[key] !== 'string' || !WORKFLOW_UUID_PATTERN.test(p[key] as string))) throw new DomainRpcError('invalid_params', 'Invalid ' + key)
  }
  if (fields[method].includes('runId') && !p.runId) throw new DomainRpcError('invalid_params', 'Run identity is required')
  for (const key of ['threadId', 'projectId', 'nodeId', 'instanceKey', 'reason']) {
    if (p[key] !== undefined && (typeof p[key] !== 'string' || !(p[key] as string).trim() || (p[key] as string).length > (key === 'instanceKey' ? 2048 : 1024) || (p[key] as string).includes('\0'))) throw new DomainRpcError('invalid_params', 'Invalid ' + key)
  }
  for (const key of ['revisionId', 'expectedDraftSemanticHash']) {
    if (p[key] !== undefined && (typeof p[key] !== 'string' || !/^[a-f0-9]{64}$/.test(p[key] as string))) throw new DomainRpcError('invalid_params', 'Invalid ' + key)
  }
  if (method === 'workflowRuns.start') {
    if (!p.definitionId || !p.requestId || !Object.hasOwn(p, 'input')) throw new DomainRpcError('invalid_params', 'Definition, request identity and input are required')
    if (p.draft !== undefined && typeof p.draft !== 'boolean') throw new DomainRpcError('invalid_params', 'draft must be boolean')
    if (p.draft === true) {
      if (!p.expectedDraftSemanticHash || p.revisionId !== undefined) throw new DomainRpcError('invalid_params', 'A draft run requires only its exact saved draft hash')
    } else if (p.expectedDraftSemanticHash !== undefined) throw new DomainRpcError('invalid_params', 'A published run cannot include a draft hash')
    validateJson(p.input)
  }
  if (method === 'workflowRuns.approve' || method === 'workflowRuns.reconcile' || method === 'workflowRuns.answer') {
    if (!p.nodeId || !p.instanceKey) throw new DomainRpcError('invalid_params', 'A pending node instance is required')
    if (method !== 'workflowRuns.answer' && (!Number.isSafeInteger(p.attempt) || (p.attempt as number) < 1)) throw new DomainRpcError('invalid_params', 'A positive attempt is required')
  }
  if (method === 'workflowRuns.approve' && (!p.approvalId || typeof p.approved !== 'boolean')) throw new DomainRpcError('invalid_params', 'Approval identity and decision are required')
  if (method === 'workflowRuns.answer') {
    if (!Object.hasOwn(p, 'data')) throw new DomainRpcError('invalid_params', 'Answer data is required')
    validateJson(p.data)
  }
  if (method === 'workflowRuns.reconcile' && !['retry', 'fail', 'accept'].includes(p.decision as string)) throw new DomainRpcError('invalid_params', 'Invalid reconciliation decision')
  if (p.limit !== undefined && (!Number.isSafeInteger(p.limit) || (p.limit as number) < 1 || (p.limit as number) > 100)) throw new DomainRpcError('invalid_params', 'limit must be between 1 and 100')
  if (p.afterSequence !== undefined && (!Number.isSafeInteger(p.afterSequence) || (p.afterSequence as number) < 0)) throw new DomainRpcError('invalid_params', 'afterSequence must be a nonnegative integer')
  if (p.before !== undefined) decodeWorkflowRunCursor(p.before)
  return p
}

/** Stable ordering also distinguishes runs admitted in the same millisecond. */
export function decodeWorkflowRunCursor(value: unknown): { createdAt: string; runId: string } {
  if (typeof value !== 'string' || value.length > 80) throw new DomainRpcError('invalid_params', 'Invalid history cursor')
  const [createdAt, runId, extra] = value.split('|')
  const time = Date.parse(createdAt)
  if (extra !== undefined || !Number.isFinite(time) || new Date(time).toISOString() !== createdAt || !WORKFLOW_UUID_PATTERN.test(runId ?? '')) throw new DomainRpcError('invalid_params', 'Invalid history cursor')
  return { createdAt, runId }
}
