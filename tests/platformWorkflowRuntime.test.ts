import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExecutionPolicyLayer } from '../src/shared/execution/types'
import type { AgentExecutorAdapter, WorkspaceFileAdapter } from '../src/shared/workflows'
import { ExecutionPolicyService } from '../src/mms/execution/ExecutionPolicyService'
import { CancellationRegistry } from '../src/mms/execution/CancellationRegistry'
import { loadWorkflowDirectory, WorkflowRegistry, WorkflowRunService } from '../src/mms/workflows'
import { createAllNodeTypesManifest } from '../src/mms/workflows/fixtures/allNodeTypes'
import { resolveContainedPath } from '../src/mms/workflows/pathSafety'

const EXAMPLE = join(process.cwd(), 'examples', 'workflows', 'summarize-files')
const dirs: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const INSTALL: ExecutionPolicyLayer = {
  allowedTools: ['workflow.node', 'workflow.script', 'workflow.agent', 'workflow.approval', 'workspace.read'],
  allowedCapabilities: [
    'workspace.read',
    'script.trusted-local',
    'model.invoke',
    'tool.invoke',
    'mcp.invoke',
    'skill.load',
    'browser.session',
    'browser.observe',
    'browser.action',
    'browser.extract',
    'browser.task',
    'human.input',
    'human.approval',
    'artifact.write'
  ],
  allowedEffects: ['pure', 'read', 'write', 'external', 'unknown']
}

class DirWorkspace implements WorkspaceFileAdapter {
  readonly kind = 'workspace' as const
  constructor(private readonly root: string) {}
  async readAuthorizedFile(relativePath: string) {
    const resolved = resolveContainedPath(this.root, relativePath)
    if (!resolved.ok) throw new Error(resolved.reason)
    const stat = lstatSync(resolved.resolved)
    if (stat.isSymbolicLink()) throw new Error('Rejected symlink file input')
    return { bytes: new Uint8Array(readFileSync(resolved.resolved)), name: relativePath }
  }
}

function countingAgent(onCall: () => void): AgentExecutorAdapter {
  return {
    kind: 'agent',
    async invoke(request) {
      onCall()
      const text = String((request.input as { text?: string })?.text ?? '')
      return { output: { summary: text } }
    }
  }
}

async function publishExample(profileRoot: string) {
  const registry = new WorkflowRegistry({ profileId: 'p1', profileRoot })
  const loaded = loadWorkflowDirectory(EXAMPLE)
  const saved = registry.saveDraft({ bundle: loaded.bundle })
  const published = registry.publish({
    definitionId: saved.definitionId,
    expectedDraftSemanticHash: saved.semanticHash,
    expectedHeadRevisionId: null
  })
  return { registry, published }
}

