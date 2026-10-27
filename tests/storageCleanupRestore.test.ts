import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { cleanupMarkerPath } from '../src/mms/lifecycle/StorageCleanupService'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { releaseExecutionLeaseHandle, tryAcquireExecutionLease } from '../src/mms/queue/ThreadExecutionLease'
import type { StorageCleanupReport, StoragePolicy } from '../src/shared/storage'
import { git, gitFoundationFixture } from './fixtures/gitFoundation'

const DAY = 86_400_000
const inactivePolicy: StoragePolicy = { schemaVersion: 1, worktrees: { removeWithDeletedThreads: true, inactiveDays: 30, removeMerged: false }, browser: { captureDays: null } }

describe('a worktree retired by a storage rule comes back on demand', () => {
  let f: ReturnType<typeof gitFoundationFixture>
  let mms: MousseMainService
  let server: MmsProtocolServer
  let gui: LocalMmsClient
  let cli: LocalMmsClient
  beforeAll(async () => {
    f = gitFoundationFixture()
    mms = await MousseMainService.create({ homeDir: f.home, headless: true, ownerKind: 'test' })
    await mms.start()
    const ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    const endpoint = await server.start()
    gui = new LocalMmsClient({ homeDir: f.home, endpoint, ownerToken, clientType: 'gui' }); await gui.connect()
    cli = new LocalMmsClient({ homeDir: f.home, endpoint, ownerToken, clientType: 'cli' }); await cli.connect()
    // The inactive rule reads ages from the service clock; 40 days ahead makes every fresh thread idle for 40 days.
    mms.storageCleanup.setClockForTests(() => Date.now() + 40 * DAY)
    // Saving the policy arms a scheduled run a minute later, which would retire whatever a test has just
    // restored. Only the manual runs the tests ask for may act.
    const manualRun = mms.storageCleanup.run.bind(mms.storageCleanup)
    vi.spyOn(mms.storageCleanup, 'run').mockImplementation((trigger) => trigger === 'manual' ? manualRun(trigger) : Promise.resolve({} as StorageCleanupReport))
    await gui.request('storage.configure', { policy: inactivePolicy })
  }, 60_000)
  afterAll(async () => {
    vi.restoreAllMocks()
    await gui?.close(); await cli?.close(); await server?.stop(); await mms?.stop(); f?.dispose()
  })

  async function retiredThread() {
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread(`Retired ${Math.random().toString(16).slice(2, 8)}`, project.id)
    const { metadata } = await gui.request<{ metadata: { worktreePath: string } }>('workspace.restore', { threadId: thread.id })
    expect(existsSync(metadata.worktreePath)).toBe(true)
    const report = (await gui.request<{ report: StorageCleanupReport }>('storage.cleanup.run', {})).report
    expect(report.items.find((entry) => entry.threadId === thread.id)).toMatchObject({ rule: 'worktree-inactive', outcome: 'removed' })
    expect(existsSync(metadata.worktreePath)).toBe(false)
    return { threadId: thread.id, worktreePath: metadata.worktreePath }
  }
  const marker = (threadId: string) => cleanupMarkerPath(mms.threads.lifecycleStore, threadId)

  it('reports the retirement from workspace.getStatus without restoring, and git.status restores it', async () => {
    const { threadId, worktreePath } = await retiredThread()
    for (let call = 0; call < 2; call++) {
      const status = await gui.request<{ metadata: { lifecycle: string }; retiredByCleanup?: { at: string; rule: string } }>('workspace.getStatus', { threadId })
      expect(status.retiredByCleanup).toMatchObject({ rule: 'worktree-inactive', at: expect.any(String) })
      expect(status.metadata.lifecycle).toBe('missing')
      expect(existsSync(worktreePath)).toBe(false)
    }
    expect(existsSync(marker(threadId))).toBe(true)
    await gui.request('git.status', { threadId })
    expect(existsSync(worktreePath)).toBe(true)
    const after = await gui.request<{ metadata: { lifecycle: string }; retiredByCleanup?: unknown }>('workspace.getStatus', { threadId })
    expect(after.retiredByCleanup).toBeUndefined(); expect(after.metadata.lifecycle).toBe('ready'); expect(existsSync(marker(threadId))).toBe(false)
    expect(readFileSync(join(worktreePath, 'value.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('base\n')
  }, 120_000)

  it('files.root restores the checkout and names the same folder as the tree that lists it', async () => {
    const { threadId, worktreePath } = await retiredThread()
    const { root } = await gui.request<{ root: string }>('files.root', { threadId })
    expect(root).toBe(worktreePath)
    expect(existsSync(worktreePath)).toBe(true); expect(existsSync(marker(threadId))).toBe(false)
    const listed = await gui.request<{ entries: Array<{ name: string }> }>('files.list', { threadId, path: '' })
    expect(listed.entries.map((entry) => entry.name)).toContain('value.txt')
    const status = await gui.request<{ execution: { projectPath: string; lifecycle: string } }>('workspace.getStatus', { threadId })
    expect(status.execution).toMatchObject({ projectPath: root, lifecycle: 'ready' })
  }, 120_000)

  it.each([
    ['files.list', { path: '' }],
    ['files.read', { path: 'value.txt' }],
    ['files.stat', { path: 'value.txt' }],
    ['git.diff', { path: 'value.txt' }],
    ['git.log', {}],
    ['git.branches', {}],
    ['git.diffStats', {}],
    ['git.lastCommitMessage', {}],
    ['files.search', { query: 'value' }],
    ['files.grep', { query: 'base' }],
    ['review.files', { scope: { kind: 'worktree' } }],
    ['review.files', { scope: { kind: 'thread' } }],
    ['actions.list', {}],
    ['publish.status', {}]
  ])('%s restores the checkout it is about to read', async (method, extra) => {
    const { threadId, worktreePath } = await retiredThread()
    await gui.request(method, { threadId, ...extra })
    expect(existsSync(worktreePath)).toBe(true); expect(existsSync(marker(threadId))).toBe(false)
  }, 120_000)

  it.each([
    ['review.files', { scope: { kind: 'turn', turnId: 'no-such-turn' } }],
    ['review.file', { scope: { kind: 'thread' }, path: 'value.txt' }],
    ['review.file', { scope: { kind: 'turn', turnId: 'no-such-turn' }, path: 'value.txt' }],
    ['git.suggestCommitMessage', {}]
  ])('%s restores the checkout even when the answer itself is an error or "unavailable"', async (method, extra) => {
    const { threadId, worktreePath } = await retiredThread()
    await gui.request(method, { threadId, ...extra }).catch(() => undefined)
    expect(existsSync(worktreePath)).toBe(true); expect(existsSync(marker(threadId))).toBe(false)
  }, 120_000)

  it('pty.create restores the checkout before it opens a terminal', async () => {
    const { threadId, worktreePath } = await retiredThread()
    const created = await gui.request<{ ptyId: string }>('pty.create', { threadId, agentId: 'storage-cleanup-restore' })
    try { expect(existsSync(worktreePath)).toBe(true) }
    finally { await gui.request('pty.kill', { ptyId: created.ptyId }).catch(() => undefined) }
  }, 120_000)

  it('a mutating action restores it and the thread is working again', async () => {
    const { threadId, worktreePath } = await retiredThread()
    await gui.request('files.write', { threadId, path: 'restored.txt', content: 'after restore\n' })
    expect(readFileSync(join(worktreePath, 'restored.txt'), 'utf8')).toBe('after restore\n')
    expect(new ThreadWorkspaceManager(mms.threads.getThreadDir(threadId)).verify().lifecycle).toBe('ready')
  }, 120_000)

  it('a terminal asked for while cleanup holds the thread is refused with a message that names cleanup', async () => {
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Cleanup is checking', project.id)
    await gui.request('workspace.restore', { threadId: thread.id })
    const lease = tryAcquireExecutionLease(mms.threads.getThreadDir(thread.id), { source: 'storage-cleanup' })!
    try {
      await expect(gui.request('pty.create', { threadId: thread.id, agentId: 'storage-cleanup-busy' })).rejects.toThrow('Cleanup is checking this thread; try again in a moment')
    } finally { releaseExecutionLeaseHandle(lease) }
  }, 60_000)

  it('deleting a thread keeps its checkout while the deleted-threads rule is off, and a later run retires it', async () => {
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Delete with the rule off', project.id)
    const { metadata } = await gui.request<{ metadata: { worktreePath: string } }>('workspace.restore', { threadId: thread.id })
    await gui.request('storage.configure', { policy: { ...inactivePolicy, worktrees: { ...inactivePolicy.worktrees, removeWithDeletedThreads: false } } })
    try {
      await gui.request('threads.delete', { threadId: thread.id })
      expect(existsSync(metadata.worktreePath)).toBe(true)
      await gui.request('storage.configure', { policy: inactivePolicy })
      const report = (await gui.request<{ report: StorageCleanupReport }>('storage.cleanup.run', {})).report
      expect(report.items.find((entry) => entry.threadId === thread.id)).toMatchObject({ rule: 'worktree-deleted', outcome: 'removed' })
      expect(existsSync(metadata.worktreePath)).toBe(false)
    } finally { await gui.request('storage.configure', { policy: inactivePolicy }) }
  }, 120_000)

  it('deleting a thread retires its checkout at once while the rule is on, as before', async () => {
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Delete with the rule on', project.id)
    const { metadata } = await gui.request<{ metadata: { worktreePath: string } }>('workspace.restore', { threadId: thread.id })
    await gui.request('threads.delete', { threadId: thread.id })
    expect(existsSync(metadata.worktreePath)).toBe(false)
    // The removal went through the storage service, which records it.
    const history = readFileSync(join(mms.threads.lifecycleStore.root, 'storage-cleanup-history.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ trigger: 'trash', outcome: 'removed', rule: 'worktree-deleted', threadId: thread.id })]))
  }, 60_000)

  it('a manual run over the protocol empties overdue trash: its own request does not make the profile look busy', async () => {
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Overdue in the trash', project.id)
    await gui.request('threads.delete', { threadId: thread.id })
    mms.threads.lifecycleStore.update(thread.id, (record) => { record.trashedAt = new Date(Date.now() - 40 * DAY).toISOString() })
    await gui.request('threads.configureTrash', { graceDays: 30, automaticPurge: true })
    mms.storageCleanup.setClockForTests(Date.now) // the trash guard refuses a clock a day ahead of its last sweep
    try {
      const report = (await gui.request<{ report: StorageCleanupReport }>('storage.cleanup.run', {})).report
      expect(report.items.find((entry) => entry.threadId === thread.id)).toMatchObject({ rule: 'trash', outcome: 'removed' })
      expect(mms.threads.lifecycleStore.require(thread.id).state).toBe('purged')
    } finally {
      mms.storageCleanup.setClockForTests(() => Date.now() + 40 * DAY)
      await gui.request('threads.configureTrash', { graceDays: 30, automaticPurge: false })
    }
  }, 60_000)

  it('storage.cleanup.run is open to a cli client while storage.configure is not', async () => {
    const report = (await cli.request<{ report: StorageCleanupReport }>('storage.cleanup.run', {})).report
    expect(report.trigger).toBe('manual')
    await expect(cli.request('storage.configure', { policy: inactivePolicy })).rejects.toMatchObject({ code: 'handler_error' })
    expect((await cli.request<{ report: StorageCleanupReport | null }>('storage.cleanup.lastReport', {})).report).toMatchObject({ trigger: 'manual' })
    git(f.repo, 'status', '--porcelain')
  }, 60_000)
})
