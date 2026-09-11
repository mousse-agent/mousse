import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ApprovalService } from '../src/mms/execution/ApprovalService'
import { CancellationRegistry } from '../src/mms/execution/CancellationRegistry'
import { ExecutionPolicyService } from '../src/mms/execution/ExecutionPolicyService'
import { DomainHandlerRegistry } from '../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../src/mms/protocol/handlers'
import { WorkflowRunService, WorkflowRegistry } from '../src/mms/workflows'
import { registerWorkflowRunMethods, type WorkflowRunDomainServices } from '../src/mms/workflows/registerRunMethods'
import { validateWorkflowRunParams } from '../src/mms/workflows/runDomainValidation'
import { workflowJsonPreview, workflowRunView, WORKFLOW_RUN_VIEW_LIMITS } from '../src/mms/workflows/runView'
import type { WorkflowManifest, WorkflowRunManifest } from '../src/shared/workflows'
import { WORKFLOW_RUN_CAPABILITY, type WorkflowRunMethod, type WorkflowRunView, type WorkflowRunListPage, type WorkflowRunTracePage } from '../src/shared/workflowRunPlatform'

const roots: string[] = []
const runtimes: WorkflowRunService[] = []
const profileId = 'run-profile-a'
const policy = { allowedTools: ['workflow.node', 'workflow.approval'], allowedCapabilities: ['human.approval', 'human.input'], allowedEffects: ['pure', 'read', 'unknown'] as const }
function fixture(kind: 'pure' | 'approval' | 'input' = 'pure') {
  const root = mkdtempSync(join(tmpdir(), 'mousse-run-domain-'))
  roots.push(root)
  const services = new Map<string, WorkflowRunDomainServices>()
  const registries = new Map<string, WorkflowRegistry>()
  for (const id of [profileId, 'run-profile-b']) {
    const profileRoot = join(root, id)
    const registry = new WorkflowRegistry({ profileId: id, profileRoot })
    const runtime = new WorkflowRunService({ profileId: id, profileRoot, registry, policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry() })
    runtimes.push(runtime)
    registries.set(id, registry)
    services.set(id, {
      profileId: id, runtime, approvals: new ApprovalService({ profileId: id, profileRoot }),
      start: (request, admission) => runtime.admit({
        profileId: id, definitionId: request.definitionId, revisionId: request.revisionId,
        expectedDraftSemanticHash: request.expectedDraftSemanticHash, requestId: request.requestId,
        input: request.input, threadId: 'owned-fixture-thread', actor: { kind: 'workflow' }, source: admission.source,
        installationPolicy: policy
      })
    })
  }
  const id = randomUUID()
  const manifest: WorkflowManifest = {
    schemaVersion: 1, id, name: 'Run domain fixture', slug: 'run-domain-fixture',
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, entryNodeId: 'start',
    nodes: [
      { id: 'start', type: 'start', version: 1, config: {} },
      ...(kind === 'pure' ? [] : [kind === 'approval'
        ? { id: 'interaction', type: 'approval' as const, version: 1, config: { action: 'continue', proposal: 'Continue this local fixture' } }
        : { id: 'interaction', type: 'ask-user' as const, version: 1, config: { prompt: 'Enter a value', answerSchema: { type: 'string' } } }]),
      { id: 'end', type: 'end', version: 1, inputs: { result: { ref: 'input', pointer: '' } }, config: {} }
    ],
    edges: kind === 'pure' ? [{ from: 'start', port: 'next', to: 'end' }]
      : [{ from: 'start', port: 'next', to: 'interaction' }, { from: 'interaction', port: kind === 'approval' ? 'approved' : 'success', to: 'end' }, ...(kind === 'approval' ? [{ from: 'interaction', port: 'denied', to: 'end' }] : [])],
    permissions: { capabilities: kind === 'pure' ? [] : [kind === 'approval' ? 'human.approval' : 'human.input'] }
  }
  const registry = registries.get(profileId)!
  const saved = registry.saveDraft({ bundle: { manifest, assets: [] } })
  const published = registry.publish({ definitionId: id, expectedDraftSemanticHash: saved.semanticHash, expectedHeadRevisionId: null })
  const domains = new DomainHandlerRegistry()
  registerWorkflowRunMethods(domains, (requested) => services.get(requested)!)
  const context = (owner = profileId): HandlerContext => ({ mms: {} as HandlerContext['mms'], globalSequence: () => 0, connection: { id: 'authenticated-fixture-window', clientType: 'gui', binding: { profileId: owner, epoch: 1 }, capabilities: new Set([WORKFLOW_RUN_CAPABILITY]) } })
  const request = async <T>(method: WorkflowRunMethod, params: unknown, owner = profileId): Promise<T> => JSON.parse(JSON.stringify(await domains.dispatch(context(owner), method, JSON.parse(JSON.stringify(params))))) as T
  const start = { profileId, definitionId: id, revisionId: published.semanticHash, input: { text: 'exact input' }, requestId: randomUUID() }
  return { root, services, domains, context, request, start, runtime: services.get(profileId)!.runtime as WorkflowRunService }
}
async function waitFor(f: ReturnType<typeof fixture>, runId: string, state: WorkflowRunView['state']): Promise<WorkflowRunView> {
  const until = Date.now() + 5000
  while (Date.now() < until) {
    const view = await f.request<WorkflowRunView>('workflowRuns.get', { profileId, runId })
    if (view.state === state) return view
    if (view.state === 'failed') throw new Error(view.error)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for ' + state)
}
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()))
  for (const root of roots.splice(0)) {
    const contained = relative(realpathSync(tmpdir()), realpathSync(root))
    if (isAbsolute(contained) || !contained.startsWith('mousse-run-domain-') || contained.includes('..')) throw new Error('Unsafe fixture cleanup target')
    rmSync(root, { recursive: true, force: true })
  }
})

