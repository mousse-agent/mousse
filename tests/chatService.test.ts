import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import { AgentChatService, chatMentions } from '../src/mms/chats/AgentChatService'
import { ChatStore } from '../src/mms/chats/ChatStore'
import { AgentDefinitionRegistry } from '../src/mms/agentDefinitions/AgentDefinitionRegistry'
import { AgentResolver } from '../src/mms/agentDefinitions/AgentResolver'
import { StaticAgentIntegrationLookup, StaticAgentModelLookup } from '../src/mms/agentDefinitions/lookups'
import { defaultAgentSettings } from '../src/shared/agents/defaults'
import type { AgentExecutionRequest } from '../src/shared/agents/execution'
import { AgentExecutionService } from '../src/mms/agentDefinitions/AgentExecutionService'
import { createNativeAgentRuntime } from '../src/mms/agentDefinitions/nativeRuntime'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { DomainHandlerRegistry } from '../src/mms/protocol/domainRegistry'
import { registerChatMethods, validateChatParams } from '../src/mms/chats/registerMethods'
import { CHAT_CAPABILITY } from '../src/shared/chats'
import { nativeClient, providerResponse } from './fixtures/agent-platform/agent-runtime-policy/helpers'
import { tryAcquireExecutionLease, releaseExecutionLeaseHandle } from '../src/mms/queue/ThreadExecutionLease'
import { canonicalJson, sha256Hex } from '../src/shared/agents/hashes'

