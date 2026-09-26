import type { DurableApprovalRecord, WorkflowJournalEvent, WorkflowRunManifest, WorkflowRunSnapshot } from '../../shared/workflows'
import type { WorkflowRunEvent, WorkflowRunView } from '../../shared/workflowRunPlatform'
import { DomainRpcError } from '../protocol/domainRegistry'

export const WORKFLOW_RUN_VIEW_LIMITS = Object.freeze({ events: 100, attempts: 100, artifacts: 100, waits: 100, resultBytes: 32 * 1024, eventBytes: 2048, responseBytes: 1024 * 1024 })

/** Clone bounded display data without serializing a potentially huge source value. */
export function workflowJsonPreview(value: unknown, maxBytes: number): { value: unknown; truncated: boolean } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 32) throw new Error('Invalid preview limit')
  let remaining = maxBytes
  let visited = 0
  let truncated = false
  const active = new WeakSet<object>()
  const string = (item: string): string => {
    let result = item.slice(0, Math.max(0, remaining - 8))
    while (result.length && Buffer.byteLength(JSON.stringify(result), 'utf8') > remaining - 8) result = result.slice(0, Math.floor(result.length * 0.75))
    remaining -= Buffer.byteLength(JSON.stringify(result), 'utf8') + 2
    if (result.length < item.length) truncated = true
    return result
  }
  const walk = (item: unknown, depth: number): unknown => {
    if (++visited > 1000 || depth > 12 || remaining < 16) { truncated = true; return null }
    remaining -= 8
    if (item === null || typeof item === 'boolean') return item
    if (typeof item === 'number') {
      remaining -= 32
      if (Number.isFinite(item)) return item
      truncated = true
      return null
    }
    if (typeof item === 'string') return string(item)
    if (!item || typeof item !== 'object' || active.has(item)) { truncated = true; return null }
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) { truncated = true; return null }
    active.add(item)
    try {
      if (Array.isArray(item)) {
        const result: unknown[] = []
        for (let i = 0; i < item.length; i++) {
          if (remaining < 64 || visited >= 1000) { truncated = true; break }
          result.push(walk(item[i], depth + 1))
        }
        return result
      }
      const result: Record<string, unknown> = Object.create(null)
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue
        if (remaining < 64 || ++visited >= 1000) { truncated = true; break }
        // Do not rename an oversized key into a different executable property.
        if (key.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(key)) { truncated = true; continue }
        remaining -= Buffer.byteLength(JSON.stringify(key), 'utf8') + 2
        if (remaining < 32) { truncated = true; break }
        result[key] = walk((item as Record<string, unknown>)[key], depth + 1)
      }
      return result
    } finally { active.delete(item) }
  }
  const result = walk(value, 0)
  // This serialization operates only on the already bounded clone.
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxBytes) return { value: null, truncated: true }
  return { value: result, truncated }
}

const displayText = (value: string | undefined, limit = 4096): string | undefined => value?.slice(0, limit)
function findLast<T>(items: readonly T[], matches: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (matches(items[i])) return items[i]
  return undefined
}

export function workflowRunEventView(event: WorkflowJournalEvent): WorkflowRunEvent {
  const preview = workflowJsonPreview(event.payload, WORKFLOW_RUN_VIEW_LIMITS.eventBytes)
  const message = typeof event.payload.message === 'string' ? event.payload.message
    : typeof event.payload.error === 'string' ? event.payload.error
      : typeof event.payload.state === 'string' ? event.payload.state : event.kind
  return {
    seq: event.seq, at: event.at, kind: event.kind, runId: event.runId,
    nodeId: typeof event.payload.nodeId === 'string' ? displayText(event.payload.nodeId, 1024) : undefined,
    instanceKey: displayText(event.instanceKey, 2048), message: displayText(message, 2048)!,
    payload: preview.value as Record<string, unknown>, payloadTruncated: preview.truncated || message.length > 2048
  }
}

export function workflowRunSummary(manifest: WorkflowRunManifest): WorkflowRunView {
  return {
    runId: manifest.runId, profileId: manifest.profileId, definitionId: manifest.definitionId,
    revisionId: manifest.revisionId, semanticHash: manifest.semanticHash, slug: manifest.slug,
    state: manifest.state, origin: 'host', startedAt: manifest.createdAt, updatedAt: manifest.updatedAt,
    journalSequence: manifest.journalSeq,
    error: displayText(manifest.terminalError), budgets: { ...manifest.budgets },
    events: [], attempts: [], artifacts: []
  }
}

