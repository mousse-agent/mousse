import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadActionService } from '../../src/mms/actions/ThreadActionService'
import { AgentDefinitionRegistry } from '../../src/mms/agentDefinitions/AgentDefinitionRegistry'
import { AgentResolver } from '../../src/mms/agentDefinitions/AgentResolver'
import { StaticAgentIntegrationLookup, StaticAgentModelLookup } from '../../src/mms/agentDefinitions/lookups'
import { AgentRegistry } from '../../src/mms/agents/AgentRegistry'
import { AgentChatService } from '../../src/mms/chats/AgentChatService'
import { ProjectManager } from '../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { getExecutionLeasePath, readLeaseOwner } from '../../src/mms/queue/ThreadExecutionLease'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'
import { PtyManager } from '../../src/mms/terminals/PtyManager'
import { WorktreeManager } from '../../src/mms/worktree/WorktreeManager'
import { defaultAgentSettings } from '../../src/shared/agents/defaults'
import { getDefaultSettings } from '../../src/shared/settings'
import { providerResponse } from '../fixtures/agent-platform/agent-runtime-policy/helpers'
import { installExactDefinitionRuntime } from '../fixtures/agent-platform/exactDefinitionRuntime'

// PR 4 §6 / §16 `agentChatDefinitionTurn`: agent chats run each reply as a definition turn through
// the real orchestrator, gateway and run engine. The chat holds the backing thread's lease for the
// whole response; each turn borrows it and never takes, stores or releases it. The host checkpoints
// once per reply. The runtime is the exact stand-in (no production runtime declares `exact` yet).

const say = (text: string) => providerResponse([{ type: 'text', text }], 'stop')
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

function fixture(options: { next?: (context: Context, signal: AbortSignal) => Promise<AssistantMessage>; bobProvider?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-chat-defturn-')))
  process.env.MOUSSE_HOME = root
  const profileId = randomUUID()
  const projects = new ProjectManager(root)
  const threads = new ThreadDataStore(projects, root, { profileId, allowLegacyProjectData: false })
  projects.setThreadStore(threads)
  const orch = new OrchestratorService(new AgentRegistry(), new TaskQueue(), new WorktreeManager(root), new PtyManager(), { get: () => getDefaultSettings() } as never, {} as never)
  orch.setThreadStore(threads)
  const engine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: root })) })
  orch.setRunEngine(engine)
  const outputs: AssistantMessage[] = []
  const captured: Context[] = []
  const runtime = installExactDefinitionRuntime({ orchestrator: orch, providerId: 'alpha', alsoProviders: ['beta'], profileHome: root, captured, ...(options.next ? { next: options.next } : { outputs }) })
  const registry = new AgentDefinitionRegistry({ profileId, profileRoot: root })
  const lookup = new StaticAgentIntegrationLookup({ builtinToolIds: ['read', 'write'] })
  const entry = (instanceId: string) => ({ ref: { providerId: instanceId.slice(3), modelId: 'model', instanceId }, available: true, efforts: [], speeds: [], contexts: [], capabilities: ['tools'], unavailableReasons: [] })
  const resolver = new AgentResolver({ registry, integrationLookup: lookup, modelLookup: new StaticAgentModelLookup([entry('pi:alpha'), entry('pi:beta')] as never) })
  const createAgent = (slug: string, instanceId: string) => {
    const settings = defaultAgentSettings({ name: slug.toUpperCase(), slug, purpose: `${slug} purpose` })
    settings.primaryModel.ref = { providerId: instanceId.slice(3), modelId: 'model', instanceId }
    settings.recovery.retryCount = 0
    const draft = registry.createDraft({ settings, systemPrompt: `You are ${slug}.` })
    registry.publish(draft.id, draft.draftHash, { integrationLookup: lookup })
    return draft.id
  }
  const alice = createAgent('alice', 'pi:alpha'), bob = createAgent('bob', options.bobProvider ?? 'pi:alpha')
  const questions = new UserQuestionService()
  const service = new AgentChatService({
    services: { profileId, getProfileHomeDir: () => root, projects, threads, questions, events: { broadcast: vi.fn() }, orchestrator: orch } as never,
    registry,
    resolverFor: () => resolver
  })
  cleanups.push(async () => {
    await service.dispose()
    orch.setRunEngine(null)
    engine.store.db.close()
    runtime.harness.stop()
    rmSync(root, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })
  return { root, orch, engine, runtime, outputs, captured, service, threads, projects, alice, bob }
}

