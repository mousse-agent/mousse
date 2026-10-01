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
import { LlmClient } from '../src/mms/orchestrator/LlmClient'
import { ChannelAuth } from '../src/mms/channels/ChannelAuth'
import { ChannelRouter } from '../src/mms/channels/ChannelRouter'
import { ChannelSessionManager } from '../src/mms/channels/ChannelSessionManager'
import { ChannelStore } from '../src/mms/channels/ChannelStore'
import type { ChannelAdapter } from '../src/mms/channels/types'
import { createWorkflowDefinitionsClient } from '../src/renderer/services/workflowDefinitionsClient'
import type { MmsProfileServices } from '../src/mms/MmsProfileServices'

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

async function openChannel(services: MmsProfileServices) {
  const store = new ChannelStore(services.config, { inheritEnvironment: false })
  store.updateConfig({
    platforms: {
      telegram: { enabled: true, allowAllUsers: true },
      discord: { enabled: false },
      webhook: { enabled: false }
    }
  })
  const sent: string[] = []
  const adapter: ChannelAdapter = {
    platform: 'telegram',
    connect: async () => undefined,
    disconnect: async () => undefined,
    getStatus: () => ({ platform: 'telegram', state: 'connected' }),
    setInboundHandler: () => undefined,
    send: async (message) => {
      sent.push(message.text)
      return { success: true, messageId: 'out' }
    }
  }
  const router = new ChannelRouter(
    store,
    new ChannelSessionManager(store, services.threads),
    new ChannelAuth(store.getPairingDirectory()),
    {
      runChannelTurn: (threadId, text, opts) => services.orchestrator.runChannelTurn(threadId, text, services.threads, opts),
      abortChannelTurn: (threadId) => services.orchestrator.abortChannelTurn(threadId),
      steerChannelTurn: (threadId, text) => services.orchestrator.steerChannelTurn(threadId, text),
      isChannelTurnActive: (threadId) => services.orchestrator.isChannelTurnActive(threadId)
    },
    () => adapter,
    () => store.getConfig(),
    { settingsStore: services.settings, threadStore: services.threads, listModels: () => [] }
  )
  return {
    store, sent, router,
    inbound: (text: string, messageId?: string) => router.handleInbound({
      platform: 'telegram', chatId: '42', chatType: 'dm', userId: 'user-1', userName: 'fixture', text, messageId
    })
  }
}

