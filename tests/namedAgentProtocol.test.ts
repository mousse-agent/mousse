import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Context, AssistantMessage } from '@earendil-works/pi-ai'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { MmsProtocolServer, LocalMmsClient } from '../src/mms/protocol'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { gitFoundationFixture } from './fixtures/gitFoundation'
import { seedLegacyNamedEpisode } from './fixtures/legacy-named-agent'
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


/** Text of the latest user message in a provider context, without the preamble a subagent's first prompt starts with. */
function lastUserText(context: Context): string {
  const user = [...context.messages].reverse().find((message) => message.role === 'user')
  if (!user) return ''
  const content = typeof user.content === 'string' ? user.content : user.content.map((part) => ('text' in part ? part.text : '')).join('')
  return content.replace(/^You are a subagent of "[^"]*"\.[^\n]*\n\n/, '')
}
/** Tool results since the latest user message. */
function toolResultsSinceUser(context: Context) {
  const index = context.messages.map((message) => message.role).lastIndexOf('user')
  return context.messages.slice(index + 1).filter((message) => message.role === 'toolResult')
}
const toolCall = (id: string, name: string, args: Record<string, unknown>) => providerResponse([{ type: 'toolCall', id, name, arguments: args }], 'toolUse')
const text = (value: string) => providerResponse([{ type: 'text', text: value }], 'stop')
const DELEGATION_ID = /finished task (delegation:[0-9a-f-]+)/

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
// Phase 4: task_cancel stops a child and everything it delegated, depth-first; a cancelled
// descendant cannot publish its late result. The child's own delegation may already be read (its
// result was delivered and acknowledged before the cancel), so only the descendant is asserted.
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
    expect(cancelled.cancelled[0]).toBe(grandchild.delegationId)
    await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(new Error('Descendant did not receive cancellation')), 5_000))])
    release()
    await vi.waitFor(() => {
      const [nested] = mms.orchestrator.listDelegations(child.childThreadId)
      expect(nested.status).toBe('cancelled')
      expect(['interrupted', 'cancelled']).toContain(nested.childRunStatus)
    }, { timeout: 15_000, interval: 50 })
  } finally { release() }
}, 45_000)

it('refuses to stop or merge a retired named agent from old task data and leaves it untouched', async () => {
  const project = mms.projects.openProject(f.repo), thread = mms.threads.createThread('Legacy named agent', project.id)
  const { agentId } = seedLegacyNamedEpisode(mms.threads.getThreadDir(thread.id), { worktreePath: f.repo })
  const registry = mms.orchestrator.getAgentsForThread(thread.id)
  registry.create({ cliType: 'mousse', executionMode: 'gui', task: 'Legacy named agent task', worktreePath: f.repo, status: 'ready' }, agentId)
  await expect(mms.orchestrator.stopAgentForThread(thread.id, agentId, true)).rejects.toThrow(/retired named agent/)
  const logs = await mms.orchestrator.stopAgentForThread(thread.id, agentId, false)
  expect(logs.join(' ')).toMatch(/retired named agent.*Nothing was stopped or changed/)
  expect(registry.get(agentId)?.status).toBe('ready')
}, 30_000)
