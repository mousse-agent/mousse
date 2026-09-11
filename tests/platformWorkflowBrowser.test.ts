import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { MmsWorkflowBrowser } from '../src/mms/platform/MmsWorkflowBrowser'
import type { ExecutionContext, ExecutionPolicySnapshot } from '../src/shared/execution/types'
import type { BrowserWorkflowRequest } from '../src/shared/browser/automation'
import type { StartWorkflowRequest, WorkflowBundle, WorkflowRunManifest, WorkflowRunSnapshot } from '../src/shared/workflows'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    const rel = relative(realpathSync(tmpdir()), realpathSync(root))
    if (isAbsolute(rel) || !rel.startsWith('mousse-workflow-browser-') || rel.includes('..')) throw new Error('Unexpected fixture root')
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

function bundle(node: WorkflowBundle['manifest']['nodes'][number]): WorkflowBundle {
  return {
    assets: [],
    manifest: {
      schemaVersion: 1,
      id: randomUUID(),
      name: 'Browser workflow fixture',
      slug: `browser-${randomUUID().slice(0, 8)}`,
      entryNodeId: 'start',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object', additionalProperties: true },
      permissions: { capabilities: ['browser.session', 'browser.observe', 'browser.action', 'browser.extract', 'browser.task'] },
      nodes: [
        { id: 'start', type: 'start', version: 1, config: {} },
        node,
        { id: 'end', type: 'end', version: 1, config: {}, inputs: { result: { ref: 'node', nodeId: node.id, pointer: '' } } }
      ],
      edges: [
        { from: 'start', port: 'next', to: node.id },
        { from: node.id, port: 'success', to: 'end' }
      ]
    }
  }
}

async function fixture() {
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const root = mkdtempSync(join(tmpdir(), 'mousse-workflow-browser-')); roots.push(root)
  const main = await MousseMainService.create({ homeDir: join(root, 'home'), repoRoot: root, requireOwnership: false, headless: true })
  const profile = main.getInstallationHost()!.manager.create({ displayName: 'Browser', slug: 'browser' })
  const services = await main.getProfileServices(profile.id)
  const thread = services.threads.createThread('Browser workflow')
  const calls: BrowserWorkflowRequest[] = []
  let result: { output: unknown } = { output: { session: { id: 'session-1' } } }
  let snapshot: WorkflowRunSnapshot
  const browser = {
    workflow: {
      invoke: async (request: BrowserWorkflowRequest) => {
        calls.push(request)
        return result
      }
    }
  }
  const helper = new MmsWorkflowBrowser(services, () => browser as never, async () => snapshot)
  const configured = services.settings.get().integrations
  services.settings.set({
    integrations: {
      ...configured,
      tools: { enabled: true, enabledTools: ['browser_open', 'browser_act'] }
    }
  })
  return {
    main, profile, services, thread, calls, helper,
    setResult: (next: { output: unknown }) => { result = next },
    setSnapshot: (next: WorkflowRunSnapshot) => { snapshot = next },
    close: async () => { helper.dispose(); await main.stop() }
  }
}

function publish(f: Awaited<ReturnType<typeof fixture>>, node: WorkflowBundle['manifest']['nodes'][number]) {
  const draft = f.services.platform.workflowDefinitions.saveDraft({ bundle: bundle(node) })
  return f.services.platform.workflowDefinitions.publish({
    definitionId: draft.definitionId,
    expectedDraftSemanticHash: draft.semanticHash,
    expectedHeadRevisionId: null
  })
}

