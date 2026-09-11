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

async function setup(kind: 'input' | 'approval' | 'timer' | 'unknown') {
  const profileRoot = mkdtempSync(join(tmpdir(), `mousse-subworkflow-${kind}-`))
  roots.push(profileRoot)
  const registry = new WorkflowRegistry({ profileId: 'subworkflow-profile', profileRoot })
  const child = registry.saveDraft({ bundle: { manifest: childBundle(kind), assets: [] } })
  const childPublished = registry.publish({ definitionId: child.definitionId, expectedDraftSemanticHash: child.semanticHash, expectedHeadRevisionId: null })
  const parentId = `33333333-3333-4333-8333-33333333333${kind === 'input' ? '1' : kind === 'approval' ? '2' : kind === 'timer' ? '3' : '4'}`
  const parent = registry.saveDraft({ bundle: { manifest: bundle(parentId, `parent_${kind}`, [
    { id: 'parent-start', type: 'start', version: 1, config: {} },
    { id: 'parent-child', type: 'subworkflow', version: 1, config: { workflow: { id: childPublished.definitionId, revision: childPublished.head?.revisionId } } },
    { id: 'parent-end', type: 'end', version: 1, inputs: { result: { ref: 'node', nodeId: 'parent-child', pointer: '' } }, config: {} }
  ], [
    { from: 'parent-start', port: 'next', to: 'parent-child' },
    { from: 'parent-child', port: 'success', to: 'parent-end' }
  ]), assets: [] } })
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
  it.each(['input', 'approval', 'timer'] as const)('keeps the exact child linked across service restart and resolves %s through the child public controls', async (kind) => {
    const value = await setup(kind)
    let dispatches = 0
    const first = service(value, () => { dispatches += 1 })
    const waiting = await startParent(first, value)
    expect(waiting.manifest.state).toBe(kind === 'timer' ? 'waiting-condition' : kind === 'input' ? 'waiting-input' : 'waiting-approval')
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
    expect(dispatches).toBe(0)
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
    expect(workflowRunView(waiting, []).pendingConditions?.[0]).toMatchObject({ childRunId: childId, childState: 'unknown-effect' })
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
})
