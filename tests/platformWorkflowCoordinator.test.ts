import { randomUUID } from 'node:crypto'
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { MmsWorkflowCoordinator } from '../src/mms/platform/MmsWorkflowCoordinator'
import { WorkflowRegistry } from '../src/mms/workflows/registry/WorkflowRegistry'
import { WorkflowRunStore, type RunLease } from '../src/mms/workflows/engine/runStore'
import type { WorkflowBundle, WorkflowNode, WorkflowRunSnapshot } from '../src/shared/workflows'
import type { WorkflowRunStartParams } from '../src/shared/workflowRunPlatform'

const roots: string[] = []
const coordinators: MmsWorkflowCoordinator[] = []
const admission = { source: 'gui' as const, connectionId: 'owned-window' }
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mousse-workflow-coordinator-')); roots.push(root)
  const profileRoot = join(root, 'profile')
  mkdirSync(profileRoot)
  const profileId = randomUUID()
  const projects = new ProjectManager(profileRoot)
  const threads = new ThreadDataStore(projects, profileRoot, { allowLegacyProjectData: false })
  projects.setThreadStore(threads)
  const registry = new WorkflowRegistry({ profileId, profileRoot })
  const errors: unknown[] = []
  const create = () => {
    const coordinator = new MmsWorkflowCoordinator({ profileId, profileRoot, projects, threads, registry, onError: (_run, error) => errors.push(error) })
    coordinators.push(coordinator)
    return coordinator
  }
  return { root, profileRoot, profileId, projects, threads, registry, create, errors }
}
function bundle(node?: WorkflowNode, assets: WorkflowBundle['assets'] = []): WorkflowBundle {
  return { assets, manifest: {
    schemaVersion: 1, id: randomUUID(), name: 'Coordinator fixture', slug: 'coordinator-fixture', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, entryNodeId: 'start',
    permissions: { capabilities: node?.type === 'script' ? ['script.trusted-local', 'workspace.read'] : [] },
    nodes: [{ id: 'start', type: 'start', version: 1, config: {} }, ...(node ? [node] : []), { id: 'end', type: 'end', version: 1, config: {}, inputs: { result: node?.type === 'script' ? { ref: 'node', nodeId: node.id, pointer: '' } : { ref: 'input', pointer: '' } } }],
    edges: node ? [{ from: 'start', port: 'next', to: node.id }, { from: node.id, port: 'success', to: 'end' }] : [{ from: 'start', port: 'next', to: 'end' }]
  } }
}
function publish(f: ReturnType<typeof setup>, content = bundle()) {
  const saved = f.registry.saveDraft({ bundle: content })
  const published = f.registry.publish({ definitionId: saved.definitionId, expectedDraftSemanticHash: saved.semanticHash, expectedHeadRevisionId: null })
  const request: WorkflowRunStartParams = { profileId: f.profileId, definitionId: saved.definitionId, requestId: randomUUID(), input: { exact: 'value' } }
  return { published, request, content }
}
async function state(coordinator: MmsWorkflowCoordinator, runId: string, expected: string): Promise<WorkflowRunSnapshot> {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const snapshot = await coordinator.runtime.get(runId, { profileId: coordinator.profileId })
    if (snapshot.manifest.state === expected) return snapshot
    if (snapshot.manifest.state === 'failed') throw new Error(snapshot.manifest.terminalError)
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  throw new Error('Workflow did not reach ' + expected)
}
afterEach(async () => {
  await Promise.all(coordinators.splice(0).map((coordinator) => coordinator.dispose()))
  for (const root of roots.splice(0)) {
    const path = relative(realpathSync(tmpdir()), realpathSync(root))
    if (isAbsolute(path) || !path.startsWith('mousse-workflow-coordinator-') || path.includes('..')) throw new Error('Unsafe fixture cleanup')
    rmSync(root, { recursive: true, force: true })
  }
})

