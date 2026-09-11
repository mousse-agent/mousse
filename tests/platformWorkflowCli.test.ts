import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/cli/parseArgs'
import { executeWorkflowCommand, prepareWorkflowCommand, workflowWaitExitCode } from '../src/cli/commands/workflow'
import { publishOwnRuntimeRecord, removeOwnRuntimeRecord } from '../src/cli/mmsRuntime'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { LocalMmsClient, MmsProtocolServer } from '../src/mms/protocol'
import { createWorkflowDefinitionsClient } from '../src/renderer/services/workflowDefinitionsClient'
import { WORKFLOW_DEFINITIONS_CAPABILITY } from '../src/shared/workflowPlatform'
import { WORKFLOW_RUN_CAPABILITY, type WorkflowRunView } from '../src/shared/workflowRunPlatform'
import type { WorkflowBundle, WorkflowNode } from '../src/shared/workflows'
import type { OrchestratorResponse } from '../src/shared/types'
import { LlmClient } from '../src/mms/orchestrator/LlmClient'
import { normalizeQueuedMessages, promoteQueuedMessageToSteer } from '../src/mms/queue/ThreadMessageQueue'

const roots: string[] = []
const previousHome = process.env.MOUSSE_HOME
afterEach(() => {
  vi.restoreAllMocks()
  if (previousHome === undefined) delete process.env.MOUSSE_HOME
  else process.env.MOUSSE_HOME = previousHome
  for (const root of roots.splice(0)) {
    const path = relative(realpathSync(tmpdir()), realpathSync(root))
    if (isAbsolute(path) || !path.startsWith('mousse-workflow-cli-') || path.includes('..')) throw new Error('Unsafe fixture cleanup')
    rmSync(root, { recursive: true, force: true })
  }
})
function newRoot() { const root = mkdtempSync(join(tmpdir(), 'mousse-workflow-cli-')); roots.push(root); return root }
function bundle(node?: WorkflowNode): WorkflowBundle {
  return { assets: node?.type === 'script' ? [{ relativePath: 'scripts/echo.mjs', bytes: new TextEncoder().encode("let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify({script:true,input:JSON.parse(s)}))") }] : [], manifest: {
    schemaVersion: 1, id: randomUUID(), name: 'CLI fixture', slug: 'cli-fixture', entryNodeId: 'start',
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, permissions: { capabilities: node?.type === 'script' ? ['script.trusted-local'] : [] },
    nodes: [{ id: 'start', type: 'start', version: 1, config: {} }, ...(node ? [node] : []), { id: 'end', type: 'end', version: 1, config: {}, inputs: { result: node?.type === 'script' ? { ref: 'node', nodeId: node.id, pointer: '' } : { ref: 'input', pointer: '' } } }],
    edges: node ? [{ from: 'start', port: 'next', to: node.id }, { from: node.id, port: 'success', to: 'end' }] : [{ from: 'start', port: 'next', to: 'end' }]
  } }
}
async function fixture() {
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const root = newRoot(), homeDir = join(root, 'home')
  const main = await MousseMainService.create({ homeDir, repoRoot: root, requireOwnership: true, headless: true, ownerKind: 'daemon' })
  const owner = main.getOwnerLease()!
  const host = main.getInstallationHost()!
  const alice = host.manager.create({ displayName: 'Alice', slug: 'alice' }), bob = host.manager.create({ displayName: 'Bob', slug: 'bob' })
  const server = new MmsProtocolServer({ mms: main, ownerToken: owner.owner.token })
  const endpoint = await server.start()
  expect(owner.setEndpoint(endpoint)).toBe(true)
  publishOwnRuntimeRecord(homeDir, { ownerToken: owner.owner.token, ownerKind: 'daemon' })
  const rpc = new LocalMmsClient({ homeDir, endpoint, ownerToken: owner.owner.token, clientType: 'cli', requestedCapabilities: ['profiles-v1', WORKFLOW_DEFINITIONS_CAPABILITY, WORKFLOW_RUN_CAPABILITY] })
  await rpc.connect(); await rpc.request('profiles.bind', { profile: alice.id })
  const workflows = createWorkflowDefinitionsClient(rpc)
  const publish = async (content = bundle()) => {
    const draft = await workflows.create({ profileId: alice.id, bundle: content })
    return workflows.publish({ profileId: alice.id, id: draft.id, expectedDraftSemanticHash: draft.semanticHash })
  }
  return { root, homeDir, main, alice, bob, rpc, workflows, publish, endpoint,
    cli: (args: string[], profile = alice.id) => cli(['--home', homeDir, '--profile', profile, '--json', 'workflow', ...args]),
    close: async () => {
      await rpc.close(); await server.stop()
      removeOwnRuntimeRecord(homeDir, owner.owner.token)
      await main.stop()
    } }
}
type CliEvent = { kind: string; requestId?: string; runId?: string; revisionId?: string; run?: WorkflowRunView; runs?: WorkflowRunView[]; events?: unknown[]; hasMore?: boolean; workflows?: unknown[]; error?: string }
function cli(args: string[], timeoutMs = 30_000): Promise<{ code: number | null; events: CliEvent[]; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve('out/cli/index.js'), ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } })
    let stdout = '', stderr = '', failure: Error | undefined
    const timer = setTimeout(() => { failure = new Error('CLI fixture timed out'); child.kill() }, timeoutMs)
    const receive = (chunk: Buffer, error: boolean) => {
      if (error) stderr += chunk.toString(); else stdout += chunk.toString()
      if (stdout.length + stderr.length > 4 * 1024 * 1024) { failure = new Error('CLI fixture exceeded output bound'); child.kill() }
    }
    child.stdout.on('data', (chunk: Buffer) => receive(chunk, false)); child.stderr.on('data', (chunk: Buffer) => receive(chunk, true))
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (failure) { reject(failure); return }
      try { resolvePromise({ code, events: stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)), stderr }) }
      catch { reject(new Error('CLI emitted non-JSON stdout: ' + stdout.slice(0, 500) + '; stderr: ' + stderr.slice(0, 500))) }
    })
  })
}

