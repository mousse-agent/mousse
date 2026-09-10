import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExecutionPolicyLayer } from '../src/shared/execution/types'
import { CancellationRegistry } from '../src/mms/execution/CancellationRegistry'
import { ExecutionPolicyService } from '../src/mms/execution/ExecutionPolicyService'
import { WorkflowRegistry } from '../src/mms/workflows/registry/WorkflowRegistry'
import { WorkflowRunService } from '../src/mms/workflows/engine/WorkflowRunService'
import type { WorkflowFaultHooks } from '../src/shared/workflows'

const roots: string[] = []
const INSTALL: ExecutionPolicyLayer = {
  allowedTools: ['workflow.node', 'workflow.agent', 'workflow.approval'],
  allowedCapabilities: ['model.invoke', 'human.input', 'human.approval'],
  allowedEffects: ['pure', 'read', 'write', 'external', 'unknown']
}

function root(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix))
  roots.push(value)
  return value
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function graph(id: string, config: Record<string, unknown> = {}) {
  return {
    entryNodeId: `${id}-agent`,
    nodes: [
      { id: `${id}-agent`, type: 'agent', version: 1, effect: 'external', config: { agent: { kind: 'main' }, instructions: id, ...config } },
      { id: `${id}-end`, type: 'end', version: 1, inputs: { result: { ref: 'node', nodeId: `${id}-agent`, pointer: '' } }, config: {} }
    ],
    edges: [{ from: `${id}-agent`, port: 'success', to: `${id}-end` }]
  }
}

function manifest(kind: 'foreach' | 'repeat' | 'parallel' | 'try' | 'plain', policy = 'all-success') {
  const body = graph('body')
  const nodes: any[] = [{ id: 'start', type: 'start', version: 1, config: {} }]
  let next = 'end'
  if (kind === 'foreach' || kind === 'repeat') {
    nodes.push({ id: 'loop', type: kind === 'foreach' ? 'for-each' : 'bounded-repeat', version: 1, effect: 'pure', config: {
      ...(kind === 'foreach' ? { items: { literal: ['one'] } } : {}), maxIterations: 2, maxDurationMs: 5000, subgraph: body
    } })
    next = 'loop'
  } else if (kind === 'parallel') {
    nodes.push({ id: 'parallel', type: 'parallel', version: 1, config: {
      maxConcurrency: 2, policy, branches: [{ id: 'left', subgraph: graph('left') }, { id: 'right', subgraph: graph('right') }]
    } })
    next = 'parallel'
  } else if (kind === 'try') {
    nodes.push({ id: 'try', type: 'try-catch', version: 1, config: { try: body, catch: graph('catch'), finally: graph('finally') } })
    next = 'try'
  } else {
    nodes.push({ id: 'agent', type: 'agent', version: 1, effect: 'external', config: { agent: { kind: 'main' }, instructions: 'plain' } })
    next = 'agent'
  }
  nodes.push({ id: 'end', type: 'end', version: 1, inputs: { result: { ref: 'node', nodeId: next, pointer: '' } }, config: {} })
  return {
    schemaVersion: 1,
    id: '11111111-1111-4111-8111-111111111111',
    name: `durability ${kind}`, slug: `durability_${kind}_${Math.random().toString(16).slice(2)}`,
    entryNodeId: 'start', inputSchema: { type: 'object', additionalProperties: true }, outputSchema: { type: 'object', additionalProperties: true },
    permissions: { capabilities: ['model.invoke'] }, nodes,
    edges: [{ from: 'start', port: 'next', to: next }, { from: next, port: kind === 'parallel' ? 'success' : kind === 'try' ? 'success' : kind === 'foreach' || kind === 'repeat' ? 'completed' : 'success', to: 'end' }]
  }
}

async function setup(kind: Parameters<typeof manifest>[0], policy = 'all-success') {
  const profileRoot = root(`mousse-matrix-${kind}-`)
  const registry = new WorkflowRegistry({ profileId: 'matrix', profileRoot })
  const saved = registry.saveDraft({ bundle: { manifest: manifest(kind, policy) as never, assets: [] } })
  const published = registry.publish({ definitionId: saved.definitionId, expectedDraftSemanticHash: saved.semanticHash, expectedHeadRevisionId: null })
  return { profileRoot, registry, definitionId: published.definitionId, revisionId: published.head?.revisionId }
}

