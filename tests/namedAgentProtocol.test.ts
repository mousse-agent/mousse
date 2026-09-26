import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
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