function runFixture(f: Awaited<ReturnType<typeof fixture>>, record: ReturnType<typeof publish>, nodeId: string, nodeType: string, config: Record<string, unknown>) {
  const binding = nodeType === 'browser-action'
    ? { tool: 'browser_act', capability: 'browser.action', effect: 'external' }
    : nodeType === 'browser-observe'
      ? { tool: 'browser_observe', capability: 'browser.observe', effect: 'read' }
      : { tool: 'browser_open', capability: 'browser.session', effect: 'external' }
  const policy = f.services.platform.workflowRuns.policy.snapshot(f.profile.id, {
    allowedTools: ['workflow.browser', binding.tool],
    allowedCapabilities: [binding.capability],
    allowedEffects: [binding.effect],
    approvalEffects: ['external']
  })
  const runId = randomUUID()
  const manifest: WorkflowRunManifest = {
    schemaVersion: 1, runId, requestId: randomUUID(), profileId: f.profile.id, threadId: f.thread.id,
    definitionId: record.definitionId, revisionId: record.head!.revisionId, semanticHash: record.semanticHash,
    slug: record.slug, policySnapshotId: policy.id, cancellationId: randomUUID(),
    actor: { kind: 'workflow', definitionId: record.definitionId, definitionRevision: record.semanticHash },
    source: 'gui', state: 'running', journalSeq: 2, limits: {},
    budgets: { elapsedMs: 0, toolCalls: 1, tokens: 0, cost: 0, artifactBytes: 0, maxElapsedMs: 60_000, maxToolCalls: 20, maxArtifactBytes: 1024 },
    depth: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }
  const idempotencyKey = randomUUID()
  const snapshot: WorkflowRunSnapshot = {
    manifest, compiled: record.compiled, artifacts: [], outputs: {},
    attempts: [{ instanceKey: nodeId, nodeId, type: nodeType, attempt: 1, path: nodeId, inputHash: 'input', effect: 'external', idempotencyKey, outcome: 'unknown', startedAt: manifest.createdAt }]
  }
  const context: ExecutionContext = {
    profileId: manifest.profileId, threadId: manifest.threadId, turnId: runId, runId,
    actor: manifest.actor, source: manifest.source, policySnapshotId: policy.id, cancellationId: manifest.cancellationId
  }
  return { policy, snapshot, context, idempotencyKey, config }
}

