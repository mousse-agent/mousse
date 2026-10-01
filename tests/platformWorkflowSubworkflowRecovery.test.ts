import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { build } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExecutionPolicyLayer } from '../src/shared/execution/types'
import { CancellationRegistry } from '../src/mms/execution/CancellationRegistry'
import { ExecutionPolicyService } from '../src/mms/execution/ExecutionPolicyService'
import { ApprovalService } from '../src/mms/execution/ApprovalService'
import { WorkflowRegistry } from '../src/mms/workflows/registry/WorkflowRegistry'
import { inheritChildAdmission } from '../src/mms/workflows/engine/childAdmission'
import { WorkflowRunService } from '../src/mms/workflows/engine/WorkflowRunService'
import { workflowRunView } from '../src/mms/workflows/runView'

const roots: string[] = []
const INSTALL: ExecutionPolicyLayer = {
  allowedTools: ['workflow.node', 'workflow.agent', 'workflow.approval'],
  allowedCapabilities: ['model.invoke', 'human.input', 'human.approval'],
  allowedEffects: ['pure', 'read', 'write', 'external', 'unknown']
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function bundle(id: string, slug: string, nodes: any[], edges: any[], capabilities: string[] = []): any {
  return {
    schemaVersion: 1,
    id,
    name: slug,
    slug,
    entryNodeId: nodes[0]!.id,
    inputSchema: { type: 'object', additionalProperties: true },
    outputSchema: {},
    permissions: { capabilities },
    nodes,
    edges
  }
}

function childBundle(kind: 'input' | 'approval' | 'timer' | 'unknown'): any {
  const id = `22222222-2222-4222-8222-22222222222${kind === 'input' ? '1' : kind === 'approval' ? '2' : kind === 'timer' ? '3' : '4'}`
  const action = kind === 'input'
    ? { id: 'child-ask', type: 'ask-user', version: 1, config: { prompt: 'Child value', answerSchema: { type: 'string' } } }
    : kind === 'approval'
      ? { id: 'child-approval', type: 'approval', version: 1, config: { action: 'child-write', proposal: 'Approve child' } }
      : kind === 'timer'
        ? { id: 'child-delay', type: 'delay', version: 1, config: { durationMs: 30 } }
        : { id: 'child-agent', type: 'agent', version: 1, effect: 'external', config: { agent: { kind: 'main' }, instructions: 'child external' } }
  const endFrom = action.id
  const endPort = kind === 'approval' ? 'approved' : 'success'
  return bundle(id, `child_${kind}`, [
    { id: 'child-start', type: 'start', version: 1, config: {} },
    action,
    { id: 'child-end', type: 'end', version: 1, inputs: { result: { ref: 'node', nodeId: endFrom, pointer: '' } }, config: {} }
  ], [
    { from: 'child-start', port: 'next', to: action.id },
    { from: action.id, port: endPort, to: 'child-end' },
    ...(kind === 'approval' ? [{ from: action.id, port: 'denied', to: 'child-end' }] : [])
  ], kind === 'input' ? ['human.input'] : kind === 'approval' ? ['human.approval'] : kind === 'unknown' ? ['model.invoke'] : [])
}

async function setup(kind: 'input' | 'approval' | 'timer' | 'unknown', childManifest = childBundle(kind), dependencyPinned = false) {
  const profileRoot = mkdtempSync(join(tmpdir(), `mousse-subworkflow-${kind}-`))
  roots.push(profileRoot)
  const registry = new WorkflowRegistry({ profileId: 'subworkflow-profile', profileRoot })
  const child = registry.saveDraft({ bundle: { manifest: childManifest, assets: [] } })
  const childPublished = registry.publish({ definitionId: child.definitionId, expectedDraftSemanticHash: child.semanticHash, expectedHeadRevisionId: null })
  const parentId = `33333333-3333-4333-8333-33333333333${kind === 'input' ? '1' : kind === 'approval' ? '2' : kind === 'timer' ? '3' : '4'}`
  const parentManifest = bundle(parentId, `parent_${kind}`, [
    { id: 'parent-start', type: 'start', version: 1, config: {} },
    { id: 'parent-child', type: 'subworkflow', version: 1, config: { workflow: { id: childPublished.definitionId, ...(dependencyPinned ? {} : { revision: childPublished.head?.revisionId }) } } },
    { id: 'parent-end', type: 'end', version: 1, inputs: { result: { ref: 'node', nodeId: 'parent-child', pointer: '' } }, config: {} }
  ], [
    { from: 'parent-start', port: 'next', to: 'parent-child' },
    { from: 'parent-child', port: 'success', to: 'parent-end' }
  ])
  if (dependencyPinned) parentManifest.dependencyPolicy = { mode: 'pinned', dependencies: [{ kind: 'subworkflow', id: childPublished.definitionId, revision: childPublished.head?.revisionId }] }
  const parent = registry.saveDraft({ bundle: { manifest: parentManifest, assets: [] } })
  const published = registry.publish({ definitionId: parent.definitionId, expectedDraftSemanticHash: parent.semanticHash, expectedHeadRevisionId: null })
  return { profileRoot, registry, parent: published, child: childPublished }
}

function service(value: Awaited<ReturnType<typeof setup>>, onAgent: () => void, failAgent = false) {
  return new WorkflowRunService({
    profileId: 'subworkflow-profile', profileRoot: value.profileRoot, registry: value.registry,
    policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry(),
    adapters: {
      agent: {
        kind: 'agent',
        async invoke() {
          onAgent()
          if (failAgent) throw new Error('external adapter crashed after dispatch')
          return { output: { child: 'completed' } }
        }
      }
    }
  })
}

async function startParent(run: WorkflowRunService, value: Awaited<ReturnType<typeof setup>>) {
  let snapshot = await run.start({
    profileId: 'subworkflow-profile', threadId: 'subworkflow-thread', actor: { kind: 'workflow' }, source: 'cli',
    definitionId: value.parent.definitionId, revisionId: value.parent.head?.revisionId, input: {}, installationPolicy: INSTALL
  })
  if (snapshot.pendingApprovalId) {
    snapshot = await run.approve(snapshot.manifest.runId, { profileId: 'subworkflow-profile' }, {
      approvalId: snapshot.pendingApprovalId, approved: true, actorId: 'parent-reviewer'
    })
  }
  return snapshot
}

describe('durable child workflow recovery', () => {
  it('resolves an omitted node revision only from the parent pinned dependency snapshot', async () => {
    const value = await setup('timer', childBundle('timer'), true)
    const pinnedRevision = value.child.head?.revisionId
    const childDraft = value.registry.get(value.child.definitionId)!
    ;(childDraft.bundle.manifest as any).description = 'newer child head'
    const changed = value.registry.saveDraft({ bundle: childDraft.bundle, expectedDraftSemanticHash: childDraft.semanticHash })
    const newer = value.registry.publish({ definitionId: changed.definitionId, expectedDraftSemanticHash: changed.semanticHash, expectedHeadRevisionId: changed.head?.revisionId ?? null })
    expect(newer.head?.revisionId).not.toBe(pinnedRevision)

    const run = service(value, () => undefined)
    const parent = await startParent(run, value)
    const childId = parent.pendingWaits?.[0]?.childRunId
    expect((await run.get(childId!, { profileId: 'subworkflow-profile' })).manifest.revisionId).toBe(pinnedRevision)
  })

  it('projects a wait matching the child aggregate state when child branches wait on different controls', async () => {
    const actionBranch = (node: any) => ({
      entryNodeId: node.id,
      nodes: [node, { id: `${node.id}-end`, type: 'end', version: 1, config: {} }],
      edges: (node.type === 'approval' ? ['approved', 'denied'] : ['success'])
        .map((port) => ({ from: node.id, port, to: `${node.id}-end` }))
    })
    const mixed = bundle('22222222-2222-4222-8222-222222222225', 'child_mixed', [
      { id: 'child-start', type: 'start', version: 1, config: {} },
      { id: 'child-parallel', type: 'parallel', version: 1, config: { policy: 'all-success', branches: [
        { id: 'z-input', subgraph: actionBranch({ id: 'z-input-node', type: 'ask-user', version: 1, config: { prompt: 'Value', answerSchema: { type: 'string' } } }) },
        { id: 'a-approval', subgraph: actionBranch({ id: 'a-approval-node', type: 'approval', version: 1, config: { action: 'write', proposal: 'Approve' } }) }
      ] } },
      { id: 'child-end', type: 'end', version: 1, config: {} }
    ], [
      { from: 'child-start', port: 'next', to: 'child-parallel' },
      { from: 'child-parallel', port: 'success', to: 'child-end' }
    ], ['human.input', 'human.approval'])
    const value = await setup('approval', mixed)
    const run = service(value, () => undefined)
    const parent = await startParent(run, value)
    expect(parent.manifest.state).toBe('waiting-input')
    expect(parent.pendingWaits?.[0]).toMatchObject({ state: 'waiting-input' })
    expect(parent.pendingWaits?.[0]?.pendingInput).toBeTruthy()
    expect(parent.pendingWaits?.[0]?.approvalId).toBeUndefined()
  })

  it.each(['input', 'approval', 'timer'] as const)('keeps the exact child linked across service restart and resolves %s through the child public controls', async (kind) => {
    const value = await setup(kind)
    let dispatches = 0
    const first = service(value, () => { dispatches += 1 })
    const waiting = await startParent(first, value)
    expect(waiting.manifest.state, waiting.manifest.terminalError).toBe(kind === 'timer' ? 'waiting-condition' : kind === 'input' ? 'waiting-input' : 'waiting-approval')
    const childId = waiting.attempts.find((attempt) => attempt.instanceKey === 'parent-child')?.childRunId
    expect(childId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(waiting.pendingWaits?.[0]?.childRunId).toBe(childId)
    if (kind === 'approval') {
      const approvalId = waiting.pendingWaits?.[0]?.approvalId
      const approval = approvalId ? new ApprovalService({ profileId: 'subworkflow-profile', profileRoot: value.profileRoot }).get(approvalId, 'subworkflow-profile') : undefined
      const view = workflowRunView(waiting, [], approval)
      expect(view.pendingApprovals?.[0]?.childRunId).toBe(childId)
    }
    await first.shutdown()

    const restarted = service(value, () => { dispatches += 1 })
    const childWaiting = await restarted.get(childId!, { profileId: 'subworkflow-profile' })
    expect(childWaiting.manifest.parentRunId).toBe(waiting.manifest.runId)
    if (kind === 'input') {
      const pending = childWaiting.pendingWaits?.find((wait) => wait.pendingInput)?.pendingInput
      expect(pending).toBeTruthy()
      await restarted.answer(childId!, { profileId: 'subworkflow-profile' }, { instanceKey: pending!.instanceKey, data: 'accepted' })
    } else if (kind === 'approval') {
      const approvalId = childWaiting.pendingWaits?.find((wait) => wait.approvalId)?.approvalId
      expect(approvalId).toBeTruthy()
      await restarted.approve(childId!, { profileId: 'subworkflow-profile' }, { approvalId: approvalId!, approved: true, actorId: 'child-reviewer' })
    } else {
      await new Promise((resolve) => setTimeout(resolve, 45))
      await restarted.resume(childId!, { profileId: 'subworkflow-profile' })
    }
    const done = await restarted.resume(waiting.manifest.runId, { profileId: 'subworkflow-profile' })
    expect(done.manifest.state).toBe('succeeded')
    expect(done.attempts.find((attempt) => attempt.instanceKey === 'parent-child')?.childRunId).toBe(childId)
    expect(done.result).toEqual(kind === 'input' ? 'accepted' : kind === 'approval' ? { decision: 'approved' } : { elapsedMs: 30 })
    expect(done.manifest.budgets.toolCalls).toBe(kind === 'input' ? 2 : 1)
    expect(dispatches).toBe(0)
  })

  it('refreshes the durable parent cursor after a deferred child control completes', async () => {
    const value = await setup('input')
    const run = service(value, () => undefined)
    const parent = await startParent(run, value)
    const childId = parent.pendingWaits?.[0]?.childRunId
    const child = await run.get(childId!, { profileId: 'subworkflow-profile' })
    const pending = child.pendingWaits?.find((wait) => wait.pendingInput)?.pendingInput
    expect(pending).toBeTruthy()

    await run.answer(childId!, { profileId: 'subworkflow-profile', deferExecution: true }, {
      instanceKey: pending!.instanceKey, data: 'deferred answer'
    })
    let refreshed = await run.get(parent.manifest.runId, { profileId: 'subworkflow-profile' })
    for (let attempt = 0; attempt < 100 && refreshed.pendingWaits?.length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      refreshed = await run.get(parent.manifest.runId, { profileId: 'subworkflow-profile' })
    }
    expect(refreshed.pendingWaits).toEqual([])
    const done = await run.resume(parent.manifest.runId, { profileId: 'subworkflow-profile' })
    expect(done.manifest.state).toBe('succeeded')
    expect(done.result).toBe('deferred answer')
    expect(done.manifest.budgets.toolCalls).toBe(2)
  })

  it('keeps an unknown child effect recoverable through the child run and never dispatches it twice', async () => {
    const value = await setup('unknown')
    let dispatches = 0
    const first = service(value, () => { dispatches += 1 }, true)
    const waiting = await startParent(first, value)
    expect(waiting.manifest.state).toBe('waiting-condition')
    const childId = waiting.pendingWaits?.[0]?.childRunId
    expect(childId).toBeTruthy()
    expect(waiting.pendingWaits?.[0]?.childState).toBe('unknown-effect')
    const waitingView = workflowRunView(waiting, [])
    expect(waitingView.pendingConditions?.[0]).toMatchObject({ childRunId: childId, childState: 'unknown-effect' })
    expect(waitingView.unknownEffect).toMatchObject({ childRunId: childId, instanceKey: 'parent-child' })
    expect(dispatches).toBe(1)
    await first.shutdown()

    const restarted = service(value, () => { dispatches += 1 })
    const child = await restarted.get(childId!, { profileId: 'subworkflow-profile' })
    expect(child.manifest.state).toBe('unknown-effect')
    const abandoned = await restarted.resume(childId!, { profileId: 'subworkflow-profile', reconcile: 'abandon' })
    expect(abandoned.manifest.state).toBe('failed')
    const failed = await restarted.resume(waiting.manifest.runId, { profileId: 'subworkflow-profile' })
    expect(failed.manifest.state).toBe('failed')
    expect(failed.attempts.find((attempt) => attempt.instanceKey === 'parent-child')?.childRunId).toBe(childId)
    expect(dispatches).toBe(1)
  })

  it('fails closed when a durable child pointer is replaced with an unrelated same-profile run', async () => {
    const value = await setup('input')
    const run = service(value, () => undefined)
    const parent = await startParent(run, value)
    const unrelated = await run.start({
      profileId: 'subworkflow-profile', threadId: 'unrelated', actor: { kind: 'workflow' }, source: 'cli',
      definitionId: value.child.definitionId, revisionId: value.child.head?.revisionId, input: {}, installationPolicy: INSTALL
    })
    const pending = unrelated.pendingWaits?.find((wait) => wait.pendingInput)?.pendingInput
    expect(pending).toBeTruthy()
    await run.answer(unrelated.manifest.runId, { profileId: 'subworkflow-profile' }, { instanceKey: pending!.instanceKey, data: 'unrelated' })
    const checkpointPath = join(value.profileRoot, 'workflow-runs', parent.manifest.runId, 'checkpoint.json')
    const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8')) as { childRuns?: Record<string, string>; waits?: Record<string, { childRunId?: string }> }
    checkpoint.childRuns = { ...(checkpoint.childRuns ?? {}), 'parent-child': unrelated.manifest.runId }
    const wait = checkpoint.waits?.['parent-child']
    if (wait) wait.childRunId = unrelated.manifest.runId
    writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`)
    const failed = await run.resume(parent.manifest.runId, { profileId: 'subworkflow-profile' })
    expect(failed.manifest.state).toBe('failed')
    expect(failed.manifest.terminalError).toContain('child linkage mismatch')
  })

  it.each(['input', 'approval', 'timer', 'unknown'] as const)('survives killing the actual workflow host while child %s is waiting', async (kind) => {
    const value = await setup(kind)
    const marker = join(value.profileRoot, `${kind}-process.ndjson`)
    const fixture = join(process.cwd(), 'tests', 'fixtures', 'workflow-runtime-crash-child.ts')
    const entry = join(value.profileRoot, `workflow-runtime-subworkflow-${kind}.cjs`)
    await build({ entryPoints: [fixture], bundle: true, platform: 'node', format: 'cjs', outfile: entry, sourcemap: false })
    const children: ChildProcess[] = []
    const waitForExit = (child: ChildProcess, timeoutMs = 5000) => new Promise<number | null>((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(child.exitCode); return }
      const timer = setTimeout(() => reject(new Error(`subworkflow fixture did not exit within ${timeoutMs}ms`)), timeoutMs)
      child.once('exit', (code) => { clearTimeout(timer); resolve(code) })
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
    })
    const launch = (mode: 'run' | 'resume', runId?: string) => new Promise<any>((resolve, reject) => {
      const child = spawn(process.execPath, [entry], {
        env: {
          ...process.env,
          MATRIX_PROFILE_ROOT: value.profileRoot,
          MATRIX_PROFILE_ID: 'subworkflow-profile',
          MATRIX_MODE: mode,
          MATRIX_RUN_ID: runId ?? '',
          MATRIX_MARKER: marker,
          MATRIX_DEFINITION_ID: value.parent.definitionId,
          MATRIX_REVISION_ID: value.parent.head?.revisionId ?? '',
          MATRIX_CHILD_CONTROL: kind,
          MATRIX_HOLD: mode === 'run' ? '1' : '',
          MATRIX_FAIL_AGENT: kind === 'unknown' && mode === 'run' ? '1' : ''
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true
      })
      children.push(child)
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error(`subworkflow ${mode} fixture readiness timed out`)) }
      }, 5000)
      child.on('message', (message) => {
        if (message?.type === 'ERROR' && !settled) {
          settled = true; clearTimeout(timer); reject(new Error(String(message.message)))
        } else if ((mode === 'run' && message?.type === 'READY') || (mode === 'resume' && message?.type === 'DONE')) {
          if (!settled) { settled = true; clearTimeout(timer); resolve({ child, message }) }
        }
      })
      child.on('error', (error) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(error) }
      })
      child.on('exit', (code) => {
        if (!settled && mode === 'resume') {
          settled = true; clearTimeout(timer); reject(new Error(`subworkflow resume exited before DONE (${code ?? 'signal'})`))
        }
      })
    })
    try {
      const first = await launch('run')
      const inspector = service(value, () => undefined)
      const parent = (await inspector.list({ profileId: 'subworkflow-profile' })).find((run) => run.definitionId === value.parent.definitionId)
      expect(parent).toBeTruthy()
      const before = await inspector.get(parent!.runId, { profileId: 'subworkflow-profile' })
      const childId = before.pendingWaits?.[0]?.childRunId
      expect(childId).toMatch(/^[0-9a-f-]{36}$/i)
      expect((await inspector.list({ profileId: 'subworkflow-profile' })).filter((run) => run.parentRunId === parent!.runId).map((run) => run.runId)).toEqual([childId])
      first.child.kill('SIGKILL')
      await waitForExit(first.child)
      const second = await launch('resume', parent!.runId)
      expect(second.message.state).toBe(kind === 'unknown' ? 'failed' : 'succeeded')
      const after = await inspector.get(parent!.runId, { profileId: 'subworkflow-profile' })
      expect(after.attempts.find((attempt) => attempt.instanceKey === 'parent-child')?.childRunId).toBe(childId)
      expect((await inspector.list({ profileId: 'subworkflow-profile' })).filter((run) => run.parentRunId === parent!.runId).map((run) => run.runId)).toEqual([childId])
      const markers = (() => {
        try { return readFileSync(marker, 'utf8').split(/\r?\n/).filter(Boolean) } catch { return [] }
      })()
      expect(markers).toHaveLength(kind === 'unknown' ? 1 : 0)
    } finally {
      await Promise.all(children.filter((child) => child.exitCode === null && child.signalCode === null).map(async (child) => {
        child.kill('SIGKILL')
        await waitForExit(child).catch(() => undefined)
      }))
    }
  }, 15000)

  it('copies failed child usage onto the parent once and does not recharge after resume', async () => {
    const childManifest = bundle('22222222-2222-4222-8222-222222222226', 'child_fail_usage', [
      { id: 'child-start', type: 'start', version: 1, config: {} },
      { id: 'child-agent', type: 'agent', version: 1, config: { agent: { kind: 'main' }, instructions: 'consume' } },
      { id: 'child-fail', type: 'fail', version: 1, config: { message: 'child failed after work' } }
    ], [
      { from: 'child-start', port: 'next', to: 'child-agent' },
      { from: 'child-agent', port: 'success', to: 'child-fail' }
    ], ['model.invoke'])
    const value = await setup('unknown', childManifest)
    let dispatches = 0
    const run = new WorkflowRunService({
      profileId: 'subworkflow-profile', profileRoot: value.profileRoot, registry: value.registry,
      policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry(),
      adapters: { agent: { kind: 'agent', async invoke() { dispatches += 1; return { output: { used: true }, tokens: 4, cost: 1.5 } } } }
    })
    let snapshot = await startParent(run, value)
    if (snapshot.manifest.state !== 'failed') snapshot = await run.resume(snapshot.manifest.runId, { profileId: 'subworkflow-profile' })
    expect(snapshot.manifest.state).toBe('failed')
    expect(snapshot.manifest.budgets.tokens).toBe(4)
    expect(snapshot.manifest.budgets.cost).toBe(1.5)
    expect(dispatches).toBe(1)
    const again = await run.resume(snapshot.manifest.runId, { profileId: 'subworkflow-profile' })
    expect(again.manifest.budgets.tokens).toBe(4)
    expect(again.manifest.budgets.cost).toBe(1.5)
    expect(dispatches).toBe(1)
  })

  it('copies cancelled child usage onto the cancelled parent once', async () => {
    const childManifest = bundle('22222222-2222-4222-8222-222222222227', 'child_cancel_usage', [
      { id: 'child-start', type: 'start', version: 1, config: {} },
      { id: 'child-agent', type: 'agent', version: 1, config: { agent: { kind: 'main' }, instructions: 'consume' } },
      { id: 'child-ask', type: 'ask-user', version: 1, config: { prompt: 'hold', answerSchema: { type: 'string' } } },
      { id: 'child-end', type: 'end', version: 1, config: {}, inputs: { result: { ref: 'node', nodeId: 'child-ask', pointer: '' } } }
    ], [
      { from: 'child-start', port: 'next', to: 'child-agent' },
      { from: 'child-agent', port: 'success', to: 'child-ask' },
      { from: 'child-ask', port: 'success', to: 'child-end' }
    ], ['model.invoke', 'human.input'])
    const value = await setup('input', childManifest)
    const run = new WorkflowRunService({
      profileId: 'subworkflow-profile', profileRoot: value.profileRoot, registry: value.registry,
      policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry(),
      adapters: { agent: { kind: 'agent', async invoke() { return { output: { used: true }, tokens: 6, cost: 2 } } } }
    })
    const waiting = await startParent(run, value)
    expect(waiting.manifest.state).toBe('waiting-input')
    const cancelled = await run.cancel(waiting.manifest.runId, { profileId: 'subworkflow-profile' }, 'stop')
    expect(cancelled.manifest.state).toBe('cancelled')
    expect(cancelled.manifest.budgets.tokens).toBe(6)
    expect(cancelled.manifest.budgets.cost).toBe(2)
    const again = await run.cancel(waiting.manifest.runId, { profileId: 'subworkflow-profile' }, 'stop')
    expect(again.manifest.budgets.tokens).toBe(6)
    expect(again.manifest.budgets.cost).toBe(2)
  })

  it('fails closed when a child Skill pin is missing from the parent snapshot', async () => {
    const childManifest = bundle('22222222-2222-4222-8222-222222222228', 'child_missing_pin', [
      { id: 'child-start', type: 'start', version: 1, config: {} },
      { id: 'child-skill', type: 'load-skill', version: 1, config: { skill: { id: 'skill-missing' } } },
      { id: 'child-end', type: 'end', version: 1, config: {}, inputs: { result: { ref: 'node', nodeId: 'child-skill', pointer: '' } } }
    ], [
      { from: 'child-start', port: 'next', to: 'child-skill' },
      { from: 'child-skill', port: 'success', to: 'child-end' }
    ], ['skill.load'])
    const value = await setup('timer', childManifest)
    const parent = {
      profileId: 'subworkflow-profile',
      threadId: 'subworkflow-thread',
      runId: '11111111-1111-4111-8111-111111111111',
      executionBindings: { version: 1 as const, profileId: 'subworkflow-profile', skills: [], mcpTools: [] }
    }
    const child = value.registry.getRevision(value.child.definitionId, value.child.head!.revisionId!)!
    expect(() => inheritChildAdmission({
      parent: parent as never,
      child,
      request: {
        profileId: 'subworkflow-profile', threadId: 'subworkflow-thread', actor: { kind: 'workflow' }, source: 'cli',
        definitionId: value.child.definitionId, revisionId: value.child.head!.revisionId, input: {},
        installationPolicy: INSTALL
      }
    })).toThrow(/missing from the parent workflow binding snapshot/)
  })
})
