import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { MmsWorkflowAgents } from '../src/mms/platform/MmsWorkflowAgents'
import { defaultAgentSettings } from '../src/shared/agents/defaults'
import type { ExecutionActor, ExecutionContext, ExecutionPolicyLayer, ExecutionPolicySnapshot } from '../src/shared/execution/types'
import type { StartWorkflowRequest, WorkflowBundle, WorkflowRunManifest } from '../src/shared/workflows'
import { WORKFLOW_MAIN_AGENT_DEFINITION_ID } from '../src/shared/workflows/agentExecutionBindings'
import { providerResponse, streamOf } from './fixtures/agent-platform/agent-runtime-policy/helpers'

const roots: string[] = []
const previousHome = process.env.MOUSSE_HOME
afterEach(() => {
  vi.restoreAllMocks()
  if (previousHome === undefined) delete process.env.MOUSSE_HOME
  else process.env.MOUSSE_HOME = previousHome
  for (const root of roots.splice(0)) {
    const rel = relative(realpathSync(tmpdir()), realpathSync(root))
    if (isAbsolute(rel) || !rel.startsWith('mousse-workflow-agents-') || rel.includes('..')) throw new Error('Unexpected fixture root')
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

async function fixture() {
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const root = mkdtempSync(join(tmpdir(), 'mousse-workflow-agents-')); roots.push(root)
  const homeDir = join(root, 'home')
  const main = await MousseMainService.create({ homeDir, repoRoot: root, requireOwnership: false, headless: true })
  const host = main.getInstallationHost()!
  const alice = host.manager.create({ displayName: 'Alice', slug: 'alice' })
  const bob = host.manager.create({ displayName: 'Bob', slug: 'bob' })
  const services = await main.getProfileServices(alice.id)
  const captured: Context[] = []
  const outputs: AssistantMessage[] = []
  const provider = services.providerAuth.models.getProviders().find((entry) => services.providerAuth.models.getModels(entry.id).length > 0)!
  const model = services.providerAuth.models.getModels(provider.id)[0]
  const modelRef = { providerId: provider.id, modelId: model.id }
  vi.spyOn(services.providerAuth, 'has').mockReturnValue(true)
  vi.spyOn(services.providerAuth.models, 'getAuth').mockResolvedValue({ apiKey: 'fixture' } as never)
  vi.spyOn(services.providerAuth.models, 'streamSimple').mockImplementation((_model, context) => {
    captured.push(structuredClone(context))
    const next = outputs.shift()
    if (!next) throw new Error('fixture provider exhausted')
    return streamOf(next) as never
  })
  const integrations = services.settings.get().integrations
  services.settings.set({
    provider: { llmProvider: modelRef.providerId, model: modelRef.modelId },
    integrations: { ...integrations, tools: { enabled: true, enabledTools: ['read', 'write', 'ask_user', 'create_task'] } }
  })
  const thread = services.threads.createThread('Workflow agent fixture')
  let manifestOverride: WorkflowRunManifest | undefined
  const agents = new MmsWorkflowAgents(services, async (context) => {
    if (manifestOverride) return manifestOverride
    return (await services.platform.workflowRuns.runtime.get(context.runId!, { profileId: context.profileId })).manifest
  })
  services.platform.workflowRuns.configureAdapters({ agent: agents.agent })
  return {
    root, main, alice, bob, services, captured, outputs, modelRef, thread, agents,
    setManifest: (manifest: WorkflowRunManifest | undefined) => { manifestOverride = manifest },
    close: async () => { agents.dispose(); await main.stop() }
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

function agentSettings(name: string, modelRef: { providerId: string; modelId: string }, allowlist = ['read', 'write']) {
  const value = defaultAgentSettings({ name, slug: name.toLowerCase().replaceAll(' ', '-') + '-' + randomUUID().slice(0, 8) })
  value.primaryModel.ref = modelRef
  value.context.includeProjectInstructions = false
  value.context.includeCurrentThread = false
  value.context.selectedFiles = []
  value.context.attachmentPolicy = 'none'
  value.context.sources = []
  value.tools = { mode: 'explicit', allowlist }
  value.approval.policy = 'inherit'
  value.recovery.retryCount = 0
  value.memory.scope = 'thread'
  return value
}

function workflowBundle(node: WorkflowBundle['manifest']['nodes'][number]): WorkflowBundle {
  return {
    assets: [],
    manifest: {
      schemaVersion: 1,
      id: randomUUID(),
      name: 'Agent adapter fixture',
      slug: 'agent-adapter-' + randomUUID().slice(0, 8),
      entryNodeId: 'start',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object', additionalProperties: true },
      permissions: { capabilities: ['model.invoke'] },
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

function publishWorkflow(f: Fixture, node: WorkflowBundle['manifest']['nodes'][number]) {
  const saved = f.services.platform.workflowDefinitions.saveDraft({ bundle: workflowBundle(node) })
  return f.services.platform.workflowDefinitions.publish({
    definitionId: saved.definitionId,
    expectedDraftSemanticHash: saved.semanticHash,
    expectedHeadRevisionId: null
  })
}

function startRequest(f: Fixture, record: ReturnType<typeof publishWorkflow>, extra: Partial<StartWorkflowRequest> = {}): StartWorkflowRequest {
  return {
    profileId: f.alice.id,
    threadId: f.thread.id,
    requestId: randomUUID(),
    definitionId: record.definitionId,
    revisionId: record.head!.revisionId,
    actor: { kind: 'workflow', definitionId: record.definitionId, definitionRevision: record.semanticHash },
    source: 'gui',
    input: {},
    installationPolicy: {
      allowedTools: ['workflow.node', 'workflow.agent'],
      allowedCapabilities: ['model.invoke'],
      allowedEffects: ['pure', 'read', 'write', 'external', 'unknown']
    },
    ...extra
  }
}

function policyOf(f: Fixture, extra: ExecutionPolicyLayer = {}): ExecutionPolicySnapshot {
  return f.services.platform.workflowRuns.policy.snapshot(f.alice.id, {
    allowedTools: ['workflow.node', 'workflow.agent', 'read', 'write'],
    allowedCapabilities: ['model.invoke', 'human.input'],
    allowedEffects: ['pure', 'read', 'write', 'external', 'unknown'],
    ...extra
  })
}

function runningManifest(f: Fixture, request: StartWorkflowRequest, policy: ExecutionPolicySnapshot, runId = randomUUID()): WorkflowRunManifest {
  const actor: ExecutionActor = request.actor
  return {
    schemaVersion: 1,
    runId,
    requestId: request.requestId,
    profileId: request.profileId,
    threadId: request.threadId,
    projectId: request.projectId,
    definitionId: request.definitionId!,
    revisionId: request.revisionId!,
    semanticHash: request.revisionId!,
    slug: 'agent-adapter-fixture',
    policySnapshotId: policy.id,
    cancellationId: randomUUID(),
    actor,
    source: request.source,
    state: 'running',
    journalSeq: 1,
    limits: {},
    budgets: { elapsedMs: 0, toolCalls: 0, tokens: 0, cost: 0, artifactBytes: 0, maxElapsedMs: 30 * 60_000, maxToolCalls: 100, maxArtifactBytes: 50 * 1024 * 1024 },
    depth: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
}

function contextOf(manifest: WorkflowRunManifest): ExecutionContext {
  return {
    profileId: manifest.profileId,
    projectId: manifest.projectId,
    threadId: manifest.threadId,
    turnId: manifest.runId,
    runId: manifest.runId,
    actor: manifest.actor,
    source: manifest.source,
    policySnapshotId: manifest.policySnapshotId,
    cancellationId: manifest.cancellationId
  }
}

async function waitState(f: Fixture, runId: string, expected: string) {
  let snapshot = await f.services.platform.workflowRuns.runtime.get(runId, { profileId: f.alice.id })
  await vi.waitFor(async () => {
    snapshot = await f.services.platform.workflowRuns.runtime.get(runId, { profileId: f.alice.id })
    if (snapshot.manifest.state === 'failed' && expected !== 'failed') throw new Error(snapshot.manifest.terminalError ?? 'failed')
    expect(snapshot.manifest.state).toBe(expected)
  }, { timeout: 15_000, interval: 25 })
  return snapshot
}

describe('production workflow Agent/Instruction adapter', () => {
  it('uses automatic profile composition to admit an instruction into a new owned thread', async () => {
    const f = await fixture()
    try {
      f.services.platform.workflowRuns.configureAdapters({ agent: f.services.platform.workflowAgents.agent })
      f.outputs.push(providerResponse([{ type: 'text', text: '{"summary":"production-composed"}' }], 'stop'))
      const record = publishWorkflow(f, { id: 'instruction', type: 'instruction', version: 1, config: { text: 'Return a summary object.' } })
      const request = { profileId: f.alice.id, definitionId: record.definitionId, requestId: randomUUID(), input: {} }
      const started = await f.services.platform.workflowRuns.start(request, { source: 'gui', connectionId: 'owned-window' })
      const done = await waitState(f, started.manifest.runId, 'succeeded')
      expect(done.result).toEqual({ summary: 'production-composed' })
      expect(done.manifest.executionBindings?.agents?.pins).toHaveLength(1)
      expect(f.services.threads.getThread(done.manifest.threadId)).toBeTruthy()
      expect((await f.services.platform.workflowRuns.start(request, { source: 'gui', connectionId: 'owned-window' })).manifest.runId).toBe(done.manifest.runId)
      expect(f.captured).toHaveLength(1)
    } finally { await f.close() }
  }, 30_000)

  it('executes an instruction node through the native loop and returns real output/usage', async () => {
    const f = await fixture()
    try {
      f.outputs.push(providerResponse([{ type: 'text', text: '{"summary":"instruction-ok"}' }], 'stop', 9, 0.02))
      const record = publishWorkflow(f, { id: 'instruction', type: 'instruction', version: 1, config: { text: 'Return a summary object.' } })
      const request = startRequest(f, record)
      await f.agents.prepare(request, record)
      const started = await f.services.platform.workflowRuns.start({
        profileId: f.alice.id, definitionId: record.definitionId, requestId: request.requestId!, input: {}, threadId: f.thread.id
      }, { source: 'gui', connectionId: 'owned-window' })
      const snapshot = await waitState(f, started.manifest.runId, 'succeeded')
      expect(snapshot.result).toEqual({ summary: 'instruction-ok' })
      expect(snapshot.manifest.budgets.tokens).toBeGreaterThan(0)
      expect(JSON.stringify(f.captured[0])).toContain('Return a summary object.')
      expect(f.captured).toHaveLength(1)
    } finally { await f.close() }
  }, 30_000)

  it('pins a user agent revision and ignores later draft/head mutation', async () => {
    const f = await fixture()
    try {
      f.outputs.push(providerResponse([{ type: 'text', text: '{"summary":"user-ok"}' }], 'stop'))
      const created = f.services.platform.agentDefinitions.createDraft({
        settings: agentSettings('Pinned Workflow Agent', f.modelRef),
        systemPrompt: 'PINNED_SYSTEM'
      })
      const published = f.services.platform.agentDefinitions.publish(created.id, created.draftHash)
      const record = publishWorkflow(f, {
        id: 'agent',
        type: 'agent',
        version: 1,
        config: {
          agent: { kind: 'user', definitionId: created.id },
          instructions: 'Return { summary: "user-ok" }',
          outputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] }
        }
      })
      const request = startRequest(f, record)
      const prepared = await f.agents.prepare(request, record)
      expect(prepared.bindings.pins[0]).toMatchObject({
        kind: 'user', definitionId: created.id, revision: published.revision, runtimeKind: 'mousse'
      })
      expect(prepared.installationPolicy.allowedTools).toEqual(expect.arrayContaining(['workflow.agent', 'read', 'write']))
      f.services.platform.agentDefinitions.saveDraft(created.id, {
        expectedDraftHash: created.draftHash,
        settings: agentSettings('Pinned Workflow Agent', f.modelRef),
        systemPrompt: 'CHANGED_DRAFT'
      })
      const changed = f.services.platform.agentDefinitions.get(created.id)
      f.services.platform.agentDefinitions.publish(created.id, changed.draftHash)
      const started = await f.services.platform.workflowRuns.start({
        profileId: f.alice.id, definitionId: record.definitionId, requestId: request.requestId!, input: {}, threadId: f.thread.id
      }, { source: 'gui', connectionId: 'owned-window' })
      const snapshot = await waitState(f, started.manifest.runId, 'succeeded')
      expect(snapshot.result).toEqual({ summary: 'user-ok' })
      expect(JSON.stringify(f.captured[0])).toContain('PINNED_SYSTEM')
      expect(JSON.stringify(f.captured[0])).not.toContain('CHANGED_DRAFT')
    } finally { await f.close() }
  }, 30_000)

  it('denies forged or isolated execution context and a foreign profile', async () => {
    const f = await fixture()
    try {
      const record = publishWorkflow(f, { id: 'instruction', type: 'instruction', version: 1, config: { text: 'Stay isolated.' } })
      const request = startRequest(f, record)
      await f.agents.prepare(request, record)
      const policy = policyOf(f)
      const manifest = runningManifest(f, request, policy)
      f.setManifest(manifest)
      const context = contextOf(manifest)
      const invoke = {
        policy, agent: { kind: 'main' as const }, instructions: 'Stay isolated.', input: {}, signal: new AbortController().signal, idempotencyKey: randomUUID()
      }
      await expect(f.agents.agent.invoke({ ...invoke, context: { ...context, threadId: randomUUID() } })).rejects.toMatchObject({ code: 'thread_unavailable' })
      await expect(f.agents.agent.invoke({ ...invoke, context: { ...context, turnId: randomUUID() } })).rejects.toMatchObject({ code: 'profile_mismatch' })
      await expect(f.agents.agent.invoke({ ...invoke, context: { ...context, profileId: f.bob.id } })).rejects.toMatchObject({ code: 'profile_mismatch' })
      f.setManifest({ ...manifest, state: 'waiting-approval' })
      await expect(f.agents.agent.invoke({ ...invoke, context })).rejects.toMatchObject({ code: 'capability_denied' })
      expect(f.captured).toEqual([])
    } finally { await f.close() }
  }, 30_000)

  it('cancels an in-flight native call without inventing success', async () => {
    const f = await fixture()
    try {
      vi.mocked(f.services.providerAuth.models.streamSimple).mockImplementation((_model, context, options) => {
        f.captured.push(structuredClone(context))
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }))
          },
          result: async () => providerResponse([], 'aborted')
        } as never
      })
      const record = publishWorkflow(f, { id: 'instruction', type: 'instruction', version: 1, config: { text: 'Wait.' } })
      const request = startRequest(f, record)
      await f.agents.prepare(request, record)
      const policy = policyOf(f)
      const manifest = runningManifest(f, request, policy)
      f.setManifest(manifest)
      const controller = new AbortController()
      const pending = f.agents.agent.invoke({
        context: contextOf(manifest), policy, agent: { kind: 'main' }, instructions: 'Wait.', input: {}, signal: controller.signal, idempotencyKey: randomUUID()
      })
      await vi.waitFor(() => expect(f.captured.length).toBe(1), { timeout: 8_000, interval: 15 })
      controller.abort()
      await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    } finally { await f.close() }
  }, 30_000)

  it('replays a duplicate invocation and treats unknown-effect as non-replayable', async () => {
    const f = await fixture()
    try {
      f.outputs.push(providerResponse([{ type: 'text', text: '{"summary":"once"}' }], 'stop', 6, 0.01))
      const record = publishWorkflow(f, { id: 'instruction', type: 'instruction', version: 1, config: { text: 'Do it once.' } })
      const request = startRequest(f, record)
      await f.agents.prepare(request, record)
      const policy = policyOf(f)
      const manifest = runningManifest(f, request, policy)
      f.setManifest(manifest)
      const invoke = {
        context: contextOf(manifest), policy, agent: { kind: 'main' as const }, instructions: 'Do it once.', input: { n: 1 },
        signal: new AbortController().signal, idempotencyKey: randomUUID()
      }
      const first = await f.agents.agent.invoke(invoke)
      expect(first.output).toEqual({ summary: 'once' })
      expect(first.tokens).toBe(6)
      const second = await f.agents.agent.invoke(invoke)
      expect(second).toEqual(first)
      expect(f.captured).toHaveLength(1)

      const crashKey = randomUUID()
      vi.spyOn(f.services.orchestrator, 'runAgentDefinition').mockRejectedValueOnce(new Error('crash after dispatch'))
      await expect(f.agents.agent.invoke({ ...invoke, idempotencyKey: crashKey })).rejects.toThrow(/crash after dispatch/)
      const providerCalls = f.captured.length
      await expect(f.agents.agent.invoke({ ...invoke, idempotencyKey: crashKey })).rejects.toMatchObject({ code: 'unknown_effect' })
      expect(f.captured).toHaveLength(providerCalls)
    } finally { await f.close() }
  }, 30_000)

  it('narrows advertised tools to the inherited workflow policy', async () => {
    const f = await fixture()
    try {
      f.outputs.push(providerResponse([{ type: 'text', text: '{"summary":"read-only"}' }], 'stop'))
      const created = f.services.platform.agentDefinitions.createDraft({
        settings: agentSettings('Policy Agent', f.modelRef, ['read', 'write']),
        systemPrompt: 'Use only granted tools.'
      })
      f.services.platform.agentDefinitions.publish(created.id, created.draftHash)
      const record = publishWorkflow(f, {
        id: 'agent',
        type: 'agent',
        version: 1,
        config: { agent: { kind: 'user', definitionId: created.id }, instructions: 'Summarize without writing.' }
      })
      const request = startRequest(f, record)
      await f.agents.prepare(request, record)
      const policy = policyOf(f, {
        allowedTools: ['workflow.node', 'workflow.agent', 'read'],
        allowedEffects: ['pure', 'read'],
        allowedCapabilities: ['model.invoke']
      })
      const manifest = runningManifest(f, request, policy)
      f.setManifest(manifest)
      const result = await f.agents.agent.invoke({
        context: contextOf(manifest), policy, agent: { kind: 'user', definitionId: created.id },
        instructions: 'Summarize without writing.', input: {}, signal: new AbortController().signal, idempotencyKey: randomUUID()
      })
      expect(result.output).toEqual({ summary: 'read-only' })
      const names = f.captured[0]!.tools!.map((tool) => tool.name)
      expect(names).toContain('read')
      expect(names).not.toContain('write')
    } finally { await f.close() }
  }, 30_000)

  it('automatically carries a transitive pinned user Agent into a child after parent approval', async () => {
    const f = await fixture()
    try {
      f.outputs.push(providerResponse([{ type: 'text', text: '{"summary":"pinned-child"}' }], 'stop'))
      const created = f.services.platform.agentDefinitions.createDraft({
        settings: agentSettings('Transitive Child Agent', f.modelRef, ['read']),
        systemPrompt: 'PINNED_CHILD_PROMPT'
      })
      const publishedAgent = f.services.platform.agentDefinitions.publish(created.id, created.draftHash)
      const childBundle: WorkflowBundle = {
        assets: [],
        manifest: {
          schemaVersion: 1, id: randomUUID(), name: 'Pinned Agent Child', slug: 'pinned-agent-child-' + randomUUID().slice(0, 8),
          entryNodeId: 'start', inputSchema: { type: 'object' }, outputSchema: { type: 'object', additionalProperties: true },
          permissions: { capabilities: ['model.invoke'] },
          nodes: [
            { id: 'start', type: 'start', version: 1, config: {} },
            { id: 'agent', type: 'agent', version: 1, effect: 'read', config: {
              agent: { kind: 'user', definitionId: created.id }, instructions: 'Return the pinned child summary.'
            } },
            { id: 'end', type: 'end', version: 1, config: {}, inputs: { result: { ref: 'node', nodeId: 'agent', pointer: '' } } }
          ],
          edges: [
            { from: 'start', port: 'next', to: 'agent' },
            { from: 'agent', port: 'success', to: 'end' }
          ]
        }
      }
      const childDraft = f.services.platform.workflowDefinitions.saveDraft({ bundle: childBundle })
      const child = f.services.platform.workflowDefinitions.publish({
        definitionId: childDraft.definitionId,
        expectedDraftSemanticHash: childDraft.semanticHash,
        expectedHeadRevisionId: null
      })
      const parentBundle: WorkflowBundle = {
        assets: [],
        manifest: {
          schemaVersion: 1, id: randomUUID(), name: 'Pinned Agent Parent', slug: 'pinned-agent-parent-' + randomUUID().slice(0, 8),
          entryNodeId: 'start', inputSchema: { type: 'object' }, outputSchema: { type: 'object', additionalProperties: true },
          permissions: { capabilities: ['model.invoke'] },
          nodes: [
            { id: 'start', type: 'start', version: 1, config: {} },
            { id: 'child', type: 'subworkflow', version: 1, effect: 'external', config: {
              workflow: { id: child.definitionId, revision: child.head!.revisionId }
            } },
            { id: 'end', type: 'end', version: 1, config: {}, inputs: { result: { ref: 'node', nodeId: 'child', pointer: '' } } }
          ],
          edges: [
            { from: 'start', port: 'next', to: 'child' },
            { from: 'child', port: 'success', to: 'end' }
          ]
        }
      }
      const parentDraft = f.services.platform.workflowDefinitions.saveDraft({ bundle: parentBundle })
      const parent = f.services.platform.workflowDefinitions.publish({
        definitionId: parentDraft.definitionId,
        expectedDraftSemanticHash: parentDraft.semanticHash,
        expectedHeadRevisionId: null
      })
      const started = await f.services.platform.workflowRuns.start({
        profileId: f.alice.id,
        threadId: f.thread.id,
        definitionId: parent.definitionId,
        requestId: randomUUID(),
        input: {}
      }, { source: 'gui', connectionId: 'owned-window' })
      const waiting = await waitState(f, started.manifest.runId, 'waiting-approval')
      expect(waiting.pendingApprovalId).toBeTruthy()

      const changed = f.services.platform.agentDefinitions.saveDraft(created.id, {
        expectedDraftHash: created.draftHash,
        systemPrompt: 'NEW_CHILD_PROMPT_MUST_NOT_RUN'
      })
      f.services.platform.agentDefinitions.publish(created.id, changed.draftHash)
      await f.services.platform.workflowRuns.runtime.approve(started.manifest.runId, {
        profileId: f.alice.id,
        deferExecution: true
      }, {
        approvalId: waiting.pendingApprovalId!, approved: true, actorId: 'owned-window'
      })
      const done = await waitState(f, started.manifest.runId, 'succeeded')
      const childRunId = done.attempts.find((attempt) => attempt.instanceKey === 'child')?.childRunId
      expect(childRunId).toBeTruthy()
      const childDone = await f.services.platform.workflowRuns.runtime.get(childRunId!, { profileId: f.alice.id })
      expect(childDone.manifest.executionBindings?.agents?.pins[0]).toMatchObject({
        definitionId: created.id, revision: publishedAgent.revision
      })
      expect(done.result).toEqual({ summary: 'pinned-child' })
      expect(f.captured).toHaveLength(1)
      expect(JSON.stringify(f.captured[0])).toContain('PINNED_CHILD_PROMPT')
      expect(JSON.stringify(f.captured[0])).not.toContain('NEW_CHILD_PROMPT_MUST_NOT_RUN')
    } finally { await f.close() }
  }, 45_000)

  it('fails closed when a pinned native tool grant is revoked before dispatch', async () => {
    const f = await fixture()
    try {
      const created = f.services.platform.agentDefinitions.createDraft({
        settings: agentSettings('Revoked Grant Agent', f.modelRef, ['read']),
        systemPrompt: 'The provider must not run after revocation.'
      })
      f.services.platform.agentDefinitions.publish(created.id, created.draftHash)
      const record = publishWorkflow(f, {
        id: 'agent', type: 'agent', version: 1,
        config: { agent: { kind: 'user', definitionId: created.id }, instructions: 'Read only.' }
      })
      const request = startRequest(f, record)
      await f.agents.prepare(request, record)
      const policy = policyOf(f, { allowedTools: ['workflow.agent', 'read'] })
      const manifest = runningManifest(f, request, policy)
      f.setManifest(manifest)
      const integrations = f.services.settings.get().integrations
      f.services.settings.set({
        integrations: { ...integrations, tools: { ...integrations.tools, enabledTools: ['write'] } }
      })
      await expect(f.agents.agent.invoke({
        context: contextOf(manifest), policy, agent: { kind: 'user', definitionId: created.id },
        instructions: 'Read only.', input: {}, signal: new AbortController().signal, idempotencyKey: randomUUID()
      })).rejects.toMatchObject({ code: 'capability_denied' })
      expect(f.captured).toEqual([])
    } finally { await f.close() }
  }, 30_000)

  it('fails closed for unsupported CLI runtimes and inherits parent pins without resolving later heads', async () => {
    const f = await fixture()
    try {
      const cliSettings = defaultAgentSettings({ name: 'CLI Workflow Agent', slug: 'cli-workflow-agent-' + randomUUID().slice(0, 8) })
      cliSettings.primaryModel.ref = f.modelRef
      const cli = f.services.platform.agentDefinitions.createDraft({
        runtimeKind: 'codex',
        settings: cliSettings,
        systemPrompt: 'unsupported'
      })
      f.services.platform.agentDefinitions.publish(cli.id, cli.draftHash)
      const cliRecord = publishWorkflow(f, {
        id: 'agent', type: 'agent', version: 1,
        config: { agent: { kind: 'user', definitionId: cli.id }, instructions: 'Must not spawn.' }
      })
      const cliError = await f.agents.prepare(startRequest(f, cliRecord), cliRecord).catch((error: unknown) => error)
      expect(cliError).toMatchObject({ code: 'executor_unavailable' })
      expect(JSON.stringify(cliError)).toContain('qualified CLI process lifecycle')
      expect(f.captured).toEqual([])

      f.outputs.push(providerResponse([{ type: 'text', text: '{"summary":"child-pin"}' }], 'stop'))
      const created = f.services.platform.agentDefinitions.createDraft({
        settings: agentSettings('Inherited Agent', f.modelRef, ['read']),
        systemPrompt: 'PARENT_PIN'
      })
      const published = f.services.platform.agentDefinitions.publish(created.id, created.draftHash)
      const parentRecord = publishWorkflow(f, {
        id: 'agent', type: 'agent', version: 1,
        config: { agent: { kind: 'user', definitionId: created.id }, instructions: 'Parent pin.' }
      })
      const parentRequest = startRequest(f, parentRecord)
      const parentPrepared = await f.agents.prepare(parentRequest, parentRecord)
      const draft = f.services.platform.agentDefinitions.saveDraft(created.id, {
        expectedDraftHash: created.draftHash, systemPrompt: 'CHILD_MUST_NOT_SEE'
      })
      f.services.platform.agentDefinitions.publish(created.id, draft.draftHash)
      const childRecord = publishWorkflow(f, {
        id: 'agent', type: 'agent', version: 1,
        config: { agent: { kind: 'user', definitionId: created.id }, instructions: 'Child pin.' }
      })
      const childRequest = startRequest(f, childRecord)
      const childPrepared = await f.agents.prepareInherited({ parent: parentPrepared.bindings, request: childRequest, record: childRecord })
      expect(childPrepared.bindings.pins[0]?.revision).toBe(published.revision)
      const policy = policyOf(f)
      const manifest = runningManifest(f, childRequest, policy)
      f.setManifest(manifest)
      await f.agents.agent.invoke({
        context: contextOf(manifest), policy, agent: { kind: 'user', definitionId: created.id },
        instructions: 'Child pin.', input: {}, signal: new AbortController().signal, idempotencyKey: randomUUID()
      })
      expect(JSON.stringify(f.captured[0])).toContain('PARENT_PIN')
      expect(JSON.stringify(f.captured[0])).not.toContain('CHILD_MUST_NOT_SEE')
      expect(childPrepared.bindings.pins[0]?.definitionId).not.toBe(WORKFLOW_MAIN_AGENT_DEFINITION_ID)
    } finally { await f.close() }
  }, 30_000)
})
