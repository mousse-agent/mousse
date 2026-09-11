import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { build } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionPolicyLayer } from '../src/shared/execution/types'
import { CancellationRegistry } from '../src/mms/execution/CancellationRegistry'
import { ExecutionPolicyService } from '../src/mms/execution/ExecutionPolicyService'
import { WorkflowRegistry } from '../src/mms/workflows/registry/WorkflowRegistry'
import { WorkflowRunService } from '../src/mms/workflows/engine/WorkflowRunService'
import type { WorkflowFaultHooks } from '../src/shared/workflows'

const roots: string[] = []
vi.setConfig({ testTimeout: 15000 })
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
  it.each(['foreach', 'repeat', 'parallel', 'try'] as const)('does not duplicate %s external dispatches across every durable fault boundary', async (kind) => {
    for (const phase of ['afterIntent', 'afterDispatch', 'afterResult', 'afterCheckpoint'] as const) {
      const value = await setup(kind)
      let calls = 0
      let tripped = false
      const keyMatches = (key: string) => key.includes('agent')
      const faults: WorkflowFaultHooks = {
        [phase]: (key: string) => {
          const target = phase === 'afterCheckpoint'
            || (phase === 'afterResult' ? key !== 'start' : keyMatches(key))
          if (target && !tripped) { tripped = true; throw new Error(`matrix ${phase}`) }
        }
      }
      const first = service(value, faults, () => { calls += 1 })
      let crashed
      try { crashed = await start(first, value) } catch { crashed = undefined }
      const runId = crashed?.manifest.runId ?? (await first.list({ profileId: 'matrix' }))[0]!.runId
      const recovered = service(value, undefined, () => { calls += 1 })
      const snapshot = await recovered.resume(runId, { profileId: 'matrix', reconcile: 'retry' })
      expect(tripped).toBe(true)
      const expectedState = phase === 'afterResult' || phase === 'afterCheckpoint'
        ? 'succeeded'
        : phase === 'afterDispatch'
          ? 'unknown-effect'
          : 'failed'
      expect(snapshot.manifest.state).toBe(expectedState)
      const events = (await recovered.trace(runId, { profileId: 'matrix' })).events
      expect(events.some((event) => event.kind === 'attempt-prepared')).toBe(true)
      expect(JSON.parse(readFileSync(join(value.profileRoot, 'workflow-runs', runId, 'checkpoint.json'), 'utf8')).intents).toBeDefined()
      const expectedDispatches = phase === 'afterIntent'
        ? kind === 'parallel' ? 1 : 0
        : phase === 'afterDispatch'
          ? kind === 'parallel' ? 2 : 1
          : kind === 'parallel' ? 2 : kind === 'try' ? 2 : kind === 'repeat' ? 2 : 1
      expect(calls).toBe(expectedDispatches)
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
    expect((snap.result as any)?.results).toHaveLength(2)

    const collectFailureValue = await setup('parallel', 'collect-results')
    const collectDraft = collectFailureValue.registry.get(collectFailureValue.definitionId)!
    const collectParallel = (collectDraft.bundle.manifest as any).nodes.find((node: any) => node.id === 'parallel')
    collectParallel.config.branches.find((branch: any) => branch.id === 'right').subgraph = {
      entryNodeId: 'right-condition',
      nodes: [
        { id: 'right-condition', type: 'condition', version: 1, config: { expression: { literal: 'not-a-boolean' } } },
        { id: 'right-end', type: 'end', version: 1, config: {} }
      ],
      edges: [
        { from: 'right-condition', port: 'true', to: 'right-end' },
        { from: 'right-condition', port: 'false', to: 'right-end' }
      ]
    }
    const collectSaved = collectFailureValue.registry.saveDraft({ bundle: collectDraft.bundle, expectedDraftSemanticHash: collectDraft.semanticHash })
    const collectPublished = collectFailureValue.registry.publish({ definitionId: collectSaved.definitionId, expectedDraftSemanticHash: collectSaved.semanticHash, expectedHeadRevisionId: collectSaved.head?.revisionId ?? null })
    collectFailureValue.revisionId = collectPublished.head?.revisionId
    let collectCalls = 0
    const collecting = new WorkflowRunService({
      profileId: 'matrix', profileRoot: collectFailureValue.profileRoot, registry: collectFailureValue.registry,
      policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry(),
      adapters: { agent: { kind: 'agent', async invoke(request) {
        collectCalls += 1
        return { output: { branch: request.instructions } }
      } } }
    })
    const collected = await start(collecting, collectFailureValue)
    expect(collected.manifest.state).toBe('succeeded')
    expect(collectCalls).toBe(1)
    expect((collected.result as any)?.results).toEqual([
      { id: 'left', ok: true, output: { branch: 'left' } },
      { id: 'right', ok: false, error: 'condition did not return a boolean' }
    ])

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
    const draft = value.registry.get(value.definitionId)!
    const parallel = (draft.bundle.manifest as any).nodes.find((node: any) => node.id === 'parallel')
    parallel.config.maxConcurrency = 3
    parallel.config.branches.push({ id: 'middle', subgraph: graph('middle') })
    parallel.config.branches.find((branch: any) => branch.id === 'left').subgraph = {
      entryNodeId: 'left-fail',
      nodes: [{ id: 'left-fail', type: 'fail', version: 1, config: { message: 'left failed' } }],
      edges: []
    }
    const saved = value.registry.saveDraft({ bundle: draft.bundle, expectedDraftSemanticHash: draft.semanticHash })
    const published = value.registry.publish({ definitionId: saved.definitionId, expectedDraftSemanticHash: saved.semanticHash, expectedHeadRevisionId: saved.head?.revisionId ?? null })
    let calls = 0; let loserSettled = false
    const run = new WorkflowRunService({
      profileId: 'matrix', profileRoot: value.profileRoot, registry: value.registry, policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry(),
      adapters: { agent: { kind: 'agent', async invoke(request) {
        calls += 1
        if (request.instructions === 'middle') {
          await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true }))
          loserSettled = true
          throw new Error('loser aborted')
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
        return { output: { winner: true } }
      } } }
    })
    const snap = await run.start({ profileId: 'matrix', threadId: 'matrix-thread', actor: { kind: 'workflow' }, source: 'cli', definitionId: published.definitionId, revisionId: published.head?.revisionId, input: {}, installationPolicy: INSTALL })
    expect(snap.manifest.state).toBe('succeeded')
    expect(calls).toBe(2)
    expect(loserSettled).toBe(true)
    expect(snap.result).toBeDefined()
    const before = (await run.trace(snap.manifest.runId, { profileId: 'matrix' })).events.length
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect((await run.trace(snap.manifest.runId, { profileId: 'matrix' })).events.length).toBe(before)
  })

  it('pauses an active external cursor, settles shutdown, and resumes without replay', async () => {
    const value = await setup('foreach')
    let startedResolve!: () => void
    const started = new Promise<void>((resolve) => { startedResolve = resolve })
    let calls = 0
    const run = new WorkflowRunService({
      profileId: 'matrix', profileRoot: value.profileRoot, registry: value.registry, policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry(),
      adapters: { agent: { kind: 'agent', async invoke(request) { calls += 1; startedResolve(); await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true })); return { output: { cancelled: true } } } } }
    })
    const admitted = await run.admit({ profileId: 'matrix', threadId: 'matrix-thread', actor: { kind: 'workflow' }, source: 'cli', definitionId: value.definitionId, revisionId: value.revisionId, input: {}, installationPolicy: INSTALL })
    await started
    await run.shutdown()
    const paused = await run.get(admitted.manifest.runId, { profileId: 'matrix' })
    expect(paused.manifest.state).toBe('interrupted')
    const fresh = service(value)
    const resumed = await fresh.resume(admitted.manifest.runId, { profileId: 'matrix', reconcile: 'retry' })
    expect(resumed.manifest.state).toBe('succeeded')
    expect(calls).toBe(1)
    expect(resumed.attempts.every((attempt) => attempt.attempt >= 1)).toBe(true)
  })

  it('enters catch and finally after a real try-body failure with exact dispatch markers', async () => {
    const value = await setup('try')
    const draft = value.registry.get(value.definitionId)!
    const tryNode = (draft.bundle.manifest as any).nodes.find((node: any) => node.id === 'try')
    tryNode.config.try = {
      entryNodeId: 'body-fail',
      nodes: [{ id: 'body-fail', type: 'fail', version: 1, config: { message: 'body failed' } }],
      edges: []
    }
    const saved = value.registry.saveDraft({ bundle: draft.bundle, expectedDraftSemanticHash: draft.semanticHash })
    const published = value.registry.publish({ definitionId: saved.definitionId, expectedDraftSemanticHash: saved.semanticHash, expectedHeadRevisionId: saved.head?.revisionId ?? null })
    value.revisionId = published.head?.revisionId
    const markers: string[] = []
    const run = new WorkflowRunService({
      profileId: 'matrix', profileRoot: value.profileRoot, registry: value.registry,
      policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry(),
      adapters: { agent: { kind: 'agent', async invoke(request) {
        markers.push(request.instructions)
        return { output: { marker: request.instructions } }
      } } }
    })
    const snap = await start(run, value)
    expect(snap.manifest.state).toBe('succeeded')
    expect(markers).toEqual(['catch', 'finally'])
    const trace = await run.trace(snap.manifest.runId, { profileId: 'matrix' })
    expect(trace.events.filter((event) => event.kind === 'attempt-prepared').map((event) => event.instanceKey)).toEqual([
      'start', 'try', 'try/try/body-fail', 'try/catch/catch-agent', 'try/catch/catch-end', 'try/finally/finally-agent', 'try/finally/finally-end', 'end'
    ])
  })

  it.each([['try', 'body'], ['parallel', undefined]] as const)(
    'does not convert an ambiguous external effect in %s into a successful result',
    async (kind, expectedOnlyMarker) => {
      const value = await setup(kind)
      const markers: string[] = []
      const run = new WorkflowRunService({
        profileId: 'matrix', profileRoot: value.profileRoot, registry: value.registry,
        policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry(),
        adapters: { agent: { kind: 'agent', async invoke(request) {
          markers.push(request.instructions)
          if (request.instructions === 'body' || request.instructions === 'right') {
            throw new Error('dispatch outcome unknown')
          }
          return { output: { marker: request.instructions } }
        } } }
      })
      const snap = await start(run, value)
      expect(snap.manifest.state).toBe('unknown-effect')
      if (expectedOnlyMarker) expect(markers).toEqual([expectedOnlyMarker])
    }
  )

  it('keeps the root checkpoint intact while a nested external intent is in flight', async () => {
    const value = await setup('foreach')
    let release!: () => void
    let started!: () => void
    const began = new Promise<void>((resolve) => { started = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const run = new WorkflowRunService({
      profileId: 'matrix', profileRoot: value.profileRoot, registry: value.registry,
      policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry(),
      adapters: { agent: { kind: 'agent', async invoke() {
        started()
        await blocked
        return { output: { ok: true } }
      } } }
    })
    const pending = start(run, value)
    await began
    const runId = (await run.list({ profileId: 'matrix' }))[0]!.runId
    const checkpoint = JSON.parse(readFileSync(join(value.profileRoot, 'workflow-runs', runId, 'checkpoint.json'), 'utf8'))
    expect(Object.keys(checkpoint.instances).sort()).toEqual(['loop', 'start'])
    expect(Object.keys(checkpoint.nested['loop#0'].instances)).toContain('loop#0/body-agent')
    expect(checkpoint.intents['loop#0/body-agent']).toMatchObject({ prepared: true, completed: false })
    release()
    expect((await pending).manifest.state).toBe('succeeded')
  })

  it('persists nested external cursor records across a fresh service instance', async () => {
    const value = await setup('foreach')
    const run = service(value)
    const snap = await start(run, value)
    expect(snap.manifest.state).toBe('succeeded')
    const fresh = service(value)
    const loaded = await fresh.get(snap.manifest.runId, { profileId: 'matrix' })
    expect(loaded.manifest.runId).toBe(snap.manifest.runId)
    expect(loaded.attempts.map((attempt) => attempt.instanceKey)).toContain('loop#0/body-agent')
    expect(loaded.attempts.find((attempt) => attempt.instanceKey === 'loop#0/body-agent')?.inputHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('deduplicates a durable start request across service restart and rejects mismatched reuse', async () => {
    const value = await setup('plain')
    let calls = 0
    const make = () => service(value, undefined, () => { calls += 1 })
    const request = {
      requestId: 'durable-start-request',
      profileId: 'matrix', threadId: 'matrix-thread', actor: { kind: 'workflow' as const }, source: 'cli' as const,
      definitionId: value.definitionId, revisionId: value.revisionId, input: { value: 1 }, installationPolicy: INSTALL
    }
    const first = await make().start(request)
    expect(first.manifest.state).toBe('succeeded')
    expect(first.manifest.requestId).toBe(request.requestId)
    expect(calls).toBe(1)

    const replayed = await make().start(request)
    expect(replayed.manifest.runId).toBe(first.manifest.runId)
    expect(replayed.manifest.requestDigest).toBe(first.manifest.requestDigest)
    expect(calls).toBe(1)
    await expect(make().start({ ...request, input: { value: 2 } })).rejects.toThrow('already used for a different admission')
    expect(calls).toBe(1)
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
    let now = Date.now()
    const cancellation = new CancellationRegistry()
    const run = new WorkflowRunService({ profileId: 'matrix', profileRoot, registry, policy: new ExecutionPolicyService(), cancellation, adapters: {}, clock: { now: () => new Date(now), wait: async (_ms, signal) => new Promise<void>((resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('shutdown')), { once: true })) } })
    const running = run.start({ profileId: 'matrix', threadId: 'matrix-thread', actor: { kind: 'workflow' }, source: 'cli', definitionId: published.definitionId, revisionId: published.head?.revisionId, input: {}, installationPolicy: INSTALL })
    let runId = ''
    for (let attempt = 0; attempt < 100 && !runId; attempt += 1) {
      const listed = await run.list({ profileId: 'matrix' })
      runId = listed[0]?.runId ?? ''
      if (!runId) await new Promise((resolve) => setTimeout(resolve, 2))
    }
    expect(runId).toBeTruthy()
    const checkpointPath = join(profileRoot, 'workflow-runs', runId, 'checkpoint.json')
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'))
      if (checkpoint.instances.check?.retryAt) break
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    const persisted = JSON.parse(readFileSync(checkpointPath, 'utf8'))
    expect(persisted.instances.check.retryAt).toBeTruthy()
    await run.shutdown()
    await running.catch(() => undefined)
    now += 2000
    const fresh = new WorkflowRunService({ profileId: 'matrix', profileRoot, registry, policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry(), adapters: {}, clock: { now: () => new Date(now), wait: async () => undefined } })
    const snap = await fresh.resume(runId, { profileId: 'matrix' })
    expect(snap.manifest.state).toBe('failed')
    expect(snap.attempts.find((attempt) => attempt.instanceKey === 'check')?.attempt).toBe(2)
    expect(snap.manifest.budgets.toolCalls).toBe(0)
  })

  it('persists and resumes nested pure retry backoff after a real shutdown', async () => {
    const profileRoot = root('mousse-matrix-nested-retry-')
    const registry = new WorkflowRegistry({ profileId: 'matrix', profileRoot })
    const bundle = manifest('foreach') as any
    bundle.nodes.find((node: any) => node.id === 'loop').config.subgraph = {
      entryNodeId: 'nested-check',
      nodes: [
        { id: 'nested-check', type: 'condition', version: 1, retry: { maxAttempts: 2, backoffMs: 1000 }, config: { expression: { literal: 'not-bool' } } },
        { id: 'nested-end', type: 'end', version: 1, config: {} }
      ],
      edges: [{ from: 'nested-check', port: 'true', to: 'nested-end' }, { from: 'nested-check', port: 'false', to: 'nested-end' }]
    }
    const saved = registry.saveDraft({ bundle: { manifest: bundle, assets: [] } })
    const published = registry.publish({ definitionId: saved.definitionId, expectedDraftSemanticHash: saved.semanticHash, expectedHeadRevisionId: null })
    let now = Date.now()
    const cancellation = new CancellationRegistry()
    const waitingClock = {
      now: () => new Date(now),
      wait: async (_ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
        if (signal?.aborted) { reject(new Error('shutdown')); return }
        signal?.addEventListener('abort', () => reject(new Error('shutdown')), { once: true })
      })
    }
    const first = new WorkflowRunService({ profileId: 'matrix', profileRoot, registry, policy: new ExecutionPolicyService(), cancellation, clock: waitingClock })
    const running = first.start({ profileId: 'matrix', threadId: 'nested-retry', actor: { kind: 'workflow' }, source: 'cli', definitionId: published.definitionId, revisionId: published.head?.revisionId, input: {}, installationPolicy: INSTALL })
    let runId = ''
    for (let attempt = 0; attempt < 100 && !runId; attempt += 1) {
      runId = (await first.list({ profileId: 'matrix' }))[0]?.runId ?? ''
      if (!runId) await new Promise((resolve) => setTimeout(resolve, 2))
    }
    const checkpointPath = join(profileRoot, 'workflow-runs', runId, 'checkpoint.json')
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'))
      if (checkpoint.nested?.['loop#0']?.instances?.['loop#0/nested-check']?.retryAt) break
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    const persisted = JSON.parse(readFileSync(checkpointPath, 'utf8'))
    expect(persisted.nested['loop#0'].instances['loop#0/nested-check'].retryAt).toBeTruthy()
    await first.shutdown()
    await running.catch(() => undefined)
    now += 5000
    const fresh = new WorkflowRunService({ profileId: 'matrix', profileRoot, registry, policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry(), clock: { now: () => new Date(now), wait: async () => undefined } })
    const resumed = await fresh.resume(runId, { profileId: 'matrix', reconcile: 'retry' })
    expect(resumed.manifest.state).toBe('failed')
    expect(resumed.attempts.find((attempt) => attempt.instanceKey === 'loop#0/nested-check')?.attempt).toBe(2)
  })

  it('keeps concurrent nested input waits independent and settles both branches', async () => {
    const value = await setup('parallel')
    const draft = value.registry.get(value.definitionId)!
    const draftManifest = draft.bundle.manifest as any
    draftManifest.permissions = { capabilities: ['human.input'] }
    const parallel = (draft.bundle.manifest as any).nodes.find((node: any) => node.id === 'parallel')
    const askBranch = (id: string) => ({
      entryNodeId: `${id}-ask`,
      nodes: [
        { id: `${id}-ask`, type: 'ask-user', version: 1, config: { prompt: `${id} value`, answerSchema: { type: 'string' } } },
        { id: `${id}-end`, type: 'end', version: 1, config: {} }
      ],
      edges: [{ from: `${id}-ask`, port: 'success', to: `${id}-end` }]
    })
    parallel.config.branches = [{ id: 'left', subgraph: askBranch('left') }, { id: 'right', subgraph: askBranch('right') }]
    const saved = value.registry.saveDraft({ bundle: draft.bundle, expectedDraftSemanticHash: draft.semanticHash })
    const published = value.registry.publish({ definitionId: saved.definitionId, expectedDraftSemanticHash: saved.semanticHash, expectedHeadRevisionId: saved.head?.revisionId ?? null })
    const run = new WorkflowRunService({ profileId: 'matrix', profileRoot: value.profileRoot, registry: value.registry, policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry() })
    let waiting = await run.start({ profileId: 'matrix', threadId: 'multi-wait', actor: { kind: 'workflow' }, source: 'cli', definitionId: published.definitionId, revisionId: published.head?.revisionId, input: {}, installationPolicy: INSTALL })
    expect(waiting.manifest.state).toBe('waiting-input')
    expect(waiting.pendingWaits).toHaveLength(2)
    const first = waiting.pendingWaits![0]!.pendingInput!
    const second = waiting.pendingWaits![1]!.pendingInput!
    waiting = await run.answer(waiting.manifest.runId, { profileId: 'matrix' }, { instanceKey: first.instanceKey, data: 'left answer' })
    expect(waiting.manifest.state).toBe('waiting-input')
    expect(waiting.pendingWaits).toHaveLength(1)
    expect(waiting.pendingWaits![0]!.pendingInput?.instanceKey).toBe(second.instanceKey)
    const done = await run.answer(waiting.manifest.runId, { profileId: 'matrix' }, { instanceKey: second.instanceKey, data: 'right answer' })
    expect(done.manifest.state).toBe('succeeded')
  })

  it('keeps concurrent nested approval waits independently consumable', async () => {
    const value = await setup('parallel')
    const draft = value.registry.get(value.definitionId)!
    const draftManifest = draft.bundle.manifest as any
    draftManifest.permissions = { capabilities: ['human.approval'] }
    const parallel = draftManifest.nodes.find((node: any) => node.id === 'parallel')
    const approvalBranch = (id: string) => ({
      entryNodeId: `${id}-approval`,
      nodes: [
        { id: `${id}-approval`, type: 'approval', version: 1, config: { action: id, proposal: id } },
        { id: `${id}-end`, type: 'end', version: 1, config: {} }
      ],
      edges: [{ from: `${id}-approval`, port: 'approved', to: `${id}-end` }, { from: `${id}-approval`, port: 'denied', to: `${id}-end` }]
    })
    parallel.config.branches = [{ id: 'left', subgraph: approvalBranch('left') }, { id: 'right', subgraph: approvalBranch('right') }]
    const saved = value.registry.saveDraft({ bundle: draft.bundle, expectedDraftSemanticHash: draft.semanticHash })
    const published = value.registry.publish({ definitionId: saved.definitionId, expectedDraftSemanticHash: saved.semanticHash, expectedHeadRevisionId: saved.head?.revisionId ?? null })
    const run = new WorkflowRunService({ profileId: 'matrix', profileRoot: value.profileRoot, registry: value.registry, policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry() })
    let waiting = await run.start({ profileId: 'matrix', threadId: 'multi-approval', actor: { kind: 'workflow' }, source: 'cli', definitionId: published.definitionId, revisionId: published.head?.revisionId, input: {}, installationPolicy: INSTALL })
    expect(waiting.pendingWaits).toHaveLength(2)
    const first = waiting.pendingWaits![0]!.approvalId!
    const second = waiting.pendingWaits![1]!.approvalId!
    waiting = await run.approve(waiting.manifest.runId, { profileId: 'matrix' }, { approvalId: first, approved: true, actorId: 'left-reviewer' })
    expect(waiting.manifest.state).toBe('waiting-approval')
    expect(waiting.pendingWaits).toHaveLength(1)
    expect(waiting.pendingWaits![0]!.approvalId).toBe(second)
    const done = await run.approve(waiting.manifest.runId, { profileId: 'matrix' }, { approvalId: second, approved: true, actorId: 'right-reviewer' })
    expect(done.manifest.state).toBe('succeeded')
  })

  it('keeps unequal nested timer waits durable and settles them in deadline order', async () => {
    const value = await setup('parallel')
    const draft = value.registry.get(value.definitionId)!
    const parallel = (draft.bundle.manifest as any).nodes.find((node: any) => node.id === 'parallel')
    const timerBranch = (id: string, durationMs: number) => ({
      entryNodeId: `${id}-delay`,
      nodes: [
        { id: `${id}-delay`, type: 'delay', version: 1, config: { durationMs } },
        { id: `${id}-end`, type: 'end', version: 1, config: {} }
      ],
      edges: [{ from: `${id}-delay`, port: 'success', to: `${id}-end` }]
    })
    parallel.config.branches = [{ id: 'short', subgraph: timerBranch('short', 10) }, { id: 'long', subgraph: timerBranch('long', 100) }]
    const saved = value.registry.saveDraft({ bundle: draft.bundle, expectedDraftSemanticHash: draft.semanticHash })
    const published = value.registry.publish({ definitionId: saved.definitionId, expectedDraftSemanticHash: saved.semanticHash, expectedHeadRevisionId: saved.head?.revisionId ?? null })
    let now = Date.now()
    const make = () => new WorkflowRunService({ profileId: 'matrix', profileRoot: value.profileRoot, registry: value.registry, policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry(), clock: { now: () => new Date(now), wait: async () => undefined } })
    let waiting = await make().start({ profileId: 'matrix', threadId: 'multi-timer', actor: { kind: 'workflow' }, source: 'cli', definitionId: published.definitionId, revisionId: published.head?.revisionId, input: {}, installationPolicy: INSTALL })
    expect(waiting.pendingWaits).toHaveLength(2)
    const wakeTimes = waiting.pendingWaits!.map((wait) => Date.parse(wait.wakeAt!)).sort((a, b) => a - b)
    expect(wakeTimes[1]! - wakeTimes[0]!).toBeGreaterThanOrEqual(80)
    now = wakeTimes[0]! + 1
    waiting = await make().tick(waiting.manifest.runId, { profileId: 'matrix' })
    expect(waiting.manifest.state).toBe('waiting-condition')
    expect(waiting.pendingWaits).toHaveLength(1)
    now = wakeTimes[1]! + 1
    const done = await make().tick(waiting.manifest.runId, { profileId: 'matrix' })
    expect(done.manifest.state).toBe('succeeded')
  })

  it('passes immutable pinned workflow instructions with revision provenance to agents', async () => {
    const value = await setup('plain')
    const draft = value.registry.get(value.definitionId)!
    ;(draft.bundle.manifest as any).instructionsFile = 'instructions.md'
    draft.bundle.assets = [{ relativePath: 'instructions.md', bytes: 'Revision one safety guidance' }]
    const saved = value.registry.saveDraft({ bundle: draft.bundle, expectedDraftSemanticHash: draft.semanticHash })
    const published = value.registry.publish({ definitionId: saved.definitionId, expectedDraftSemanticHash: saved.semanticHash, expectedHeadRevisionId: saved.head?.revisionId ?? null })
    const instructions: string[] = []
    const run = new WorkflowRunService({
      profileId: 'matrix', profileRoot: value.profileRoot, registry: value.registry, policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry(),
      adapters: { agent: { kind: 'agent', async invoke(request) { instructions.push(request.instructions); return { output: { ok: true } } } } }
    })
    const result = await run.start({ profileId: 'matrix', threadId: 'instructions', actor: { kind: 'workflow' }, source: 'cli', definitionId: published.definitionId, revisionId: published.head?.revisionId, input: {}, installationPolicy: INSTALL })
    expect(result.manifest.state).toBe('succeeded')
    expect(instructions).toHaveLength(1)
    expect(instructions[0]).toContain('Revision one safety guidance')
    expect(instructions[0]).toContain('[Pinned workflow instructions from revision')
    expect(instructions[0]).toContain('[Node instructions]')
    expect(readFileSync(join(value.profileRoot, 'workflow-runs', result.manifest.runId, 'bundle', 'instructions.md'), 'utf8')).toBe('Revision one safety guidance')
  })

  it('enforces compiled step, token, and cost limits at dispatch boundaries', async () => {
    const value = await setup('plain')
    const draft = value.registry.get(value.definitionId)!
    ;(draft.bundle.manifest as any).limits = { maxSteps: 2, maxTokens: 1, maxCost: 1 }
    const saved = value.registry.saveDraft({ bundle: draft.bundle, expectedDraftSemanticHash: draft.semanticHash })
    const published = value.registry.publish({ definitionId: saved.definitionId, expectedDraftSemanticHash: saved.semanticHash, expectedHeadRevisionId: saved.head?.revisionId ?? null })
    const run = new WorkflowRunService({
      profileId: 'matrix', profileRoot: value.profileRoot, registry: value.registry, policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry(),
      adapters: { agent: { kind: 'agent', async invoke() { return { output: { ok: true }, tokens: 2, cost: 2 } } } }
    })
    const result = await run.start({ profileId: 'matrix', threadId: 'limits', actor: { kind: 'workflow' }, source: 'cli', definitionId: published.definitionId, revisionId: published.head?.revisionId, input: {}, installationPolicy: INSTALL })
    expect(result.manifest.state).toBe('failed')
    expect(result.manifest.terminalError).toMatch(/step limit|token limit|cost limit/i)
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

  it('recovers a parent after child result persistence with one durable child and propagated budget', async () => {
    const profileRoot = root('mousse-matrix-child-restart-')
    const registry = new WorkflowRegistry({ profileId: 'matrix', profileRoot })
    const child = manifest('plain') as any
    child.id = '44444444-4444-4444-8444-444444444444'; child.slug = 'matrix_child_restart'
    const childSaved = registry.saveDraft({ bundle: { manifest: child, assets: [] } })
    const childPublished = registry.publish({ definitionId: childSaved.definitionId, expectedDraftSemanticHash: childSaved.semanticHash, expectedHeadRevisionId: null })
    const parent = manifest('plain') as any
    parent.id = '55555555-5555-4555-8555-555555555555'; parent.slug = 'matrix_parent_restart'
    parent.nodes[1] = { id: 'sub', type: 'subworkflow', version: 1, config: { workflow: { id: childPublished.definitionId, revision: childPublished.head?.revisionId } } }
    parent.nodes.find((node: any) => node.id === 'end').inputs = { result: { ref: 'node', nodeId: 'sub', pointer: '' } }
    parent.edges = [{ from: 'start', port: 'next', to: 'sub' }, { from: 'sub', port: 'success', to: 'end' }]
    const parentSaved = registry.saveDraft({ bundle: { manifest: parent, assets: [] } })
    const parentPublished = registry.publish({ definitionId: parentSaved.definitionId, expectedDraftSemanticHash: parentSaved.semanticHash, expectedHeadRevisionId: null })
    let calls = 0
    const faults: WorkflowFaultHooks = {
      afterCheckpoint: (runId: string) => {
        const current = JSON.parse(readFileSync(join(profileRoot, 'workflow-runs', runId, 'manifest.json'), 'utf8')) as { definitionId: string }
        const checkpoint = JSON.parse(readFileSync(join(profileRoot, 'workflow-runs', runId, 'checkpoint.json'), 'utf8')) as { childRuns?: Record<string, string> }
        if (current.definitionId === parentPublished.definitionId && Object.keys(checkpoint.childRuns ?? {}).length > 0) throw new Error('controlled parent crash after child result')
      }
    }
    const adapter = { agent: { kind: 'agent' as const, async invoke() { calls += 1; return { output: { child: true } } } } }
    const first = new WorkflowRunService({ profileId: 'matrix', profileRoot, registry, policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry(), faults, adapters: adapter })
    const request = {
      profileId: 'matrix', threadId: 't', actor: { kind: 'workflow' }, source: 'cli', definitionId: parentPublished.definitionId,
      revisionId: parentPublished.head?.revisionId, input: {}, installationPolicy: INSTALL,
      runPolicy: { maxToolCalls: 2, maxElapsedMs: 60_000, maxArtifactBytes: 1_000_000 }
    } as const
    let admitted: Awaited<ReturnType<WorkflowRunService['start']>> | undefined
    try { admitted = await first.start(request) } catch (error) { expect(String(error)).toContain('controlled parent crash') }
    if (admitted?.pendingApprovalId) {
      await expect(first.approve(admitted.manifest.runId, { profileId: 'matrix' }, { approvalId: admitted.pendingApprovalId, approved: true, actorId: 'matrix' })).rejects.toThrow('controlled parent crash')
    }
    const listed = await first.list({ profileId: 'matrix' })
    const parentRun = listed.find((item) => item.definitionId === parentPublished.definitionId)!
    const childRuns = listed.filter((item) => item.parentRunId === parentRun.runId)
    expect(childRuns).toHaveLength(1)
    expect(childRuns[0]!.parentInstanceKey).toBe('sub')
    expect(childRuns[0]!.state).toBe('succeeded')
    const childId = childRuns[0]!.runId
    expect(calls).toBe(1)
    const fresh = new WorkflowRunService({ profileId: 'matrix', profileRoot, registry, policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry(), adapters: adapter })
    const resumed = await fresh.resume(parentRun.runId, { profileId: 'matrix', reconcile: 'retry' })
    expect(resumed.manifest.state).toBe('succeeded')
    expect(calls).toBe(1)
    const after = await fresh.list({ profileId: 'matrix' })
    const afterChildren = after.filter((item) => item.parentRunId === parentRun.runId)
    expect(afterChildren).toHaveLength(1)
    expect(afterChildren[0]!.runId).toBe(childId)
    expect(afterChildren[0]!.budgets.maxToolCalls).toBe(1)
    expect(afterChildren[0]!.budgets.toolCalls).toBe(1)
    expect(resumed.manifest.budgets.maxToolCalls).toBe(2)
    expect(resumed.manifest.budgets.toolCalls).toBe(2)
  })

  it('kills and restarts the actual workflow child process without replaying a nested external effect', async () => {
    const value = await setup('foreach')
    const marker = join(value.profileRoot, 'dispatch-marker.ndjson')
    const fixture = join(process.cwd(), 'tests', 'fixtures', 'workflow-runtime-crash-child.ts')
    const entry = join(value.profileRoot, 'workflow-runtime-crash-child.cjs')
    await build({ entryPoints: [fixture], bundle: true, platform: 'node', format: 'cjs', outfile: entry, sourcemap: false })
    const children: ChildProcess[] = []
    const waitForExit = (child: ChildProcess, timeoutMs = 5000) => new Promise<number | null>((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(child.exitCode); return }
      const timer = setTimeout(() => reject(new Error(`workflow fixture did not exit within ${timeoutMs}ms`)), timeoutMs)
      child.once('exit', (code) => { clearTimeout(timer); resolve(code) })
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
    })
    const launch = (mode: 'run' | 'resume', runId?: string) => new Promise<{ child: ChildProcess; message: any; exitCode: number | null }>((resolve, reject) => {
      const child = spawn(process.execPath, [entry], {
        env: { ...process.env, MATRIX_PROFILE_ROOT: value.profileRoot, MATRIX_MODE: mode, MATRIX_RUN_ID: runId ?? '', MATRIX_MARKER: marker, MATRIX_DEFINITION_ID: value.definitionId, MATRIX_REVISION_ID: value.revisionId },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true
      })
      children.push(child)
      let last: any
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error(`workflow fixture did not send ${mode === 'run' ? 'READY' : 'DONE'} within 5000ms`)) }
      }, 5000)
      child.on('message', (message) => {
        last = message
        if (message.type === 'ERROR' && !settled) {
          settled = true; clearTimeout(timer); reject(new Error(String(message.message)))
        } else if (mode === 'run' && message.type === 'READY' && !settled) {
          settled = true; clearTimeout(timer); resolve({ child, message, exitCode: null })
        }
      })
      child.on('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error) } })
      child.on('exit', (code) => {
        if (mode === 'resume' && !settled && last?.type === 'DONE') {
          settled = true; clearTimeout(timer); resolve({ child, message: last, exitCode: code })
        } else if (mode === 'resume' && !settled) {
          settled = true; clearTimeout(timer); reject(new Error(`workflow fixture exited before DONE (${code ?? 'signal'})`))
        }
      })
    })
    try {
      const first = await launch('run')
      const firstRun = service(value)
      const runs = await firstRun.list({ profileId: 'matrix' })
      expect(runs).toHaveLength(1)
      const runId = runs[0]!.runId
      expect(first.message.type).toBe('READY')
      first.child.kill('SIGKILL')
      await waitForExit(first.child)
      const second = await launch('resume', runId)
      expect(second.message.type).toBe('DONE')
      expect(second.message.state).toBe('unknown-effect')
      expect(second.exitCode).toBe(0)
      const markers = readFileSync(marker, 'utf8').trim().split(/\r?\n/).filter(Boolean)
      expect(markers).toHaveLength(1)
      const trace = await firstRun.trace(runId, { profileId: 'matrix' })
      expect(trace.events.filter((event) => event.kind === 'attempt-prepared' && String(event.instanceKey).includes('agent'))).toHaveLength(1)
      expect(trace.events.some((event) => event.kind === 'attempt-unknown')).toBe(false)
    } finally {
      await Promise.all(children.filter((child) => child.exitCode === null && child.signalCode === null).map(async (child) => {
        child.kill('SIGKILL')
        await waitForExit(child).catch(() => undefined)
      }))
    }
  })

  it.each(['afterNestedResult', 'afterNestedCheckpoint'] as const)('kills and resumes a real child at the nested %s boundary without redispatch', async (fault) => {
    const value = await setup('foreach')
    const marker = join(value.profileRoot, `nested-${fault}.ndjson`)
    const fixture = join(process.cwd(), 'tests', 'fixtures', 'workflow-runtime-crash-child.ts')
    const entry = join(value.profileRoot, `workflow-runtime-${fault}.cjs`)
    await build({ entryPoints: [fixture], bundle: true, platform: 'node', format: 'cjs', outfile: entry, sourcemap: false })
    const children: ChildProcess[] = []
    const waitForExit = (child: ChildProcess, timeoutMs = 5000) => new Promise<number | null>((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(child.exitCode); return }
      const timer = setTimeout(() => reject(new Error(`workflow fixture did not exit within ${timeoutMs}ms`)), timeoutMs)
      child.once('exit', (code) => { clearTimeout(timer); resolve(code) })
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
    })
    const launch = (mode: 'run' | 'resume', runId?: string, selectedFault?: string) => new Promise<{ child: ChildProcess; message?: any; exitCode?: number | null }>((resolve, reject) => {
      const child = spawn(process.execPath, [entry], {
        env: { ...process.env, MATRIX_PROFILE_ROOT: value.profileRoot, MATRIX_MODE: mode, MATRIX_RUN_ID: runId ?? '', MATRIX_MARKER: marker, MATRIX_DEFINITION_ID: value.definitionId, MATRIX_REVISION_ID: value.revisionId, MATRIX_FAULT: selectedFault ?? '' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true
      })
      children.push(child)
      let settled = false
      let last: any
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error(`workflow fixture did not send ${mode} readiness`)) } }, 5000)
      child.on('message', (message) => {
        last = message
        if (message.type === 'ERROR' && !settled) { settled = true; clearTimeout(timer); reject(new Error(String(message.message))) }
        else if (mode === 'run' && message.type === 'READY' && !settled) { settled = true; clearTimeout(timer); resolve({ child, message }) }
        else if (mode === 'resume' && message.type === 'DONE' && !settled) { settled = true; clearTimeout(timer); resolve({ child, message, exitCode: child.exitCode }) }
      })
      child.on('exit', (code) => {
        if (mode === 'resume' && !settled && last?.type === 'DONE') { settled = true; clearTimeout(timer); resolve({ child, message: last, exitCode: code }) }
        else if (mode === 'resume' && !settled) { settled = true; clearTimeout(timer); reject(new Error(`workflow fixture exited before DONE (${code ?? 'signal'})`)) }
      })
    })
    try {
      const first = await launch('run', undefined, fault)
      const inspector = service(value)
      const runId = (await inspector.list({ profileId: 'matrix' }))[0]!.runId
      // The fixture's nested fault hook kills itself only after the requested
      // durable boundary, so READY is not treated as the crash boundary.
      await waitForExit(first.child)
      const resumed = await launch('resume', runId)
      expect(resumed.message?.type).toBe('DONE')
      expect(resumed.message?.state).toBe('succeeded')
      const markers = readFileSync(marker, 'utf8').trim().split(/\r?\n/).filter(Boolean)
      expect(markers).toHaveLength(1)
      const trace = await inspector.trace(runId, { profileId: 'matrix' })
      expect(trace.events.filter((event) => event.kind === 'attempt-prepared' && String(event.instanceKey).includes('agent')).length).toBe(1)
    } finally {
      await Promise.all(children.filter((child) => child.exitCode === null && child.signalCode === null).map(async (child) => {
        child.kill('SIGKILL')
        await waitForExit(child).catch(() => undefined)
      }))
    }
  })

  it('cancels a recovered parent and its active child, settling both durable leases', async () => {
    const profileRoot = root('mousse-matrix-parent-cancel-')
    const registry = new WorkflowRegistry({ profileId: 'matrix', profileRoot })
    const child = manifest('plain') as any
    child.id = '66666666-6666-4666-8666-666666666666'; child.slug = 'matrix_cancel_child'
    const childSaved = registry.saveDraft({ bundle: { manifest: child, assets: [] } })
    const childPublished = registry.publish({ definitionId: childSaved.definitionId, expectedDraftSemanticHash: childSaved.semanticHash, expectedHeadRevisionId: null })
    const parent = manifest('plain') as any
    parent.id = '77777777-7777-4777-8777-777777777777'; parent.slug = 'matrix_cancel_parent'
    parent.nodes[1] = { id: 'sub', type: 'subworkflow', version: 1, effect: 'pure', config: { workflow: { id: childPublished.definitionId, revision: childPublished.head?.revisionId } } }
    parent.nodes.find((node: any) => node.id === 'end').inputs = { result: { ref: 'node', nodeId: 'sub', pointer: '' } }
    parent.edges = [{ from: 'start', port: 'next', to: 'sub' }, { from: 'sub', port: 'success', to: 'end' }]
    const parentSaved = registry.saveDraft({ bundle: { manifest: parent, assets: [] } })
    const parentPublished = registry.publish({ definitionId: parentSaved.definitionId, expectedDraftSemanticHash: parentSaved.semanticHash, expectedHeadRevisionId: null })
    const fixture = join(process.cwd(), 'tests', 'fixtures', 'workflow-runtime-crash-child.ts')
    const entry = join(profileRoot, 'workflow-runtime-parent-cancel.cjs')
    await build({ entryPoints: [fixture], bundle: true, platform: 'node', format: 'cjs', outfile: entry, sourcemap: false })
    const childProcess = spawn(process.execPath, [entry], {
      env: { ...process.env, MATRIX_PROFILE_ROOT: profileRoot, MATRIX_MODE: 'run', MATRIX_RUN_ID: '', MATRIX_MARKER: join(profileRoot, 'cancel.ndjson'), MATRIX_DEFINITION_ID: parentPublished.definitionId, MATRIX_REVISION_ID: parentPublished.head?.revisionId ?? '' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('parent/child fixture did not reach child dispatch')), 5000)
        childProcess.on('message', (message) => {
          if (message.type === 'READY') { clearTimeout(timer); resolve() }
          if (message.type === 'ERROR') { clearTimeout(timer); reject(new Error(String(message.message))) }
        })
        childProcess.on('error', (error) => { clearTimeout(timer); reject(error) })
      })
      const inspector = service({ profileRoot, registry, definitionId: parentPublished.definitionId, revisionId: parentPublished.head?.revisionId })
      const before = await inspector.list({ profileId: 'matrix' })
      const parentRun = before.find((item) => item.definitionId === parentPublished.definitionId)!
      const childRun = before.find((item) => item.parentRunId === parentRun.runId)!
      expect(parentRun).toBeDefined()
      expect(childRun).toBeDefined()
      childProcess.kill('SIGKILL')
      await new Promise<void>((resolve) => childProcess.once('exit', () => resolve()))
      const fresh = service({ profileRoot, registry, definitionId: parentPublished.definitionId, revisionId: parentPublished.head?.revisionId })
      const cancelled = await fresh.cancel(parentRun.runId, { profileId: 'matrix' }, 'fixture cancellation')
      expect(cancelled.manifest.state).toBe('cancelled')
      const after = await fresh.list({ profileId: 'matrix' })
      expect(after.find((item) => item.runId === childRun.runId)?.state).toBe('cancelled')
      expect(existsSync(join(profileRoot, 'workflow-runs', parentRun.runId, 'lease.json'))).toBe(false)
      expect(existsSync(join(profileRoot, 'workflow-runs', childRun.runId, 'lease.json'))).toBe(false)
    } finally {
      if (childProcess.exitCode === null && childProcess.signalCode === null) childProcess.kill('SIGKILL')
    }
  }, 15000)

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