describe('production workflow browser binding', () => {
  it('prepares exact enabled tools from a parent and pinned transitive child', async () => {
    const f = await fixture()
    try {
      const child = publish(f, { id: 'act', type: 'browser-action', version: 1, config: {} })
      const parent = publish(f, { id: 'open', type: 'browser-session', version: 1, config: {} })
      parent.compiled.graph.nodes.splice(1, 0, {
        id: 'child', type: 'subworkflow', version: 1, effect: 'pure', config: { workflow: { id: child.definitionId, revision: child.head!.revisionId } }, inputs: {}, subgraphs: {}
      })
      const request: StartWorkflowRequest = {
        requestId: randomUUID(), profileId: f.profile.id, threadId: f.thread.id,
        definitionId: parent.definitionId, revisionId: parent.head!.revisionId,
        actor: { kind: 'workflow', definitionId: parent.definitionId }, source: 'gui', input: {}
      }
      const prepared = f.helper.prepare(request, parent, { allowedTools: ['workflow.node'], allowedCapabilities: [] })
      expect(prepared.allowedTools).toEqual(expect.arrayContaining(['workflow.node', 'workflow.browser', 'browser_open', 'browser_act']))
      expect(prepared.allowedCapabilities).toEqual(expect.arrayContaining(['browser.session', 'browser.action']))

      const configured = f.services.settings.get().integrations
      f.services.settings.set({ integrations: { ...configured, tools: { enabled: true, enabledTools: ['browser_open'] } } })
      expect(() => f.helper.prepare(request, parent, {})).toThrow(/browser_act/)
    } finally { await f.close() }
  })

  it('validates the durable node, removes duplicate effect approval, and fails closed on uncertain actions', async () => {
    const f = await fixture()
    try {
      const open = publish(f, { id: 'open', type: 'browser-session', version: 1, config: {} })
      const active = runFixture(f, open, 'open', 'browser-session', {})
      f.setSnapshot(active.snapshot)
      await expect(f.helper.adapter.invoke({
        context: active.context, policy: active.policy, nodeType: 'browser-session', config: {}, input: {},
        signal: new AbortController().signal, idempotencyKey: active.idempotencyKey
      })).resolves.toEqual({ output: { session: { id: 'session-1' } } })
      expect(f.calls[0].policy).toMatchObject({
        allowedTools: ['browser_open'], allowedCapabilities: ['browser.session'], allowedEffects: ['external']
      })
      expect(f.calls[0].policy.approvalEffects).not.toContain('external')
      expect(f.calls[0].context.policySnapshotId).toBe(f.calls[0].policy.id)

      const missingExactTool = f.services.platform.workflowRuns.policy.snapshot(f.profile.id, {
        allowedTools: ['workflow.browser'], allowedCapabilities: ['browser.session'], allowedEffects: ['external']
      })
      f.setSnapshot({ ...active.snapshot, manifest: { ...active.snapshot.manifest, policySnapshotId: missingExactTool.id } })
      await expect(f.helper.adapter.invoke({
        context: { ...active.context, policySnapshotId: missingExactTool.id }, policy: missingExactTool,
        nodeType: 'browser-session', config: {}, input: {}, signal: new AbortController().signal,
        idempotencyKey: active.idempotencyKey
      })).rejects.toMatchObject({ code: 'capability_denied' })
      f.setSnapshot(active.snapshot)

      const configured = f.services.settings.get().integrations
      f.services.settings.set({ integrations: { ...configured, tools: { enabled: true, enabledTools: ['browser_act'] } } })
      await expect(f.helper.adapter.invoke({
        context: active.context, policy: active.policy, nodeType: 'browser-session', config: {}, input: {},
        signal: new AbortController().signal, idempotencyKey: active.idempotencyKey
      })).rejects.toMatchObject({ code: 'capability_denied' })
      expect(f.calls).toHaveLength(1)
      f.services.settings.set({ integrations: { ...configured, tools: { enabled: true, enabledTools: ['browser_open', 'browser_act'] } } })

      await expect(f.helper.adapter.invoke({
        context: active.context, policy: active.policy, nodeType: 'browser-session', config: { forged: true }, input: {},
        signal: new AbortController().signal, idempotencyKey: active.idempotencyKey
      })).rejects.toMatchObject({ code: 'capability_denied' })

      f.setSnapshot({ ...active.snapshot, attempts: [{ ...active.snapshot.attempts[0], completedAt: new Date().toISOString() }] })
      await expect(f.helper.adapter.invoke({
        context: active.context, policy: active.policy, nodeType: 'browser-session', config: {}, input: {},
        signal: new AbortController().signal, idempotencyKey: active.idempotencyKey
      })).rejects.toMatchObject({ code: 'capability_denied' })

      const action = publish(f, { id: 'act', type: 'browser-action', version: 1, config: {} })
      const uncertain = runFixture(f, action, 'act', 'browser-action', {})
      f.setSnapshot(uncertain.snapshot)
      f.setResult({ output: { action: { outcome: 'unknown-effect', dispatched: true, message: 'ack lost' } } })
      await expect(f.helper.adapter.invoke({
        context: uncertain.context, policy: uncertain.policy, nodeType: 'browser-action', config: {}, input: {},
        signal: new AbortController().signal, idempotencyKey: uncertain.idempotencyKey
      })).rejects.toMatchObject({ code: 'unknown_effect' })
    } finally { await f.close() }
  })

  it('accepts a read-only observe policy and rejects an external action under that ceiling', async () => {
    const f = await fixture()
    try {
      const configured = f.services.settings.get().integrations
      f.services.settings.set({ integrations: { ...configured, tools: { enabled: true, enabledTools: ['browser_observe', 'browser_act'] } } })
      const observe = publish(f, { id: 'observe', type: 'browser-observe', version: 1, config: {} })
      const readonly = runFixture(f, observe, 'observe', 'browser-observe', {})
      f.setSnapshot(readonly.snapshot)
      f.setResult({ output: { observation: { observationId: 'observation-1' } } })
      await expect(f.helper.adapter.invoke({
        context: readonly.context, policy: readonly.policy, nodeType: 'browser-observe', config: {}, input: {},
        signal: new AbortController().signal, idempotencyKey: readonly.idempotencyKey
      })).resolves.toMatchObject({ output: { observation: { observationId: 'observation-1' } } })
      expect(f.calls.at(-1)?.policy).toMatchObject({ allowedTools: ['browser_observe'], allowedEffects: ['read'] })

      const action = publish(f, { id: 'act', type: 'browser-action', version: 1, config: {} })
      const external = runFixture(f, action, 'act', 'browser-action', {})
      const forgedReadonly = f.services.platform.workflowRuns.policy.snapshot(f.profile.id, {
        allowedTools: ['workflow.browser', 'browser_act'], allowedCapabilities: ['browser.action'], allowedEffects: ['read']
      })
      f.setSnapshot({ ...external.snapshot, manifest: { ...external.snapshot.manifest, policySnapshotId: forgedReadonly.id } })
      await expect(f.helper.adapter.invoke({
        context: { ...external.context, policySnapshotId: forgedReadonly.id }, policy: forgedReadonly,
        nodeType: 'browser-action', config: {}, input: {}, signal: new AbortController().signal,
        idempotencyKey: external.idempotencyKey
      })).rejects.toMatchObject({ code: 'capability_denied' })
      expect(f.calls).toHaveLength(1)
    } finally { await f.close() }
  })
})
