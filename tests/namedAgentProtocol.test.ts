import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Context, AssistantMessage } from '@earendil-works/pi-ai'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { MmsProtocolServer, LocalMmsClient } from '../src/mms/protocol'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import type { AgentEpisode, NamedAgentIdentity } from '../src/shared/agentEpisodes'
import { gitFoundationFixture } from './fixtures/gitFoundation'
import { providerResponse, streamOf } from './fixtures/agent-platform/agent-runtime-policy/helpers'

let f: ReturnType<typeof gitFoundationFixture>, mms: MousseMainService, server: MmsProtocolServer, client: LocalMmsClient
const responses: AssistantMessage[] = [], captured: Context[] = []
beforeEach(async () => {
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  f = gitFoundationFixture()
  mms = await MousseMainService.create({ homeDir: f.home, headless: true, ownerKind: 'test' })
  await mms.start()
  const ownerToken = mms.getOwnerLease()!.owner.token
  server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
  const endpoint = await server.start()
  client = new LocalMmsClient({ homeDir: f.home, endpoint, ownerToken, clientType: 'gui' })
  await client.connect()
  const provider = mms.providerAuth.models.getProviders().find((entry) => mms.providerAuth.models.getModels(entry.id).length > 0)!
  const model = mms.providerAuth.models.getModels(provider.id)[0]
  vi.spyOn(mms.providerAuth, 'has').mockReturnValue(true)
  vi.spyOn(mms.providerAuth.models, 'getAuth').mockResolvedValue({ apiKey: 'fixture' } as never)
  vi.spyOn(mms.providerAuth.models, 'streamSimple').mockImplementation((_model, context) => {
    captured.push(structuredClone(context))
    const next = responses.shift(); if (!next) throw new Error('Named provider fixture exhausted')
    return streamOf(next) as never
  })
  const settings = mms.settings.get()
  mms.settings.set({ provider: { llmProvider: provider.id, model: model.id }, integrations: { ...settings.integrations,
    tools: { enabled: true, enabledTools: ['read', 'write', 'bash'] }, skills: { ...settings.integrations.skills, enabled: false }, mcp: { ...settings.integrations.mcp, enabled: false } } })
}, 30_000)
afterEach(async () => { await client?.close(); await server?.stop(); await mms?.stop(); vi.restoreAllMocks(); f?.dispose(); responses.length = 0; captured.length = 0 })


/** Text of the latest user message in a provider context. */
function lastUserText(context: Context): string {
  const user = [...context.messages].reverse().find((message) => message.role === 'user')
  if (!user) return ''
  return typeof user.content === 'string' ? user.content : user.content.map((part) => ('text' in part ? part.text : '')).join('')
}
/** Tool results since the latest user message. */
function toolResultsSinceUser(context: Context) {
  const index = context.messages.map((message) => message.role).lastIndexOf('user')
  return context.messages.slice(index + 1).filter((message) => message.role === 'toolResult')
}
const toolCall = (id: string, name: string, args: Record<string, unknown>) => providerResponse([{ type: 'toolCall', id, name, arguments: args }], 'toolUse')
const text = (value: string) => providerResponse([{ type: 'text', text: value }], 'stop')
const DELEGATION_ID = /Delegated task (delegation:[0-9a-f-]+)/

async function completed(threadId: string, episodeId: string) {
  let value!: { agent: NamedAgentIdentity; episode: AgentEpisode }
  await vi.waitFor(async () => {
    const state = await client.request<{ identities: NamedAgentIdentity[]; episodes: AgentEpisode[] }>('agents.listNamed', { threadId })
    const episode = state.episodes.find((entry) => entry.id === episodeId)!
    expect(episode.state).toBe('completed')
    value = { agent: state.identities.find((entry) => entry.id === episode.agentId)!, episode }
  }, { timeout: 15_000, interval: 40 })
  return value
}