describe('agent chats on definition turns', () => {
  it('a direct reply borrows the chat lease once, never takes or releases it, and the next reply sees the first', async () => {
    let leaseDuringTurn: { source?: string } | null = null
    let sessionLease: unknown = 'unset'
    const f = fixture({
      next: async (context) => {
        const threadId = f.runtime.turns.at(-1)!.input.threadId
        leaseDuringTurn = readLeaseOwner(getExecutionLeasePath(f.threads.getThreadDir(threadId)))
        sessionLease = (f.orch as unknown as { sessions: Map<string, { executionLease: unknown }> }).sessions.get(threadId)?.executionLease
        return say(context.messages.length > 1 ? 'I remember hello' : 'hello user')
      }
    })
    const chat = await f.service.create({ kind: 'direct', agentIds: [f.alice] })
    f.service.send({ chatId: chat.id, text: 'hello' })
    await f.service.waitForIdle()
    expect(leaseDuringTurn).toMatchObject({ source: 'chat' })
    // The borrowed handle is never put on the thread's session.
    expect(sessionLease ?? null).toBeNull()
    // The chat released its lease when the response settled; the turn released nothing of its own.
    expect(readLeaseOwner(getExecutionLeasePath(f.threads.getThreadDir(chat.threadId)))).toBeNull()
    f.service.send({ chatId: chat.id, text: 'remember?' })
    await f.service.waitForIdle()
    expect(f.service.get(chat.id).messages.map((message) => message.text)).toEqual(['hello', 'hello user', 'remember?', 'I remember hello'])
    // The second reply's own messages carry the first exchange, and its preamble has it too.
    expect(f.captured[1]!.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'hello' }),
      expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: 'hello user' }] }),
      expect.objectContaining({ role: 'user', content: 'remember?' })
    ])
    expect(f.runtime.turns[1]!.input.nativeHistory).toContain('hello user')
    expect(f.captured[1]!.systemPrompt).toContain('You are alice.')
    // One run record per reply, each its own and settled.
    expect(f.engine.listRuns(chat.threadId).map((run) => [run.source, run.status])).toEqual([['definition', 'completed'], ['definition', 'completed']])
  })

  it('a composer send to the backing thread during a reply never starts a turn beside it', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const f = fixture({ next: async () => { await gate; return say('done') } })
    const chat = await f.service.create({ kind: 'direct', agentIds: [f.alice] })
    f.service.send({ chatId: chat.id, text: 'take your time' })
    await vi.waitFor(() => expect(f.runtime.turns).toHaveLength(1))
    const sent = await f.orch.send('from the composer', false, { threadId: chat.threadId, awaitMode: 'ack', clientRequestId: 'composer-1' })
    expect(sent.queued === true || f.engine.getRun(sent.runId!)?.status === 'queued').toBe(true)
    expect(f.runtime.turns).toHaveLength(1)
    release()
    await f.service.waitForIdle()
    expect(f.service.get(chat.id).run?.state).toBe('completed')
  })

  it('a group reply hands over to the mentioned agent on another provider, with one checkpoint per reply', async () => {
    const f = fixture({ bobProvider: 'pi:beta' })
    const repo = join(f.root, 'repo')
    mkdirSync(repo)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
    git('init'); git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'Fixture')
    writeFileSync(join(repo, 'tracked.txt'), 'tracked'); git('add', 'tracked.txt'); git('commit', '-m', 'fixture')
    const project = f.projects.openProject(repo)
    const checkpoints = vi.spyOn(ThreadActionService.prototype, 'checkpointExistingTurn')
    f.outputs.push(say('@bob please review'), say('Reviewed by bob.'))
    const group = await f.service.create({ kind: 'group', name: 'Review', agentIds: [f.alice, f.bob], projectId: project.id })
    f.service.send({ chatId: group.id, text: '@alice start' })
    await f.service.waitForIdle()
    expect(f.service.get(group.id).messages.map((message) => message.participantId)).toEqual(['self', f.alice, f.bob])
    expect(checkpoints).toHaveBeenCalledTimes(2)
    expect(checkpoints.mock.calls.map((callArgs) => callArgs[2])).toEqual(['completed', 'completed'])
    // Bob runs on another provider: the person's message reaches him attributed, and Alice's reply is his input.
    expect(f.runtime.turns.map((turn) => turn.input.instanceId)).toEqual(['pi:alpha', 'pi:beta'])
    expect(f.captured[1]!.messages).toEqual([
      expect.objectContaining({ role: 'user', content: '[You]\n@alice start' }),
      expect.objectContaining({ role: 'user', content: 'Message from ALICE:\n@bob please review' })
    ])
    expect(f.captured[1]!.systemPrompt).toContain('You are bob.')
    expect(f.runtime.turns[1]!.input.cwd).toBe(f.service.resourceBinding(group.id).workspaceRoot)
  })

  it('cancel stops the reply, checkpoints it as stopped and ends its run interrupted', async () => {
    const f = fixture({ next: (_context, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) })
    const repo = join(f.root, 'repo')
    mkdirSync(repo)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
    git('init'); git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'Fixture')
    writeFileSync(join(repo, 'tracked.txt'), 'tracked'); git('add', 'tracked.txt'); git('commit', '-m', 'fixture')
    const project = f.projects.openProject(repo)
    const checkpoints = vi.spyOn(ThreadActionService.prototype, 'checkpointExistingTurn')
    const group = await f.service.create({ kind: 'group', name: 'Cancel', agentIds: [f.alice, f.bob], projectId: project.id })
    const admitted = f.service.send({ chatId: group.id, text: '@alice wait' })
    await vi.waitFor(() => expect(f.runtime.turns).toHaveLength(1))
    f.service.cancel({ chatId: group.id, runId: admitted.run!.id })
    await f.service.waitForIdle()
    expect(f.service.get(group.id).run?.state).toBe('cancelled')
    expect(checkpoints).toHaveBeenCalledTimes(1)
    expect(checkpoints.mock.calls[0]![2]).toBe('stopped')
    expect(f.engine.listRuns(group.threadId).map((run) => run.status)).toEqual(['interrupted'])
    expect(readLeaseOwner(getExecutionLeasePath(f.threads.getThreadDir(group.threadId)))).toBeNull()
  })
})