describe('workflow run domain over the real durable engine', () => {
  it('admits an exact revision, preserves one request identity, and returns bounded owned history/trace', async () => {
    const f = fixture()
    const accepted = await f.request<WorkflowRunView>('workflowRuns.start', f.start)
    expect(accepted.state).toBe('queued')
    expect(accepted.origin).toBe('host')
    const completed = await waitFor(f, accepted.runId, 'succeeded')
    expect(completed.result).toEqual(f.start.input)
    const replay = await f.request<WorkflowRunView>('workflowRuns.start', f.start)
    expect(replay.runId).toBe(accepted.runId)
    expect((await f.runtime.list({ profileId }))).toHaveLength(1)
    expect((await f.runtime.get(accepted.runId, { profileId })).manifest.source).toBe('gui')
    await expect(f.request('workflowRuns.start', { ...f.start, input: { changed: true } })).rejects.toMatchObject({ code: 'WORKFLOW_CONCURRENCY_CONFLICT' })
    const list = await f.request<WorkflowRunListPage>('workflowRuns.list', { profileId })
    expect(list.runs.map((run) => run.runId)).toEqual([accepted.runId])
    const first = await f.request<WorkflowRunTracePage>('workflowRuns.trace', { profileId, runId: accepted.runId, limit: 1 })
    const next = await f.request<WorkflowRunTracePage>('workflowRuns.trace', { profileId, runId: accepted.runId, afterSequence: first.afterSequence })
    expect(first.events).toHaveLength(1)
    expect(first.hasMore).toBe(true)
    expect(next.events.every((event) => event.seq > first.afterSequence)).toBe(true)
    expect(JSON.stringify(completed)).not.toContain(f.root.replaceAll('\\', '\\\\'))
    expect(completed).not.toHaveProperty('compiled')
    expect(completed).not.toHaveProperty('policySnapshotId')
  })

  it('denies forged authority and foreign run access before any new run is created', async () => {
    const f = fixture()
    for (const extra of [{ actor: { kind: 'main' } }, { source: 'schedule' }, { installationPolicy: policy }, { profileRoot: f.root }, { runId: randomUUID() }]) await expect(f.request('workflowRuns.start', { ...f.start, ...extra })).rejects.toMatchObject({ code: 'unknown_field' })
    expect(await f.runtime.list({ profileId })).toHaveLength(0)
    const accepted = await f.request<WorkflowRunView>('workflowRuns.start', f.start)
    await expect(f.request('workflowRuns.get', { profileId: 'run-profile-b', runId: accepted.runId })).rejects.toMatchObject({ code: 'profile_mismatch' })
    await expect(f.request('workflowRuns.get', { profileId: 'run-profile-b', runId: accepted.runId }, 'run-profile-b')).rejects.toMatchObject({ code: 'run_not_found' })
    const context = f.context()
    context.connection = { ...context.connection!, capabilities: new Set() }
    await expect(f.domains.dispatch(context, 'workflowRuns.list', { profileId })).rejects.toMatchObject({ code: 'capability_required' })
  })

  it('binds approval to its durable node attempt and authenticated connection identity', async () => {
    const f = fixture('approval')
    const accepted = await f.request<WorkflowRunView>('workflowRuns.start', f.start)
    const waiting = await waitFor(f, accepted.runId, 'waiting-approval')
    const pending = waiting.pendingApproval!
    expect(pending.nodeId).toBe('interaction')
    const decision = { profileId, runId: accepted.runId, approvalId: pending.approvalId, nodeId: pending.nodeId, instanceKey: pending.instanceKey, attempt: pending.attempt, approved: true }
    await expect(f.request('workflowRuns.approve', { ...decision, attempt: pending.attempt + 1 })).rejects.toMatchObject({ code: 'stale_approval' })
    expect(f.services.get(profileId)!.approvals.get(pending.approvalId, profileId)?.consumedAt).toBeUndefined()
    await f.request('workflowRuns.approve', decision)
    expect(f.services.get(profileId)!.approvals.get(pending.approvalId, profileId)?.decidedBy).toBe('authenticated-fixture-window')
    expect((await waitFor(f, accepted.runId, 'succeeded')).result).toEqual(f.start.input)
    await expect(f.request('workflowRuns.approve', decision)).rejects.toMatchObject({ code: 'stale_approval' })
  })

  it('uses the stored pending input identity and rejects a stale node before consuming the answer', async () => {
    const f = fixture('input')
    const accepted = await f.request<WorkflowRunView>('workflowRuns.start', f.start)
    const waiting = await waitFor(f, accepted.runId, 'waiting-input')
    expect(waiting.pendingInput?.nodeId).toBe('interaction')
    const answer = { profileId, runId: accepted.runId, nodeId: 'interaction', instanceKey: waiting.pendingInput!.instanceKey, data: 'exact answer' }
    await expect(f.request('workflowRuns.answer', { ...answer, nodeId: 'forged-node' })).rejects.toMatchObject({ code: 'stale_input' })
    expect((await f.runtime.get(accepted.runId, { profileId })).pendingInput).toBeDefined()
    await f.request('workflowRuns.answer', answer)
    await waitFor(f, accepted.runId, 'succeeded')
    expect((await f.runtime.get(accepted.runId, { profileId })).outputs.interaction).toBe('exact answer')
  })

  it('paginates equal-timestamp admissions without dropping or duplicating runs', async () => {
    const f = fixture()
    const accepted = await f.request<WorkflowRunView>('workflowRuns.start', f.start)
    await waitFor(f, accepted.runId, 'succeeded')
    const manifest = (await f.runtime.get(accepted.runId, { profileId })).manifest
    const rows: WorkflowRunManifest[] = ['00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'].map((runId) => ({ ...manifest, runId }))
    // Fixed catalog data isolates the equal-timestamp cursor contract from the clock.
    f.services.get(profileId)!.runtime.list = async () => rows
    const first = await f.request<WorkflowRunListPage>('workflowRuns.list', { profileId, limit: 2 })
    const last = await f.request<WorkflowRunListPage>('workflowRuns.list', { profileId, limit: 2, before: first.nextCursor })
    expect([...first.runs, ...last.runs].map((run) => run.runId)).toEqual([...rows].sort((a, b) => b.runId.localeCompare(a.runId)).map((row) => row.runId))
    expect(last.nextCursor).toBeUndefined()
  })
})

