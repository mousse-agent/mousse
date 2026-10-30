import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { LocalMmsClient, MmsProtocolServer } from '../src/mms/protocol'
import { WORKFLOW_DEFINITIONS_CAPABILITY } from '../src/shared/workflowPlatform'
import { WORKFLOW_RUN_CAPABILITY } from '../src/shared/workflowRunPlatform'
import type { WorkflowBundle, WorkflowNode } from '../src/shared/workflows'
import { Harness } from '../src/mms/harness/gateway'
import { createWorkflowDefinitionsClient } from '../src/renderer/services/workflowDefinitionsClient'

const roots: string[] = []
const previousHome = process.env.MOUSSE_HOME
afterEach(() => {
  vi.restoreAllMocks()
  if (previousHome === undefined) delete process.env.MOUSSE_HOME
  else process.env.MOUSSE_HOME = previousHome
  for (const root of roots.splice(0)) {
    const path = relative(realpathSync(tmpdir()), realpathSync(root))
    if (isAbsolute(path) || !path.startsWith('mousse-workflow-ingress-') || path.includes('..')) throw new Error('Unsafe fixture cleanup')
    rmSync(root, { recursive: true, force: true })
  }
})

function newRoot() {
  const root = mkdtempSync(join(tmpdir(), 'mousse-workflow-ingress-'))
  roots.push(root)
  return root
}

function bundle(node?: WorkflowNode, slug = 'ingress-fixture'): WorkflowBundle {
  const capabilities = node?.type === 'script' ? ['script.trusted-local'] : node?.type === 'approval' ? ['human.approval'] : []
  return {
    assets: node?.type === 'script'
      ? [{ relativePath: 'scripts/echo.mjs', bytes: new TextEncoder().encode("let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify({script:true,input:JSON.parse(s)}))") }]
      : [],
    manifest: {
      schemaVersion: 1, id: randomUUID(), name: 'Ingress fixture', slug, entryNodeId: 'start',
      inputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false },
      outputSchema: { type: 'object' },
      permissions: { capabilities },
      nodes: [
        { id: 'start', type: 'start', version: 1, config: {} },
        ...(node ? [node] : []),
        { id: 'end', type: 'end', version: 1, config: {}, inputs: { result: node?.type === 'script' ? { ref: 'node', nodeId: node.id, pointer: '' } : { ref: 'input', pointer: '' } } }
      ],
      edges: node
        ? [
            { from: 'start', port: 'next', to: node.id },
            { from: node.id, port: node.type === 'approval' ? 'approved' : 'success', to: 'end' },
            ...(node.type === 'approval' ? [{ from: node.id, port: 'denied', to: 'end' }] : [])
          ]
        : [{ from: 'start', port: 'next', to: 'end' }]
    }
  }
}

async function fixture() {
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const root = newRoot(), homeDir = join(root, 'home')
  const main = await MousseMainService.create({ homeDir, repoRoot: root, requireOwnership: false, headless: true })
  const host = main.getInstallationHost()!
  const alice = host.manager.create({ displayName: 'Alice', slug: 'alice' })
  const bob = host.manager.create({ displayName: 'Bob', slug: 'bob' })
  const server = new MmsProtocolServer({ mms: main, ownerToken: 'fixture-owner' })
  const endpoint = await server.start()
  const clients: LocalMmsClient[] = []
  const connect = async (profile: string) => {
    const rpc = new LocalMmsClient({
      homeDir, endpoint, ownerToken: 'fixture-owner', clientType: 'cli',
      requestedCapabilities: ['profiles-v1', WORKFLOW_DEFINITIONS_CAPABILITY, WORKFLOW_RUN_CAPABILITY]
    })
    clients.push(rpc)
    await rpc.connect()
    await rpc.request('profiles.bind', { profile })
    return { rpc, workflows: createWorkflowDefinitionsClient(rpc) }
  }
  const aliceClient = await connect(alice.id)
  const publish = async (profileId: string, content = bundle()) => {
    const client = profileId === alice.id ? aliceClient : await connect(profileId)
    const draft = await client.workflows.create({ profileId, bundle: content })
    return client.workflows.publish({ profileId, id: draft.id, expectedDraftSemanticHash: draft.semanticHash })
  }
  return {
    root, homeDir, main, alice, bob, aliceClient, publish,
    services: (profileId = alice.id) => main.getProfileServices(profileId),
    close: async () => {
      await Promise.all(clients.map((client) => client.close()))
      await server.stop()
      await main.stop()
    }
  }
}