it('creates a real named shared reader by default, denies emitted writes and durably exposes its completed episode', async () => {
  const project = mms.projects.openProject(f.repo), thread = mms.threads.createThread('Named reader', project.id)
  responses.push(providerResponse([
    { type: 'toolCall', id: 'bad-write', name: 'write', arguments: { path: 'value.txt', content: 'bad' } },
    { type: 'toolCall', id: 'read-value', name: 'read', arguments: { path: 'value.txt' } }
  ], 'toolUse'), providerResponse([{ type: 'text', text: 'Read the task' }], 'stop'))
  const input = { threadId: thread.id, name: 'Reviewer', task: 'Review value.txt', operationId: 'named-reader-1' }
  const admission = await client.request<{ agent: NamedAgentIdentity; episode: AgentEpisode }>('agents.createNamed', input)
  expect(admission.episode.state).toBe('queued')
  const result = await completed(thread.id, input.operationId)
  expect(result.agent).toMatchObject({ name: 'Reviewer', state: 'dormant', contextGeneration: 1 })
  expect(result.episode).toMatchObject({ state: 'completed', policy: { workspace: 'shared', access: 'read-only' }, binding: { consistency: 'moving' } })
  const metadata = new ThreadWorkspaceManager(mms.threads.getThreadDir(thread.id)).load()!
  expect(result.episode.binding.worktreePath).toBe(metadata.worktreePath)
  expect(f.read(metadata.worktreePath)).toBe('base\n'); expect(f.read(f.repo)).toBe('base\n')
  expect(JSON.stringify(captured[1].messages)).toContain('prohibited by read-only')
  expect(await client.request('agents.createNamed', input)).toEqual(result)
  const listed = await client.request<{ episodes: AgentEpisode[] }>('agents.listNamed', { threadId: thread.id })
  expect(listed.episodes).toEqual([result.episode])
  expect(readFileSync(join(mms.threads.getThreadDir(thread.id), 'agent-episodes.json'), 'utf8')).toContain('Reviewer')
  await expect(client.request('agents.createNamed', { ...input, operationId: 'different' })).rejects.toThrow('already exists')
}, 30_000)

