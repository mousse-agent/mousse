import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeProtocolEvent } from '../src/main/mms/protocolEventBridge'
import { PresentationState } from '../src/main/mms/PresentationState'
import { useAppStore } from '../src/renderer/stores/appStore'
import type { ThreadMessagesSnapshot } from '../src/shared/types'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { worktreeTree } from '../src/mms/actions/snapshots'
import { ChildAgentIntegrationService } from '../src/mms/agents/ChildAgentIntegrationService'
import { waitAcquireExecutionLease, releaseExecutionLeaseHandle } from '../src/mms/queue/ThreadExecutionLease'
import { acquireWorkspaceMutationLease, isWorkflowRevisionCurrent, resolveOwnedThreadWorkspace } from '../src/mms/workspace/WorkflowWorkspace'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { CRASH_CHILD_REQUIRE, actionOptions, git, gitFoundationFixture } from './fixtures/gitFoundation'
import { testHarness } from '../src/mms/run/testkit/harness'
import { piAdapter } from './run/phase6Fixture'
import { PI_TEST_CAPABILITIES } from './support/piStub'

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
    // No shipped runtime has strong containment now (Pi's RPC engine is weak, so a restore asks for a review first):
    // a Mousse-run one stands in, so undo and redo here restore without one.
    vi.spyOn(mms.orchestrator, 'capabilitiesForThread').mockReturnValue(PI_TEST_CAPABILITIES as never)
  }, 30_000)
  afterEach(async () => {
    vi.restoreAllMocks()
    await client?.close()
    await server?.stop()
    await mms?.stop()
    f?.dispose()
  })

  it('a public main-agent send writes into the task and a read-only follow-up reads those bytes', async () => {
    const provider = mms.providerAuth.models.getProviders().find((item) => mms.providerAuth.models.getModels(item.id).length > 0)!
    const model = mms.providerAuth.models.getModels(provider.id)[0]
    mms.settings.set({ provider: { llmProvider: provider.id, model: model.id } })
    // Pi's agent runs its file tools in its own process, in the turn's folder: the scripted turns do the same.
    const replies: Array<(cwd: string) => string> = [
      (cwd) => { writeFileSync(join(cwd, 'value.txt'), 'main-agent bytes\n'); return 'Wrote task bytes.' },
      (cwd) => `Read task bytes: ${f.read(cwd)}`
    ]
    const adapter = piAdapter((input) => {
      const next = replies.shift()
      if (!next) throw new Error('Main provider fixture exhausted')
      return next(input.cwd!)
    })
    mms.orchestrator.setHarness(testHarness({ adapters: [adapter], profileHome: mms.getProfileHomeDir() }))
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Actual main agent', project.id)
    const result = await client.request<{ message: string }>('orchestrator.send', { threadId: thread.id, content: 'Write value.txt in this task.', mode: 'agent' })
    expect(result.message).toContain('Wrote task bytes')
    const metadata = new ThreadWorkspaceManager(mms.threads.getThreadDir(thread.id)).load()!
    expect(f.read(metadata.worktreePath)).toBe('main-agent bytes\n')
    expect(f.read(f.repo)).toBe('base\n')
    expect(adapter.turns[0]!.cwd).toBe(metadata.worktreePath)
    const followUp = await client.request<{ message: string }>('orchestrator.send', { threadId: thread.id, content: 'Read value.txt without changes.', mode: 'plan' })
    expect(adapter.turns[1]!.cwd).toBe(metadata.worktreePath)
    expect(followUp.message).toContain('main-agent bytes')
    expect((await client.request<{ content: string }>('files.read', { threadId: thread.id, path: 'value.txt' })).content).toContain('main-agent bytes')
    expect(new ThreadActionService(mms.threads.getThreadDir(thread.id)).list().some((action) => action.receiptId && action.changedPaths.some((path) => path.path === 'value.txt'))).toBe(true)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseSha)
    const directory = mms.threads.getThreadDir(thread.id)
    const currentHead = git(metadata.worktreePath, 'rev-parse', 'HEAD')
    const child = f.child('conflicting-main-child', currentHead)
    const childResult = f.commit(child, 'conflicting child\n')
    // The agent commits its own work on the thread's branch, as it is free to; the child's commit then conflicts with it.
    await new ThreadActionService(directory).runCheckpointedAction({ ...actionOptions(metadata.worktreePath, 'conflicting-parent'), threadId: thread.id }, () => {
      writeFileSync(join(metadata.worktreePath, 'value.txt'), 'conflicting parent\n')
      git(metadata.worktreePath, 'commit', '-qam', 'conflicting parent')
    })
    const before = git(metadata.worktreePath, 'status', '--porcelain', '--untracked-files=all')
    await expect(new ChildAgentIntegrationService(directory).integrate({
      operationId: 'main-conflict', agentId: 'conflicting-main-child', workerWorktree: child,
      spawnBaseSha: currentHead, pinnedWorkerSha: childResult, threadWorkspace: metadata.worktreePath
    })).rejects.toMatchObject({ code: 'integration_conflict', details: { files: ['value.txt'] } })
    // A refused integration changes nothing and locks nothing: no merge is left in the worktree, and the next turn runs.
    expect(git(metadata.worktreePath, 'status', '--porcelain', '--untracked-files=all')).toBe(before)
    expect(f.read(metadata.worktreePath)).toBe('conflicting parent\n')
    replies.push(() => 'Continued after the conflict.')
    expect(await client.request('orchestrator.send', { threadId: thread.id, content: 'Continue after the conflict', mode: 'agent' })).toMatchObject({ message: 'Continued after the conflict.' })
  }, 45_000)

  it('a queued workflow writer is admitted after HEAD moved while it waited, and records the dirty input as outside changes', async () => {
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
      writeFileSync(join(workspace.workspacePath, 'pending.txt'), 'recorded as outside changes')
    } finally { releaseExecutionLeaseHandle(lease) }
    const head = git(workspace.workspacePath, 'rev-parse', 'HEAD')
    const writer = await pending!
    writer.release()
    // Nothing is rejected, moved or committed: the files the writer found are recorded as the user's first.
    expect(git(workspace.workspacePath, 'rev-parse', 'HEAD')).toBe(head)
    expect(f.read(workspace.workspacePath, 'pending.txt')).toBe('recorded as outside changes')
    const outside = new ThreadActionService(workspace.threadDirectory).list().find((action) => action.turnId.startsWith('user-changes:'))!
    expect(outside).toMatchObject({ actor: { kind: 'user' }, state: 'completed' })
    expect(outside.changedPaths.map((item) => item.path).sort()).toEqual(['pending.txt', 'value.txt'])
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
        agentId: 'nested-child', workerWorktree: child,
        spawnBaseSha: snapshot.endSha, pinnedWorkerSha: result,
        threadWorkspace: workspace, heldThreadLease: lease, actionId: parent.id, turnId: 'parent-turn'
      })
      writeFileSync(join(workspace, 'parent.txt'), 'parent after child\n')
      const completed = await actions.checkpointExistingTurn(options, f.baseSha, 'completed')
      expect(completed.id).toBe(parent.id)
      expect(actions.latest('main')?.id).toBe(parent.id)
      finalHead = completed.endSha
    } finally { releaseExecutionLeaseHandle(lease) }
    const listed = await client.request<{ actions: Array<{ id: string }>; redoTarget?: unknown }>('actions.list', { threadId: thread.id })
    expect(listed.actions.at(-1)?.id).toBe(parentId!)
    expect(listed.redoTarget).toBeUndefined()
    // Connect the actual daemon event, main-process bridge, and renderer store.
    const presentation = new PresentationState()
    presentation.setActiveThreadId(thread.id)
    useAppStore.setState({ profileId: mms.profileId, activeThreadId: thread.id, messages: mms.orchestrator.getMessages(thread.id) })
    const snapshots: ThreadMessagesSnapshot[] = []
    const unsubscribe = client.onEvent((event) => bridgeProtocolEvent(event, (channel, data) => {
      if (channel !== 'orchestrator:thread-messages') return
      const snapshot = data as ThreadMessagesSnapshot
      snapshots.push(snapshot)
      useAppStore.getState().applyThreadMessages(snapshot, mms.profileId)
    }, presentation))
    await client.subscribe()
    await client.request('actions.undoLatest', { threadId: thread.id })
    expect(isWorkflowRevisionCurrent({ profileId: mms.profileId, projects: mms.projects, threads: mms.threads },
      { profileId: mms.profileId, projectId: project.id, threadId: thread.id }, nestedRevision!)).toBe(false)
    expect(mms.orchestrator.getMessages(thread.id)).toHaveLength(0)
    await vi.waitFor(() => expect(useAppStore.getState().messages).toHaveLength(0))
    expect(snapshots.at(-1)).toMatchObject({ threadId: thread.id, replace: true, messages: [] })
    expect(mms.orchestrator.getMessagesForPersistence(thread.id)).toHaveLength(2)
    expect(mms.orchestrator.getMessagesForPersistence(thread.id).every((message) => message.hidden)).toBe(true)
    const undoneHistory = await client.request<{ actions: Array<{ id: string }>; journalGeneration: number; redoTarget?: { actionId: string } }>('actions.list', { threadId: thread.id })
    expect(undoneHistory.redoTarget?.actionId).toBe(undoneHistory.actions.at(-1)!.id)
    await expect(client.request('actions.redo', { threadId: thread.id, expectedJournalGeneration: undoneHistory.journalGeneration - 1 })).rejects.toThrow()
    // Undo restored the files; no commit was made for the child's result, so the branch has nothing of it either way.
    expect(worktreeTree(workspace)).toBe(git(f.repo, 'rev-parse', `${f.baseSha}^{tree}`))
    await client.request('actions.redo', { threadId: thread.id, expectedJournalGeneration: undoneHistory.journalGeneration })
    expect(mms.orchestrator.getMessages(thread.id)).toHaveLength(2)
    await vi.waitFor(() => expect(useAppStore.getState().messages).toHaveLength(2))
    expect((await client.request<{ redoTarget?: unknown }>('actions.list', { threadId: thread.id })).redoTarget).toBeUndefined()
    expect(snapshots.at(-1)?.replace).toBe(true)
    expect(mms.orchestrator.getMessages(thread.id).every((message) => !message.hidden)).toBe(true)
    expect(worktreeTree(workspace)).toBe(git(workspace, 'rev-parse', `${finalHead!}^{tree}`))
    expect(f.read(workspace)).toBe('child second\n')
    expect(f.read(workspace, 'parent.txt')).toBe('parent after child\n')
    // Completion for A after selecting B must only refresh A's cached transcript.
    const other = mms.threads.createThread('Selected while undo runs', project.id)
    useAppStore.getState().switchToThread(other.id)
    const otherMessages = [{ id: 'other', role: 'user' as const, content: 'Keep task B visible', timestamp: new Date().toISOString() }]
    useAppStore.getState().setMessages(otherMessages)
    presentation.setActiveThreadId(other.id)
    const previousEvents = snapshots.length
    await client.request('actions.undoLatest', { threadId: thread.id })
    await vi.waitFor(() => expect(snapshots.length).toBeGreaterThan(previousEvents))
    expect(useAppStore.getState().messages).toEqual(otherMessages)
    useAppStore.getState().switchToThread(thread.id)
    expect(useAppStore.getState().messages).toEqual([])
    useAppStore.setState({ profileId: 'switched-profile', messages: otherMessages })
    useAppStore.getState().applyThreadMessages(snapshots.at(-1)!, mms.profileId)
    expect(useAppStore.getState().messages).toEqual(otherMessages)
    unsubscribe()
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
    await expect(client.request('actions.undoLatest', { threadId: thread.id, expectedTurnId: 'workflow-code' })).rejects.toThrow(/no exact recorded conversation Undo boundary/)
    expect(f.read(workspace)).toBe('workflow code\n')
    expect(mms.orchestrator.getMessagesForPersistence(thread.id)).toEqual(messages)
    expect(mms.orchestrator.getNativeContext(thread.id)).toEqual(native)
    await client.request('actions.undoLatest', { threadId: thread.id })
    expect(f.read(workspace)).toBe('base\n')
    expect((await client.request<{ redoTarget?: unknown }>('actions.list', { threadId: thread.id })).redoTarget).toBeUndefined()
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
    // A commit made outside Mousse is the thread's own Git work: it neither blocks the next save nor is moved by it.
    const unmanaged = f.commit(execution.workspacePath!, 'outside editor save\n', 'package/value.txt')
    await client.request('files.write', { threadId: thread.id, path: 'value.txt', content: 'saved after the outside commit\n' })
    expect(git(execution.workspacePath!, 'rev-parse', 'HEAD')).toBe(unmanaged)
    expect(f.read(execution.projectPath!)).toBe('saved after the outside commit\n')
    expect(new ThreadActionService(directory).list().some((item) => item.turnId.startsWith('user-changes:') && item.changedPaths.some((path) => path.path === 'package/value.txt'))).toBe(true)
  }, 30_000)

  it('public publish retries the original reviewed revisions despite the now-stale request journal generation', async () => {
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Reviewed publish', project.id)
    const directory = mms.threads.getThreadDir(thread.id)
    const workspace = (await new WorkspaceResolver(directory, thread.id, f.repo).resolve('agent')).workspacePath!
    // Publish merges a commit of the thread's branch, so the agent commits its work, as it is free to.
    await new ThreadActionService(directory).runCheckpointedAction({ ...actionOptions(workspace), threadId: thread.id }, () => {
      writeFileSync(join(workspace, 'value.txt'), 'reviewed publish\n')
      git(workspace, 'commit', '-qam', 'reviewed publish')
    })
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
    await build({ entryPoints: ['tests/fixtures/git-foundation-crash-child.ts'], outfile: runner, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', banner: { js: CRASH_CHILD_REQUIRE } })
    const beforeCrash = git(workspace, 'rev-parse', 'HEAD')
    const refused = spawnSync(process.execPath, [runner, directory, workspace, 'receipt'], { env: { ...process.env, MOUSSE_HOME: f.home }, windowsHide: true, encoding: 'utf8', timeout: 20_000 })
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('Lifecycle-managed storage requires initialized profile admission')
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(beforeCrash)
    expect(actions.list()).toHaveLength(1)
    const crashed = spawnSync(process.execPath, [runner, directory, workspace, 'receipt', 'undo', mms.getProfileHomeDir(), mms.profileId], { env: { ...process.env, MOUSSE_HOME: f.home }, windowsHide: true, encoding: 'utf8', timeout: 20_000 })
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