describe('background workflow ingress', () => {
  it('keeps a workflow durable when channel observation aborts after admission', async () => {
    const f = await fixture()
    try {
      const published = await f.publish(f.alice.id, bundle({
        id: 'wait', type: 'delay', version: 1, config: { durationMs: 60_000 }
      }, 'abort-after-admission'))
      const alice = await f.services(f.alice.id)
      const { thread } = await f.aliceClient.rpc.request<{ thread: { id: string } }>('threads.create', { name: 'Abort boundary' })
      const requestId = randomUUID()
      const content = '/' + published.slug + ' --count 1'
      await alice.platform.workflowChat.prepare(thread.id, { content, requestId }, 'channel')
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

  it('replays the same channel receipt and pinned run after host restart', async () => {
    const f = await fixture()
    let restored: MousseMainService | undefined
    try {
      vi.spyOn(LlmClient.prototype, 'chat').mockRejectedValue(new Error('Workflow commands must not ask a model'))
      const content = bundle(undefined, 'restart-ingress')
      const published = await f.publish(f.alice.id, content)
      const alice = await f.services(f.alice.id)
      const channel = await openChannel(alice)
      const command = '/' + published.slug + ' --count 2'
      await channel.inbound(command, 'durable-message')
      const [first] = await alice.platform.workflowRuns.runtime.list({ profileId: f.alice.id })
      content.manifest.description = 'Published after durable ingress'
      const draft = await f.aliceClient.workflows.saveDraft({
        profileId: f.alice.id, id: published.id, expectedDraftSemanticHash: published.semanticHash, bundle: content
      })
      await f.aliceClient.workflows.publish({
        profileId: f.alice.id, id: published.id, expectedDraftSemanticHash: draft.semanticHash,
        expectedHeadRevisionId: published.head!.revisionId
      })
      await f.close()
      restored = await MousseMainService.create({
        homeDir: f.homeDir, repoRoot: f.root, requireOwnership: true, headless: true, ownerKind: 'daemon'
      })
      const resumed = await restored.getProfileServices(f.alice.id)
      const resumedChannel = await openChannel(resumed)
      await resumedChannel.inbound(command, 'durable-message')
      const runs = await resumed.platform.workflowRuns.runtime.list({ profileId: f.alice.id })
      expect(runs).toHaveLength(1)
      expect(runs[0]).toMatchObject({ runId: first.runId, revisionId: published.head!.revisionId, state: 'succeeded' })
    } finally {
      await restored?.stop()
      await f.close()
    }
  }, 45_000)

  it('admits channel and scheduled slash workflows without a model, pins retries after head changes, and isolates profiles', async () => {
    const f = await fixture()
    try {
      const content = bundle()
      const published = await f.publish(f.alice.id, content)
      const model = vi.spyOn(LlmClient.prototype, 'chat').mockImplementation(async (messages) => {
        const last = messages[messages.length - 1]
        const content = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')
        if (content.trim().startsWith('/')) throw new Error('Workflow commands must not ask a model')
        return {
          text: 'plain-ok',
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
          modelName: 'fixture',
          totalResponseTimeMs: 1,
          totalTokensUsed: 2,
          contextInputs: { signature: 'fixture' },
          toolEvents: [],
          nativeMessages: [...messages, { role: 'assistant', content: 'plain-ok', timestamp: Date.now() }]
        } as Awaited<ReturnType<LlmClient['chat']>>
      })
      vi.spyOn(LlmClient.prototype, 'generateTitle').mockRejectedValue(new Error('No model title request for explicit workflow execution'))
      await f.publish(f.bob.id, bundle(undefined, published.slug))
      const alice = await f.services(f.alice.id)
      const bob = await f.services(f.bob.id)
      const aliceChannel = await openChannel(alice)
      const bobChannel = await openChannel(bob)
      const command = '/' + published.slug + ' --count 3'

      await aliceChannel.inbound(command)
      expect(aliceChannel.sent.at(-1)).toMatch(/stable caller requestId/i)
      expect(await alice.platform.workflowRuns.runtime.list({ profileId: f.alice.id })).toEqual([])

      await aliceChannel.inbound(command, 'msg-1')
      expect(aliceChannel.sent.join('\n')).toMatch(/succeeded/i)
      expect(aliceChannel.sent.join('\n')).toMatch(/"count":3/)
      const aliceRuns = await alice.platform.workflowRuns.runtime.list({ profileId: f.alice.id })
      expect(aliceRuns).toHaveLength(1)
      expect(aliceRuns[0].state).toBe('succeeded')
      expect((await alice.platform.workflowRuns.runtime.get(aliceRuns[0].runId, { profileId: f.alice.id })).manifest.source).toBe('channel')

      content.manifest.description = 'New published head'
      const draft = await f.aliceClient.workflows.saveDraft({ profileId: f.alice.id, id: published.id, expectedDraftSemanticHash: published.semanticHash, bundle: content })
      await f.aliceClient.workflows.publish({
        profileId: f.alice.id, id: published.id, expectedDraftSemanticHash: draft.semanticHash, expectedHeadRevisionId: published.head!.revisionId
      })
      await aliceChannel.inbound(command, 'msg-1')
      expect(await alice.platform.workflowRuns.runtime.list({ profileId: f.alice.id })).toHaveLength(1)
      expect((await alice.platform.workflowRuns.runtime.get(aliceRuns[0].runId, { profileId: f.alice.id })).manifest.revisionId).toBe(published.head!.revisionId)

      await bobChannel.inbound(command, 'msg-1')
      const bobRuns = await bob.platform.workflowRuns.runtime.list({ profileId: f.bob.id })
      expect(bobRuns).toHaveLength(1)
      expect(bobRuns[0].runId).not.toBe(aliceRuns[0].runId)
      expect(await alice.platform.workflowRuns.runtime.list({ profileId: f.alice.id })).toHaveLength(1)

      await expect(aliceChannel.inbound('/' + published.slug, 'msg-missing')).resolves.toBeUndefined()
      expect(aliceChannel.sent.at(-1)).toMatch(/invalid|required|count/i)
      expect(await alice.platform.workflowRuns.runtime.list({ profileId: f.alice.id })).toHaveLength(1)

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
      const scheduledRuns = (await alice.platform.workflowRuns.runtime.list({ profileId: f.alice.id })).filter((run) => run.runId !== aliceRuns[0].runId)
      expect(scheduledRuns).toHaveLength(1)
      expect((await alice.platform.workflowRuns.runtime.get(scheduledRuns[0].runId, { profileId: f.alice.id })).manifest.source).toBe('schedule')
      const retried = await alice.orchestrator.runIsolatedScheduledJob(command, {
        jobId: job.id, occurrenceAt, threadId: thread.id, jobName: job.name
      })
      expect(retried.error).toBeUndefined()
      expect(retried.text).toMatch(/succeeded/i)
      expect((await alice.platform.workflowRuns.runtime.list({ profileId: f.alice.id })).filter((run) => run.runId !== aliceRuns[0].runId)).toHaveLength(1)

      aliceChannel.sent.length = 0
      await aliceChannel.inbound('just a prompt', 'msg-plain')
      expect(aliceChannel.sent.at(-1)).toBe('plain-ok')
      const plain = await alice.orchestrator.runIsolatedScheduledJob('just a prompt')
      expect(plain.text).toBe('plain-ok')
      expect(model).toHaveBeenCalled()
    } finally { await f.close() }
  }, 30_000)

  it('delivers waiting channel and scheduled workflows honestly, and cancellation leaves the durable run', async () => {
    const f = await fixture()
    try {
      vi.spyOn(LlmClient.prototype, 'chat').mockRejectedValue(new Error('Workflow commands must not ask a model'))
      const waitingBundle = bundle({
        id: 'wait', type: 'delay', version: 1, config: { durationMs: 60_000 }
      }, 'wait-fixture')
      const scriptBundle = bundle({
        id: 'script', type: 'script', version: 1,
        inputs: { count: { ref: 'input', pointer: '/count' } },
        config: { runtime: 'node', file: 'scripts/echo.mjs', executionMode: 'trusted-local' }
      }, 'script-fixture')
      const waitingPublished = await f.publish(f.alice.id, waitingBundle)
      const scriptPublished = await f.publish(f.alice.id, scriptBundle)
      const alice = await f.services(f.alice.id)
      const channel = await openChannel(alice)
      await channel.inbound('/' + scriptPublished.slug + ' --count 8', 'script-msg')
      expect(channel.sent.join('\n').toLowerCase()).toMatch(/waiting for approval/)
      expect(channel.sent.join('\n').toLowerCase()).not.toContain('succeed')
      const waitingScript = (await alice.platform.workflowRuns.runtime.list({ profileId: f.alice.id }))[0]
      expect(waitingScript.state).toBe('waiting-approval')
      const pendingScript = await alice.platform.workflowRuns.runtime.get(waitingScript.runId, { profileId: f.alice.id })
      expect(pendingScript.pendingApprovalId).toBeTruthy()
      const approval = alice.platform.workflowRuns.approvals.get(pendingScript.pendingApprovalId!, f.alice.id)!
      await alice.platform.workflowRuns.runtime.approve(waitingScript.runId, { profileId: f.alice.id }, {
        approvalId: approval.approvalId, approved: false, actorId: 'fixture-operator'
      })
      await vi.waitFor(async () => expect((await alice.platform.workflowRuns.runtime.get(waitingScript.runId, { profileId: f.alice.id })).manifest.state).toBe('failed'))

      const pending = channel.inbound('/' + waitingPublished.slug + ' --count 4', 'wait-msg')
      await vi.waitFor(async () => {
        const runs = await alice.platform.workflowRuns.runtime.list({ profileId: f.alice.id })
        expect(runs.some((run) => run.state === 'waiting-condition')).toBe(true)
      }, { timeout: 8000 })
      await pending
      expect(channel.sent.join('\n')).toMatch(/waiting-condition/i)
      expect(channel.sent.join('\n').toLowerCase()).not.toMatch(/state: succeeded/)
      const waitingRun = (await alice.platform.workflowRuns.runtime.list({ profileId: f.alice.id })).find((run) => run.state === 'waiting-condition')!
      expect(waitingRun.state).toBe('waiting-condition')
      await channel.inbound('/stop', 'stop-msg')
      expect(channel.sent.at(-1)).toMatch(/nothing to stop|stop requested/i)
      expect((await alice.platform.workflowRuns.runtime.get(waitingRun.runId, { profileId: f.alice.id })).manifest.state).toBe('waiting-condition')

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
      const resumable = alice.scheduled.createJob({
        name: 'Resumable waiting occurrence',
        prompt: '/' + resumablePublished.slug + ' --count 9',
        schedule: { kind: 'interval', minutes: 60 },
        threadId: thread.id,
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