it('executes a named shared writer under the task lease and records code receipt without changing primary', async () => {
  const project = mms.projects.openProject(f.repo), thread = mms.threads.createThread('Named writer', project.id)
  responses.push(providerResponse([{ type: 'toolCall', id: 'write-value', name: 'write', arguments: { path: 'value.txt', content: 'named result\n' } }], 'toolUse'),
    providerResponse([{ type: 'text', text: 'Written' }], 'stop'))
  await client.request<{ episode: AgentEpisode }>('agents.createNamed', { threadId: thread.id, name: 'Writer', task: 'Edit value.txt', operationId: 'named-writer-1', access: 'write' })
  const result = await completed(thread.id, 'named-writer-1')
  expect(result.episode.state).toBe('completed')
  expect(result.episode.result?.receiptId).toBeTruthy()
  expect(f.read(result.episode.binding.worktreePath)).toBe('named result\n')
  expect(f.read(f.repo)).toBe('base\n')
  expect(existsSync(join(mms.threads.getThreadDir(thread.id), 'execution.lease'))).toBe(false)
}, 30_000)
// Phase 4 (SPEC §14): create_subagent is a wrapper over delegate_task. The parent no longer
// blocks inside the tool call: the child is a thread with lineage, its completion is an inbox row,
// and reconciler rule 4 wakes the parent, which reads the result and integrates the isolated work.
it('delegates main to an isolated writer thread, wakes main with its result and integrates it', async () => {
  const project = mms.projects.openProject(f.repo), thread = mms.threads.createThread('Nested writers', project.id)
  const seen: string[] = []
  vi.mocked(mms.providerAuth.models.streamSimple).mockImplementation((_model, context) => {
    captured.push(structuredClone(context))
    const prompt = lastUserText(context), results = toolResultsSinceUser(context)
    seen.push(`${prompt.slice(0, 24)}#${results.length}`)
    if (prompt === 'Delegate the change.') return streamOf(results.length ? text('Main delegated') : toolCall('create-worker', 'create_subagent', { name: 'Worker', task: 'Write value', access: 'write' })) as never
    if (prompt === 'Write value') return streamOf(results.length ? text('Worker done') : toolCall('worker-write', 'write', { path: 'value.txt', content: 'child result\n' })) as never
    const delegationId = DELEGATION_ID.exec(prompt)?.[1]
    if (delegationId) {
      if (results.length === 0) return streamOf(toolCall('main-status', 'task_status', { delegationId })) as never
      if (results.length === 1) return streamOf(toolCall('main-integrate', 'integrate_delegation', { delegationId })) as never
      return streamOf(text('Integration requested')) as never
    }
    if (prompt.startsWith('Integration of delegated task')) return streamOf(text('Integrated')) as never
    return streamOf(text('unexpected')) as never
  })
  const result = await client.request<{ message: string }>('orchestrator.send', { threadId: thread.id, content: 'Delegate the change.', mode: 'agent' })
  expect(result.message).toBe('Main delegated')
  const [delegation] = mms.orchestrator.listDelegations(thread.id)
  expect(delegation).toMatchObject({ title: 'Worker' })
  const child = mms.threads.getThread(delegation.childThreadId)!
  expect(child.projectId).toBe(project.id)
  await vi.waitFor(() => {
    expect(mms.orchestrator.getMessages(thread.id).some((message) => message.role === 'assistant' && message.content === 'Integrated')).toBe(true)
  }, { timeout: 20_000, interval: 50 })
  expect(mms.orchestrator.listDelegations(thread.id)[0].status).toBe('acknowledged')
  const status = captured.flatMap((context) => context.messages).find((message) => message.role === 'toolResult' && message.toolName === 'task_status')
  expect(JSON.stringify(status)).toContain('Worker done')
  const childWorkspace = new ThreadWorkspaceManager(mms.threads.getThreadDir(child.id)).load()!
  const mainWorkspace = new ThreadWorkspaceManager(mms.threads.getThreadDir(thread.id)).load()!
  expect(childWorkspace.worktreePath).not.toBe(mainWorkspace.worktreePath)
  expect(f.read(childWorkspace.worktreePath)).toBe('child result\n')
  expect(f.read(mainWorkspace.worktreePath)).toBe('child result\n')
  expect(f.read(f.repo)).toBe('base\n')
  expect(seen).toContain('Write value#0')
}, 45_000)
it('recalls the same named identity with native context and rejects stale concurrent generations', async () => {
  const project = mms.projects.openProject(f.repo), thread = mms.threads.createThread('Recall', project.id)
  responses.push(providerResponse([{ type: 'text', text: 'Remember continuity-marker-519' }], 'stop'))
  await client.request('agents.createNamed', { threadId: thread.id, name: 'Rememberer', task: 'Remember the marker', operationId: 'remember-first' })
  const first = await completed(thread.id, 'remember-first')
  responses.push(providerResponse([{ type: 'text', text: 'Recalled continuity-marker-519' }], 'stop'))
  const input = { threadId: thread.id, agent: first.agent.id, task: 'Recall your marker', operationId: 'remember-second', expectedAgentGeneration: 1 }
  await client.request('agents.recallNamed', input)
  const second = await completed(thread.id, 'remember-second')
  expect(second.agent.id).toBe(first.agent.id)
  expect(second.agent.contextGeneration).toBe(2)
  expect(captured[1].messages.some((message) => message.role === 'assistant' && JSON.stringify(message).includes('continuity-marker-519'))).toBe(true)
  expect(JSON.stringify(captured[1].messages)).toContain('Mousse recall notice')
  expect(await client.request('agents.recallNamed', input)).toEqual(second)
  await expect(client.request('agents.recallNamed', { ...input, operationId: 'remember-third' })).rejects.toThrow('generation')
  await expect(client.request('mousseAgent.retry', { threadId: thread.id, agentId: first.agent.id })).rejects.toThrow('recall')
}, 30_000)
it('retires a completed isolated checkout and integrates its pinned result after verified reconstruction', async () => {
  const project = mms.projects.openProject(f.repo), thread = mms.threads.createThread('Isolated retirement', project.id)
  responses.push(providerResponse([{ type: 'toolCall', id: 'isolated-write', name: 'write', arguments: { path: 'value.txt', content: 'isolated result\n' } }], 'toolUse'), providerResponse([{ type: 'text', text: 'Done' }], 'stop'))
  await client.request('agents.createNamed', { threadId: thread.id, name: 'Isolated', task: 'Edit value', operationId: 'isolated-first', workspace: 'isolated', access: 'write' })
  const result = await completed(thread.id, 'isolated-first')
  await vi.waitFor(() => expect(existsSync(result.episode.binding.worktreePath)).toBe(false), { timeout: 10_000 })
  expect(mms.orchestrator.listMousseAgentSessionIds()).not.toContain(result.agent.id)
  const manager = new ThreadWorkspaceManager(mms.threads.getThreadDir(thread.id)), metadata = manager.load()!
  expect(f.read(metadata.worktreePath)).toBe('base\n')
  const request = { threadId: thread.id, agent: result.agent.id, episodeId: result.episode.id, operationId: 'integrate-isolated-first', expectedResultSha: result.episode.result!.resultSha, expectedDestinationSha: metadata.headSha }
  const integrated = await client.request('agents.integrateNamed', request)
  expect(f.read(metadata.worktreePath)).toBe('isolated result\n')
  expect(existsSync(result.episode.binding.worktreePath)).toBe(false)
  expect(await client.request('agents.integrateNamed', request)).toEqual(integrated)
  expect(existsSync(result.episode.binding.worktreePath)).toBe(false)
  expect(f.read(f.repo)).toBe('base\n')
}, 45_000)