describe('structured workflow CLI', () => {
  it('admits slash workflows through GUI RPC without a model, preserving identity, source and original transcript', async () => {
    const f = await fixture()
    const gui = new LocalMmsClient({ homeDir: f.homeDir, endpoint: f.endpoint, ownerToken: f.main.getOwnerRecord()!.token, clientType: 'gui', requestedCapabilities: ['profiles-v1', WORKFLOW_RUN_CAPABILITY] })
    try {
      const model = vi.spyOn(LlmClient.prototype, 'chat').mockRejectedValue(new Error('Workflow commands must not ask a model to schedule their graph'))
      const title = vi.spyOn(LlmClient.prototype, 'generateTitle').mockRejectedValue(new Error('No model title request for explicit workflow execution'))
      const content = bundle()
      content.manifest.inputSchema = { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false }
      const published = await f.publish(content)
      const { thread } = await f.rpc.request<{ thread: { id: string } }>('threads.create', { name: 'Slash GUI' })
      const services = await f.main.getProfileServices(f.alice.id)
      const saves: boolean[] = []
      const save = services.threads.mutateThreadData.bind(services.threads)
      vi.spyOn(services.threads, 'mutateThreadData').mockImplementation((id, mutate) => save(id, (current) => {
        const data = mutate(current)
        for (const message of data.messages ?? []) {
          if (message.workflowInvocationId) saves.push(Boolean(data.messages?.some((item) => item.workflowRun?.invocationId === message.workflowInvocationId)))
        }
        return data
      }))
      await gui.connect(); await gui.request('profiles.bind', { profile: f.alice.id })
      const params = { threadId: thread.id, content: '/' + published.slug + ' --count 3', requestId: randomUUID(), source: 'cli' }
      const first = await gui.request<OrchestratorResponse>('orchestrator.send', params)
      expect(first.workflowRun).toMatchObject({ profileId: f.alice.id, threadId: thread.id, definitionId: published.id, revisionId: published.head!.revisionId })
      const repeated = await gui.request<OrchestratorResponse>('orchestrator.send', params)
      expect(repeated.workflowRun?.runId).toBe(first.workflowRun!.runId)
      await vi.waitFor(async () => expect((await services.platform.workflowRuns.runtime.get(first.workflowRun!.runId, { profileId: f.alice.id })).manifest.state).toBe('succeeded'))
      const snapshot = await services.platform.workflowRuns.runtime.get(first.workflowRun!.runId, { profileId: f.alice.id })
      expect(snapshot.manifest.source).toBe('gui'); expect(snapshot.result).toEqual({ count: 3 })
      const messages = services.threads.loadThreadData(thread.id).messages
      expect(saves.length).toBeGreaterThan(0); expect(saves.every(Boolean)).toBe(true)
      expect(messages.filter((message) => message.workflowInvocationId === params.requestId)).toHaveLength(1)
      expect(messages.filter((message) => message.workflowRun?.runId === first.workflowRun!.runId)).toHaveLength(1)
      expect(messages.find((message) => message.workflowInvocationId)?.content).toBe(params.content)
      await expect(gui.request('orchestrator.send', { ...params, content: params.content + ' --unknown 1' })).rejects.toMatchObject({ code: 'WORKFLOW_CONCURRENCY_CONFLICT' })
      await expect(gui.request('orchestrator.send', { ...params, requestId: randomUUID(), content: '/' + published.slug })).rejects.toMatchObject({ code: 'invalid_arguments' })
      await expect(gui.request('orchestrator.send', { ...params, requestId: randomUUID(), workflowInvocationId: params.requestId })).rejects.toMatchObject({ code: 'invalid_params' })
      await gui.request('profiles.bind', { profile: f.bob.id })
      await expect(gui.request('orchestrator.send', params)).rejects.toThrow()
      expect(await services.platform.workflowRuns.runtime.list({ profileId: f.alice.id })).toHaveLength(1)
      expect(model).not.toHaveBeenCalled(); expect(title).not.toHaveBeenCalled()
    } finally { await gui.close(); await f.close() }
  }, 30_000)

  it('pins queued slash commands before publication changes, survives host reconstruction, and tombstones removals', async () => {
    const f = await fixture()
    let fresh: MousseMainService | undefined
    try {
      vi.spyOn(LlmClient.prototype, 'chat').mockRejectedValue(new Error('No model scheduling'))
      const content = bundle(), published = await f.publish(content)
      const { thread } = await f.rpc.request<{ thread: { id: string } }>('threads.create', { name: 'Queued workflow' })
      const request = { threadId: thread.id, content: '/' + published.slug, requestId: randomUUID(), forceQueue: true }
      const queued = await f.rpc.request<OrchestratorResponse>('orchestrator.send', request)
      expect(queued.queued).toBe(true); expect(queued.queueItem?.workflowInvocationId).toBe(request.requestId)
      const repeat = await f.rpc.request<OrchestratorResponse>('orchestrator.send', request)
      expect(repeat.queueItem?.id).toBe(queued.queueItem?.id)
      expect(() => promoteQueuedMessageToSteer([queued.queueItem!], queued.queueItem!.id)).toThrow('cannot be promoted')
      expect(() => normalizeQueuedMessages([{ ...queued.queueItem, workflowInvocationId: '../forged' }])).toThrow('refusing ordinary prompt fallback')
      const services = await f.main.getProfileServices(f.alice.id)
      expect(await services.platform.workflowRuns.runtime.list({ profileId: f.alice.id })).toEqual([])
      content.manifest.description = 'New head after queue admission'
      const draft = await f.workflows.saveDraft({ profileId: f.alice.id, id: published.id, expectedDraftSemanticHash: published.semanticHash, bundle: content })
      await f.workflows.publish({ profileId: f.alice.id, id: published.id, expectedDraftSemanticHash: draft.semanticHash, expectedHeadRevisionId: published.head!.revisionId })
      // Removal is durable before queue removal, so a lost response cannot revive it.
      const removedRequest = { ...request, requestId: randomUUID() }
      const remove = await f.rpc.request<OrchestratorResponse>('orchestrator.send', removedRequest)
      await f.rpc.request('queue.remove', { threadId: thread.id, itemId: remove.queueItem!.id })
      await expect(f.rpc.request('orchestrator.send', removedRequest)).rejects.toMatchObject({ code: 'invocation_cancelled' })
      await f.close()
      fresh = await MousseMainService.create({ homeDir: f.homeDir, repoRoot: f.root, requireOwnership: true, headless: true, ownerKind: 'daemon' })
      const restored = await fresh.getProfileServices(f.alice.id)
      restored.orchestrator.recoverAndDrainPendingQueues()
      await vi.waitFor(async () => {
        const runs = await restored.platform.workflowRuns.runtime.list({ profileId: f.alice.id })
        expect(runs).toHaveLength(1); expect(runs[0].state).toBe('succeeded')
        expect(runs[0].revisionId).toBe(published.head!.revisionId)
      }, { timeout: 8000 })
      expect(restored.threads.loadMessageQueue(thread.id)).toEqual([])
      expect(restored.threads.loadThreadData(thread.id).messages.filter((message) => message.workflowRun)).toHaveLength(1)
    } finally { await fresh?.stop(); await f.close() }
  }, 30_000)

  it('rejects a valid-looking receipt whose pinned execution authority changed on disk', async () => {
    const f = await fixture()
    try {
      const published = await f.publish()
      const { thread } = await f.rpc.request<{ thread: { id: string } }>('threads.create', { name: 'Tampered receipt' })
      const requestId = randomUUID()
      await f.rpc.request('orchestrator.send', { threadId: thread.id, content: '/' + published.slug, requestId, forceQueue: true })
      const receiptPath = join(f.homeDir, 'profiles', f.alice.id, 'workflow-chat-invocations', requestId + '.json')
      const services = await f.main.getProfileServices(f.alice.id)
      await expect(services.platform.workflowChat.execute(requestId, thread.id, '/different-command', new AbortController().signal)).rejects.toMatchObject({ code: 'WORKFLOW_CONCURRENCY_CONFLICT' })
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { params: { input: unknown } }
      receipt.params.input = { injected: true }
      writeFileSync(receiptPath, JSON.stringify(receipt))
      await expect(services.platform.workflowChat.execute(requestId, thread.id, '/' + published.slug, new AbortController().signal)).rejects.toMatchObject({ code: 'invocation_unavailable' })
      expect(await services.platform.workflowRuns.runtime.list({ profileId: f.alice.id })).toEqual([])
    } finally { await f.close() }
  }, 30_000)

  it('clears queued workflow receipts durably when stopping a delayed chat admission', async () => {
    const f = await fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let pending: Promise<unknown> | undefined
    try {
      const published = await f.publish()
      const { thread } = await f.rpc.request<{ thread: { id: string } }>('threads.create', { name: 'Clear workflow queue' })
      const services = await f.main.getProfileServices(f.alice.id)
      const execute = services.platform.workflowChat.execute.bind(services.platform.workflowChat)
      const delayed = vi.spyOn(services.platform.workflowChat, 'execute').mockImplementationOnce(async (...args) => { await gate; return execute(...args) })
      pending = f.rpc.request('orchestrator.send', { threadId: thread.id, content: '/' + published.slug, requestId: randomUUID() }).catch((error: unknown) => error)
      await vi.waitFor(() => expect(delayed).toHaveBeenCalledOnce())
      const queuedRequest = { threadId: thread.id, content: '/' + published.slug, requestId: randomUUID(), forceQueue: true }
      await f.rpc.request('orchestrator.send', queuedRequest)
      expect(services.threads.loadMessageQueue(thread.id)).toHaveLength(1)
      expect(await f.rpc.request('orchestrator.abort', { threadId: thread.id, clearQueue: true })).toMatchObject({ ok: true })
      expect(services.threads.loadMessageQueue(thread.id)).toEqual([])
      await expect(f.rpc.request('orchestrator.send', queuedRequest)).rejects.toMatchObject({ code: 'invocation_cancelled' })
      release()
      expect(await pending).toMatchObject({ code: 'cancelled' })
      expect(await services.platform.workflowRuns.runtime.list({ profileId: f.alice.id })).toEqual([])
    } finally { release(); await pending; await f.close() }
  }, 30_000)

  it('replays a claim after admission-before-transcript failure without admitting a second workflow run', async () => {
    const f = await fixture()
    try {
      const published = await f.publish()
      const { thread } = await f.rpc.request<{ thread: { id: string } }>('threads.create', { name: 'Admission fault' })
      const request = { threadId: thread.id, content: '/' + published.slug, requestId: randomUUID(), forceQueue: true }
      await f.rpc.request('orchestrator.send', request)
      const services = await f.main.getProfileServices(f.alice.id)
      const execute = services.platform.workflowChat.execute.bind(services.platform.workflowChat)
      const fault = vi.spyOn(services.platform.workflowChat, 'execute').mockImplementationOnce(async (...args) => {
        await execute(...args)
        throw new Error('Injected fault after durable graph admission and before transcript acceptance')
      })
      const failed: unknown[] = []
      services.orchestrator.on('queue-drain-failed', (event) => failed.push(event))
      services.orchestrator.recoverAndDrainPendingQueues()
      await vi.waitFor(() => expect(failed.length).toBeGreaterThan(0))
      expect(services.threads.loadMessageQueue(thread.id)).toHaveLength(1)
      expect(services.threads.loadThreadData(thread.id).messages.filter((message) => message.workflowRun)).toEqual([])
      fault.mockRestore()
      services.orchestrator.recoverAndDrainPendingQueues()
      await vi.waitFor(() => expect(services.threads.loadMessageQueue(thread.id)).toEqual([]))
      expect(await services.platform.workflowRuns.runtime.list({ profileId: f.alice.id })).toHaveLength(1)
      expect(services.threads.loadThreadData(thread.id).messages.filter((message) => message.workflowRun)).toHaveLength(1)
    } finally { await f.close() }
  }, 30_000)

  it('executes the built explicit chat command through the same slash resolver and wait exit codes', async () => {
    const f = await fixture()
    try {
      const content = bundle()
      content.manifest.inputSchema = { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] }
      const published = await f.publish(content)
      const { thread } = await f.rpc.request<{ thread: { id: string } }>('threads.create', { name: 'CLI slash' })
      const args = ['--home', f.homeDir, '--profile', f.alice.id, '--session', thread.id, '--json', '--print', 'chat']
      const result = await cli([...args, '/' + published.slug + ' --count 12'])
      expect(result.stderr).toBe(''); expect(result.code).toBe(0)
      expect(result.events[0].kind).toBe('accepted')
      expect(result.events.at(-1)?.run).toMatchObject({ state: 'succeeded', result: { count: 12 } })
      const invalid = await cli([...args, '/' + published.slug + ' --count nope'])
      expect(invalid.code).toBe(2)
      const override = await cli([...args, '--provider', 'must-not-change', '/' + published.slug + ' --count 2'])
      expect(override.code).toBe(2); expect(override.stderr).toContain('overrides are not supported')
      const services = await f.main.getProfileServices(f.alice.id)
      expect(await services.platform.workflowRuns.runtime.list({ profileId: f.alice.id })).toHaveLength(1)
    } finally { await f.close() }
  }, 60_000)

  it('keeps an identical slash invocation equivalent through GUI chat and the built CLI', async () => {
    const f = await fixture()
    const gui = new LocalMmsClient({
      homeDir: f.homeDir,
      endpoint: f.endpoint,
      ownerToken: f.main.getOwnerRecord()!.token,
      clientType: 'gui',
      requestedCapabilities: ['profiles-v1', WORKFLOW_RUN_CAPABILITY]
    })
    try {
      const content = bundle()
      content.manifest.inputSchema = {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          enabled: { type: 'boolean' },
          label: { type: 'string' }
        },
        required: ['count', 'enabled', 'label'],
        additionalProperties: false
      }
      const published = await f.publish(content)
      const command = `/${published.slug} --count 12 --enabled true --label "same value"`
      const invalidCommand = `/${published.slug} --count nope --enabled true --label "same value"`
      const { thread: guiThread } = await f.rpc.request<{ thread: { id: string } }>('threads.create', { name: 'GUI parity' })
      const { thread: cliThread } = await f.rpc.request<{ thread: { id: string } }>('threads.create', { name: 'CLI parity' })

      await gui.connect()
      await gui.request('profiles.bind', { profile: f.alice.id })
      const guiResponse = await gui.request<OrchestratorResponse>('orchestrator.send', {
        threadId: guiThread.id,
        content: command,
        requestId: randomUUID(),
        source: 'gui'
      })
      await vi.waitFor(async () => expect((await f.rpc.request<WorkflowRunView>('workflowRuns.get', {
        profileId: f.alice.id,
        runId: guiResponse.workflowRun!.runId
      })).state).toBe('succeeded'), { timeout: 10_000, interval: 50 })

      const cliResult = await cli([
        '--home', f.homeDir,
        '--profile', f.alice.id,
        '--session', cliThread.id,
        '--json',
        '--print',
        'chat',
        command
      ])
      expect(cliResult.stderr).toBe('')
      expect(cliResult.code).toBe(0)
      const cliAccepted = cliResult.events.find((event) => event.kind === 'accepted')!
      const guiRun = await f.rpc.request<WorkflowRunView>('workflowRuns.get', {
        profileId: f.alice.id,
        runId: guiResponse.workflowRun!.runId
      })
      const cliRun = await f.rpc.request<WorkflowRunView>('workflowRuns.get', {
        profileId: f.alice.id,
        runId: cliAccepted.runId!
      })
      expect(guiRun.definitionId).toBe(published.id)
      expect(cliRun.definitionId).toBe(guiRun.definitionId)
      expect(guiRun.revisionId).toBe(published.head!.revisionId)
      expect(cliAccepted.revisionId).toBe(guiRun.revisionId)
      expect(cliRun.revisionId).toBe(guiRun.revisionId)
      const services = await f.main.getProfileServices(f.alice.id)
      const guiTrace = await services.platform.workflowRuns.runtime.trace(guiRun.runId, { profileId: f.alice.id })
      const cliTrace = await services.platform.workflowRuns.runtime.trace(cliRun.runId, { profileId: f.alice.id })
      expect(guiTrace.nodeOutputs.start).toEqual({ count: 12, enabled: true, label: 'same value' })
      expect(cliTrace.nodeOutputs.start).toEqual(guiTrace.nodeOutputs.start)
      expect(cliRun.result).toEqual(guiRun.result)
      expect(cliRun.state).toBe(guiRun.state)
      expect(cliRun.attempts.map(({ nodeId, outcome }) => ({ nodeId, outcome })))
        .toEqual(guiRun.attempts.map(({ nodeId, outcome }) => ({ nodeId, outcome })))

      let guiValidation: unknown
      try {
        await gui.request('orchestrator.send', {
          threadId: guiThread.id,
          content: invalidCommand,
          requestId: randomUUID(),
          source: 'gui'
        })
      } catch (error) {
        guiValidation = error
      }
      expect(guiValidation).toMatchObject({ code: 'invalid_arguments' })
      const invalidCli = await cli([
        '--home', f.homeDir,
        '--profile', f.alice.id,
        '--session', cliThread.id,
        '--json',
        '--print',
        'chat',
        invalidCommand
      ])
      expect(invalidCli.code).toBe(2)
      const cliValidation = JSON.parse(invalidCli.stderr.trim()) as { error: string }
      expect(cliValidation.error).toContain((guiValidation as Error).message)
      expect(await services.platform.workflowRuns.runtime.list({ profileId: f.alice.id })).toHaveLength(2)
    } finally {
      await gui.close()
      await f.close()
    }
  }, 60_000)

  it('parses switches before names and validates inputs before connecting', async () => {
    const parsed = parseArgs(['--json', 'workflow', 'run', '--wait', 'review', '--input', '{"n":2,"ok":false,"items":[1]}'])
    expect(parsed.globals.mode).toBe('json')
    expect(await prepareWorkflowCommand(parsed)).toMatchObject({ command: 'run', target: 'review', wait: true, input: { n: 2, ok: false, items: [1] } })
    for (const args of [
      ['run', 'review', '--wait', '--no-wait'], ['run', 'review', '--draft'], ['run', 'review', '--input', '{'],
      ['run', 'review', '--provider', 'fixture'], ['run', 'review', '--wait=false'], ['run', 'review', '--unexpected'],
      ['approve', randomUUID(), '--yes'], ['history', '--limit', '101'], ['answer', randomUUID(), '--input', 'null'],
      ['reconcile', randomUUID(), '--node', 'node', '--instance', 'instance', '--attempt', '1', '--decision', 'retry']
    ]) await expect(prepareWorkflowCommand(parseArgs(['workflow', ...args]))).rejects.toThrow()
    const root = newRoot(), input = join(root, 'input.json')
    writeFileSync(input, '\uFEFF{"literal":"$(must-not-run)","n":3}')
    expect((await prepareWorkflowCommand(parseArgs(['workflows', 'run', '--no-wait', 'review', '--input-file', input]))).input).toEqual({ literal: '$(must-not-run)', n: 3 })
    writeFileSync(input, ' '.repeat(1024 * 1024 + 1))
    await expect(prepareWorkflowCommand(parseArgs(['workflow', 'run', 'review', '--input-file', input]))).rejects.toThrow('1 MiB')
    expect(['succeeded', 'failed', 'waiting-input', 'waiting-approval', 'cancelled', 'unknown-effect', 'recovery-required', 'interrupted', 'running'].map((state) => workflowWaitExitCode(state as WorkflowRunView['state']))).toEqual([0, 1, 3, 3, 4, 5, 5, 5, undefined])
  })

  it('runs the built CLI through the real owned daemon and retains one pinned admission across head changes', async () => {
    const f = await fixture()
    try {
      const content = bundle(), published = await f.publish(content)
      const input = join(f.root, 'input.json'); writeFileSync(input, '{"count":7,"literal":"$(no-shell)"}')
      const requestId = randomUUID()
      const args = ['run', published.id, '--input-file', input, '--request-id', requestId, '--wait']
      const first = await f.cli(args)
      expect(first.stderr).toBe(''); expect(first.code).toBe(0)
      const accepted = first.events.find((event) => event.kind === 'accepted')!
      expect(first.events[0]).toMatchObject({ kind: 'admitting', requestId })
      expect(first.events.at(-1)?.run).toMatchObject({ state: 'succeeded', profileId: f.alice.id, result: { count: 7, literal: '$(no-shell)' } })
      content.manifest.description = 'Changed after admission'
      const next = await f.workflows.saveDraft({ profileId: f.alice.id, id: published.id, expectedDraftSemanticHash: published.semanticHash, bundle: content })
      expect(next.semanticHash).not.toBe(published.semanticHash)
      await f.workflows.publish({ profileId: f.alice.id, id: published.id, expectedDraftSemanticHash: next.semanticHash, expectedHeadRevisionId: published.head!.revisionId })
      const retry = await f.cli(args)
      expect(retry.code).toBe(0)
      expect(retry.events.find((event) => event.kind === 'accepted')).toMatchObject({ runId: accepted.runId, revisionId: accepted.revisionId })
      const services = await f.main.getProfileServices(f.alice.id)
      expect(services.threads.listAllThreads()).toHaveLength(1)
      expect((await services.platform.workflowRuns.runtime.get(accepted.runId!, { profileId: f.alice.id })).manifest.source).toBe('cli')
      const history = await f.cli(['history']); expect(history.events[0].runs).toHaveLength(1)
      const foreign = await f.cli(['show', accepted.runId!], f.bob.id); expect(foreign.code).toBe(2)
      expect((await f.cli(['history'], f.bob.id)).events[0].runs).toEqual([])
      const trace = await f.cli(['trace', accepted.runId!, '--limit', '1'])
      expect(trace.events[0].events).toHaveLength(1); expect(trace.events[0].hasMore).toBe(true)
      expect((await f.cli(['list'])).events[0].workflows).toHaveLength(1)
    } finally { await f.close() }
  }, 60_000)

  it('leaves real code awaiting explicit approval, rejects stale approval IDs, then executes and monitors successfully', async () => {
    const f = await fixture()
    try {
      const published = await f.publish(bundle({ id: 'script', type: 'script', version: 1, inputs: { count: { ref: 'input', pointer: '/count' } }, config: { runtime: 'node', file: 'scripts/echo.mjs', executionMode: 'trusted-local' } }))
      const waiting = await f.cli(['run', published.slug, '--input={"count":9}'])
      expect(waiting.code).toBe(3)
      const run = waiting.events.at(-1)!.run!
      expect(run.state).toBe('waiting-approval')
      const stale = await f.cli(['approve', run.runId, '--approval-id', randomUUID(), '--yes'])
      expect(stale.code).toBe(2)
      expect((await f.rpc.request<WorkflowRunView>('workflowRuns.get', { profileId: f.alice.id, runId: run.runId })).state).toBe('waiting-approval')
      expect((await f.cli(['approve', run.runId, '--approval-id', run.pendingApproval!.approvalId, '--yes'])).code).toBe(0)
      const completed = await f.cli(['watch', run.runId])
      expect(completed.code).toBe(0)
      expect(completed.events.at(-1)!.run?.result).toEqual({ script: true, input: { count: 9 } })
      const interrupt = new AbortController()
      const another = await prepareWorkflowCommand(parseArgs(['workflow', 'run', published.id, '--input={"count":10}']))
      let interruptedId = ''
      expect(await executeWorkflowCommand(another, f.rpc, f.alice.id, { signal: interrupt.signal, pollMs: 10, emit: (event) => {
        const item = event as CliEvent
        if (item.kind === 'accepted') interruptedId = item.runId!
        if (item.run?.state === 'waiting-approval') interrupt.abort()
      } })).toBe(4)
      await vi.waitFor(async () => expect((await f.rpc.request<WorkflowRunView>('workflowRuns.get', { profileId: f.alice.id, runId: interruptedId })).state).toBe('cancelled'))
    } finally { await f.close() }
  }, 60_000)

  it('separates foreground cancellation from monitor interruption against actual durable runs', async () => {
    const f = await fixture()
    try {
      const published = await f.publish(bundle({ id: 'delay', type: 'delay', version: 1, config: { durationMs: 30_000 } }))
      const background = await f.cli(['run', published.id, '--no-wait'])
      expect(background.code).toBe(0)
      const runId = background.events.find((event) => event.kind === 'accepted')!.runId!
      const stopWatching = new AbortController(); stopWatching.abort()
      const monitor = await prepareWorkflowCommand(parseArgs(['workflow', 'watch', runId]))
      expect(await executeWorkflowCommand(monitor, f.rpc, f.alice.id, { emit: () => undefined, signal: stopWatching.signal, pollMs: 10 })).toBe(130)
      expect((await f.rpc.request<WorkflowRunView>('workflowRuns.get', { profileId: f.alice.id, runId })).state).not.toBe('cancelled')
      const interrupt = new AbortController()
      const foreground = await prepareWorkflowCommand(parseArgs(['workflow', 'run', published.id]))
      let foregroundId = ''
      expect(await executeWorkflowCommand(foreground, f.rpc, f.alice.id, { signal: interrupt.signal, pollMs: 10, emit: (event) => {
        const item = event as CliEvent
        if (item.kind === 'accepted') { foregroundId = item.runId!; interrupt.abort() }
      } })).toBe(4)
      await vi.waitFor(async () => expect((await f.rpc.request<WorkflowRunView>('workflowRuns.get', { profileId: f.alice.id, runId: foregroundId })).state).toBe('cancelled'))
      expect((await f.rpc.request<WorkflowRunView>('workflowRuns.get', { profileId: f.alice.id, runId })).state).not.toBe('cancelled')
      expect((await f.cli(['cancel', runId])).code).toBe(0)
    } finally { await f.close() }
  }, 60_000)
})