describe('workflow run transfer bounds', () => {
  it('rejects malformed identities, draft ambiguity, deep data and invalid cursors', () => {
    const start = { profileId, definitionId: randomUUID(), requestId: randomUUID(), input: {} }
    for (const invalid of [{ ...start, requestId: undefined }, { ...start, definitionId: '../outside' }, { ...start, draft: true }, { ...start, draft: true, revisionId: 'a'.repeat(64), expectedDraftSemanticHash: 'b'.repeat(64) }, { ...start, input: JSON.parse('{"__proto__":true}') }, { ...start, input: NaN }]) expect(() => validateWorkflowRunParams('workflowRuns.start', invalid)).toThrow()
    let nested: unknown = null
    for (let i = 0; i < 40; i++) nested = [nested]
    expect(() => validateWorkflowRunParams('workflowRuns.start', { ...start, input: nested })).toThrow(/complex/)
    for (const before of ['2026-01-01T00:00:00Z', '../run', 'invalid|' + randomUUID()]) expect(() => validateWorkflowRunParams('workflowRuns.list', { profileId, before })).toThrow(/cursor/)
    for (const limit of [-1, 0, 101, 1.5]) expect(() => validateWorkflowRunParams('workflowRuns.trace', { profileId, runId: randomUUID(), limit })).toThrow(/limit/)
  })

  it('preserves small values and explicitly bounds Unicode, breadth, depth and cyclic display data', () => {
    const exact = { bool: false, zero: 0, text: 'hello', values: [null, 2] }
    expect(workflowJsonPreview(exact, 1024)).toEqual({ value: exact, truncated: false })
    const cyclic: unknown[] = []; cyclic.push(cyclic)
    for (const value of ['💡\n\"'.repeat(100_000), Array.from({ length: 50_000 }, (_, n) => n), cyclic]) {
      const preview = workflowJsonPreview(value, 1024)
      expect(preview.truncated).toBe(true)
      expect(Buffer.byteLength(JSON.stringify(preview.value))).toBeLessThanOrEqual(1024)
    }
  })

  it('keeps persisted output exact while exposing bounded previews and counts', async () => {
    const f = fixture()
    const input = { large: 'x'.repeat(100_000) }
    const accepted = await f.request<WorkflowRunView>('workflowRuns.start', { ...f.start, input })
    const finished = await waitFor(f, accepted.runId, 'succeeded')
    expect(finished.truncated?.result).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(finished))).toBeLessThan(WORKFLOW_RUN_VIEW_LIMITS.responseBytes)
    const snapshot = await f.runtime.get(accepted.runId, { profileId })
    expect(snapshot.result).toEqual(input)
    const broken = { ...snapshot, artifacts: [{ id: 'foreign', profileId: 'run-profile-b', runId: accepted.runId, displayName: 'private', mediaType: 'text/plain', byteLength: 1, sha256: 'a'.repeat(64), createdAt: new Date().toISOString() }] }
    expect(() => workflowRunView(broken, [])).toThrow(/Artifact/)
  })
})