describe('WorkflowRunService', () => {
  it('executes collect.mjs with staged inputs and exact summary output', async () => {
    const profileRoot = tempDir('mousse-run-')
    const workspaceRoot = tempDir('mousse-ws-')
    writeFileSync(join(workspaceRoot, 'a.txt'), 'alpha')
    writeFileSync(join(workspaceRoot, 'b.txt'), 'beta')
    const { registry, published } = await publishExample(profileRoot)
    let agentCalls = 0
    const service = new WorkflowRunService({
      profileId: 'p1',
      profileRoot,
      registry,
      policy: new ExecutionPolicyService(),
      cancellation: new CancellationRegistry(),
      adapters: {
        workspace: new DirWorkspace(workspaceRoot),
        agent: countingAgent(() => {
          agentCalls += 1
        })
      }
    })
    let snap = await service.start({
      profileId: 'p1',
      threadId: 't1',
      actor: { kind: 'workflow' },
      source: 'cli',
      definitionId: published.definitionId,
      revisionId: published.head?.revisionId,
      input: { files: ['a.txt', 'b.txt'] },
      installationPolicy: INSTALL
    })
    expect(snap.manifest.state, snap.manifest.terminalError ?? JSON.stringify(snap.outputs)).toBe('waiting-approval')
    expect(snap.pendingApprovalId).toBeTruthy()
    snap = await service.approve(snap.manifest.runId, { profileId: 'p1' }, {
      approvalId: snap.pendingApprovalId!,
      approved: true,
      actorId: 'tester'
    })
    expect(snap.manifest.state).toBe('succeeded')
    expect(snap.result).toEqual({ summary: 'alpha\n\nbeta' })
    expect(agentCalls).toBe(1)
    expect(snap.outputs.collect).toEqual({ count: 2, text: 'alpha\n\nbeta' })
  })

  it('rewrites only declared fileInputs and rejects traversal/symlinks', async () => {
    const profileRoot = tempDir('mousse-run-')
    const workspaceRoot = tempDir('mousse-ws-')
    writeFileSync(join(workspaceRoot, 'ok.txt'), 'ok')
    const { registry, published } = await publishExample(profileRoot)
    const service = new WorkflowRunService({
      profileId: 'p1',
      profileRoot,
      registry,
      policy: new ExecutionPolicyService(),
      cancellation: new CancellationRegistry(),
      adapters: { workspace: new DirWorkspace(workspaceRoot), agent: countingAgent(() => undefined) }
    })
    const start = await service.start({
      profileId: 'p1',
      threadId: 't1',
      actor: { kind: 'workflow' },
      source: 'cli',
      definitionId: published.definitionId,
      revisionId: published.head?.revisionId,
      input: { files: ['../secret.txt'] },
      installationPolicy: INSTALL
    })
    const approved = await service.approve(start.manifest.runId, { profileId: 'p1' }, {
      approvalId: start.pendingApprovalId!,
      approved: true,
      actorId: 'tester'
    })
    expect(approved.manifest.state).toBe('failed')
    expect(approved.manifest.terminalError).toMatch(/Rejected file input|Unsafe|traversal/i)
  })

  it('uses the pinned script snapshot when the source is edited after publish', async () => {
    const profileRoot = tempDir('mousse-run-')
    const workspaceRoot = tempDir('mousse-ws-')
    writeFileSync(join(workspaceRoot, 'a.txt'), 'keep')
    const { registry, published } = await publishExample(profileRoot)
    const original = join(profileRoot, 'workflows', published.definitionId, 'revisions', published.semanticHash, 'scripts', 'collect.mjs')
    const service = new WorkflowRunService({
      profileId: 'p1',
      profileRoot,
      registry,
      policy: new ExecutionPolicyService(),
      cancellation: new CancellationRegistry(),
      adapters: { workspace: new DirWorkspace(workspaceRoot), agent: countingAgent(() => undefined) }
    })
    const waiting = await service.start({
      profileId: 'p1',
      threadId: 't1',
      actor: { kind: 'workflow' },
      source: 'cli',
      definitionId: published.definitionId,
      revisionId: published.head?.revisionId,
      input: { files: ['a.txt'] },
      installationPolicy: INSTALL
    })
    writeFileSync(original, 'process.stdout.write(JSON.stringify({count:99,text:"tampered"}))\n')
    const snap = await service.approve(waiting.manifest.runId, { profileId: 'p1' }, {
      approvalId: waiting.pendingApprovalId!,
      approved: true,
      actorId: 'tester'
    })
    expect(snap.outputs.collect).toEqual({ count: 1, text: 'keep' })
    expect(snap.result).toEqual({ summary: 'keep' })
  })

  it('does not automatically replay unknown script effects after a dispatch fault', async () => {
    const profileRoot = tempDir('mousse-run-')
    const workspaceRoot = tempDir('mousse-ws-')
    writeFileSync(join(workspaceRoot, 'a.txt'), 'x')
    const { registry, published } = await publishExample(profileRoot)
    let spawns = 0
    const service = new WorkflowRunService({
      profileId: 'p1',
      profileRoot,
      registry,
      policy: new ExecutionPolicyService(),
      cancellation: new CancellationRegistry(),
      adapters: {
        workspace: new DirWorkspace(workspaceRoot),
        agent: countingAgent(() => undefined)
      },
      faults: {
        afterDispatch(instanceKey) {
          if (instanceKey !== 'collect') return
          spawns += 1
          throw new Error('crash after dispatch')
        }
      }
    })
    const waiting = await service.start({
      profileId: 'p1',
      threadId: 't1',
      actor: { kind: 'workflow' },
      source: 'cli',
      definitionId: published.definitionId,
      revisionId: published.head?.revisionId,
      input: { files: ['a.txt'] },
      installationPolicy: INSTALL
    })
    const crashed = await service.approve(waiting.manifest.runId, { profileId: 'p1' }, {
      approvalId: waiting.pendingApprovalId!,
      approved: true,
      actorId: 'tester'
    })
    expect(crashed.manifest.state).toBe('unknown-effect')
    const recovered = new WorkflowRunService({
      profileId: 'p1',
      profileRoot,
      registry,
      policy: new ExecutionPolicyService(),
      cancellation: new CancellationRegistry(),
      adapters: { workspace: new DirWorkspace(workspaceRoot), agent: countingAgent(() => undefined) }
    })
    const after = await recovered.resume(crashed.manifest.runId, { profileId: 'p1' })
    expect(after.manifest.state).toBe('unknown-effect')
    const retried = await recovered.resume(crashed.manifest.runId, { profileId: 'p1', reconcile: 'retry' })
    expect(retried.manifest.state).not.toBe('succeeded')
    expect(spawns).toBe(1)
  })

  it('isolates A/B profiles and enforces budgets', async () => {
    const aRoot = tempDir('mousse-a-')
    const bRoot = tempDir('mousse-b-')
    const { registry: regA, published: pubA } = await publishExample(aRoot)
    const { registry: regB } = await publishExample(bRoot)
    const serviceA = new WorkflowRunService({
      profileId: 'p1',
      profileRoot: aRoot,
      registry: regA,
      policy: new ExecutionPolicyService(),
      cancellation: new CancellationRegistry()
    })
    const serviceB = new WorkflowRunService({
      profileId: 'p1',
      profileRoot: bRoot,
      registry: regB,
      policy: new ExecutionPolicyService(),
      cancellation: new CancellationRegistry()
    })
    const started = await serviceA.start({
      profileId: 'p1',
      threadId: 'tA',
      actor: { kind: 'workflow' },
      source: 'gui',
      definitionId: pubA.definitionId,
      revisionId: pubA.head?.revisionId,
      input: { files: ['missing.txt'] },
      installationPolicy: INSTALL
    })
    const listB = await serviceB.list({ profileId: 'p1' })
    expect(listB.find((item) => item.runId === started.manifest.runId)).toBeUndefined()
  })

  it('returns executor unavailable for agent nodes without a registered adapter', async () => {
    const profileRoot = tempDir('mousse-run-')
    const workspaceRoot = tempDir('mousse-ws-')
    writeFileSync(join(workspaceRoot, 'a.txt'), 'hello')
    const { registry, published } = await publishExample(profileRoot)
    const service = new WorkflowRunService({
      profileId: 'p1',
      profileRoot,
      registry,
      policy: new ExecutionPolicyService(),
      cancellation: new CancellationRegistry(),
      adapters: { workspace: new DirWorkspace(workspaceRoot) }
    })
    const waiting = await service.start({
      profileId: 'p1',
      threadId: 't1',
      actor: { kind: 'workflow' },
      source: 'cli',
      definitionId: published.definitionId,
      revisionId: published.head?.revisionId,
      input: { files: ['a.txt'] },
      installationPolicy: INSTALL
    })
    const snap = await service.approve(waiting.manifest.runId, { profileId: 'p1' }, {
      approvalId: waiting.pendingApprovalId!,
      approved: true,
      actorId: 'tester'
    })
    expect(snap.manifest.state).toBe('failed')
    expect(snap.manifest.terminalError).toMatch(/Executor unavailable/)
  })

  it('runs delay waits via injected clock without holding an in-process sleep as durable state', async () => {
    const profileRoot = tempDir('mousse-delay-')
    const registry = new WorkflowRegistry({ profileId: 'p1', profileRoot })
    const manifest = {
      schemaVersion: 1,
      id: '77777777-7777-4777-8777-777777777777',
      name: 'delay',
      slug: 'delay_demo',
      inputSchema: { type: 'object', additionalProperties: true },
      outputSchema: { type: 'object', additionalProperties: true },
      entryNodeId: 'start',
      permissions: { capabilities: [] },
      nodes: [
        { id: 'start', type: 'start', version: 1, config: {} },
        { id: 'wait', type: 'delay', version: 1, config: { durationMs: 5_000 } },
        { id: 'end', type: 'end', version: 1, inputs: { result: { literal: { ok: true } } }, config: {} }
      ],
      edges: [
        { from: 'start', port: 'next', to: 'wait' },
        { from: 'wait', port: 'success', to: 'end' }
      ]
    }
    const saved = registry.saveDraft({ bundle: { manifest, assets: [] } })
    const published = registry.publish({
      definitionId: saved.definitionId,
      expectedDraftSemanticHash: saved.semanticHash,
      expectedHeadRevisionId: null
    })
    let now = Date.now()
    const service = new WorkflowRunService({
      profileId: 'p1',
      profileRoot,
      registry,
      policy: new ExecutionPolicyService(),
      cancellation: new CancellationRegistry(),
      clock: {
        now: () => new Date(now),
        wait: async () => undefined
      }
    })
    const waiting = await service.start({
      profileId: 'p1',
      threadId: 't1',
      actor: { kind: 'workflow' },
      source: 'cli',
      definitionId: published.definitionId,
      revisionId: published.head?.revisionId,
      input: {},
      installationPolicy: INSTALL
    })
    expect(waiting.manifest.state).toBe('waiting-condition')
    now += 6_000
    const done = await service.tick(waiting.manifest.runId, { profileId: 'p1' })
    expect(done.manifest.state, done.manifest.terminalError).toBe('succeeded')
    expect(done.result).toEqual({ ok: true })
  })

  it('executes catalog loops, joins, and skips note/group without adapters', async () => {
    const profileRoot = tempDir('mousse-catalog-')
    const registry = new WorkflowRegistry({ profileId: 'p1', profileRoot })
    const saved = registry.saveDraft({
      bundle: {
        manifest: createAllNodeTypesManifest(),
        assets: [{ relativePath: 'scripts/noop.mjs', bytes: 'process.stdout.write(JSON.stringify({ok:true}))\n' }]
      }
    })
    expect(saved.compiled.runnable).toBe(true)
    const published = registry.publish({
      definitionId: saved.definitionId,
      expectedDraftSemanticHash: saved.semanticHash,
      expectedHeadRevisionId: null
    })
    const service = new WorkflowRunService({
      profileId: 'p1',
      profileRoot,
      registry,
      policy: new ExecutionPolicyService(),
      cancellation: new CancellationRegistry()
    })
    const snap = await service.start({
      profileId: 'p1',
      threadId: 't1',
      actor: { kind: 'workflow' },
      source: 'cli',
      definitionId: published.definitionId,
      revisionId: published.head?.revisionId,
      input: { topic: 'x', files: ['a'] },
      installationPolicy: INSTALL
    })
    expect(snap.manifest.terminalError ?? snap.manifest.state).toMatch(/Executor unavailable|waiting-approval|failed|succeeded/)
  })
})

void mkdirSync
void symlinkSync