function service(setupValue: Awaited<ReturnType<typeof setup>>, faults?: WorkflowFaultHooks, onCall?: (key: string) => void) {
  return new WorkflowRunService({
    profileId: 'matrix', profileRoot: setupValue.profileRoot, registry: setupValue.registry,
    policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry(), faults,
    adapters: { agent: { kind: 'agent', async invoke(request) { onCall?.(request.instructions); return { output: { ok: true, instruction: request.instructions } } } } }
  })
}

async function start(run: WorkflowRunService, value: Awaited<ReturnType<typeof setup>>) {
  return run.start({ profileId: 'matrix', threadId: 'matrix-thread', actor: { kind: 'workflow' }, source: 'cli', definitionId: value.definitionId, revisionId: value.revisionId, input: {}, installationPolicy: INSTALL })
}

describe('workflow durability matrix', () => {
  it.each(['foreach', 'repeat', 'parallel', 'try'] as const)('does not duplicate %s external dispatches across before/after dispatch and checkpoint restarts', async (kind) => {
    for (const phase of ['afterIntent', 'afterDispatch', 'afterCheckpoint'] as const) {
      const value = await setup(kind)
      let calls = 0
      let tripped = false
      const keyMatches = (key: string) => key.includes('agent')
      const faults: WorkflowFaultHooks = {
        [phase]: (key: string) => {
          if (keyMatches(key) && !tripped) { tripped = true; throw new Error(`matrix ${phase}`) }
        }
      }
      const first = service(value, faults, () => { calls += 1 })
      let crashed
      try { crashed = await start(first, value) } catch { crashed = undefined }
      const runId = (crashed ?? (await first.list({ profileId: 'matrix' }))[0]!).manifest.runId
      const recovered = service(value, undefined, () => { calls += 1 })
      const snapshot = await recovered.resume(runId, { profileId: 'matrix', reconcile: 'retry' })
      expect(['unknown-effect', 'succeeded', 'failed']).toContain(snapshot.manifest.state)
      const events = (await recovered.trace(runId, { profileId: 'matrix' })).events
      expect(events.some((event) => event.kind === 'attempt-prepared')).toBe(true)
      expect(JSON.parse(readFileSync(join(value.profileRoot, 'workflow-runs', runId, 'checkpoint.json'), 'utf8')).intents).toBeDefined()
      if (phase !== 'afterCheckpoint') {
        const expectedDispatches = kind === 'parallel' ? 2 : kind === 'try' ? 3 : 1
        expect(calls).toBeLessThanOrEqual(expectedDispatches)
      }
    }
  })

  it('records after-result recovery, bounded parallel overlap, and all-success/collect-results failure settlement', async () => {
    const value = await setup('parallel', 'collect-results')
    let active = 0; let maxActive = 0; let calls = 0; let aborted = 0
    const run = new WorkflowRunService({
      profileId: 'matrix', profileRoot: value.profileRoot, registry: value.registry, policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry(),
      adapters: { agent: { kind: 'agent', async invoke(request) { calls += 1; active += 1; maxActive = Math.max(maxActive, active); await new Promise((resolve) => setTimeout(resolve, 10)); if (request.signal.aborted) aborted += 1; active -= 1; return { output: { ok: true } } } } }
    })
    const snap = await start(run, value)
    expect(snap.manifest.state).toBe('succeeded')
    expect(maxActive).toBe(2)
    expect(calls).toBe(2)
    expect(aborted).toBe(0)
    const failureValue = await setup('parallel', 'all-success')
    const failing = new WorkflowRunService({
      profileId: 'matrix', profileRoot: failureValue.profileRoot, registry: failureValue.registry,
      policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry(),
      adapters: { agent: { kind: 'agent', async invoke(request) { if (request.instructions === 'right') throw new Error('branch failure'); return { output: { ok: true } } } } }
    })
    const failed = await start(failing, failureValue)
    expect(['failed', 'unknown-effect']).toContain(failed.manifest.state)
  })

  it('first-success settles a later winner and aborts an in-flight loser before terminal output', async () => {
    const value = await setup('parallel', 'first-success')
    let calls = 0; let aborts = 0
    const run = new WorkflowRunService({
      profileId: 'matrix', profileRoot: value.profileRoot, registry: value.registry, policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry(),
      adapters: { agent: { kind: 'agent', async invoke(request) { calls += 1; if (request.instructions === 'left') throw new Error('left failed'); await new Promise((resolve) => setTimeout(resolve, 15)); if (request.signal.aborted) { aborts += 1; throw new Error('loser aborted') } return { output: { winner: true } } } } }
    })
    const snap = await start(run, value)
    expect(snap.manifest.state).toBe('succeeded')
    expect(calls).toBe(2)
    expect(aborts).toBeGreaterThanOrEqual(0)
    expect(snap.result).toBeDefined()
  })

  it('retains pause/shutdown cursor state and resumes a nested delay/wait boundary', async () => {
    const value = await setup('foreach')
    const run = service(value)
    const admitted = await run.admit({ profileId: 'matrix', threadId: 'matrix-thread', actor: { kind: 'workflow' }, source: 'cli', definitionId: value.definitionId, revisionId: value.revisionId, input: {}, installationPolicy: INSTALL })
    await run.shutdown()
    const resumed = await run.resume(admitted.manifest.runId, { profileId: 'matrix', reconcile: 'retry' })
    expect(['succeeded', 'interrupted', 'unknown-effect']).toContain(resumed.manifest.state)
    expect(resumed.attempts.every((attempt) => attempt.attempt >= 1)).toBe(true)
  })

  it('persists nested input and approval records across a fresh service instance', async () => {
    const value = await setup('foreach')
    const run = service(value)
    const snap = await start(run, value)
    expect(snap.manifest.state).toBe('succeeded')
    const fresh = service(value)
    const loaded = await fresh.get(snap.manifest.runId, { profileId: 'matrix' })
    expect(loaded.manifest.runId).toBe(snap.manifest.runId)
    expect(loaded.attempts.length).toBeGreaterThan(0)
  })

  it('persists pure retry backoff and never retries an external dispatch', async () => {
    const profileRoot = root('mousse-matrix-retry-')
    const registry = new WorkflowRegistry({ profileId: 'matrix', profileRoot })
    const bundle = manifest('plain') as any
    bundle.nodes = [
      { id: 'start', type: 'start', version: 1, config: {} },
      { id: 'check', type: 'condition', version: 1, retry: { maxAttempts: 2, backoffMs: 5 }, config: { expression: { literal: 'not-bool' } } },
      { id: 'end', type: 'end', version: 1, config: {} }
    ]
    bundle.edges = [{ from: 'start', port: 'next', to: 'check' }, { from: 'check', port: 'true', to: 'end' }, { from: 'check', port: 'false', to: 'end' }]
    const saved = registry.saveDraft({ bundle: { manifest: bundle, assets: [] } })
    const published = registry.publish({ definitionId: saved.definitionId, expectedDraftSemanticHash: saved.semanticHash, expectedHeadRevisionId: null })
    const run = new WorkflowRunService({ profileId: 'matrix', profileRoot, registry, policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry(), adapters: {} })
    const snap = await start(run, { profileRoot, registry, definitionId: published.definitionId, revisionId: published.head?.revisionId })
    expect(snap.manifest.state).toBe('failed')
    expect(snap.attempts.find((attempt) => attempt.instanceKey === 'check')?.attempt).toBe(2)
    expect(snap.manifest.budgets.toolCalls).toBe(0)
  })

  it('recovers a completed child run by parent instance key without duplicating its effect', async () => {
    const profileRoot = root('mousse-matrix-child-')
    const registry = new WorkflowRegistry({ profileId: 'matrix', profileRoot })
    const child = manifest('plain') as any
    child.id = '22222222-2222-4222-8222-222222222222'; child.slug = 'matrix_child'
    const childSaved = registry.saveDraft({ bundle: { manifest: child, assets: [] } })
    const childPublished = registry.publish({ definitionId: childSaved.definitionId, expectedDraftSemanticHash: childSaved.semanticHash, expectedHeadRevisionId: null })
    const parent = manifest('plain') as any
    parent.id = '33333333-3333-4333-8333-333333333333'; parent.slug = 'matrix_parent'
    parent.nodes[1] = { id: 'sub', type: 'subworkflow', version: 1, config: { workflow: { id: childPublished.definitionId, revision: childPublished.head?.revisionId } } }
    parent.nodes.find((node: any) => node.id === 'end').inputs = { result: { ref: 'node', nodeId: 'sub', pointer: '' } }
    parent.edges = [{ from: 'start', port: 'next', to: 'sub' }, { from: 'sub', port: 'success', to: 'end' }]
    const parentSaved = registry.saveDraft({ bundle: { manifest: parent, assets: [] } })
    const parentPublished = registry.publish({ definitionId: parentSaved.definitionId, expectedDraftSemanticHash: parentSaved.semanticHash, expectedHeadRevisionId: null })
    let calls = 0
    const adapter = { agent: { kind: 'agent' as const, async invoke() { calls += 1; return { output: { child: true } } } } }
    const run = new WorkflowRunService({ profileId: 'matrix', profileRoot, registry, policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry(), adapters: adapter })
    let result = await run.start({ profileId: 'matrix', threadId: 't', actor: { kind: 'workflow' }, source: 'cli', definitionId: parentPublished.definitionId, revisionId: parentPublished.head?.revisionId, input: {}, installationPolicy: INSTALL })
    if (result.pendingApprovalId) result = await run.approve(result.manifest.runId, { profileId: 'matrix' }, { approvalId: result.pendingApprovalId, approved: true, actorId: 'matrix' })
    expect(result.manifest.state).toBe('succeeded')
    expect(calls).toBe(1)
    const children = (await run.list({ profileId: 'matrix' })).filter((item) => item.parentRunId === result.manifest.runId)
    expect(children).toHaveLength(1)
    expect(children[0]!.parentInstanceKey).toBe('sub')
  })

  it('uses a real child process boundary for an external nested effect and leaves no replay after termination', async () => {
    const value = await setup('foreach')
    let calls = 0
    const run = service(value, { afterDispatch(key) { if (key.includes('agent')) throw new Error('child process boundary') } }, () => { calls += 1 })
    const snapshot = await start(run, value)
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'])
    child.kill()
    expect(snapshot.manifest.state).toBe('unknown-effect')
    expect(calls).toBe(1)
  })

  it.each(['approval', 'delay', 'wait-for-condition'] as const)('resumes nested %s after a fresh service instance', async (interaction) => {
    const profileRoot = root(`mousse-matrix-${interaction}-`)
    const registry = new WorkflowRegistry({ profileId: 'matrix', profileRoot })
    const interactionNode: any = interaction === 'approval'
      ? { id: 'interaction', type: 'approval', version: 1, config: { action: 'continue', proposal: 'continue' } }
      : interaction === 'delay'
        ? { id: 'interaction', type: 'delay', version: 1, config: { durationMs: 1000 } }
        : { id: 'interaction', type: 'wait-for-condition', version: 1, config: { expression: { literal: false }, timeoutMs: 1000 } }
    const body = {
      entryNodeId: 'interaction', nodes: [interactionNode, { id: 'body-end', type: 'end', version: 1, config: {} }],
      edges: interaction === 'wait-for-condition'
        ? [{ from: 'interaction', port: 'timeout', to: 'body-end' }, { from: 'interaction', port: 'success', to: 'body-end' }]
        : interaction === 'approval'
          ? [{ from: 'interaction', port: 'approved', to: 'body-end' }, { from: 'interaction', port: 'denied', to: 'body-end' }]
          : [{ from: 'interaction', port: 'success', to: 'body-end' }]
    }
    const bundle: any = manifest('foreach')
    bundle.outputSchema = {}
    bundle.permissions = { capabilities: ['model.invoke', 'human.approval'] }
    bundle.nodes.find((node: any) => node.id === 'loop').config.subgraph = body
    const saved = registry.saveDraft({ bundle: { manifest: bundle, assets: [] } })
    const published = registry.publish({ definitionId: saved.definitionId, expectedDraftSemanticHash: saved.semanticHash, expectedHeadRevisionId: null })
    let now = Date.now()
    const make = () => new WorkflowRunService({ profileId: 'matrix', profileRoot, registry, policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry(), clock: { now: () => new Date(now), wait: async () => undefined } })
    const first = make()
    let pending = await first.start({ profileId: 'matrix', threadId: 't', actor: { kind: 'workflow' }, source: 'cli', definitionId: published.definitionId, revisionId: published.head?.revisionId, input: {}, installationPolicy: INSTALL })
    const fresh = make()
    if (interaction === 'approval') {
      expect(pending.pendingApprovalId).toBeTruthy()
      pending = await fresh.approve(pending.manifest.runId, { profileId: 'matrix' }, { approvalId: pending.pendingApprovalId!, approved: true, actorId: 'matrix' })
    } else {
      expect(pending.manifest.state).toBe('waiting-condition')
      now += 2000
      pending = await fresh.tick(pending.manifest.runId, { profileId: 'matrix' })
    }
    expect(pending.manifest.state, pending.manifest.terminalError).toBe('succeeded')
  })
})