it('provisions first-use task editor writes and commits only in the owned checkout', async () => {
  const project = mms.projects.openProject(f.repo), thread = mms.threads.createThread('First editor save', project.id)
  await client.request('files.write', { threadId: thread.id, path: 'value.txt', content: 'editor-owned\n' })
  const metadata = new ThreadWorkspaceManager(mms.threads.getThreadDir(thread.id)).load()!
  expect(f.read(metadata.worktreePath)).toBe('editor-owned\n')
  expect(f.read(f.repo)).toBe('base\n')
  writeFileSync(join(metadata.worktreePath, 'value.txt'), 'manual owned change\n')
  await client.request('git.commit', { threadId: thread.id, message: 'Reviewed manual owned change' })
  expect(new ThreadWorkspaceManager(mms.threads.getThreadDir(thread.id)).verify().lifecycle).toBe('ready')
  await expect(client.request('git.checkout', { threadId: thread.id, branch: 'master' })).rejects.toThrow('authoritative')
  expect(f.read(f.repo)).toBe('base\n')
}, 30_000)

// Phase 4: create_subagents starts every valid assignment as its own child thread and returns at
// once; a failed admission is reported per item and does not stop the others.
it('starts every valid parallel assignment without waiting and reports a failed admission', async () => {
  const project = mms.projects.openProject(f.repo), thread = mms.threads.createThread('Parallel batch', project.id)
  let release!: () => void
  const delayed = new Promise<void>((resolve) => { release = resolve })
  let entered = 0
  vi.mocked(mms.providerAuth.models.streamSimple).mockImplementation((_model, context) => {
    captured.push(structuredClone(context))
    const prompt = lastUserText(context), results = toolResultsSinceUser(context)
    if (prompt === 'Run parallel agents') {
      if (results.length) return streamOf(text('Batch started')) as never
      return streamOf(toolCall('parallel-batch', 'create_subagents', { agents: [
        { name: 'Empty', task: '   ', workspace: 'isolated' },
        { name: 'Slow A', task: 'slow-a', workspace: 'isolated' },
        { name: 'Slow B', task: 'slow-b', workspace: 'isolated' }
      ] })) as never
    }
    if ((prompt === 'slow-a' || prompt === 'slow-b') && !results.length) {
      entered += 1
      return { async *[Symbol.asyncIterator]() { await delayed }, result: async () => text(`${prompt} finished`) } as never
    }
    return streamOf(text('Batch settled')) as never
  })
  try {
    const result = await client.request<{ message: string }>('orchestrator.send', { threadId: thread.id, content: 'Run parallel agents', mode: 'agent' })
    expect(result.message).toBe('Batch started')
    await vi.waitFor(() => expect(entered).toBe(2), { timeout: 15_000 })
    const batchResult = captured.flatMap((context) => context.messages).find((message) => message.role === 'toolResult' && message.toolName === 'create_subagents')
    expect(JSON.stringify(batchResult)).toContain('needs a prompt')
    const started = mms.orchestrator.listDelegations(thread.id)
    expect(started.map((entry) => entry.title).sort()).toEqual(['Slow A', 'Slow B'])
    expect(started.every((entry) => entry.status === 'running')).toBe(true)
    release()
    await vi.waitFor(() => {
      expect(mms.orchestrator.listDelegations(thread.id).every((entry) => entry.childRunStatus === 'completed' && entry.status !== 'running')).toBe(true)
    }, { timeout: 15_000, interval: 50 })
  } finally { release() }
}, 45_000)
// Phase 4: task_cancel stops a child and everything it delegated, depth-first; a cancelled child
// cannot publish its late result.
it('cancels a delegated child and its nested delegation depth-first, aborting the live grandchild', async () => {
  const project = mms.projects.openProject(f.repo), thread = mms.threads.createThread('Cancel descendants', project.id)
  let release!: () => void, observeAbort!: () => void
  const draining = new Promise<void>((resolve) => { release = resolve })
  const aborted = new Promise<void>((resolve) => { observeAbort = resolve })
  let nestedEntered = false
  vi.mocked(mms.providerAuth.models.streamSimple).mockImplementation((_model, context, options) => {
    captured.push(structuredClone(context))
    const prompt = lastUserText(context), results = toolResultsSinceUser(context)
    if (prompt === 'Delegate nested') return streamOf(results.length ? text('Main delegated') : toolCall('main-create', 'create_subagent', { name: 'Parent cancel', task: 'Delegate deeper', access: 'write' })) as never
    if (prompt === 'Delegate deeper') return streamOf(results.length ? text('Child delegated') : toolCall('child-create', 'create_subagent', { name: 'Nested cancel', task: 'Wait for cancellation', access: 'write' })) as never
    if (prompt === 'Wait for cancellation' && !results.length) {
      nestedEntered = true
      return { async *[Symbol.asyncIterator]() {
        if (options?.signal?.aborted) observeAbort()
        else options?.signal?.addEventListener('abort', observeAbort, { once: true })
        await draining
      }, result: async () => text('Drained') } as never
    }
    return streamOf(text('ok')) as never
  })
  try {
    await client.request('orchestrator.send', { threadId: thread.id, content: 'Delegate nested', mode: 'agent' })
    await vi.waitFor(() => expect(nestedEntered).toBe(true), { timeout: 15_000 })
    const [child] = mms.orchestrator.listDelegations(thread.id)
    const [grandchild] = mms.orchestrator.listDelegations(child.childThreadId)
    expect(grandchild).toMatchObject({ title: 'Nested cancel', status: 'running' })
    const cancelled = await mms.orchestrator.cancelDelegation(thread.id, child.delegationId)
    expect(cancelled.cancelled).toEqual([grandchild.delegationId, child.delegationId])
    await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(new Error('Descendant did not receive cancellation')), 5_000))])
    release()
    await vi.waitFor(() => {
      const [nested] = mms.orchestrator.listDelegations(child.childThreadId)
      expect(nested.status).toBe('cancelled')
      expect(['interrupted', 'cancelled']).toContain(nested.childRunStatus)
    }, { timeout: 15_000, interval: 50 })
    expect(mms.orchestrator.listDelegations(thread.id)[0].status).toBe('cancelled')
  } finally { release() }
}, 45_000)