const roots: string[] = []
const services: AgentChatService[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(outputs: Array<string | AssistantMessage> = ['done'], override?: (request: AgentExecutionRequest) => Promise<any>) {
  const root = mkdtempSync(join(tmpdir(), 'mousse-chats-')); roots.push(root)
  const profileId = randomUUID()
  const registry = new AgentDefinitionRegistry({ profileId, profileRoot: root })
  const lookup = new StaticAgentIntegrationLookup({ builtinToolIds: ['read', 'write'] })
  const models = new StaticAgentModelLookup([{ ref: { providerId: 'fixture-provider', modelId: 'fixture-model' }, available: true,
    efforts: [], speeds: [], contexts: [], capabilities: ['tools'], unavailableReasons: [] }])
  const resolver = new AgentResolver({ registry, integrationLookup: lookup, modelLookup: models })
  const createAgent = (slug: string, publish = true) => {
    const settings = defaultAgentSettings({ name: slug.toUpperCase(), slug, purpose: `${slug} purpose` })
    settings.primaryModel.ref = { providerId: 'fixture-provider', modelId: 'fixture-model' }
    settings.recovery.retryCount = 0
    const draft = registry.createDraft({ settings, systemPrompt: `You are ${slug}.` })
    if (publish) registry.publish(draft.id, draft.draftHash, { integrationLookup: lookup })
    return draft.id
  }
  const alice = createAgent('alice'), bob = createAgent('bob')
  const projects = new ProjectManager(root), threads = new ThreadDataStore(projects, root, { profileId, allowLegacyProjectData: false })
  projects.setThreadStore(threads)
  const questions = new UserQuestionService()
  const captured: Context[] = [], requests: AgentExecutionRequest[] = []
  const llm = nativeClient(outputs.map((text) => typeof text === 'string' ? providerResponse([{ type: 'text', text }], 'stop') : text), captured)
  const run = new AgentExecutionService({ native: createNativeAgentRuntime(llm) })
  const options = { services: { profileId, getProfileHomeDir: () => root, projects, threads, questions,
    events: { broadcast: vi.fn() }, orchestrator: {
      recordAgentDefinitionMessages: vi.fn(), runAgentDefinition: async (request: AgentExecutionRequest) => {
        requests.push(request)
        return override ? override(request) : run.run(request)
      }
    } } as any, registry, resolverFor: vi.fn(() => resolver) }
  const service = new AgentChatService(options); services.push(service)
  return { root, profileId, registry, resolver, createAgent, alice, bob, projects, threads, questions, captured, requests, options, service }
}

 describe('daemon-owned agent chats', () => {
  it('uses published identity rather than draft changes and excludes unpublished agents', () => {
    const f = fixture()
    f.createAgent('unpublished', false)
    const draft = f.registry.get(f.alice)
    f.registry.saveDraft(f.alice, { expectedDraftHash: draft.draftHash, settings: { identity: { ...draft.settings.identity, name: 'Draft Name' } } })
    expect(f.service.snapshot().agents.map((agent) => agent.name)).toEqual(['ALICE', 'BOB'])
    expect(f.service.snapshot().devices).toEqual([expect.objectContaining({ id: 'local', isLocal: true, online: true, name: expect.any(String) })])
  })
  it('creates one durable agent DM and round-trips actual history through the provider system/user channels', async () => {
    const f = fixture(['hello user', 'I remember'])
    const chat = await f.service.create({ kind: 'direct', agentIds: [f.alice] })
    expect((await f.service.create({ kind: 'direct', agentIds: [f.alice] })).id).toBe(chat.id)
    const admitted = f.service.send({ chatId: chat.id, text: 'hello', clientMessageId: 'first-message' })
    expect(admitted.run?.state).toBe('running')
    expect(f.service.send({ chatId: chat.id, text: 'hello', clientMessageId: 'first-message' }).messages).toHaveLength(1)
    expect(() => f.service.send({ chatId: chat.id, text: 'different', clientMessageId: 'first-message' })).toThrow(/different text/)
    await f.service.waitForIdle()
    expect(f.service.get(chat.id).messages.map((message) => message.text)).toEqual(['hello', 'hello user'])
    f.service.send({ chatId: chat.id, text: 'remember?' })
    await f.service.waitForIdle()
    expect(f.captured[1]!.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'hello' }),
      expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: 'hello user' }] }),
      expect.objectContaining({ role: 'user', content: 'remember?' })
    ])
    expect(f.captured[1]!.systemPrompt).toContain('You are alice.')
    expect(f.captured[1]!.systemPrompt).toContain('You are ALICE (@alice) in a Mousse direct chat')
    const reopened = new AgentChatService(f.options); services.push(reopened)
    expect(reopened.get(chat.id).messages).toHaveLength(4)
    expect(f.options.resolverFor).toHaveBeenCalledTimes(2)
  })
  it('rejects project-associated DMs without creating a backing thread, including while a valid DM is pending', async () => {
    const f = fixture()
    const repo = join(f.root, 'repo'); mkdirSync(repo)
    const project = f.projects.openProject(repo)
    const pending = f.service.create({ kind: 'direct', agentIds: [f.alice] })
    await expect(f.service.create({ kind: 'direct', agentIds: [f.alice], projectId: project.id })).rejects.toMatchObject({ code: 'invalid_params', message: 'Only groups can be associated with a project' })
    const chat = await pending
    expect(chat.projectId).toBeUndefined()
    expect(f.threads.listAllThreads()).toHaveLength(1)
    expect(f.threads.getThread(chat.threadId)?.projectId).toBeUndefined()
    expect(f.service.snapshot().chats).toHaveLength(1)
  })
  it('routes explicit user and agent @mentions through group members, retaining speaker identity and context', async () => {
    const f = fixture(['@bob please review this', 'I reviewed it'])
    const group = await f.service.create({ kind: 'group', name: 'Review', agentIds: [f.alice, f.bob] })
    f.service.send({ chatId: group.id, text: '@alice implement it' })
    await f.service.waitForIdle()
    const result = f.service.get(group.id)
    expect(result.run?.state).toBe('completed')
    expect(result.messages.map((message) => message.participantId)).toEqual(['self', f.alice, f.bob])
    expect(f.requests.map((request) => request.resolved.definitionId)).toEqual([f.alice, f.bob])
    expect(f.captured[1]!.systemPrompt).toContain('Participants: You, ALICE (@alice), BOB (@bob)')
    expect(f.captured[1]!.messages[0]).toEqual(expect.objectContaining({ role: 'user', content: '[You]\n@alice implement it' }))
    expect(f.captured[1]!.messages[1]).toEqual(expect.objectContaining({ role: 'user', content: 'Message from ALICE:\n@bob please review this' }))
    const binding = f.service.resourceBinding(group.id)
    expect(binding).toMatchObject({ profileId: f.profileId, chatId: group.id, threadId: group.threadId, participants: group.participants })
    expect(f.requests.every((request) => request.threadId === group.threadId && request.projectPath === binding.workspaceRoot)).toBe(true)
  })
  it('delivers prior agent replies when a user addresses multiple agents in one message', async () => {
    const f = fixture(['@bob alice reply', 'bob reply'])
    const group = await f.service.create({ kind: 'group', name: 'Both', agentIds: [f.alice, f.bob] })
    f.service.send({ chatId: group.id, text: '@alice @bob what do you think?' })
    await f.service.waitForIdle()
    expect(f.captured[1]!.messages[0]).toEqual(expect.objectContaining({ role: 'user', content: '[ALICE (@alice)]\n@bob alice reply' }))
    expect(f.service.get(group.id).run?.state).toBe('completed')
  })
  it('stops circular agent mentions and rejects references outside group membership', async () => {
    const f = fixture(['@bob continue', '@alice again'])
    const group = await f.service.create({ kind: 'group', name: 'Loop', agentIds: [f.alice, f.bob] })
    expect(() => f.service.send({ chatId: group.id, text: '@unknown hello' })).toThrow(/not an agent in this chat/)
    expect(f.service.get(group.id).messages).toHaveLength(0)
    f.service.send({ chatId: group.id, text: '@alice begin' })
    await f.service.waitForIdle()
    expect(f.requests).toHaveLength(2)
    expect(f.service.get(group.id).run).toMatchObject({ state: 'failed', error: expect.stringContaining('loop') })
    expect(chatMentions('email alice@example.com, ask @alice and @BOB')).toEqual(['alice', 'bob'])
  })
  it('bounds distinct handoffs independently of circular routing', async () => {
    const f = fixture(['@bob continue', ...Array.from({ length: 7 }, (_, index) => `@worker-${index} continue`)])
    const ids = [f.alice, f.bob, ...Array.from({ length: 7 }, (_, index) => f.createAgent(`worker-${index}`))]
    const group = await f.service.create({ kind: 'group', name: 'Bounded', agentIds: ids })
    f.service.send({ chatId: group.id, text: '@alice begin' })
    await f.service.waitForIdle()
    expect(f.requests).toHaveLength(8)
    expect(f.service.get(group.id).run).toMatchObject({ state: 'failed', error: expect.stringContaining('handoff limit') })
  })
  it('rejects ambiguous published slugs instead of guessing a group recipient', async () => {
    const f = fixture()
    const draft = f.registry.get(f.alice)
    f.registry.saveDraft(f.alice, { expectedDraftHash: draft.draftHash, settings: { identity: { ...draft.settings.identity, slug: 'alice-draft' } } })
    const duplicate = f.createAgent('alice')
    await expect(f.service.create({ kind: 'group', name: 'Ambiguous', agentIds: [f.alice, duplicate] })).rejects.toThrow(/distinct agent slugs/)
  })

  it('holds actual ownership after cancellation until the provider settles and releases it safely', async () => {
    let finish!: (result: any) => void
    const f = fixture([], (request) => new Promise((resolve) => { finish = resolve }))
    const chat = await f.service.create({ kind: 'direct', agentIds: [f.alice] })
    f.service.send({ chatId: chat.id, text: 'wait' })
    await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    const runId = f.service.get(chat.id).run!.id
    expect(() => f.service.send({ chatId: chat.id, text: 'second' })).toThrow(/response/)
    expect(() => f.service.cancel({ chatId: chat.id, runId: randomUUID() })).toThrow(/no longer current/)
    f.service.cancel({ chatId: chat.id, runId })
    expect(f.requests[0]!.signal!.aborted).toBe(true)
    expect(f.service.getActiveCount()).toBe(1)
    expect(tryAcquireExecutionLease(f.threads.getThreadDir(chat.threadId))).toBeNull()
    expect(() => f.service.assertLifecycleIdle(new Set([chat.threadId]))).toThrow(/active/)
    finish({ status: 'cancelled', text: '', history: [], usage: { elapsedMs: 0 } })
    await f.service.waitForIdle()
    expect(f.service.get(chat.id).run?.state).toBe('cancelled')
    const lease = tryAcquireExecutionLease(f.threads.getThreadDir(chat.threadId))!
    expect(lease).toBeTruthy(); releaseExecutionLeaseHandle(lease)
  })
  it('closes admission and waits for actual work on shutdown', async () => {
    const f = fixture([], async (request) => {
      await new Promise((resolve) => request.signal!.addEventListener('abort', resolve, { once: true }))
      return { status: 'cancelled', text: '', history: [], usage: { elapsedMs: 0 } }
    })
    const chat = await f.service.create({ kind: 'direct', agentIds: [f.alice] })
    f.service.send({ chatId: chat.id, text: 'wait' })
    await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    f.service.beginShutdown()
    expect(() => f.service.send({ chatId: chat.id, text: 'new' })).toThrow(/shutting down/)
    await f.service.dispose()
    expect(f.service.getActiveCount()).toBe(0)
    expect(f.service.get(chat.id).run?.state).toBe('cancelled')
  })
  it('marks abandoned durable responses interrupted on restart without replaying them', async () => {
    const f = fixture()
    const chat = await f.service.create({ kind: 'direct', agentIds: [f.alice] })
    const store = new ChatStore(f.root, f.profileId), record = store.read(chat.id)
    record.conversation.run = { id: randomUUID(), state: 'running', startedAt: new Date().toISOString() }
    store.write(record)
    const restarted = new AgentChatService(f.options); services.push(restarted)
    expect(restarted.get(chat.id).run?.state).toBe('interrupted')
    expect(f.requests).toHaveLength(0)
  })
  it('uses one existing task worktree for project agent execution and shared resources, including project instructions', async () => {
    const f = fixture(['project response'])
    const repo = join(f.root, 'repo'); mkdirSync(repo)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
    git('init'); git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'Fixture')
    writeFileSync(join(repo, 'tracked.txt'), 'tracked'); git('add', 'tracked.txt'); git('commit', '-m', 'fixture')
    writeFileSync(join(repo, 'AGENTS.md'), 'PROJECT CHAT AGENT RULES')
    const project = f.projects.openProject(repo)
    const group = await f.service.create({ kind: 'group', name: 'Project group', agentIds: [f.alice, f.bob], projectId: project.id })
    const binding = f.service.resourceBinding(group.id)
    expect(binding.workspaceRoot).not.toBe(repo)
    expect(existsSync(join(binding.workspaceRoot, 'tracked.txt'))).toBe(true)
    expect(readFileSync(join(binding.workspaceRoot, 'AGENTS.md'), 'utf8')).toBe('PROJECT CHAT AGENT RULES')
    f.service.send({ chatId: group.id, text: '@alice inspect' })
    await f.service.waitForIdle()
    expect(f.requests[0]!.projectPath).toBe(binding.workspaceRoot)
    expect(f.captured[0]!.systemPrompt).toContain('PROJECT CHAT AGENT RULES')
  })
  it('does not silently assign a remote device or accept another profile agent', async () => {
    const f = fixture()
    expect(() => f.service.assignDevice({ agentId: f.alice, deviceId: 'remote' })).toThrow(/this device only/)
    await expect(f.service.create({ kind: 'direct', agentIds: [randomUUID()] })).rejects.toThrow(/published active agent/)
    expect(() => new ChatStore(f.root, 'other-profile').list()).not.toThrow()
    const chat = await f.service.create({ kind: 'direct', agentIds: [f.alice] })
    expect(() => new ChatStore(f.root, 'other-profile').read(chat.id)).toThrow(/ownership/)
  })
  it('rejects tampered, cross-profile or symlinked chat storage', async () => {
    const f = fixture(), chat = await f.service.create({ kind: 'direct', agentIds: [f.alice] })
    const path = join(f.root, 'chats', `${chat.id}.json`)
    const record = JSON.parse(readFileSync(path, 'utf8')); record.profileId = 'other-profile'
    writeFileSync(path, JSON.stringify(record))
    expect(() => f.service.get(chat.id)).toThrow(/ownership/)
    const target = join(f.root, 'symlink-target.json'); writeFileSync(target, '{}')
    rmSync(path); symlinkSync(target, path)
    expect(() => f.service.get(chat.id)).toThrow(/regular file/)
  })
  it('authorizes only the exact live participant execution for shared browser access, including DMs', async () => {
    let finish!: (result: any) => void
    const f = fixture([], () => new Promise((resolve) => { finish = resolve }))
    const chat = await f.service.create({ kind: 'direct', agentIds: [f.alice] })
    f.service.send({ chatId: chat.id, text: 'browser' })
    await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    const request = f.requests[0]!
    const context = { profileId: f.profileId, threadId: chat.threadId, runId: request.runId,
      actor: { kind: 'agent', definitionId: f.alice, definitionRevision: request.resolved.revision }, source: 'gui' } as any
    expect(f.service.assertBrowserExecution(context)).toMatchObject({ chatId: chat.id, threadId: chat.threadId })
    expect(() => f.service.assertBrowserExecution({ ...context, profileId: 'wrong' })).toThrow(/profile/)
    expect(() => f.service.assertBrowserExecution({ ...context, runId: randomUUID() })).toThrow(/active chat agent/)
    expect(() => f.service.assertBrowserExecution({ ...context, actor: { ...context.actor, definitionId: f.bob } })).toThrow(/active chat agent/)
    expect(() => new AgentChatService(f.options)).toThrow(/live daemon/)
    finish({ status: 'completed', text: 'done', history: [], usage: { elapsedMs: 0 } })
    await f.service.waitForIdle()
    expect(() => f.service.assertBrowserExecution(context)).toThrow(/active chat agent/)
  })

  it('hydrates live tool approvals on chat reload and performs a real provider write only after exact approval', async () => {
    const f = fixture([
      providerResponse([{ type: 'toolCall', id: 'chat-write', name: 'write', arguments: { path: 'hello.txt', content: 'approved contents' } }], 'toolUse'),
      'I wrote the file'
    ])
    const draft = f.registry.get(f.alice)
    const updated = f.registry.saveDraft(f.alice, { expectedDraftHash: draft.draftHash,
      settings: { approval: { ...draft.settings.approval, policy: 'always' } } })
    f.registry.publish(f.alice, updated.draftHash)
    const group = await f.service.create({ kind: 'group', name: 'Writer', agentIds: [f.alice, f.bob] })
    const workspace = f.service.resourceBinding(group.id).workspaceRoot
    f.service.send({ chatId: group.id, text: '@alice write hello.txt' })
    await vi.waitFor(() => expect(f.service.get(group.id).pendingQuestions).toHaveLength(1))
    expect(existsSync(join(workspace, 'hello.txt'))).toBe(false)
    const pending = f.service.get(group.id).pendingQuestions![0]!
    expect(pending.questions[0]!.prompt).toContain('approved contents')
    expect(readFileSync(join(f.root, 'chats', `${group.id}.json`), 'utf8')).not.toContain('pendingQuestions')
    expect(f.questions.submitAnswers(pending.requestId, { approval: 'approve' })).toBe(true)
    await f.service.waitForIdle()
    expect(readFileSync(join(workspace, 'hello.txt'), 'utf8')).toBe('approved contents')
    expect(f.service.get(group.id).pendingQuestions).toEqual([])
    expect(f.service.get(group.id).run?.state).toBe('completed')
  })

  it('requires the existing exact tool approval dialog and denies mismatched argument digests', async () => {
    const decisions: unknown[] = []
    const f = fixture([], async (request) => {
      const args = { path: 'hello.txt', content: 'hello' }, digest = sha256Hex(canonicalJson(args))
      const approval = { profileId: request.profileId, threadId: request.threadId, runId: request.runId!,
        definitionId: request.resolved.definitionId, definitionRevision: request.resolved.revision,
        toolName: 'write', canonicalToolName: 'write', classification: 'write' as const, arguments: args,
        argumentDigest: 'bad', workspacePaths: [request.projectPath!] }
      decisions.push(await request.host!.approveToolRequest!(approval))
      decisions.push(await request.host!.approveToolRequest!({ ...approval, argumentDigest: digest }))
      return { status: 'completed', text: 'approved', history: [], usage: { elapsedMs: 0 } }
    })
    f.questions.on('pending', (question) => f.questions.submitAnswers(question.requestId, { approval: 'approve' }))
    const chat = await f.service.create({ kind: 'direct', agentIds: [f.alice] })
    f.service.send({ chatId: chat.id, text: 'write' })
    await f.service.waitForIdle()
    expect(decisions).toEqual([{ status: 'denied' }, { status: 'approved', digest: expect.stringMatching(/^[a-f0-9]{64}$/) }])
  })
})

