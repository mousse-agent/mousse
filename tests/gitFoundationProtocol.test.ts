import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { ChildAgentIntegrationService } from '../src/mms/agents/ChildAgentIntegrationService'
import { waitAcquireExecutionLease, releaseExecutionLeaseHandle } from '../src/mms/queue/ThreadExecutionLease'
import { actionOptions, git, gitFoundationFixture } from './fixtures/gitFoundation'

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
    await client?.close()
    await server?.stop()
    await mms?.stop()
    f?.dispose()
  })

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
    let parentId: string
    let finalHead: string
    try {
      const parent = actions.beginTurn(options, f.baseSha)
      parentId = parent.id
      writeFileSync(join(workspace, 'parent.txt'), 'parent before child\n')
      const snapshot = await actions.checkpointExistingTurn({ ...options, turnId: 'pre-spawn-snapshot' }, f.baseSha, 'completed')
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
    expect(git(workspace, 'rev-parse', 'HEAD^{tree}')).toBe(git(f.repo, 'rev-parse', `${f.baseSha}^{tree}`))
    expect(git(workspace, 'status', '--porcelain')).toBe('')
    await client.request('actions.redo', { threadId: thread.id })
    expect(git(workspace, 'rev-parse', 'HEAD^{tree}')).toBe(git(workspace, 'rev-parse', `${finalHead!}^{tree}`))
    expect(f.read(workspace)).toBe('child second\n')
    expect(f.read(workspace, 'parent.txt')).toBe('parent after child\n')
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseSha)
  }, 45_000)
})
