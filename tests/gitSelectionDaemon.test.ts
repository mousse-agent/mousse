import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import type { GitChangesResult, GitIncludeResult, GitSelectionState } from '../src/shared/types'
import { git, gitFoundationFixture } from './fixtures/gitFoundation'

const LINES = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`)
const text = (lines: string[]) => lines.map((line) => `${line}\n`).join('')
const twoHunks = () => text(LINES.map((line, index) => (index === 2 ? 'line 3 changed' : index === 24 ? 'line 25 changed' : line)))

describe('Git selection through the daemon', () => {
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

  const changes = (scope: Record<string, unknown>, paths?: string[]) => client.request<GitChangesResult>('git.changes', { ...scope, ...(paths ? { paths } : {}) })
  const fileOf = (result: GitChangesResult, path: string) => result.files.find((file) => file.path === path)!

  async function threadScope() {
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Selection thread', project.id)
    const directory = mms.threads.getThreadDir(thread.id)
    const path = (await new WorkspaceResolver(directory, thread.id, f.repo).resolve('agent')).workspacePath!
    return { threadId: thread.id, directory, path }
  }

  it('chooses hunks in a project folder, announces it, and commits only them', async () => {
    const project = mms.projects.openProject(f.repo)
    const scope = { projectId: project.id }
    writeFileSync(join(f.repo, 'a.txt'), twoHunks()); writeFileSync(join(f.repo, 'value.txt'), 'other\n')
    const seen: unknown[] = []
    client.onEvent((event) => { if (event.type === 'git.selectionChanged') seen.push(event.data) })
    await client.subscribe(0)
    const before = await changes(scope)
    expect(before.selection.state).toBe('untouched')
    const a = fileOf(before, 'a.txt')
    const included = await client.request<GitIncludeResult>('git.include', { ...scope, path: 'a.txt', version: a.version, include: false, hunks: [a.hunks[1]!.id] })
    expect(included).toMatchObject({ path: 'a.txt', included: 'partial', selection: { state: 'chosen' } })
    await vi.waitFor(() => expect(seen).toContainEqual({ projectId: project.id }))
    const after = await changes(scope, ['a.txt'])
    expect(after.files.map((file) => file.path)).toEqual(['a.txt'])
    expect(after.selection.token).toBe(included.selection.token)
    await client.request('git.commit', { ...scope, message: 'chosen', selection: { mode: 'chosen', token: included.selection.token } })
    expect(git(f.repo, 'show', 'HEAD:a.txt')).toContain('line 3 changed')
    expect(git(f.repo, 'show', 'HEAD:a.txt')).not.toContain('line 25 changed')
    await expect(client.request('git.commit', { ...scope, message: 'again', selection: { mode: 'chosen', token: included.selection.token } })).rejects.toMatchObject({ code: 'stale' })
    // Undo last commit puts the change back into the files and the index.
    const head = git(f.repo, 'rev-parse', 'HEAD')
    await client.request('git.undoLastCommit', { ...scope, expectedHead: head })
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(git(f.repo, 'rev-parse', `${head}^`))
    expect(git(f.repo, 'diff', '--cached', '--name-only')).toContain('a.txt')
  })

  it('keeps a thread worktree\'s choice in the thread, commits it as a recorded action, and refuses Undo last commit there', async () => {
    const t = await threadScope()
    const scope = { threadId: t.threadId }
    writeFileSync(join(t.path, 'a.txt'), twoHunks()); writeFileSync(join(t.path, 'value.txt'), 'thread\n')
    const a = fileOf(await changes(scope), 'a.txt')
    const { selection } = await client.request<GitIncludeResult>('git.include', { ...scope, path: 'a.txt', version: a.version, include: false, hunks: [a.hunks[0]!.id] })
    // The real index is untouched; the choice lives in the thread's folder.
    expect(git(t.path, 'diff', '--cached', '--name-only')).toBe('')
    await client.request('git.commit', { ...scope, message: 'chosen in thread', selection: { mode: 'chosen', token: selection.token } })
    expect(git(t.path, 'show', 'HEAD:a.txt')).toContain('line 25 changed')
    expect(git(t.path, 'show', 'HEAD:a.txt')).not.toContain('line 3 changed')
    expect(git(t.path, 'show', 'HEAD:value.txt')).toBe('thread')
    const { actions } = await client.request<{ actions: Array<{ commits?: string[]; actor: { kind: string } }> }>('actions.list', scope)
    expect(actions.at(-1)).toMatchObject({ actor: { kind: 'user' }, commits: [git(t.path, 'rev-parse', 'HEAD')] })
    await expect(client.request('git.undoLastCommit', { ...scope, expectedHead: git(t.path, 'rev-parse', 'HEAD') })).rejects.toMatchObject({ code: 'git_undo_in_thread' })
  })

  it('an older client committing in a thread worktree without the field still commits everything', async () => {
    const t = await threadScope()
    writeFileSync(join(t.path, 'a.txt'), twoHunks())
    const a = fileOf(await changes({ threadId: t.threadId }), 'a.txt')
    await client.request('git.include', { threadId: t.threadId, path: 'a.txt', version: a.version, include: false })
    await client.request('git.commit', { threadId: t.threadId, message: 'everything' })
    expect(git(t.path, 'show', 'HEAD:a.txt')).toContain('line 25 changed')
    expect((await changes({ threadId: t.threadId })).selection.state).toBe('untouched')
  })

  it('refuses a change of the selection while a turn runs, in the thread and in a project folder a thread works in', async () => {
    const t = await threadScope()
    writeFileSync(join(t.path, 'a.txt'), twoHunks())
    const a = fileOf(await changes({ threadId: t.threadId }), 'a.txt')
    const active = vi.spyOn(mms.orchestrator, 'isTurnActive').mockReturnValue(true)
    await expect(client.request('git.include', { threadId: t.threadId, path: 'a.txt', version: a.version, include: false })).rejects.toMatchObject({ code: 'thread_busy' })
    await expect(client.request('git.commit', { threadId: t.threadId, message: 'x', selection: { mode: 'chosen', token: 'x' } })).rejects.toMatchObject({ code: 'thread_busy' })
    active.mockRestore()

    const project = mms.projects.openProject(f.repo)
    mms.threads.createThread('In the folder', project.id, undefined, { worktreeEnabled: false })
    writeFileSync(join(f.repo, 'a.txt'), twoHunks())
    const p = fileOf(await changes({ projectId: project.id }), 'a.txt')
    vi.spyOn(mms.orchestrator, 'isConversationHistoryBusy').mockReturnValue(true)
    await expect(client.request('git.include', { projectId: project.id, path: 'a.txt', version: p.version, include: false })).rejects.toMatchObject({ code: 'thread_busy' })
    await expect(client.request('git.include', { projectId: project.id, all: true, include: false })).rejects.toMatchObject({ code: 'thread_busy' })
    await expect(client.request('git.undoLastCommit', { projectId: project.id, expectedHead: git(f.repo, 'rev-parse', 'HEAD') })).rejects.toMatchObject({ code: 'thread_busy' })
    expect(git(f.repo, 'diff', '--cached', '--name-only')).toBe('')
  })

  it('describes only a chosen selection for a commit message, and refuses an old token', async () => {
    const project = mms.projects.openProject(f.repo)
    const scope = { projectId: project.id }
    writeFileSync(join(f.repo, 'a.txt'), twoHunks()); writeFileSync(join(f.repo, 'value.txt'), 'other\n')
    const value = fileOf(await changes(scope), 'value.txt')
    const { selection } = await client.request<GitIncludeResult>('git.include', { ...scope, path: 'value.txt', version: value.version, include: false })
    const described: string[][] = []
    vi.spyOn(mms.orchestrator, 'generateCommitMessage').mockImplementation(async (params) => {
      const input = await params.describe!()
      described.push(input.files)
      return { message: 'm', truncated: false }
    })
    await client.request('git.suggestCommitMessage', { ...scope, selection: { mode: 'chosen', token: selection.token } })
    expect(described).toEqual([['a.txt']])
    await expect(client.request('git.suggestCommitMessage', { ...scope, selection: { mode: 'chosen', token: 'old' } })).rejects.toMatchObject({ code: 'stale' })
    await expect(client.request('git.suggestCommitMessage', { ...scope, selection: { mode: 'sideways' } })).rejects.toMatchObject({ code: 'invalid_params' })
  })

  it('includes everything again with all, and rejects a path outside the folder', async () => {
    const project = mms.projects.openProject(f.repo)
    const scope = { projectId: project.id }
    writeFileSync(join(f.repo, 'a.txt'), twoHunks())
    const out = await client.request<{ selection: GitSelectionState }>('git.include', { ...scope, all: true, include: false })
    expect(out.selection.state).toBe('chosen')
    expect(fileOf(await changes(scope), 'a.txt').included).toBe('no')
    await client.request('git.include', { ...scope, all: true, include: true })
    expect(fileOf(await changes(scope), 'a.txt').included).toBe('yes')
    await expect(client.request('git.include', { ...scope, path: '../outside.txt', version: 'x', include: true })).rejects.toMatchObject({ code: 'git_path_outside' })
  })

  it('a branch switch away and back ends "everything left out"', async () => {
    const project = mms.projects.openProject(f.repo)
    const scope = { projectId: project.id }
    const main = git(f.repo, 'rev-parse', '--abbrev-ref', 'HEAD')
    git(f.repo, 'switch', '-q', '-c', 'other'); writeFileSync(join(f.repo, 'other.txt'), 'other\n'); git(f.repo, 'add', 'other.txt'); git(f.repo, 'commit', '-qm', 'other'); git(f.repo, 'switch', '-q', main)
    writeFileSync(join(f.repo, 'new.txt'), 'new\n')
    await client.request('git.include', { ...scope, all: true, include: false })
    expect((await changes(scope)).selection.state).toBe('chosen')
    const seen: unknown[] = []
    client.onEvent((event) => { if (event.type === 'git.selectionChanged') seen.push(event.data) })
    await client.subscribe(0)
    await client.request('git.checkout', { ...scope, branch: 'other' })
    await client.request('git.checkout', { ...scope, branch: main })
    expect((await changes(scope)).selection.state).toBe('untouched')
    await vi.waitFor(() => expect(seen).toContainEqual({ projectId: project.id }))
  })
})
