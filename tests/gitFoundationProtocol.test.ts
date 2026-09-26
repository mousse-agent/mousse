import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@earendil-works/pi-ai'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { ChildAgentIntegrationService } from '../src/mms/agents/ChildAgentIntegrationService'
import { waitAcquireExecutionLease, releaseExecutionLeaseHandle } from '../src/mms/queue/ThreadExecutionLease'
import { isWorkflowRevisionCurrent } from '../src/mms/workspace/WorkflowWorkspace'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { actionOptions, git, gitFoundationFixture } from './fixtures/gitFoundation'
import { providerResponse, streamOf } from './fixtures/agent-platform/agent-runtime-policy/helpers'

describe('Git foundation through daemon protocol', () => {
  let f: ReturnType<typeof gitFoundationFixture>
  let mms: MousseMainService
  let server: MmsProtocolServer
  let client: LocalMmsClient
  beforeEach(async () => {
    f = gitFoundationFixture()
    mms = await MousseMainService.create({ homeDir: f.home, headless: true, ownerKind: 'test' })
    await mms.start()
    const ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    const endpoint = await server.start()
    client = new LocalMmsClient({ homeDir: f.home, endpoint, ownerToken, clientType: 'gui' })
    await client.connect()
  }, 30_000)
  afterEach(async () => {
    vi.restoreAllMocks()
    await client?.close()
    await server?.stop()
    await mms?.stop()
    f?.dispose()
  })

  it('a public main-agent send writes through real tools into the task and a read-only follow-up reads those bytes', async () => {
    const provider = mms.providerAuth.models.getProviders().find((item) => mms.providerAuth.models.getModels(item.id).length > 0)!
    const model = mms.providerAuth.models.getModels(provider.id)[0]
    vi.spyOn(mms.providerAuth, 'has').mockReturnValue(true)
    vi.spyOn(mms.providerAuth.models, 'getAuth').mockResolvedValue({ apiKey: 'fixture' } as never)
    const settings = mms.settings.get()
    mms.settings.set({ provider: { llmProvider: provider.id, model: model.id }, integrations: {
      ...settings.integrations, tools: { enabled: true, enabledTools: ['read', 'write'] },
      skills: { ...settings.integrations.skills, enabled: false }, mcp: { ...settings.integrations.mcp, enabled: false }
    } })
    const captured: Context[] = []
    const responses = [
      providerResponse([{ type: 'toolCall', id: 'main-write', name: 'write', arguments: { path: 'value.txt', content: 'main-agent bytes\n' } }], 'toolUse'),
      providerResponse([{ type: 'text', text: 'Wrote task bytes.' }], 'stop'),
      providerResponse([{ type: 'toolCall', id: 'main-read', name: 'read', arguments: { path: 'value.txt' } }], 'toolUse'),
      providerResponse([{ type: 'text', text: 'Read task bytes.' }], 'stop')
    ]
    vi.spyOn(mms.providerAuth.models, 'streamSimple').mockImplementation((_model, context) => {
      if (!context.tools?.length) return streamOf(providerResponse([{ type: 'text', text: 'Task title' }], 'stop')) as never
      captured.push(structuredClone(context))
      const next = responses.shift()
      if (!next) throw new Error('Main provider fixture exhausted')
      return streamOf(next) as never
    })
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Actual main agent', project.id)
    const result = await client.request<{ message: string }>('orchestrator.send', { threadId: thread.id, content: 'Write value.txt in this task.', mode: 'agent' })
    expect(result.message).toContain('Wrote task bytes')
    const metadata = new ThreadWorkspaceManager(mms.threads.getThreadDir(thread.id)).load()!
    expect(f.read(metadata.worktreePath)).toBe('main-agent bytes\n')
    expect(f.read(f.repo)).toBe('base\n')
    await client.request('orchestrator.send', { threadId: thread.id, content: 'Read value.txt without changes.', mode: 'ask' })
    expect(JSON.stringify(captured.at(-1)?.messages.filter((message) => message.role === 'toolResult'))).toContain('main-agent bytes')
    expect((await client.request<{ content: string }>('files.read', { threadId: thread.id, path: 'value.txt' })).content).toContain('main-agent bytes')
    expect(new ThreadActionService(mms.threads.getThreadDir(thread.id)).list().some((action) => action.receiptId && action.changedPaths.some((path) => path.path === 'value.txt'))).toBe(true)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseSha)
  }, 45_000)

  it('main resolution, read-only follow-up and GUI file requests share one task while a second task and primary stay isolated', async () => {
    const project = mms.projects.openProject(f.repo)
    const a = mms.threads.createThread('Task A', project.id)
    const b = mms.threads.createThread('Task B', project.id)
    const aDir = mms.threads.getThreadDir(a.id)
    const resolver = new WorkspaceResolver(aDir, a.id, f.repo)
    const writer = await resolver.resolve('agent')
    const other = await new WorkspaceResolver(mms.threads.getThreadDir(b.id), b.id, f.repo).resolve('agent')
    expect(writer.workspacePath).not.toBe(f.repo)
    expect(writer.workspacePath).not.toBe(other.workspacePath)
    await new ThreadActionService(aDir).runCheckpointedAction({ ...actionOptions(writer.workspacePath!), threadId: a.id }, () => {
      writeFileSync(join(writer.workspacePath!, 'value.txt'), 'task A\n')
    })
    const reader = await resolver.resolve('ask')
    expect(reader.workspacePath).toBe(writer.workspacePath)
    const fromGui = await client.request<{ path: string; content: string }>('files.read', { threadId: a.id, path: 'value.txt' })
    expect(fromGui.path).toBe('value.txt')
    expect(fromGui.content.replace(/\r\n/g, '\n')).toBe('task A\n')
    const otherGui = await client.request<{ content: string }>('files.read', { threadId: b.id, path: 'value.txt' })
    expect(otherGui.content.replace(/\r\n/g, '\n')).toBe('base\n')
    expect(f.read(f.repo)).toBe('base\n')
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseSha)
    expect(git(f.repo, 'status', '--porcelain')).toBe('')
  }, 30_000)

  it('public undo/redo selects a parent turn completed after its midturn snapshot and child integration', async () => {
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Parent turn', project.id)
    const threadDir = mms.threads.getThreadDir(thread.id)
    const workspace = (await new WorkspaceResolver(threadDir, thread.id, f.repo).resolve('agent')).workspacePath!
    const actions = new ThreadActionService(threadDir)
    const lease = await waitAcquireExecutionLease(threadDir, { source: 'test-parent-turn' })
    const options = { ...actionOptions(workspace, 'parent-turn'), threadId: thread.id, heldThreadLease: lease }
    mms.orchestrator.replaceConversationState(thread.id, [
      { id: 'user-message', role: 'user', content: 'Make the task change', timestamp: Date.now() },
      { id: 'assistant-message', role: 'assistant', content: 'Task changed', timestamp: Date.now() }
    ], {
      version: 2, fidelity: 'native', activeStartIndex: 0,
      messages: [
        { role: 'user', content: 'Make the task change', timestamp: Date.now() },
        { role: 'user', content: 'Task result checkpoint', timestamp: Date.now() }
      ]
    })
    let parentId: string
    let finalHead: string
    let nestedRevision: { workspaceId: string; readSha: string; writeSha: string; receiptId?: string }
    try {
      const parent = actions.beginTurn(options, f.baseSha)
      parentId = parent.id
      writeFileSync(join(workspace, 'parent.txt'), 'parent before child\n')
      const snapshot = await actions.checkpointExistingTurn({ ...options, turnId: 'pre-spawn-snapshot' }, f.baseSha, 'completed')
      nestedRevision = { workspaceId: new ThreadWorkspaceManager(threadDir).load()!.workspaceId!, readSha: f.baseSha, writeSha: snapshot.endSha, receiptId: snapshot.receiptId }
      const child = f.child('nested-child', snapshot.endSha)
      f.commit(child, 'child first\n')
      const result = f.commit(child, 'child second\n')
      await new ChildAgentIntegrationService(threadDir).integrate({
        agentId: 'nested-child', workerWorktree: child, workerBranch: 'nested-child',
        spawnBaseSha: snapshot.endSha, expectedWorkerHead: result, expectedDestinationHead: snapshot.endSha,
        threadWorkspace: workspace, heldThreadLease: lease, actionId: parent.id, turnId: 'parent-turn'
      })
      writeFileSync(join(workspace, 'parent.txt'), 'parent after child\n')
      const completed = await actions.checkpointExistingTurn(options, f.baseSha, 'completed')
      expect(completed.id).toBe(parent.id)
      expect(actions.latest('main')?.id).toBe(parent.id)
      finalHead = completed.endSha
    } finally { releaseExecutionLeaseHandle(lease) }
    const listed = await client.request<{ actions: Array<{ id: string }> }>('actions.list', { threadId: thread.id })
    expect(listed.actions.at(-1)?.id).toBe(parentId!)
    await client.request('actions.undoLatest', { threadId: thread.id })
    expect(isWorkflowRevisionCurrent({ profileId: mms.profileId, projects: mms.projects, threads: mms.threads },
      { profileId: mms.profileId, projectId: project.id, threadId: thread.id }, nestedRevision!)).toBe(false)
    expect(mms.orchestrator.getMessages(thread.id)).toHaveLength(0)
    expect(mms.orchestrator.getMessagesForPersistence(thread.id)).toHaveLength(2)
    expect(mms.orchestrator.getMessagesForPersistence(thread.id).every((message) => message.hidden)).toBe(true)
    expect(git(workspace, 'rev-parse', 'HEAD^{tree}')).toBe(git(f.repo, 'rev-parse', `${f.baseSha}^{tree}`))
    expect(git(workspace, 'status', '--porcelain')).toBe('')
    await client.request('actions.redo', { threadId: thread.id })
    expect(mms.orchestrator.getMessages(thread.id)).toHaveLength(2)
    expect(mms.orchestrator.getMessages(thread.id).every((message) => !message.hidden)).toBe(true)
    expect(git(workspace, 'rev-parse', 'HEAD^{tree}')).toBe(git(workspace, 'rev-parse', `${finalHead!}^{tree}`))
    expect(f.read(workspace)).toBe('child second\n')
    expect(f.read(workspace, 'parent.txt')).toBe('parent after child\n')
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseSha)
  }, 45_000)

  it('code-only workflow undo and redo preserve the prior discussion and native context', async () => {
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Workflow context', project.id)
    const directory = mms.threads.getThreadDir(thread.id)
    const workspace = (await new WorkspaceResolver(directory, thread.id, f.repo).resolve('agent')).workspacePath!
    mms.orchestrator.replaceConversationState(thread.id, [
      { id: 'prior-user', role: 'user', content: 'Keep this discussion', timestamp: Date.now() },
      { id: 'prior-assistant', role: 'assistant', content: 'Earlier answer', timestamp: Date.now() }
    ], { version: 2, fidelity: 'native', activeStartIndex: 0, messages: [{ role: 'user', content: 'Prior discussion', timestamp: Date.now() }] })
    const messages = mms.orchestrator.getMessagesForPersistence(thread.id)
    const native = mms.orchestrator.getNativeContext(thread.id)
    await new ThreadActionService(directory).runCheckpointedAction({
      ...actionOptions(workspace, 'workflow-code'), threadId: thread.id,
      actor: { kind: 'workflow', id: 'run' }, runId: 'run',
      presentationMessageStart: 0, presentationMessageEnd: 0, nativeContextStartBoundary: undefined,
      nativeContextBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' }
    }, () => writeFileSync(join(workspace, 'value.txt'), 'workflow code\n'))
    await client.request('actions.undoLatest', { threadId: thread.id })
    expect(f.read(workspace)).toBe('base\n')
    expect(mms.orchestrator.getMessagesForPersistence(thread.id)).toEqual(messages)
    expect(mms.orchestrator.getNativeContext(thread.id)).toEqual(native)
    await client.request('actions.redo', { threadId: thread.id })
    expect(f.read(workspace)).toBe('workflow code\n')
    expect(mms.orchestrator.getMessagesForPersistence(thread.id)).toEqual(messages)
    expect(mms.orchestrator.getNativeContext(thread.id)).toEqual(native)
  }, 30_000)
})
