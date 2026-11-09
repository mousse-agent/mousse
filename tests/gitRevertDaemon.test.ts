import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { dispatchMethod } from '../src/mms/protocol/handlers'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import type { GitChangesResult, GitRestoreRevertedResult, GitRevertedItem, GitRevertResult } from '../src/shared/types'
import { git, gitFoundationFixture } from './fixtures/gitFoundation'

const LINES = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`)
const text = (lines: string[]) => lines.map((line) => `${line}\n`).join('')
const changed = (at: readonly number[]) => text(LINES.map((line, index) => (at.includes(index + 1) ? `line ${index + 1} changed` : line)))

describe('Revert through the daemon', () => {
  let f: ReturnType<typeof gitFoundationFixture>
  let mms: MousseMainService
  let server: MmsProtocolServer
  let client: LocalMmsClient

  beforeEach(async () => {
    f = gitFoundationFixture()
    git(f.repo, 'config', 'core.hooksPath', join(f.root, 'no-hooks'))
    git(f.repo, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(f.repo, 'a.txt'), text(LINES)); git(f.repo, 'add', 'a.txt'); git(f.repo, 'commit', '-qm', 'lines')
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

  const changes = (scope: Record<string, unknown>) => client.request<GitChangesResult>('git.changes', scope)
  const fileOf = async (scope: Record<string, unknown>, path: string) => (await changes(scope)).files.find((file) => file.path === path)!

  async function threadScope() {
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Revert thread', project.id)
    const directory = mms.threads.getThreadDir(thread.id)
    const path = (await new WorkspaceResolver(directory, thread.id, f.repo).resolve('agent')).workspacePath!
    return { threadId: thread.id, directory, path }
  }

  it('reverts, lists and restores in a project folder, and tells other views', async () => {
    const project = mms.projects.openProject(f.repo)
    const scope = { projectId: project.id }
    writeFileSync(join(f.repo, 'a.txt'), changed([3, 25]))
    const seen: unknown[] = []
    client.onEvent((event) => { if (event.type === 'git.selectionChanged') seen.push(event.data) })
    await client.subscribe(0)
    const a = await fileOf(scope, 'a.txt')
    const done = await client.request<GitRevertResult>('git.revert', { ...scope, path: 'a.txt', version: a.version, hunks: [a.hunks[0]!.id] })
    expect(readFileSync(join(f.repo, 'a.txt'), 'utf8')).toBe(changed([25]))
    expect(await client.request<GitRevertedItem[]>('git.revertedList', scope)).toMatchObject([{ revertId: done.revertId, path: 'a.txt', summary: '1 hunk of a.txt' }])
    expect(await client.request<GitRestoreRevertedResult>('git.restoreReverted', { ...scope, revertId: done.revertId })).toEqual({ restored: true })
    expect(readFileSync(join(f.repo, 'a.txt'), 'utf8')).toBe(changed([3, 25]))
    expect(await client.request('git.revertedList', scope)).toEqual([])
    await vi.waitFor(() => expect(seen).toContainEqual({ projectId: project.id }))
    await expect(client.request('git.revert', { ...scope, path: 'a.txt', version: 'old' })).rejects.toMatchObject({ code: 'stale' })
    await expect(client.request('git.revert', { ...scope, path: 'a.txt' })).rejects.toMatchObject({ code: 'invalid_params' })
  })

  it('records a revert and its restore as the person\'s actions in a thread worktree, and keeps the copy for the thread', async () => {
    const t = await threadScope()
    const scope = { threadId: t.threadId }
    writeFileSync(join(t.path, 'a.txt'), changed([3, 25]))
    const actions = async () => ((await client.request('actions.list', scope)) as { actions: unknown[] }).actions.length
    const before = await actions()
    const a = await fileOf(scope, 'a.txt')
    const done = await client.request<GitRevertResult>('git.revert', { ...scope, path: 'a.txt', version: a.version })
    expect(readFileSync(join(t.path, 'a.txt'), 'utf8')).toBe(text(LINES))
    expect(await actions()).toBe(before + 1)
    expect(existsSync(join(t.directory, 'journal'))).toBe(true)
    expect((await client.request<GitRevertedItem[]>('git.revertedList', scope)).map((item) => item.revertId)).toEqual([done.revertId])
    expect(await client.request<GitRestoreRevertedResult>('git.restoreReverted', { ...scope, revertId: done.revertId })).toEqual({ restored: true })
    expect(readFileSync(join(t.path, 'a.txt'), 'utf8')).toBe(changed([3, 25]))
    expect(await actions()).toBe(before + 2)
    // Nothing left to write: no action is recorded.
    expect(await client.request<GitRestoreRevertedResult>('git.restoreReverted', { ...scope, revertId: done.revertId })).toEqual({ restored: true })
    expect(await actions()).toBe(before + 2)
  })

  it('refuses a revert and a restore while a turn runs, in the thread and in a project folder a thread works in', async () => {
    const t = await threadScope()
    writeFileSync(join(t.path, 'a.txt'), changed([3]))
    const a = await fileOf({ threadId: t.threadId }, 'a.txt')
    const done = await client.request<GitRevertResult>('git.revert', { threadId: t.threadId, path: 'a.txt', version: a.version })
    const active = vi.spyOn(mms.orchestrator, 'isTurnActive').mockReturnValue(true)
    writeFileSync(join(t.path, 'b.txt'), 'b\n')
    const b = await fileOf({ threadId: t.threadId }, 'b.txt')
    await expect(client.request('git.revert', { threadId: t.threadId, path: 'b.txt', version: b.version })).rejects.toMatchObject({ code: 'thread_busy' })
    await expect(client.request('git.restoreReverted', { threadId: t.threadId, revertId: done.revertId })).rejects.toMatchObject({ code: 'thread_busy' })
    expect(existsSync(join(t.path, 'b.txt'))).toBe(true)
    active.mockRestore()

    const project = mms.projects.openProject(f.repo)
    mms.threads.createThread('In the folder', project.id, undefined, { worktreeEnabled: false })
    writeFileSync(join(f.repo, 'a.txt'), changed([3]))
    const p = await fileOf({ projectId: project.id }, 'a.txt')
    vi.spyOn(mms.orchestrator, 'isConversationHistoryBusy').mockReturnValue(true)
    await expect(client.request('git.revert', { projectId: project.id, path: 'a.txt', version: p.version })).rejects.toMatchObject({ code: 'thread_busy' })
    expect(readFileSync(join(f.repo, 'a.txt'), 'utf8')).toBe(changed([3]))
  })

  it('in a project folder a thread works in, lists and restores a revert whichever journal recorded it', async () => {
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('In the folder', project.id, undefined, { worktreeEnabled: false })
    const directory = mms.threads.getThreadDir(thread.id)
    const inThread = { threadId: thread.id }, inProject = { projectId: project.id }
    writeFileSync(join(f.repo, 'a.txt'), changed([3, 25]))
    // Made in the thread, ready in the folder: its own journal records it.
    const a = await fileOf(inThread, 'a.txt')
    const byThread = await client.request<GitRevertResult>('git.revert', { ...inThread, path: 'a.txt', version: a.version, hunks: [a.hunks[0]!.id] })
    // The thread's first Git action set up its place in the folder.
    expect(new ThreadWorkspaceManager(directory).load()).toMatchObject({ kind: 'project-folder', lifecycle: 'ready' })
    expect(existsSync(join(directory, 'journal'))).toBe(true)
    // Made from the project: the project's journal records it.
    const p = await fileOf(inProject, 'a.txt')
    const byProject = await client.request<GitRevertResult>('git.revert', { ...inProject, path: 'a.txt', version: p.version })
    expect(readFileSync(join(f.repo, 'a.txt'), 'utf8')).toBe(text(LINES))
    const ids = async (scope: Record<string, unknown>) => (await client.request<GitRevertedItem[]>('git.revertedList', scope)).map((item) => item.revertId)
    expect(await ids(inThread)).toEqual([byProject.revertId, byThread.revertId])
    expect(await ids(inProject)).toEqual([byProject.revertId])
    // The thread restores the project's revert, then its own.
    expect(await client.request<GitRestoreRevertedResult>('git.restoreReverted', { ...inThread, revertId: byProject.revertId })).toEqual({ restored: true })
    expect(readFileSync(join(f.repo, 'a.txt'), 'utf8')).toBe(changed([25]))
    expect(await client.request<GitRestoreRevertedResult>('git.restoreReverted', { ...inThread, revertId: byThread.revertId })).toEqual({ restored: true })
    expect(readFileSync(join(f.repo, 'a.txt'), 'utf8')).toBe(changed([3, 25]))
    expect(await ids(inThread)).toEqual([])
  })

  it('from another computer, refuses a path that leads out of the folder through a link or junction', async () => {
    const project = mms.projects.openProject(f.repo)
    const outside = join(f.root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'topsecret\n')
    symlinkSync(outside, join(f.repo, 'out'), process.platform === 'win32' ? 'junction' : 'dir')
    const ctx = {
      mms,
      globalSequence: () => 0,
      connection: { id: 'conn-bridge', capabilities: new Set<string>(), clientType: 'gui', bridgeCaller: { node: 'other-computer', user: 'me', maxPermissionMode: 'full' as const } }
    }
    await expect(dispatchMethod(ctx as never, 'git.revert', { projectId: project.id, path: 'out/secret.txt', version: 'x' })).rejects.toMatchObject({ code: 'path_outside_folder' })
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('topsecret\n')
    await expect(dispatchMethod(ctx as never, 'git.revert', { projectId: project.id, path: '../outside/secret.txt', version: 'x' })).rejects.toMatchObject({ code: 'git_path_outside' })
  })
})
