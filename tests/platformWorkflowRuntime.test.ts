import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

    let linkedInput = 'linked.txt'
    try {
      symlinkSync(join(workspaceRoot, 'ok.txt'), join(workspaceRoot, 'linked.txt'))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'ENOTSUP') throw error
      const outsideRoot = tempDir('mousse-ws-outside-')
      writeFileSync(join(outsideRoot, 'secret.txt'), 'secret')
      symlinkSync(outsideRoot, join(workspaceRoot, 'escaped'), 'junction')
      linkedInput = 'escaped/secret.txt'
    }
    const linked = await service.start({
      profileId: 'p1', threadId: 't2', actor: { kind: 'workflow' }, source: 'cli',
      definitionId: published.definitionId, revisionId: published.head?.revisionId,
      input: { files: [linkedInput] }, installationPolicy: INSTALL
    })
    const rejectedLink = await service.approve(linked.manifest.runId, { profileId: 'p1' }, {
      approvalId: linked.pendingApprovalId!, approved: true, actorId: 'tester'
    })
    expect(rejectedLink.manifest.state).toBe('failed')
    expect(rejectedLink.manifest.terminalError).toMatch(/symlink/i)
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

  it('cancels a running script while its run lease is held', async () => {
    const profileRoot = tempDir('mousse-runtime-cancel-')
    const registry = new WorkflowRegistry({ profileId: 'p1', profileRoot })
    const manifest = {
      schemaVersion: 1, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'runtime cancel', slug: 'runtime_cancel', entryNodeId: 'start',
      inputSchema: { type: 'object', additionalProperties: true }, outputSchema: { type: 'object', additionalProperties: true }, permissions: { capabilities: ['script.trusted-local'] },
      nodes: [
        { id: 'start', type: 'start', version: 1, config: {} },
        { id: 'script', type: 'script', version: 1, config: { runtime: 'node', file: 'scripts/wait.mjs', executionMode: 'trusted-local', timeoutMs: 20_000 } },
        { id: 'end', type: 'end', version: 1, inputs: { result: { ref: 'node', nodeId: 'script', pointer: '' } }, config: {} }
      ],
      edges: [{ from: 'start', port: 'next', to: 'script' }, { from: 'script', port: 'success', to: 'end' }]
    }
    const saved = registry.saveDraft({ bundle: { manifest: manifest as never, assets: [{ relativePath: 'scripts/wait.mjs', bytes: 'await new Promise(r => setTimeout(r, 30000)); process.stdout.write("{}")\n' }] } })
    const published = registry.publish({ definitionId: saved.definitionId, expectedDraftSemanticHash: saved.semanticHash, expectedHeadRevisionId: null })
    const service = new WorkflowRunService({ profileId: 'p1', profileRoot, registry, policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry() })
    const waiting = await service.start({ profileId: 'p1', threadId: 't1', actor: { kind: 'workflow' }, source: 'cli', definitionId: published.definitionId, revisionId: published.head?.revisionId, input: {}, installationPolicy: INSTALL })
    const running = service.approve(waiting.manifest.runId, { profileId: 'p1' }, { approvalId: waiting.pendingApprovalId!, approved: true, actorId: 'tester' })
    await new Promise((resolve) => setTimeout(resolve, 150))
    const cancelled = await service.cancel(waiting.manifest.runId, { profileId: 'p1' }, 'test cancellation')
    expect(cancelled.manifest.state).toBe('cancelled')
    expect((await running).manifest.state).toBe('cancelled')
  })

  it('recovers after a durable checkpoint fault without reusing journal sequence numbers', async () => {
    const profileRoot = tempDir('mousse-ack-fault-')
    const registry = new WorkflowRegistry({ profileId: 'p1', profileRoot })
    const manifest = {
      schemaVersion: 1, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'ack fault', slug: 'ack_fault', entryNodeId: 'start',
      inputSchema: { type: 'object', additionalProperties: true }, outputSchema: { type: 'object', additionalProperties: true }, permissions: { capabilities: [] },
      nodes: [
        { id: 'start', type: 'start', version: 1, config: {} },
        { id: 'value', type: 'transform', version: 1, config: { value: { literal: { ok: true } } } },
        { id: 'end', type: 'end', version: 1, inputs: { result: { ref: 'node', nodeId: 'value', pointer: '' } }, config: {} }
      ],
      edges: [{ from: 'start', port: 'next', to: 'value' }, { from: 'value', port: 'success', to: 'end' }]
    }
    const saved = registry.saveDraft({ bundle: { manifest: manifest as never, assets: [] } })
    const published = registry.publish({ definitionId: saved.definitionId, expectedDraftSemanticHash: saved.semanticHash, expectedHeadRevisionId: null })
    let faulted = false
    const crashing = new WorkflowRunService({
      profileId: 'p1', profileRoot, registry, policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry(),
      faults: { afterCheckpoint() { if (!faulted) { faulted = true; throw new Error('crash after checkpoint') } } }
    })
    await expect(crashing.start({ profileId: 'p1', threadId: 't1', actor: { kind: 'workflow' }, source: 'cli', definitionId: published.definitionId, revisionId: published.head?.revisionId, input: {}, installationPolicy: INSTALL })).rejects.toThrow(/crash after checkpoint/)
    const [runId] = readdirSync(join(profileRoot, 'workflow-runs'))
    const recovered = new WorkflowRunService({ profileId: 'p1', profileRoot, registry, policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry() })
    const snap = await recovered.resume(runId!, { profileId: 'p1' })
    expect(snap.manifest.state, snap.manifest.terminalError).toBe('succeeded')
    expect(snap.result).toEqual({ ok: true })
    const seqs = (await recovered.trace(runId!, { profileId: 'p1' })).events.map((event) => event.seq)
    expect(seqs).toEqual([...new Set(seqs)].sort((a, b) => a - b))
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

  it('executes a real condition branch and for-each body with loop bindings', async () => {
    const profileRoot = tempDir('mousse-loop-')
    const registry = new WorkflowRegistry({ profileId: 'p1', profileRoot })
    const manifest = {
      schemaVersion: 1,
      id: '88888888-8888-4888-8888-888888888888',
      name: 'loop semantics', slug: 'loop_semantics', entryNodeId: 'start',
      inputSchema: { type: 'object', additionalProperties: true },
      outputSchema: { type: 'array', items: { type: 'number' }, maxItems: 10 },
      permissions: { capabilities: [] },
      nodes: [
        { id: 'start', type: 'start', version: 1, config: {} },
        { id: 'choose', type: 'condition', version: 1, config: { expression: { op: 'eq', args: [{ literal: 1 }, { literal: 1 }] } } },
        { id: 'each', type: 'for-each', version: 1, config: {
          items: { literal: [1, 2, 3] }, maxIterations: 3, maxDurationMs: 1000, failPolicy: 'fail-fast',
          subgraph: {
            entryNodeId: 'item',
            nodes: [
              { id: 'item', type: 'transform', version: 1, config: { value: { ref: 'item' } } },
              { id: 'item-end', type: 'end', version: 1, inputs: { result: { ref: 'node', nodeId: 'item', pointer: '' } }, config: {} }
            ],
            edges: [{ from: 'item', port: 'success', to: 'item-end' }]
          }
        } },
        { id: 'bad', type: 'fail', version: 1, config: { message: 'wrong branch' } },
        { id: 'end', type: 'end', version: 1, inputs: { result: { ref: 'node', nodeId: 'each', pointer: '/results' } }, config: {} }
      ],
      edges: [
        { from: 'start', port: 'next', to: 'choose' },
        { from: 'choose', port: 'true', to: 'each' },
        { from: 'choose', port: 'false', to: 'bad' },
        { from: 'each', port: 'completed', to: 'end' }
      ]
    }
    const saved = registry.saveDraft({ bundle: { manifest: manifest as never, assets: [] } })
    expect(saved.compiled.runnable, saved.compiled.diagnostics).toBe(true)
    const published = registry.publish({ definitionId: saved.definitionId, expectedDraftSemanticHash: saved.semanticHash, expectedHeadRevisionId: null })
    const service = new WorkflowRunService({ profileId: 'p1', profileRoot, registry, policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry() })
    const snap = await service.start({ profileId: 'p1', threadId: 't1', actor: { kind: 'workflow' }, source: 'cli', definitionId: published.definitionId, revisionId: published.head?.revisionId, input: {}, installationPolicy: INSTALL })
    expect(snap.manifest.state, snap.manifest.terminalError).toBe('succeeded')
    expect(snap.result).toEqual([1, 2, 3])
    expect(snap.outputs.bad).toBeUndefined()
  })

  it('executes all parallel branches before join and returns deterministic branch order', async () => {
    const profileRoot = tempDir('mousse-parallel-')
    const registry = new WorkflowRegistry({ profileId: 'p1', profileRoot })
    const leaf = (id: string, value: string) => ({
      entryNodeId: `${id}-value`,
      nodes: [
        { id: `${id}-value`, type: 'transform', version: 1, config: { value: { literal: value } } },
        { id: `${id}-end`, type: 'end', version: 1, inputs: { result: { ref: 'node', nodeId: `${id}-value`, pointer: '' } }, config: {} }
      ],
      edges: [{ from: `${id}-value`, port: 'success', to: `${id}-end` }]
    })
    const manifest = {
      schemaVersion: 1, id: '99999999-9999-4999-8999-999999999999', name: 'parallel semantics', slug: 'parallel_semantics', entryNodeId: 'start',
      inputSchema: { type: 'object', additionalProperties: true }, outputSchema: { type: 'object', additionalProperties: true }, permissions: { capabilities: [] },
      nodes: [
        { id: 'start', type: 'start', version: 1, config: {} },
        { id: 'parallel', type: 'parallel', version: 1, config: { maxConcurrency: 2, branches: [{ id: 'z', subgraph: leaf('z', 'last') }, { id: 'a', subgraph: leaf('a', 'first') }] } },
        { id: 'join', type: 'join', version: 1, config: { parallelNodeId: 'parallel', policy: 'all-success' } },
        { id: 'end', type: 'end', version: 1, inputs: { result: { ref: 'node', nodeId: 'join', pointer: '' } }, config: {} }
      ],
      edges: [{ from: 'start', port: 'next', to: 'parallel' }, { from: 'parallel', port: 'success', to: 'join' }, { from: 'join', port: 'success', to: 'end' }]
    }
    const saved = registry.saveDraft({ bundle: { manifest: manifest as never, assets: [] } })
    expect(saved.compiled.runnable, saved.compiled.diagnostics).toBe(true)
    const published = registry.publish({ definitionId: saved.definitionId, expectedDraftSemanticHash: saved.semanticHash, expectedHeadRevisionId: null })
    const service = new WorkflowRunService({ profileId: 'p1', profileRoot, registry, policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry() })
    const snap = await service.start({ profileId: 'p1', threadId: 't1', actor: { kind: 'workflow' }, source: 'cli', definitionId: published.definitionId, revisionId: published.head?.revisionId, input: {}, installationPolicy: INSTALL })
    expect(snap.manifest.state, snap.manifest.terminalError).toBe('succeeded')
    expect(snap.result).toEqual({ results: [{ id: 'a', ok: true, output: 'first' }, { id: 'z', ok: true, output: 'last' }] })
  })

  it('does not let a manifest downgrade artifact effects and enforces bytes before writing', async () => {
    const profileRoot = tempDir('mousse-artifact-policy-')
    const registry = new WorkflowRegistry({ profileId: 'p1', profileRoot })
    const manifest = {
      schemaVersion: 1, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'artifact policy', slug: 'artifact_policy', entryNodeId: 'start',
      inputSchema: { type: 'object', additionalProperties: true }, outputSchema: { type: 'object', additionalProperties: true }, permissions: { capabilities: ['artifact.write'] },
      nodes: [
        { id: 'start', type: 'start', version: 1, config: {} },
        { id: 'artifact', type: 'write-artifact', version: 1, effect: 'pure', config: { name: 'out.json', content: { literal: { secret: 'value' } } } },
        { id: 'end', type: 'end', version: 1, inputs: { result: { ref: 'node', nodeId: 'artifact', pointer: '' } }, config: {} }
      ],
      edges: [{ from: 'start', port: 'next', to: 'artifact' }, { from: 'artifact', port: 'success', to: 'end' }]
    }
    const saved = registry.saveDraft({ bundle: { manifest: manifest as never, assets: [] } })
    const published = registry.publish({ definitionId: saved.definitionId, expectedDraftSemanticHash: saved.semanticHash, expectedHeadRevisionId: null })
    const service = new WorkflowRunService({ profileId: 'p1', profileRoot, registry, policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry() })
    const denied = await service.start({
      profileId: 'p1', threadId: 't1', actor: { kind: 'workflow' }, source: 'cli', definitionId: published.definitionId,
      revisionId: published.head?.revisionId, input: {},
      installationPolicy: { allowedTools: ['workflow.node'], allowedCapabilities: ['artifact.write'], allowedEffects: ['pure'] }
    })
    expect(denied.manifest.terminalError).toBe('denied:effect_denied')
    const stillDenied = await service.resume(denied.manifest.runId, { profileId: 'p1' })
    expect(stillDenied.manifest.state).toBe('failed')
    expect(stillDenied.manifest.terminalError).toBe('denied:effect_denied')

    const bounded = await service.start({
      profileId: 'p1', threadId: 't2', actor: { kind: 'workflow' }, source: 'cli', definitionId: published.definitionId,
      revisionId: published.head?.revisionId, input: {},
      installationPolicy: { allowedTools: ['workflow.node'], allowedCapabilities: ['artifact.write'], allowedEffects: ['pure', 'write'], maxArtifactBytes: 1 }
    })
    expect(bounded.manifest.terminalError).toBe('artifact byte budget exceeded')
    expect(readdirSync(join(profileRoot, 'artifacts'))).toEqual([])
  })

  it('admits a queued run without blocking and preserves the verified draft hash', async () => {
    const profileRoot = tempDir('mousse-admit-')
    const registry = new WorkflowRegistry({ profileId: 'p1', profileRoot })
    const manifest = {
      schemaVersion: 1,
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      name: 'draft admission',
      slug: 'draft_admission',
      entryNodeId: 'start',
      inputSchema: { type: 'object', additionalProperties: true },
      outputSchema: { type: 'object', additionalProperties: true },
      permissions: { capabilities: [] },
      nodes: [
        { id: 'start', type: 'start', version: 1, config: {} },
        { id: 'end', type: 'end', version: 1, inputs: { result: { literal: { admitted: true } } }, config: {} }
      ],
      edges: [{ from: 'start', port: 'next', to: 'end' }]
    }
    const saved = registry.saveDraft({ bundle: { manifest: manifest as never, assets: [] } })
    const service = new WorkflowRunService({
      profileId: 'p1', profileRoot, registry, policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry()
    })
    const queued = await service.admit({
      profileId: 'p1', threadId: 't1', actor: { kind: 'workflow' }, source: 'cli', definitionId: saved.definitionId,
      expectedDraftSemanticHash: saved.semanticHash, input: {}, installationPolicy: INSTALL
    })
    expect(queued.manifest.state).toBe('queued')
    expect(queued.manifest.draftSemanticHash).toBe(saved.semanticHash)
    const done = await service.get(queued.manifest.runId, { profileId: 'p1' })
    expect(done.manifest.semanticHash).toBe(saved.semanticHash)
    await service.shutdown()
  })

  it('resumes a nested ask-user cursor from the durable parent checkpoint', async () => {
    const profileRoot = tempDir('mousse-nested-input-')
    const registry = new WorkflowRegistry({ profileId: 'p1', profileRoot })
    const manifest = {
      schemaVersion: 1, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'nested input', slug: 'nested_input', entryNodeId: 'start',
      inputSchema: { type: 'object', additionalProperties: true }, outputSchema: { type: 'object', additionalProperties: true },
      permissions: { capabilities: ['human.input'] },
      nodes: [
        { id: 'start', type: 'start', version: 1, config: {} },
        { id: 'each', type: 'for-each', version: 1, config: {
          items: { literal: ['one'] }, maxIterations: 1, subgraph: {
            entryNodeId: 'ask', nodes: [
              { id: 'ask', type: 'ask-user', version: 1, config: { prompt: 'value', answerSchema: { type: 'string' } } },
              { id: 'body-end', type: 'end', version: 1, inputs: { result: { ref: 'node', nodeId: 'ask', pointer: '' } }, config: {} }
            ], edges: [{ from: 'ask', port: 'success', to: 'body-end' }]
          }
        } },
        { id: 'end', type: 'end', version: 1, inputs: { result: { ref: 'node', nodeId: 'each', pointer: '' } }, config: {} }
      ],
      edges: [{ from: 'start', port: 'next', to: 'each' }, { from: 'each', port: 'completed', to: 'end' }]
    }
    const saved = registry.saveDraft({ bundle: { manifest: manifest as never, assets: [] } })
    const published = registry.publish({ definitionId: saved.definitionId, expectedDraftSemanticHash: saved.semanticHash, expectedHeadRevisionId: null })
    const service = new WorkflowRunService({ profileId: 'p1', profileRoot, registry, policy: new ExecutionPolicyService(), cancellation: new CancellationRegistry() })
    const waiting = await service.start({ profileId: 'p1', threadId: 't1', actor: { kind: 'workflow' }, source: 'cli', definitionId: published.definitionId, revisionId: published.head?.revisionId, input: {}, installationPolicy: INSTALL })
    expect(waiting.manifest.state).toBe('waiting-input')
    expect(waiting.pendingInput?.instanceKey).toContain('ask')
    const done = await service.answer(waiting.manifest.runId, { profileId: 'p1' }, { instanceKey: waiting.pendingInput!.instanceKey, data: 'answered' })
    expect(done.manifest.state, done.manifest.terminalError).toBe('succeeded')
    expect(done.result).toEqual({ results: ['answered'] })
  })
})

void mkdirSync
void symlinkSync