describe('chat public RPC admission', () => {
  it('validates exact keys, identities, member counts, names and message bounds', () => {
    expect(() => validateChatParams('chats.create', { kind: 'group', agentIds: [randomUUID()] })).toThrow(/name/)
    expect(() => validateChatParams('chats.send', { chatId: randomUUID(), text: 'hi', participantId: 'agent' })).toThrow(/Unexpected field/)
    expect(() => validateChatParams('chats.send', { chatId: randomUUID(), text: 'hi', clientMessageId: '__proto__' })).toThrow(/idempotency/)
    expect(() => validateChatParams('chats.send', { chatId: randomUUID(), text: 'x'.repeat(256 * 1024 + 1) })).toThrow(/message/)
    expect(() => validateChatParams('chats.create', { kind: 'direct', agentIds: [randomUUID(), randomUUID()] })).toThrow(/distinct/)
    expect(() => validateChatParams('chats.create', { kind: 'direct', agentIds: [randomUUID()], projectId: randomUUID() })).toThrow(/Only groups/)
    expect(validateChatParams('chats.create', { kind: 'group', name: 'Project group', agentIds: [randomUUID()], projectId: randomUUID() })).toMatchObject({ kind: 'group', projectId: expect.any(String) })
  })
  it('binds methods to admitted profiles and capability without accepting spoofed profile or executor fields', async () => {
    const f = fixture(), domains = new DomainHandlerRegistry()
    registerChatMethods(domains, () => f.service)
    const ctx = { connection: { id: 'fixture', binding: { profileId: f.profileId, epoch: 1 }, capabilities: new Set([CHAT_CAPABILITY]) } } as any
    expect(await domains.dispatch(ctx, 'chats.snapshot', {})).toMatchObject({ agents: expect.any(Array), devices: expect.any(Array) })
    await expect(domains.dispatch(ctx, 'chats.snapshot', { profileId: 'other-profile' })).rejects.toMatchObject({ code: 'profile_mismatch' })
    await expect(domains.dispatch({ connection: { ...ctx.connection, capabilities: new Set() } } as any, 'chats.snapshot', {})).rejects.toMatchObject({ code: 'capability_required' })
    await expect(domains.dispatch(ctx, 'chats.create', { kind: 'direct', agentIds: [f.alice], cwd: '/tmp' })).rejects.toMatchObject({ code: 'unknown_field' })
  })
})
