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
it('delegates main to a shared writer and nested writer without reacquiring the physical task lease', async () => {
  const project = mms.projects.openProject(f.repo), thread = mms.threads.createThread('Nested writers', project.id)
  const call = (id: string, name: string, args: Record<string, unknown>) => providerResponse([{ type: 'toolCall', id, name, arguments: args }], 'toolUse')
  const done = (text: string) => providerResponse([{ type: 'text', text }], 'stop')
  responses.push(call('create-worker', 'create_subagent', { name: 'Worker', task: 'Delegate and edit', access: 'write' }),
    call('create-nested', 'create_subagent', { name: 'Nested', task: 'Write value', access: 'write' }),
    call('nested-write', 'write', { path: 'value.txt', content: 'nested result\n' }), done('Nested done'),
    call('worker-read', 'read', { path: 'value.txt' }), done('Worker done'),
    call('main-read', 'read', { path: 'value.txt' }), done('Main done'))
  const result = await client.request<{ message: string }>('orchestrator.send', { threadId: thread.id, content: 'Delegate the change.', mode: 'agent' })
  expect(result.message).toBe('Main done')
  const state = await client.request<{ episodes: AgentEpisode[] }>('agents.listNamed', { threadId: thread.id })
  expect(state.episodes).toHaveLength(2)
  expect(state.episodes.every((episode) => episode.state === 'completed')).toBe(true)
  expect(state.episodes[1].parentEpisodeId).toBe(state.episodes[0].id)
  expect(new Set(state.episodes.map((episode) => episode.binding.worktreePath)).size).toBe(1)
  expect(f.read(state.episodes[0].binding.worktreePath)).toBe('nested result\n')
  expect(f.read(f.repo)).toBe('base\n')
  expect(JSON.stringify(captured.at(-1)?.messages)).toContain('nested result')
}, 30_000)
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

it('waits for every parallel isolated assignment when another batch admission fails', async () => {
  const project = mms.projects.openProject(f.repo), thread = mms.threads.createThread('Parallel batch', project.id)
  let release!: () => void
  const delayed = new Promise<void>((resolve) => { release = resolve })
  let entered = 0, mainFinished = false
  const batch = providerResponse([{ type: 'toolCall', id: 'parallel-batch', name: 'create_subagents', arguments: { agents: [
    { name: 'invalid/name', task: 'fail admission', workspace: 'isolated' },
    { name: 'Slow A', task: 'slow-a', workspace: 'isolated' },
    { name: 'Slow B', task: 'slow-b', workspace: 'isolated' }
  ] } }], 'toolUse')
  let calls = 0
  vi.mocked(mms.providerAuth.models.streamSimple).mockImplementation((_model, context) => {
    captured.push(structuredClone(context))
    if (calls++ === 0) return streamOf(batch) as never
    if (JSON.stringify(context.messages).includes('slow-a') && !context.messages.some((message) => message.role === 'toolResult') || JSON.stringify(context.messages).includes('slow-b') && !context.messages.some((message) => message.role === 'toolResult')) {
      entered += 1
      return { async *[Symbol.asyncIterator]() { await delayed }, result: async () => providerResponse([{ type: 'text', text: 'Isolated finished' }], 'stop') } as never
    }
    mainFinished = true
    return streamOf(providerResponse([{ type: 'text', text: 'Batch settled' }], 'stop')) as never
  })
  const running = client.request<{ message: string }>('orchestrator.send', { threadId: thread.id, content: 'Run parallel agents', mode: 'agent' })
  try {
    await vi.waitFor(() => expect(entered).toBe(2), { timeout: 15_000 })
    expect(mainFinished).toBe(false)
    release()
    expect((await running).message).toBe('Batch settled')
    const state = await client.request<{ episodes: AgentEpisode[] }>('agents.listNamed', { threadId: thread.id })
    expect(state.episodes).toHaveLength(2)
    expect(state.episodes.every((episode) => episode.state === 'completed')).toBe(true)
    expect(JSON.stringify(captured.at(-1)?.messages)).toContain('rejected')
  } finally { release(); await running.catch(() => undefined) }
}, 45_000)
it('cancels nested named writers and holds physical ownership until the child callback actually drains', async () => {
  const project = mms.projects.openProject(f.repo), thread = mms.threads.createThread('Cancel descendants', project.id)
  let release!: () => void, observeAbort!: () => void
  const draining = new Promise<void>((resolve) => { release = resolve })
  const aborted = new Promise<void>((resolve) => { observeAbort = resolve })
  let calls = 0, nestedEntered = false
  vi.mocked(mms.providerAuth.models.streamSimple).mockImplementation((_model, context, options) => {
    captured.push(structuredClone(context))
    if (calls++ === 0) return streamOf(providerResponse([{ type: 'toolCall', id: 'nested-cancel', name: 'create_subagent', arguments: { name: 'Nested cancel', task: 'Wait for cancellation', access: 'write' } }], 'toolUse')) as never
    nestedEntered = true
    return { async *[Symbol.asyncIterator]() {
      if (options?.signal?.aborted) observeAbort()
      else options?.signal?.addEventListener('abort', observeAbort, { once: true })
      await draining
    }, result: async () => providerResponse([{ type: 'text', text: 'Drained' }], 'stop') } as never
  })
  const admitted = await client.request<{ agent: NamedAgentIdentity }>('agents.createNamed', { threadId: thread.id, name: 'Parent cancel', task: 'Delegate nested', operationId: 'cancel-parent', access: 'write' })
  let stopped: Promise<unknown> | undefined
  try {
    await vi.waitFor(() => expect(nestedEntered).toBe(true), { timeout: 15_000 })
    stopped = client.request('agents.stop', { threadId: thread.id, agentId: admitted.agent.id, merge: false })
    await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(new Error('Descendant did not receive cancellation')), 5_000))])
    expect(existsSync(join(mms.threads.getThreadDir(thread.id), 'execution.lease'))).toBe(true)
    release(); await stopped
    await vi.waitFor(() => expect(existsSync(join(mms.threads.getThreadDir(thread.id), 'execution.lease'))).toBe(false))
    const state = await client.request<{ episodes: AgentEpisode[] }>('agents.listNamed', { threadId: thread.id })
    expect(state.episodes).toHaveLength(2)
    expect(state.episodes.every((episode) => ['interrupted', 'failed'].includes(episode.state))).toBe(true)
  } finally { release(); await stopped?.catch(() => undefined) }
}, 30_000)