describe('background workflow ingress', () => {
  it('keeps a workflow durable when observation aborts after admission', async () => {
    const f = await fixture()
    try {
      const published = await f.publish(f.alice.id, bundle({
        id: 'wait', type: 'delay', version: 1, config: { durationMs: 60_000 }
      }, 'abort-after-admission'))
      const alice = await f.services(f.alice.id)
      const { thread } = await f.aliceClient.rpc.request<{ thread: { id: string } }>('threads.create', { name: 'Abort boundary' })
      const requestId = randomUUID()
      const content = '/' + published.slug + ' --count 1'
      await alice.platform.workflowChat.prepare(thread.id, { content, requestId }, 'remote')
      const abort = new AbortController()
      const start = alice.platform.workflowRuns.start.bind(alice.platform.workflowRuns)
      vi.spyOn(alice.platform.workflowRuns, 'start').mockImplementationOnce(async (...args) => {
        const snapshot = await start(...args)
        abort.abort()
        return snapshot
      })
      const run = await alice.platform.workflowChat.execute(requestId, thread.id, content, abort.signal)
      expect((await alice.platform.workflowRuns.runtime.get(run.runId, { profileId: f.alice.id })).manifest.state).not.toBe('cancelled')
      await vi.waitFor(async () => {
        expect((await alice.platform.workflowRuns.runtime.get(run.runId, { profileId: f.alice.id })).manifest.state).toBe('waiting-condition')
      }, { timeout: 8000 })
      await alice.platform.workflowRuns.runtime.cancel(run.runId, { profileId: f.alice.id }, 'Fixture cleanup')
    } finally { await f.close() }
  }, 30_000)

  it('admits scheduled slash workflows without a model and pins retries after head changes', async () => {
    const f = await fixture()
    try {
      const content = bundle()
      const published = await f.publish(f.alice.id, content)
      // The model's turn, through the gateway: a workflow command never reaches it; a plain prompt says 'plain-ok'.
      const model = vi.spyOn(Harness.prototype, 'startTurn').mockImplementation((spec) => {
        if (spec.input.prompt.trim().startsWith('/')) throw new Error('Workflow commands must not ask a model')
        const providerRef = { provider: spec.input.llmProvider, model: spec.input.model }
        spec.sink.providerRef(providerRef)
        spec.sink.text({ phase: 'complete', content: 'plain-ok', contentIndex: 0 })
        spec.host.context.nativeHistoryAfterTurn('plain-ok')
        const result = Promise.resolve({
          text: 'plain-ok', aborted: false, modelName: 'fixture', totalResponseTimeMs: 1,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 'fixture', nativeMessages: [], providerRef
        })
        return { result, steer: async () => 'not_active' as const, interrupt: async () => 'not_active' as const, providerRef: () => providerRef }
      })
      vi.spyOn(Harness.prototype, 'oneShot').mockRejectedValue(new Error('No model title request for explicit workflow execution'))
      const alice = await f.services(f.alice.id)
      const command = '/' + published.slug + ' --count 3'

      const { thread } = await f.aliceClient.rpc.request<{ thread: { id: string } }>('threads.create', { name: 'Scheduled target' })
      const job = alice.scheduled.createJob({
        name: 'Pinned workflow',
        prompt: command,
        schedule: { kind: 'interval', minutes: 60 },
        threadId: thread.id
      })
      alice.scheduled.triggerJob(job.id)
      const occurrenceAt = alice.scheduled.getJob(job.id)!.nextRunAt!
      alice.scheduled.start()
      await vi.waitFor(() => {
        expect(alice.scheduled.getJob(job.id)?.lastStatus).toBe('ok')
      }, { timeout: 8000 })
      alice.scheduled.stop()
      const scheduledRuns = await alice.platform.workflowRuns.runtime.list({ profileId: f.alice.id })
      expect(scheduledRuns).toHaveLength(1)
      expect((await alice.platform.workflowRuns.runtime.get(scheduledRuns[0].runId, { profileId: f.alice.id })).manifest.source).toBe('schedule')

      // A new published head: the retry of the same occurrence keeps the run it pinned.
      content.manifest.description = 'New published head'
      const draft = await f.aliceClient.workflows.saveDraft({ profileId: f.alice.id, id: published.id, expectedDraftSemanticHash: published.semanticHash, bundle: content })
      await f.aliceClient.workflows.publish({
        profileId: f.alice.id, id: published.id, expectedDraftSemanticHash: draft.semanticHash, expectedHeadRevisionId: published.head!.revisionId
      })
      const retried = await alice.orchestrator.runIsolatedScheduledJob(command, {
        jobId: job.id, occurrenceAt, threadId: thread.id, jobName: job.name
      })
      expect(retried.error).toBeUndefined()
      expect(retried.text).toMatch(/succeeded/i)
      const runs = await alice.platform.workflowRuns.runtime.list({ profileId: f.alice.id })
      expect(runs).toHaveLength(1)
      expect((await alice.platform.workflowRuns.runtime.get(runs[0].runId, { profileId: f.alice.id })).manifest.revisionId).toBe(published.head!.revisionId)

      // A plain prompt is a model turn on the profile's default model (there is no bare pi route), on a per-run thread.
      alice.settings.set({ provider: { llmProvider: 'openai', model: 'fixture' } })
      const plainAt = new Date().toISOString()
      const plain = await alice.orchestrator.runIsolatedScheduledJob('just a prompt', {
        jobId: 'plain-job', occurrenceAt: plainAt, occurrenceKey: plainAt, jobName: 'Plain prompt'
      })
      expect(plain.error).toBeUndefined()
      expect(plain.text).toBe('plain-ok')
      expect(plain.threadId).toBeTruthy()
      expect(plain.runId).toBeTruthy()
      expect(model).toHaveBeenCalled()
    } finally { await f.close() }
  }, 30_000)

  it('delivers waiting scheduled workflows honestly, and cancellation leaves the durable run', async () => {
    const f = await fixture()
    try {
      vi.spyOn(Harness.prototype, 'startTurn').mockImplementation(() => { throw new Error('Workflow commands must not ask a model') })
      const waitingBundle = bundle({
        id: 'wait', type: 'delay', version: 1, config: { durationMs: 60_000 }
      }, 'wait-fixture')
      const waitingPublished = await f.publish(f.alice.id, waitingBundle)
      const alice = await f.services(f.alice.id)
      const { thread } = await f.aliceClient.rpc.request<{ thread: { id: string } }>('threads.create', { name: 'Waiting schedule' })
      const job = alice.scheduled.createJob({
        name: 'Waiting delay',
        prompt: '/' + waitingPublished.slug + ' --count 8',
        schedule: { kind: 'interval', minutes: 60 },
        threadId: thread.id
      })
      alice.scheduled.triggerJob(job.id)
      alice.scheduled.start()
      await vi.waitFor(() => {
        expect(alice.scheduled.getJob(job.id)?.lastStatus).toBe('waiting')
      }, { timeout: 8000 })
      alice.scheduled.stop()
      const scheduled = alice.scheduled.getJob(job.id)!
      expect(scheduled.lastStatus).toBe('waiting')
      expect(scheduled.lastError).toBeUndefined()
      expect(scheduled.runHistory?.at(-1)?.output?.toLowerCase()).toContain('waiting')
      expect(scheduled.runHistory?.at(-1)?.output?.toLowerCase()).not.toMatch(/state: succeeded/)
      const delayRuns = (await alice.platform.workflowRuns.runtime.list({ profileId: f.alice.id })).filter((run) => run.state === 'waiting-condition')
      expect(delayRuns.length).toBeGreaterThanOrEqual(1)
      const scheduledDelay = (await Promise.all(delayRuns.map((run) =>
        alice.platform.workflowRuns.runtime.get(run.runId, { profileId: f.alice.id })
      ))).find((run) => run.manifest.source === 'schedule')!
      await alice.platform.workflowRuns.runtime.cancel(scheduledDelay.manifest.runId, { profileId: f.alice.id }, 'Fixture cleanup')

      const resumablePublished = await f.publish(f.alice.id, bundle({
        id: 'wait', type: 'delay', version: 1, config: { durationMs: 500 }
      }, 'resume-wait-fixture'))
      // Its own thread: due jobs start together, and the waiting job above resumes on its thread at the same tick.
      const { thread: resumableThread } = await f.aliceClient.rpc.request<{ thread: { id: string } }>('threads.create', { name: 'Resumable schedule' })
      const resumable = alice.scheduled.createJob({
        name: 'Resumable waiting occurrence',
        prompt: '/' + resumablePublished.slug + ' --count 9',
        schedule: { kind: 'interval', minutes: 60 },
        threadId: resumableThread.id,
        repeat: { times: 1 }
      })
      alice.scheduled.triggerJob(resumable.id)
      alice.scheduled.start()
      await vi.waitFor(() => {
        expect(alice.scheduled.getJob(resumable.id)).toMatchObject({ state: 'scheduled', lastStatus: 'waiting', repeat: { completed: 0 } })
      }, { timeout: 8000 })
      alice.scheduled.stop()
      await new Promise((resolve) => setTimeout(resolve, 700))
      alice.scheduled.start()
      await vi.waitFor(() => expect(alice.scheduled.getJob(resumable.id)).toBeUndefined(), { timeout: 8000 })
      alice.scheduled.stop()
    } finally { await f.close() }
  }, 30_000)
})
