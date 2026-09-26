import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@earendil-works/pi-ai'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { ChildAgentIntegrationService } from '../src/mms/agents/ChildAgentIntegrationService'
import { waitAcquireExecutionLease, releaseExecutionLeaseHandle } from '../src/mms/queue/ThreadExecutionLease'
import { acquireWorkspaceMutationLease, isWorkflowRevisionCurrent, resolveOwnedThreadWorkspace } from '../src/mms/workspace/WorkflowWorkspace'
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
    await client.request('orchestrator.send', { threadId: thread.id, content: 'Read value.txt without changes.', mode: 'plan' })
    expect(JSON.stringify(captured.at(-1)?.messages.filter((message) => message.role === 'toolResult'))).toContain('main-agent bytes')
    expect((await client.request<{ content: string }>('files.read', { threadId: thread.id, path: 'value.txt' })).content).toContain('main-agent bytes')
    expect(new ThreadActionService(mms.threads.getThreadDir(thread.id)).list().some((action) => action.receiptId && action.changedPaths.some((path) => path.path === 'value.txt'))).toBe(true)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseSha)
    const directory = mms.threads.getThreadDir(thread.id)
    const currentHead = git(metadata.worktreePath, 'rev-parse', 'HEAD')
    const child = f.child('conflicting-main-child', currentHead)
    const childResult = f.commit(child, 'conflicting child\n')
    const { action: parent } = await new ThreadActionService(directory).runCheckpointedAction({ ...actionOptions(metadata.worktreePath, 'conflicting-parent'), threadId: thread.id }, () => writeFileSync(join(metadata.worktreePath, 'value.txt'), 'conflicting parent\n'))
    await expect(new ChildAgentIntegrationService(directory).integrate({
      operationId: 'main-conflict', agentId: 'conflicting-main-child', workerWorktree: child, workerBranch: 'conflicting-main-child',
      spawnBaseSha: currentHead, expectedWorkerHead: childResult, expectedDestinationHead: parent.endSha, threadWorkspace: metadata.worktreePath
    })).rejects.toThrow(/conflict/i)
    await expect(client.request('orchestrator.send', { threadId: thread.id, content: 'Blocked while conflict exists', mode: 'agent' })).rejects.toThrow(/clean|recovery|conflict/i)
    expect(mms.orchestrator.getOrCreateSession(thread.id).isTurnRunning()).toBe(false)
    await client.request('operations.abort', { threadId: thread.id, operationId: 'main-conflict' })
    responses.push(providerResponse([{ type: 'text', text: 'Recovered after conflict.' }], 'stop'))
    expect(await client.request('orchestrator.send', { threadId: thread.id, content: 'Continue after abort', mode: 'agent' })).toMatchObject({ message: 'Recovered after conflict.' })
  }, 45_000)

  it('a queued workflow writer rejects unmanaged HEAD movement before snapshotting dirty input', async () => {
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Queued writer', project.id)
    const context = { profileId: mms.profileId, projectId: project.id, threadId: thread.id }
    const owner = { profileId: mms.profileId, projects: mms.projects, threads: mms.threads }
    const workspace = await resolveOwnedThreadWorkspace(owner, context)
    const lease = await waitAcquireExecutionLease(workspace.threadDirectory, { source: 'queue-fixture' })
    let pending: ReturnType<typeof acquireWorkspaceMutationLease>
    try {
      pending = acquireWorkspaceMutationLease(owner, context, workspace, new AbortController().signal)
      f.commit(workspace.workspacePath, 'unmanaged while queued\n')
      writeFileSync(join(workspace.workspacePath, 'pending.txt'), 'must not snapshot')
    } finally { releaseExecutionLeaseHandle(lease) }
    const head = git(workspace.workspacePath, 'rev-parse', 'HEAD')
    await expect(pending!.then((writer) => { writer.release(); return writer })).rejects.toThrow(/recovery|revision|HEAD/i)
    expect(git(workspace.workspacePath, 'rev-parse', 'HEAD')).toBe(head)
    expect(f.read(workspace.workspacePath, 'pending.txt')).toBe('must not snapshot')
    expect(new ThreadActionService(workspace.threadDirectory).list()).toEqual([])
  }, 30_000)

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
    const reader = await resolver.resolve('plan')
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
    await client.request('actions.undoLatest', { threadId: thread.id })
    expect(f.read(workspace)).toBe('base\n')
    expect(mms.orchestrator.getMessagesForPersistence(thread.id)).toEqual(messages)
    expect(mms.orchestrator.getNativeContext(thread.id)).toEqual(native)
  }, 30_000)

  it('nested-project editor APIs resolve the project subdirectory and journal saves for public undo', async () => {
    const nested = join(f.repo, 'package')
    mkdirSync(nested)
    const base = f.commit(f.repo, 'nested base\n', 'package/value.txt')
    const project = mms.projects.openProject(nested)
    const thread = mms.threads.createThread('Nested package', project.id)
    const directory = mms.threads.getThreadDir(thread.id)
    const execution = await new WorkspaceResolver(directory, thread.id, nested).resolve('agent')
    expect(execution.projectPath).toBe(join(execution.workspacePath!, 'package'))
    expect((await client.request<{ content: string }>('files.read', { threadId: thread.id, path: 'value.txt' })).content).toContain('nested base')
    await client.request('files.write', { threadId: thread.id, path: 'value.txt', content: 'editor task save\n' })
    expect(f.read(execution.projectPath!)).toBe('editor task save\n')
    expect(f.read(execution.workspacePath!)).toBe('base\n')
    expect(f.read(nested)).toBe('nested base\n')
    const action = new ThreadActionService(directory).latest('main')!
    expect(action.receiptId).toBeTruthy()
    expect(action.changedPaths.map((item) => item.path)).toEqual(['package/value.txt'])
    await client.request('actions.undoLatest', { threadId: thread.id })
    expect(f.read(execution.projectPath!)).toBe('nested base\n')
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(base)
    const unmanaged = f.commit(execution.workspacePath!, 'outside editor save\n', 'package/value.txt')
    await expect(client.request('files.write', { threadId: thread.id, path: 'value.txt', content: 'must not overwrite' })).rejects.toThrow(/recovery|HEAD|recorded/i)
    expect(git(execution.workspacePath!, 'rev-parse', 'HEAD')).toBe(unmanaged)
    expect(f.read(execution.projectPath!)).toBe('outside editor save\n')
  }, 30_000)

  it('public publish retries the original reviewed revisions despite the now-stale request journal generation', async () => {
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Reviewed publish', project.id)
    const directory = mms.threads.getThreadDir(thread.id)
    const workspace = (await new WorkspaceResolver(directory, thread.id, f.repo).resolve('agent')).workspacePath!
    await new ThreadActionService(directory).runCheckpointedAction({ ...actionOptions(workspace), threadId: thread.id }, () => writeFileSync(join(workspace, 'value.txt'), 'reviewed publish\n'))
    const reviewed = await client.request<{ sourceSha: string; targetSha: string; journalGeneration: number }>('publish.status', { threadId: thread.id })
    const input = { threadId: thread.id, targetBranch: git(f.repo, 'branch', '--show-current'), operationId: 'public-publish',
      expectedSourceSha: reviewed.sourceSha, expectedTargetSha: reviewed.targetSha, expectedJournalGeneration: reviewed.journalGeneration }
    const first = await client.request<{ publishSha: string }>('publish.start', input)
    expect(await client.request('publish.start', input)).toEqual(first)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(first.publishSha)
    expect(f.read(f.repo)).toBe('reviewed publish\n')
    await expect(client.request('publish.start', { ...input, operationId: 'new-stale-publish' })).rejects.toThrow(/STALE_JOURNAL_GENERATION|revision changed/)
    await expect(client.request('actions.undoLatest', { threadId: thread.id })).rejects.toThrow(/Published/)
  }, 30_000)

  it('public recovery finishes conversation restoration after a process exits with only the undo receipt persisted', async () => {
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Recovery API', project.id)
    const directory = mms.threads.getThreadDir(thread.id)
    const workspace = (await new WorkspaceResolver(directory, thread.id, f.repo).resolve('agent')).workspacePath!
    mms.orchestrator.replaceConversationState(thread.id, [
      { id: 'audit-message', role: 'user', content: 'Retained history', timestamp: Date.now() }
    ], { version: 2, fidelity: 'native', activeStartIndex: 0, messages: [{ role: 'user', content: 'Retained context', timestamp: Date.now() }] })
    const actions = new ThreadActionService(directory)
    await actions.runCheckpointedAction({ ...actionOptions(workspace), threadId: thread.id,
      presentationMessageEnd: 1, nativeContextBoundary: { messageIndex: 1, compactionGeneration: 0, fidelity: 'exact' }
    }, () => writeFileSync(join(workspace, 'value.txt'), 'before crash\n'))
    const runner = join(f.root, 'public-crash.mjs')
    await build({ entryPoints: ['tests/fixtures/git-foundation-crash-child.ts'], outfile: runner, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    const crashed = spawnSync(process.execPath, [runner, directory, workspace, 'receipt'], { env: { ...process.env, MOUSSE_HOME: f.home }, windowsHide: true, encoding: 'utf8', timeout: 20_000 })
    expect(crashed.status, crashed.stderr).toBe(86)
    const undoneHead = git(workspace, 'rev-parse', 'HEAD')
    expect(f.read(workspace)).toBe('base\n')
    expect(mms.orchestrator.getMessages(thread.id)).toHaveLength(1)
    await client.request('operations.recover', { threadId: thread.id })
    expect(mms.orchestrator.getMessages(thread.id)).toHaveLength(0)
    expect(mms.orchestrator.getMessagesForPersistence(thread.id)).toHaveLength(1)
    expect(mms.orchestrator.getNativeContext(thread.id).retiredMessages).toHaveLength(1)
    expect(actions.list()).toHaveLength(2)
    await client.request('operations.recover', { threadId: thread.id })
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(undoneHead)
    expect(actions.list()).toHaveLength(2)
    await client.request('actions.redo', { threadId: thread.id })
    expect(f.read(workspace)).toBe('before crash\n')
    expect(mms.orchestrator.getMessages(thread.id)).toHaveLength(1)
  }, 30_000)
})