describe('production workflow coordinator', () => {
  it.each(['malformed', 'wrong-shape', 'oversized', 'tampered'] as const)('fails closed for a %s durable admission before replay', async (kind) => {
    const f = setup(), { request } = publish(f), coordinator = f.create()
    const started = await coordinator.start(request, admission)
    await state(coordinator, started.manifest.runId, 'succeeded')
    const path = join(f.profileRoot, 'workflow-admissions', request.requestId + '.json')
    if (kind === 'malformed') writeFileSync(path, '{')
    if (kind === 'wrong-shape') writeFileSync(path, JSON.stringify({ request: null }))
    if (kind === 'tampered') {
      const record = JSON.parse(readFileSync(path, 'utf8'))
      record.request.installationPolicy.allowedTools = []
      writeFileSync(path, JSON.stringify(record))
    }
    if (kind === 'oversized') {
      const descriptor = openSync(path, 'w')
      try { ftruncateSync(descriptor, 16 * 1024 * 1024 + 1) } finally { closeSync(descriptor) }
    }
    await expect(coordinator.start(request, admission)).rejects.toMatchObject({ code: 'invocation_unavailable' })
    expect(await coordinator.runtime.list({ profileId: f.profileId })).toHaveLength(1)
    expect(f.threads.listAllThreads()).toHaveLength(1)
  })

  it('reuses durable thread/policy/revision after restart and a changed published head', async () => {
    const f = setup(), { published, request, content } = publish(f)
    const first = f.create()
    const started = await first.start(request, admission)
    await state(first, started.manifest.runId, 'succeeded')
    const changed = f.registry.saveDraft({ bundle: { ...content, manifest: { ...content.manifest, name: 'Changed later' } }, expectedDraftSemanticHash: published.semanticHash })
    f.registry.publish({ definitionId: published.definitionId, expectedDraftSemanticHash: changed.semanticHash, expectedHeadRevisionId: published.semanticHash })
    await first.dispose()
    const fresh = f.create()
    const repeated = await fresh.start(request, admission)
    expect(repeated.manifest.runId).toBe(started.manifest.runId)
    expect(repeated.manifest.revisionId).toBe(published.semanticHash)
    expect(repeated.manifest.threadId).toBe(started.manifest.threadId)
    expect(f.threads.listAllThreads()).toHaveLength(1)
    expect(f.threads.listAllThreads()[0].startedAt).toBeTruthy()
    await expect(fresh.start({ ...request, input: { changed: true } }, admission)).rejects.toMatchObject({ code: 'WORKFLOW_CONCURRENCY_CONFLICT' })
    f.threads.deleteThread(repeated.manifest.threadId)
    await expect(fresh.start(request, admission)).rejects.toMatchObject({ code: 'thread_unavailable' })
    expect(f.threads.listAllThreads()).toHaveLength(0)
  })

  it('repairs interrupted thread initialization without replacing messages or duplicating the index', () => {
    const f = setup()
    const first = f.threads.ensureExecutionThread('stable-execution-key', 'A workflow')
    const messages = [{ id: 'kept', role: 'user', content: 'Existing exact transcript' }]
    writeFileSync(join(f.threads.getThreadDir(first.id), 'messages.json'), JSON.stringify(messages))
    writeFileSync(join(f.profileRoot, 'threads-index.json'), '[]')
    const second = f.threads.ensureExecutionThread('stable-execution-key', 'Do not rename existing')
    expect(second.id).toBe(first.id)
    expect(second.name).toBe(first.name)
    expect(JSON.parse(readFileSync(join(f.threads.getThreadDir(first.id), 'messages.json'), 'utf8'))).toEqual(messages)
    f.threads.ensureExecutionThread('stable-execution-key', 'Still same')
    expect(f.threads.listAllThreads()).toHaveLength(1)
  })

  it('restores a durable timer without a UI and rejects new work after disposal', async () => {
    const f = setup()
    const { request } = publish(f, bundle({ id: 'delay', type: 'delay', version: 1, config: { durationMs: 450 } }))
    const first = f.create(), accepted = await first.start(request, admission)
    await state(first, accepted.manifest.runId, 'waiting-condition')
    await first.dispose()
    const fresh = f.create()
    await fresh.startRecovery()
    expect((await state(fresh, accepted.manifest.runId, 'succeeded')).result).toEqual(request.input)
    expect(f.errors).toEqual([])
    await fresh.dispose()
    await expect(fresh.start({ ...request, requestId: randomUUID() }, admission)).rejects.toMatchObject({ code: 'profile_unavailable' })
  })

  it('executes pinned local code only after approval and stages files from the owning project', async () => {
    const f = setup()
    const projectPath = join(f.root, 'repository'); mkdirSync(projectPath)
    writeFileSync(join(projectPath, 'source.txt'), 'Owned project bytes')
    const project = f.projects.openProject(projectPath)
    const source = "import { readFileSync } from 'node:fs'; let text=''; for await (const chunk of process.stdin) text+=chunk; const input=JSON.parse(text); console.log(JSON.stringify({text:readFileSync(input.files[0],'utf8')}));"
    const content = bundle({ id: 'script', type: 'script', version: 1, inputs: { files: { ref: 'input', pointer: '/files' } }, config: {
      runtime: 'node', file: 'scripts/run.mjs', executionMode: 'trusted-local', fileInputs: [{ pointer: '/files', source: 'thread-workspace', destination: 'input-dir', rewrite: 'relative-staged-paths', maxTotalBytes: 4096 }]
    } }, [{ relativePath: 'scripts/run.mjs', bytes: new TextEncoder().encode(source) }])
    const { request } = publish(f, content)
    request.input = { files: ['source.txt'] }; request.projectId = project.id
    const coordinator = f.create(), accepted = await coordinator.start(request, admission)
    const waiting = await state(coordinator, accepted.manifest.runId, 'waiting-approval')
    expect(waiting.outputs.script).toBeUndefined()
    const changed = { ...content, assets: [{ relativePath: 'scripts/run.mjs', bytes: new TextEncoder().encode("throw new Error('wrong revision')") }] }
    f.registry.saveDraft({ bundle: changed })
    await coordinator.runtime.approve(accepted.manifest.runId, { profileId: f.profileId, deferExecution: true }, { approvalId: waiting.pendingApprovalId!, approved: true, actorId: admission.connectionId })
    expect((await state(coordinator, accepted.manifest.runId, 'succeeded')).result).toEqual({ text: 'Owned project bytes' })
    expect(f.threads.getThread(accepted.manifest.threadId)?.projectId).toBe(project.id)
  })

  it('retries a durable timer when a concurrent control lease overlaps its due time', async () => {
    const f = setup()
    const { request } = publish(f, bundle({ id: 'delay', type: 'delay', version: 1, config: { durationMs: 900 } }))
    const coordinator = f.create(), accepted = await coordinator.start(request, admission)
    const waiting = await state(coordinator, accepted.manifest.runId, 'waiting-condition')
    const store = new WorkflowRunStore(f)
    let lease!: RunLease
    await vi.waitFor(() => { lease = store.acquire(accepted.manifest.runId, new Date().toISOString()) })
    try {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(waiting.wakeAt!) - Date.now()) + 350))
      expect((await coordinator.runtime.get(accepted.manifest.runId, { profileId: f.profileId })).manifest.state).toBe('waiting-condition')
    } finally { store.release(accepted.manifest.runId, lease.token) }
    expect((await state(coordinator, accepted.manifest.runId, 'succeeded')).result).toEqual(request.input)
    expect(f.errors).toEqual([])
  })

  it('rejects unknown executors and foreign project/thread identities before creating a thread', async () => {
    const f = setup()
    const { request } = publish(f)
    const coordinator = f.create()
    await expect(coordinator.start({ ...request, projectId: randomUUID() }, admission)).rejects.toMatchObject({ code: 'project_unavailable' })
    await expect(coordinator.start({ ...request, threadId: randomUUID() }, admission)).rejects.toMatchObject({ code: 'thread_unavailable' })
    expect(f.threads.listAllThreads()).toHaveLength(0)
    const agent = bundle({ id: 'agent', type: 'agent', version: 1, config: { agent: { kind: 'main' }, instructions: 'Do work' } })
    agent.manifest.slug = 'agent-fixture'; agent.manifest.permissions = { capabilities: ['model.invoke'] }
    const saved = f.registry.saveDraft({ bundle: agent })
    const agentRequest: WorkflowRunStartParams = { profileId: f.profileId, definitionId: saved.definitionId, draft: true, expectedDraftSemanticHash: saved.semanticHash, input: {}, requestId: randomUUID() }
    await expect(coordinator.start(agentRequest, admission)).rejects.toMatchObject({ code: 'executor_unavailable' })
    const sandbox = bundle({ id: 'sandbox', type: 'script', version: 1, config: {
      runtime: 'node', file: 'scripts/run.mjs', executionMode: 'sandboxed'
    } }, [{ relativePath: 'scripts/run.mjs', bytes: new TextEncoder().encode("console.log('{}')") }])
    sandbox.manifest.slug = 'sandbox-fixture'
    const sandboxSaved = f.registry.saveDraft({ bundle: sandbox })
    await expect(coordinator.start({
      profileId: f.profileId, definitionId: sandboxSaved.definitionId, draft: true,
      expectedDraftSemanticHash: sandboxSaved.semanticHash, input: {}, requestId: randomUUID()
    }, admission)).rejects.toMatchObject({ code: 'executor_unavailable' })
    expect(f.threads.listAllThreads()).toHaveLength(0)
  })

  function publishChild(f: ReturnType<typeof setup>, childNode: WorkflowNode, capabilities: string[] = []) {
    const child = {
      assets: [] as WorkflowBundle['assets'],
      manifest: {
        schemaVersion: 1 as const, id: randomUUID(), name: 'Child fixture', slug: 'child-' + randomUUID().slice(0, 8),
        inputSchema: { type: 'object' }, outputSchema: {}, entryNodeId: 'start',
        permissions: { capabilities },
        nodes: [
          { id: 'start', type: 'start', version: 1, config: {} },
          childNode,
          { id: 'end', type: 'end', version: 1, config: {}, inputs: { result: { ref: 'node', nodeId: childNode.id, pointer: '' } } }
        ],
        edges: [
          { from: 'start', port: 'next', to: childNode.id },
          { from: childNode.id, port: childNode.type === 'approval' ? 'approved' : 'success', to: 'end' },
          ...(childNode.type === 'approval' ? [{ from: childNode.id, port: 'denied' as const, to: 'end' }] : [])
        ]
      }
    } satisfies WorkflowBundle
    const saved = f.registry.saveDraft({ bundle: child })
    const published = f.registry.publish({ definitionId: saved.definitionId, expectedDraftSemanticHash: saved.semanticHash, expectedHeadRevisionId: null })
    const parent = bundle({ id: 'child', type: 'subworkflow', version: 1, config: { workflow: { id: published.definitionId, revision: published.head?.revisionId } } })
    parent.manifest.slug = 'parent-' + randomUUID().slice(0, 8)
    parent.manifest.outputSchema = {}
    parent.manifest.permissions = { capabilities }
    const end = parent.manifest.nodes.find((node) => node.id === 'end')
    if (end) end.inputs = { result: { ref: 'node', nodeId: 'child', pointer: '' } }
    const started = publish(f, parent)
    return { ...started, child: published }
  }

  async function waitForChildWait(coordinator: MmsWorkflowCoordinator, runId: string): Promise<WorkflowRunSnapshot> {
    const deadline = Date.now() + 8000
    const approved = new Set<string>()
    while (Date.now() < deadline) {
      const snapshot = await coordinator.runtime.get(runId, { profileId: coordinator.profileId })
      const childId = snapshot.pendingWaits?.find((wait) => wait.childRunId)?.childRunId
      if (childId) return snapshot
      if (snapshot.manifest.state === 'failed') throw new Error(snapshot.manifest.terminalError)
      if (snapshot.manifest.state === 'waiting-approval' && snapshot.pendingApprovalId && !approved.has(snapshot.pendingApprovalId)) {
        approved.add(snapshot.pendingApprovalId)
        await coordinator.runtime.approve(runId, { profileId: coordinator.profileId, deferExecution: true }, {
          approvalId: snapshot.pendingApprovalId, approved: true, actorId: admission.connectionId
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
    throw new Error('Parent did not reach a child-owned wait')
  }

  it.each(['input', 'approval'] as const)('resumes the parent after deferred child %s without a second parent resume call', async (kind) => {
    const f = setup()
    const childNode: WorkflowNode = kind === 'input'
      ? { id: 'ask', type: 'ask-user', version: 1, config: { prompt: 'Child value', answerSchema: { type: 'string' } } }
      : { id: 'approval', type: 'approval', version: 1, config: { action: 'child-write', proposal: 'Approve child' } }
    const { request } = publishChild(f, childNode, kind === 'input' ? ['human.input'] : ['human.approval'])
    const coordinator = f.create()
    const accepted = await coordinator.start(request, admission)
    const waiting = await waitForChildWait(coordinator, accepted.manifest.runId)
    const childId = waiting.pendingWaits?.find((wait) => wait.childRunId)?.childRunId
    expect(childId).toMatch(/^[0-9a-f-]{36}$/i)
    const child = await coordinator.runtime.get(childId!, { profileId: f.profileId })
    if (kind === 'input') {
      const pending = child.pendingWaits?.find((wait) => wait.pendingInput)?.pendingInput
      expect(pending).toBeTruthy()
      await coordinator.runtime.answer(childId!, { profileId: f.profileId, deferExecution: true }, { instanceKey: pending!.instanceKey, data: 'from-child' })
    } else {
      const approvalId = child.pendingWaits?.find((wait) => wait.approvalId)?.approvalId
      expect(approvalId).toBeTruthy()
      await coordinator.runtime.approve(childId!, { profileId: f.profileId, deferExecution: true }, {
        approvalId: approvalId!, approved: true, actorId: admission.connectionId
      })
    }
    const done = await state(coordinator, accepted.manifest.runId, 'succeeded')
    expect(done.result).toEqual(kind === 'input' ? 'from-child' : { decision: 'approved' })
    expect(done.attempts.find((attempt) => attempt.instanceKey === 'child')?.childRunId).toBe(childId)
    expect(f.errors).toEqual([])
  }, 12_000)

  it('recovers a child timer after host reconstruction without replaying the child', async () => {
    const f = setup()
    const { request } = publishChild(f, { id: 'delay', type: 'delay', version: 1, config: { durationMs: 450 } })
    const first = f.create()
    const accepted = await first.start(request, admission)
    const waiting = await waitForChildWait(first, accepted.manifest.runId)
    const childId = waiting.pendingWaits?.find((wait) => wait.childRunId)?.childRunId
    expect(childId).toBeTruthy()
    await first.dispose()
    const fresh = f.create()
    await fresh.startRecovery()
    const done = await state(fresh, accepted.manifest.runId, 'succeeded')
    expect(done.attempts.find((attempt) => attempt.instanceKey === 'child')?.childRunId).toBe(childId)
    expect((await fresh.runtime.list({ profileId: f.profileId })).filter((run) => run.parentRunId === accepted.manifest.runId).map((run) => run.runId)).toEqual([childId])
    expect(f.errors).toEqual([])
  }, 12_000)

  it('cancels an owned child when the parent is cancelled and does not resume it later', async () => {
    const f = setup()
    const { request } = publishChild(f, { id: 'ask', type: 'ask-user', version: 1, config: { prompt: 'Child value', answerSchema: { type: 'string' } } }, ['human.input'])
    const coordinator = f.create()
    const accepted = await coordinator.start(request, admission)
    const waiting = await waitForChildWait(coordinator, accepted.manifest.runId)
    const childId = waiting.pendingWaits?.find((wait) => wait.childRunId)?.childRunId
    await coordinator.runtime.cancel(accepted.manifest.runId, { profileId: f.profileId }, 'stop parent')
    const parent = await state(coordinator, accepted.manifest.runId, 'cancelled')
    const child = await coordinator.runtime.get(childId!, { profileId: f.profileId })
    expect(parent.manifest.state).toBe('cancelled')
    expect(child.manifest.state).toBe('cancelled')
    expect(f.errors).toEqual([])
  }, 12_000)
})