/** Project execution records without private runtime envelopes or compiled bundles. */
export function workflowRunView(snapshot: WorkflowRunSnapshot, events: readonly WorkflowJournalEvent[], approvals: DurableApprovalRecord | readonly DurableApprovalRecord[] = []): WorkflowRunView {
  const view = workflowRunSummary(snapshot.manifest)
  const result = workflowJsonPreview(snapshot.result ?? null, WORKFLOW_RUN_VIEW_LIMITS.resultBytes)
  const eligibleEvents = events.filter((event) => event.seq <= snapshot.manifest.journalSeq)
  view.result = result.value
  view.events = eligibleEvents.slice(-WORKFLOW_RUN_VIEW_LIMITS.events).map(workflowRunEventView)
  view.attempts = snapshot.attempts.slice(-WORKFLOW_RUN_VIEW_LIMITS.attempts).map((attempt) => ({
    instanceKey: attempt.instanceKey, nodeId: attempt.nodeId, type: attempt.type, attempt: attempt.attempt,
    path: displayText(attempt.path, 2048), outcome: attempt.outcome,
    startedAt: attempt.startedAt, completedAt: attempt.completedAt, error: displayText(attempt.error), effect: attempt.effect,
    childRunId: attempt.childRunId, workspaceRevision: attempt.workspaceRevision
  }))
  if (snapshot.artifacts.some((artifact) => artifact.profileId !== view.profileId || (artifact.runId && artifact.runId !== view.runId))) throw new DomainRpcError('profile_mismatch', 'Artifact does not belong to this workflow run')
  view.artifacts = snapshot.artifacts.slice(-WORKFLOW_RUN_VIEW_LIMITS.artifacts).map((artifact) => {
    return { id: artifact.id, displayName: displayText(artifact.displayName, 1024)!, mediaType: displayText(artifact.mediaType, 256)!, byteLength: artifact.byteLength, sha256: artifact.sha256 }
  })
  const approvalRecords = Array.isArray(approvals) ? approvals : [approvals]
  const waits = snapshot.pendingWaits?.slice().sort((a, b) => a.instanceKey.localeCompare(b.instanceKey)) ?? []
  const visibleWaits = waits.slice(0, WORKFLOW_RUN_VIEW_LIMITS.waits)
  view.counts = { events: eligibleEvents.length, attempts: snapshot.attempts.length, artifacts: snapshot.artifacts.length, waits: waits.length }
  view.truncated = {
    events: eligibleEvents.length > view.events.length,
    attempts: snapshot.attempts.length > view.attempts.length,
    artifacts: snapshot.artifacts.length > view.artifacts.length,
    waits: waits.length > visibleWaits.length,
    result: result.truncated
  }
  const approvalWaits = visibleWaits.filter((wait) => wait.approvalId)
  if (!approvalWaits.length && snapshot.pendingApprovalId) approvalWaits.push({
    instanceKey: snapshot.pendingInput?.instanceKey ?? '', nodeId: '', state: 'waiting-approval', approvalId: snapshot.pendingApprovalId
  })
  view.pendingApprovals = approvalWaits.map((wait) => {
    const approvalId = wait.approvalId!
    const approval = approvalRecords.find((record) => record.approvalId === approvalId)
    if (!approval) return undefined
    const childApproval = approval.runId === wait.childRunId
    if (approval.profileId !== view.profileId || (!childApproval && approval.runId !== view.runId) || (!childApproval && (approval.definitionId !== view.definitionId || approval.revisionId !== view.revisionId || approval.policySnapshotId !== snapshot.manifest.policySnapshotId))) throw new DomainRpcError('approval_mismatch', 'Approval does not match this workflow execution')
    if (approval.consumedAt || approval.revokedAt) return undefined
    return {
      approvalId: approval.approvalId, runId: view.runId, nodeId: approval.nodeId,
      instanceKey: approval.instanceKey, attempt: approval.attempt,
      description: displayText(approval.description)!, expiresAt: approval.expiresAt,
      childRunId: wait.childRunId
    }
  }).filter((value): value is NonNullable<typeof value> => Boolean(value))
  view.pendingApproval = view.pendingApprovals[0]
  const inputWaits = visibleWaits.filter((wait) => wait.pendingInput).map((wait) => ({ pending: wait.pendingInput!, childRunId: wait.childRunId }))
  if (!inputWaits.length && snapshot.pendingInput) inputWaits.push({ pending: snapshot.pendingInput, childRunId: undefined })
  view.pendingInputs = inputWaits.map(({ pending, childRunId }) => {
    // The instance record owns the node identity. A DTO cannot provide it.
    const attempt = findLast(snapshot.attempts, (item) => item.instanceKey === pending.instanceKey)
    const nodeId = 'nodeId' in pending && typeof pending.nodeId === 'string' ? pending.nodeId : attempt?.nodeId
    if (!nodeId) throw new DomainRpcError('pending_input_unavailable', 'The pending node identity could not be recovered')
    return { runId: view.runId, nodeId, instanceKey: pending.instanceKey, prompt: displayText(pending.prompt)!, schema: pending.schema as Record<string, unknown> | undefined, childRunId }
  })
  view.pendingInput = view.pendingInputs[0]
  view.pendingConditions = visibleWaits.filter((wait) => wait.wakeAt || wait.childState).map((wait) => ({
    runId: view.runId, nodeId: wait.nodeId, instanceKey: wait.instanceKey, wakeAt: wait.wakeAt, childRunId: wait.childRunId, childState: wait.childState
  }))
  const childUnknown = visibleWaits.find((wait) => wait.childState === 'unknown-effect' && wait.childRunId)
  if (childUnknown) {
    const attempt = findLast(snapshot.attempts, (item) => item.instanceKey === childUnknown.instanceKey)
    view.unknownEffect = {
      runId: view.runId, nodeId: childUnknown.nodeId, instanceKey: childUnknown.instanceKey,
      attempt: attempt?.attempt ?? 0,
      description: 'A child workflow has an external action with an unknown outcome.',
      childRunId: childUnknown.childRunId
    }
  }
  if (view.state === 'unknown-effect') {
    const unknown = findLast(snapshot.attempts, (attempt) => attempt.outcome === 'unknown')
    if (unknown) view.unknownEffect = {
      runId: view.runId, nodeId: unknown.nodeId, instanceKey: unknown.instanceKey, attempt: unknown.attempt,
      description: displayText(unknown.error ?? 'The external action may have completed before its result was recorded.')!,
      childRunId: unknown.childRunId
    }
  }
  view.currentNodeId = view.pendingApproval?.nodeId ?? view.pendingInput?.nodeId ?? view.pendingConditions?.[0]?.nodeId ?? view.unknownEffect?.nodeId
  return boundWorkflowRunResponse(view)
}

export function boundWorkflowRunResponse<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > WORKFLOW_RUN_VIEW_LIMITS.responseBytes) throw new DomainRpcError('response_too_large', 'Workflow run response exceeds the desktop transfer limit')
  return value
}
