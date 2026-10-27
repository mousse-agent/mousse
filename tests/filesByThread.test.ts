import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import { FILE_ASSET_PIECE_BYTES, FILES_WRITE_DIRECT_MAX_BYTES, SAVE_TOO_LARGE_MESSAGE } from '../src/shared/fileAssets'
import { git, gitFoundationFixture } from './fixtures/gitFoundation'

/**
 * The Files and Git panels name a thread or a project; the daemon resolves its folder. These tests talk to a
 * real daemon the way the Electron main process does (as a window), and the way a script does (as a CLI).
 */
describe('files and Git reads by thread, through the daemon', () => {
  let f: ReturnType<typeof gitFoundationFixture>
  let mms: MousseMainService
  let server: MmsProtocolServer
  let window: LocalMmsClient
  let script: LocalMmsClient

  beforeEach(async () => {
    f = gitFoundationFixture()
    git(f.repo, 'config', 'commit.gpgsign', 'false')
    mms = await MousseMainService.create({ homeDir: f.home, headless: true, ownerKind: 'test' })
    await mms.start()
    const ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    const endpoint = await server.start()
    window = new LocalMmsClient({ homeDir: f.home, endpoint, ownerToken, clientType: 'gui' })
    script = new LocalMmsClient({ homeDir: f.home, endpoint, ownerToken, clientType: 'cli' })
    await window.connect()
    await script.connect()
  }, 30_000)
  afterEach(async () => {
    vi.restoreAllMocks()
    await window?.close()
    await script?.close()
    await server?.stop()
    await mms?.stop()
    f?.dispose()
  })

  const project = () => mms.projects.openProject(f.repo)
  const threadWorktree = async (projectId: string) => {
    const thread = mms.threads.createThread('Worktree thread', projectId)
    const path = (await new WorkspaceResolver(mms.threads.getThreadDir(thread.id), thread.id, f.repo).resolve('agent')).workspacePath!
    return { threadId: thread.id, path }
  }
  const rootOf = async (params: Record<string, unknown>) => (await window.request<{ root: string }>('files.root', params)).root

  describe('the folder a window browses', () => {
    it('is the project folder for a project and for a thread without a worktree', async () => {
      const p = project()
      const thread = mms.threads.createThread('Plain thread', p.id)
      expect(await rootOf({ projectId: p.id })).toBe(p.path)
      expect(await rootOf({ threadId: thread.id })).toBe(p.path)
    })

    it('is the thread own worktree once it is ready, and the project folder before', async () => {
      const p = project()
      const before = mms.threads.createThread('Not yet', p.id)
      expect(await rootOf({ threadId: before.id })).toBe(p.path)
      const t = await threadWorktree(p.id)
      const root = await rootOf({ threadId: t.threadId })
      expect(root).toBe(t.path)
      expect(root).not.toBe(p.path)
      // A project named next to the thread is only the fallback; the ready worktree still wins.
      expect(await rootOf({ threadId: t.threadId, projectId: p.id })).toBe(t.path)
    })

    it('is the home folder for a thread without a project and for nothing selected', async () => {
      const standalone = mms.threads.createThread('No project')
      expect(await rootOf({ threadId: standalone.id })).toBe(homedir())
      expect(await rootOf({})).toBe(homedir())
    })

    it('is refused for a thread or project the daemon does not know, never answered with the home folder', async () => {
      const p = project()
      const named = [{ threadId: 'no-such-thread' }, { projectId: 'no-such-project' }, { threadId: 'no-such-thread', projectId: p.id }]
      for (const params of named) {
        await expect(window.request('files.root', params)).rejects.toMatchObject({ code: expect.stringMatching(/^(thread|project)_not_found$/) })
        await expect(window.request('files.list', { ...params, path: '' })).rejects.toMatchObject({ code: expect.stringMatching(/not_found$/) })
        await expect(window.request('files.read', { ...params, path: 'value.txt' })).rejects.toMatchObject({ code: expect.stringMatching(/not_found$/) })
        await expect(window.request('files.readAsset', { ...params, path: 'a.png' })).rejects.toMatchObject({ code: expect.stringMatching(/not_found$/) })
        await expect(window.request('files.writeDirect', { ...params, path: 'mousse-must-not-exist.txt', content: 'x' })).rejects.toMatchObject({ code: expect.stringMatching(/not_found$/) })
      }
      expect(existsSync(join(homedir(), 'mousse-must-not-exist.txt'))).toBe(false)
    })

    it('lists, reads and saves in that folder, and keeps a path inside it', async () => {
      const p = project()
      const t = await threadWorktree(p.id)
      await window.request('files.writeDirect', { threadId: t.threadId, path: 'inside.txt', content: 'one\ntwo\n' })
      expect(readFileSync(join(t.path, 'inside.txt'), 'utf8')).toBe('one\ntwo\n')
      expect(existsSync(join(f.repo, 'inside.txt'))).toBe(false)
      const listed = await window.request<{ entries: Array<{ name: string }> }>('files.list', { threadId: t.threadId, path: '' })
      expect(listed.entries.map((entry) => entry.name)).toEqual(expect.arrayContaining(['inside.txt', 'value.txt']))
      expect((await window.request<{ content: string }>('files.read', { threadId: t.threadId, path: 'inside.txt' })).content).toBe('one\ntwo\n')
      await expect(window.request('files.read', { threadId: t.threadId, path: '../outside.txt' })).rejects.toThrow(/outside|escape/i)
      await expect(window.request('files.writeDirect', { threadId: t.threadId, path: '../outside.txt', content: 'x' })).rejects.toThrow()
      expect(existsSync(join(t.path, '..', 'outside.txt'))).toBe(false)
    })

    it('gives a window the reason a file cannot be opened, and anyone else the general error', async () => {
      const p = project()
      writeFileSync(join(f.repo, 'huge.txt'), 'x'.repeat(600 * 1024))
      await expect(window.request('files.read', { projectId: p.id, path: 'huge.txt' })).rejects.toMatchObject({ code: 'file_unavailable', message: expect.stringContaining('exceeds 512KB') })
      await expect(window.request('files.read', { projectId: p.id, path: 'missing.txt' })).rejects.toMatchObject({ code: 'file_unavailable', message: expect.stringContaining('ENOENT') })
      await expect(script.request('files.read', { projectId: p.id, path: 'huge.txt' })).rejects.not.toMatchObject({ code: 'file_unavailable' })
    })

    it('is exactly the thread or project folder for a caller that is not a window', async () => {
      const p = project()
      const standalone = mms.threads.createThread('No project')
      expect((await script.request<{ root: string }>('files.root', { projectId: p.id })).root).toBe(p.path)
      await expect(script.request('files.root', { threadId: standalone.id })).rejects.toThrow()
      await expect(script.request('files.list', { threadId: standalone.id, path: '' })).rejects.toThrow()
      await expect(script.request('files.root', {})).rejects.toThrow()
    })
  })

  describe('a save from the editor', () => {
    it('writes what it is given, however long, with nothing to Undo', async () => {
      const p = project()
      const t = await threadWorktree(p.id)
      const big = 'line\n'.repeat(200_000)
      expect(big.length).toBeGreaterThan(512 * 1024)
      await window.request('files.writeDirect', { threadId: t.threadId, path: 'big.txt', content: big })
      expect(readFileSync(join(t.path, 'big.txt'), 'utf8')).toBe(big)
      // The checkpointed `files.write` still keeps its own limit.
      await expect(window.request('files.write', { threadId: t.threadId, path: 'big2.txt', content: big })).rejects.toThrow(/max length/)
      const actions = await window.request<{ actions: unknown[] }>('actions.list', { threadId: t.threadId })
      expect(actions.actions).toHaveLength(0)
    })

    it('saves up to the request frame and refuses, in plain words, a save that would not fit it', async () => {
      const p = project()
      const fits = 'a'.repeat(FILES_WRITE_DIRECT_MAX_BYTES - 100)
      await window.request('files.writeDirect', { projectId: p.id, path: 'near-limit.txt', content: fits })
      expect(readFileSync(join(f.repo, 'near-limit.txt'), 'utf8')).toBe(fits)
      // Over the save limit but still a frame the transport carries: the daemon refuses it with the reason.
      const tooBig = 'a'.repeat(FILES_WRITE_DIRECT_MAX_BYTES + 1000)
      await expect(window.request('files.writeDirect', { projectId: p.id, path: 'too-big.txt', content: tooBig }))
        .rejects.toMatchObject({ code: 'file_too_large', message: SAVE_TOO_LARGE_MESSAGE })
      expect(existsSync(join(f.repo, 'too-big.txt'))).toBe(false)
    })

    it('saves an empty file, and counts the lines it changed', async () => {
      const p = project()
      writeFileSync(join(f.repo, 'notes.txt'), 'a\nb\nc\n')
      const record = vi.spyOn(mms.lineEditStats, 'record')
      await window.request('files.writeDirect', { projectId: p.id, path: 'notes.txt', content: '' })
      expect(readFileSync(join(f.repo, 'notes.txt'), 'utf8')).toBe('')
      expect(record).toHaveBeenCalledOnce()
      expect(record).toHaveBeenCalledWith('manual', expect.any(Number))
      expect(record.mock.calls[0]![1]).toBeGreaterThan(0)
    })

    it('refuses to write for another profile, and for a caller that is not a window', async () => {
      const p = project()
      await expect(window.request('files.writeDirect', { projectId: p.id, path: 'x.txt', content: 'x', expectedProfileId: 'another-profile' }))
        .rejects.toMatchObject({ code: 'profile_mismatch' })
      await expect(script.request('files.writeDirect', { projectId: p.id, path: 'x.txt', content: 'x' }))
        .rejects.toMatchObject({ code: 'forbidden' })
      await expect(window.request('files.writeDirect', { projectId: p.id, path: 'x.txt', content: 42 })).rejects.toMatchObject({ code: 'invalid_params' })
      expect(existsSync(join(f.repo, 'x.txt'))).toBe(false)
    })
  })

  describe('a preview', () => {
    const piece = (params: Record<string, unknown>) =>
      window.request<{ mimeType: string; size: number; offset: number; data: string }>('files.readAsset', params)

    it('arrives in pieces that join into the file', async () => {
      const p = project()
      const bytes = Buffer.alloc(FILE_ASSET_PIECE_BYTES + 12_345, 7)
      bytes[0] = 0x89
      bytes[bytes.length - 1] = 0x42
      writeFileSync(join(f.repo, 'big.png'), bytes)
      const first = await piece({ projectId: p.id, path: 'big.png' })
      expect(first).toMatchObject({ mimeType: 'image/png', size: bytes.length, offset: 0 })
      const head = Buffer.from(first.data, 'base64')
      expect(head).toHaveLength(FILE_ASSET_PIECE_BYTES)
      const rest = await piece({ projectId: p.id, path: 'big.png', offset: head.length, length: FILE_ASSET_PIECE_BYTES })
      const tail = Buffer.from(rest.data, 'base64')
      expect(tail).toHaveLength(12_345)
      expect(Buffer.concat([head, tail]).equals(bytes)).toBe(true)
      expect(Buffer.from((await piece({ projectId: p.id, path: 'big.png', offset: bytes.length, length: 10 })).data, 'base64')).toHaveLength(0)
    })

    it('refuses a piece larger than a message, other file types and paths outside the folder', async () => {
      const p = project()
      writeFileSync(join(f.repo, 'small.png'), Buffer.from([1, 2, 3]))
      await expect(piece({ projectId: p.id, path: 'small.png', length: FILE_ASSET_PIECE_BYTES + 1 })).rejects.toThrow()
      await expect(piece({ projectId: p.id, path: 'value.txt' })).rejects.toThrow(/does not support/)
      await expect(piece({ projectId: p.id, path: '../small.png' })).rejects.toThrow()
    })
  })

  describe('Git reads', () => {
    it('answer for a project and for a thread own worktree', async () => {
      const p = project()
      const t = await threadWorktree(p.id)
      writeFileSync(join(f.repo, 'project-only.txt'), 'new\n')
      writeFileSync(join(t.path, 'thread-only.txt'), 'new\nlines\n')
      const projectStatus = await window.request<{ status: { isRepo: boolean; changes: Array<{ path: string }> } }>('git.status', { projectId: p.id })
      const threadStatus = await window.request<{ status: { changes: Array<{ path: string }> } }>('git.status', { threadId: t.threadId })
      expect(projectStatus.status.changes.map((change) => change.path)).toEqual(['project-only.txt'])
      expect(threadStatus.status.changes.map((change) => change.path)).toEqual(['thread-only.txt'])
      const stats = await window.request<{ stats: { filesChanged: number } }>('git.diffStats', { threadId: t.threadId })
      expect(stats.stats).toMatchObject({ additions: expect.any(Number), deletions: expect.any(Number), filesChanged: expect.any(Number) })
      expect((await window.request<{ commits: unknown[] }>('git.log', { projectId: p.id, limit: 5 })).commits).toHaveLength(1)
      expect((await window.request<{ branches: { current: string | null } }>('git.branches', { projectId: p.id })).branches.current).toBe(git(f.repo, 'branch', '--show-current'))
    })

    it('give the message of the last commit, or null where there is none', async () => {
      const p = project()
      expect((await window.request<{ message: string | null }>('git.lastCommitMessage', { projectId: p.id })).message).toBe('base')
      const empty = join(f.root, 'empty-repo')
      git(f.root, 'init', '-q', empty)
      const other = mms.projects.openProject(empty)
      expect((await window.request<{ message: string | null }>('git.lastCommitMessage', { projectId: other.id })).message).toBeNull()
    })

    it('name their folder by a thread or a project, never by a path', async () => {
      await expect(window.request('git.status', {})).rejects.toThrow()
      await expect(window.request('git.status', { projectId: 'no-such-project' })).rejects.toMatchObject({ code: 'project_not_found' })
      await expect(window.request('git.diffStats', { projectId: project().id, threadId: 'x' })).rejects.toThrow()
      // A folder sent as `cwd` is not a parameter of any of them; the project decides.
      const p = project()
      const status = await window.request<{ status: { isRepo: boolean } }>('git.status', { projectId: p.id, cwd: f.root })
      expect(status.status.isRepo).toBe(true)
    })
  })
})
