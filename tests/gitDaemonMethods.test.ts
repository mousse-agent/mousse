import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { withGitMutationLocks } from '../src/mms/actions/GitOperationCoordinator'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { MousseMainService } from '../src/mms/MousseMainService'
import type { HarnessGateway } from '../src/mms/harness/gateway'
import { LocalMmsClient, MmsProtocolError, requestTimeoutFor } from '../src/mms/protocol/client'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import {
  MMS_PROTOCOL_DEFAULT_REQUEST_TIMEOUT_MS,
  MMS_PROTOCOL_GIT_OPERATION_TIMEOUT_MS,
  MMS_PROTOCOL_LOGIN_TIMEOUT_MS,
  MMS_PROTOCOL_ORCHESTRATOR_SEND_TIMEOUT_MS
} from '../src/mms/protocol/types'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import { parseEnvelope } from '../src/mms/protocol/validators'
import type { GitOperationEvent, GitStatusSnapshot } from '../src/shared/types'
import { actionOptions, git, gitFoundationFixture } from './fixtures/gitFoundation'

type Status = { status: GitStatusSnapshot }

describe('requestTimeoutFor', () => {
  it('gives every Git mutation the long operation timeout and leaves reads on the default', () => {
    for (const method of ['git.push', 'git.commit', 'git.checkout', 'git.stage', 'git.unstage', 'git.discard', 'git.fetch', 'git.pull', 'git.abortInProgress', 'git.createBranch', 'git.renameBranch', 'git.deleteBranch', 'git.init']) {
      expect(requestTimeoutFor(method), method).toBe(MMS_PROTOCOL_GIT_OPERATION_TIMEOUT_MS)
    }
    expect(MMS_PROTOCOL_GIT_OPERATION_TIMEOUT_MS).toBe(30 * 60_000)
    for (const method of ['git.status', 'git.diff', 'git.log', 'git.branches', 'files.read']) {
      expect(requestTimeoutFor(method), method).toBe(MMS_PROTOCOL_DEFAULT_REQUEST_TIMEOUT_MS)
    }
    expect(requestTimeoutFor('orchestrator.send')).toBe(MMS_PROTOCOL_ORCHESTRATOR_SEND_TIMEOUT_MS)
    expect(requestTimeoutFor('providers.loginOAuth')).toBe(MMS_PROTOCOL_LOGIN_TIMEOUT_MS)
  })
})

describe('Git mutations through the daemon', () => {
  let f: ReturnType<typeof gitFoundationFixture>
  let mms: MousseMainService
  let server: MmsProtocolServer
  let endpoint: string
  let ownerToken: string
  let client: LocalMmsClient
  const extraClients: LocalMmsClient[] = []

  beforeEach(async () => {
    f = gitFoundationFixture()
    git(f.repo, 'config', 'core.hooksPath', join(f.root, 'no-hooks'))
    git(f.repo, 'config', 'commit.gpgsign', 'false')
    mms = await MousseMainService.create({ homeDir: f.home, headless: true, ownerKind: 'test' })
    await mms.start()
    ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    endpoint = await server.start()
    client = new LocalMmsClient({ homeDir: f.home, endpoint, ownerToken, clientType: 'gui' })
    await client.connect()
  }, 30_000)
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const extra of extraClients.splice(0)) await extra.close()
    await client?.close()
    await server?.stop()
    await mms?.stop()
    f?.dispose()
  })

  /** Hooks live outside the repository; the script runs from the folder Git runs the hook in. */
  function installHook(script: string, name = 'pre-commit'): string {
    const dir = join(f.root, 'hooks')
    mkdirSync(dir, { recursive: true })
    const body = join(dir, `${name}.cjs`)
    writeFileSync(body, script)
    writeFileSync(join(dir, name), `#!/bin/sh\nexec node "${body.replace(/\\/g, '/')}"\n`, { mode: 0o755 })
    git(f.repo, 'config', 'core.hooksPath', dir)
    return join(dir, name)
  }
  const rejectingHook = "console.error('hook says no'); process.exit(1)"
  /** A hook that records the staged paths it saw and changes nothing. */
  const recordingHook = (log: string) => `const { execFileSync } = require('node:child_process'); require('node:fs').writeFileSync(${JSON.stringify(log)}, execFileSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8' }).trim().split('\\n').sort().join(','))`

  const write = (dir: string, name: string, text = `${name}\n`) => writeFileSync(join(dir, name), text)
  const staged = (dir: string) => git(dir, 'diff', '--cached', '--name-only').split('\n').filter(Boolean).sort()
  const porcelain = (dir: string) => git(dir, 'status', '--porcelain=v1', '-uall').split('\n').filter(Boolean).sort()
  const branchOf = (dir: string) => git(dir, 'branch', '--show-current')

  async function projectScope() {
    const project = mms.projects.openProject(f.repo)
    return { projectId: project.id }
  }

  async function threadScope(title = 'Git thread') {
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread(title, project.id)
    const directory = mms.threads.getThreadDir(thread.id)
    const path = (await new WorkspaceResolver(directory, thread.id, f.repo).resolve('agent')).workspacePath!
    return { threadId: thread.id, directory, path }
  }

  /** A bare remote the project's branch tracks. */
  function withRemote(): string {
    const origin = join(f.root, 'origin.git')
    git(f.root, 'init', '--bare', '-q', origin)
    git(f.repo, 'remote', 'add', 'origin', origin)
    git(f.repo, 'push', '-q', '-u', 'origin', branchOf(f.repo))
    return origin
  }

  describe('project folders', () => {
    it('stages, unstages and discards the named paths and rejects a path outside the project', async () => {
      const scope = await projectScope()
      write(f.repo, 'a.txt'); write(f.repo, 'b.txt')
      const staged1 = await client.request<Status>('git.stage', { ...scope, paths: ['a.txt'] })
      expect(staged1.status.changes).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'a.txt', staged: true })]))
      expect(staged(f.repo)).toEqual(['a.txt'])
      await client.request('git.unstage', { ...scope, paths: ['a.txt'] })
      expect(staged(f.repo)).toEqual([])
      await client.request('git.stage', { ...scope, all: true })
      expect(staged(f.repo)).toEqual(['a.txt', 'b.txt'])
      await client.request('git.unstage', { ...scope, all: true })
      expect(staged(f.repo)).toEqual([])
      await client.request('git.discard', { ...scope, paths: ['b.txt'] })
      expect(existsSync(join(f.repo, 'b.txt'))).toBe(false)
      expect(existsSync(join(f.repo, 'a.txt'))).toBe(true)
      await expect(client.request('git.discard', { ...scope, paths: ['../outside.txt'] })).rejects.toMatchObject({ code: 'git_path_outside' })
      await expect(client.request('git.stage', { ...scope, paths: [] })).rejects.toMatchObject({ code: 'invalid_params' })
      await expect(client.request('git.stage', { ...scope, paths: Array.from({ length: 5001 }, (_, i) => `f${i}.txt`) })).rejects.toThrow(/max items/)
    })

    it('fetches, pulls, and creates, renames and deletes branches against a bare remote', async () => {
      const scope = await projectScope()
      const origin = withRemote()
      const other = join(f.root, 'other')
      git(f.root, 'clone', '-q', origin, other)
      git(other, 'config', 'user.name', 'Other'); git(other, 'config', 'user.email', 'other@example.test'); git(other, 'config', 'commit.gpgsign', 'false')
      write(other, 'remote.txt'); git(other, 'add', '.'); git(other, 'commit', '-qm', 'remote change'); git(other, 'push', '-q')
      const fetched = await client.request<Status & { behindBefore: number; behindAfter: number }>('git.fetch', scope)
      expect(fetched).toMatchObject({ behindBefore: 0, behindAfter: 1 })
      expect(fetched.status.behind).toBe(1)
      const pulled = await client.request<Status & { result: string }>('git.pull', scope)
      expect(pulled.result).toBe('fast-forwarded')
      expect(existsSync(join(f.repo, 'remote.txt'))).toBe(true)

      await client.request('git.createBranch', { ...scope, name: 'topic', checkout: false })
      expect(git(f.repo, 'branch', '--list', 'topic')).toContain('topic')
      await client.request('git.renameBranch', { ...scope, name: 'topic', newName: 'topic-2' })
      expect(git(f.repo, 'branch', '--list', 'topic-2')).toContain('topic-2')
      await client.request('git.deleteBranch', { ...scope, name: 'topic-2' })
      expect(git(f.repo, 'branch', '--list', 'topic-2')).toBe('')
      const created = await client.request<Status>('git.createBranch', { ...scope, name: 'topic-3' })
      expect(created.status.branch).toBe('topic-3')
      await expect(client.request('git.pull', { ...scope, strategy: 'sideways' })).rejects.toMatchObject({ code: 'invalid_params' })
    })

    it('initialises a project folder that is not a repository yet, and refuses a thread', async () => {
      const folder = mkdtempSync(join(tmpdir(), 'mousse-daemon-init-'))
      try {
        const project = mms.projects.openProject(folder)
        const result = await client.request<Status>('git.init', { projectId: project.id })
        expect(result.status.isRepo).toBe(true)
        await expect(client.request('git.init', { projectId: project.id })).rejects.toMatchObject({ code: 'git_already_repo' })
        await expect(client.request('git.init', { threadId: 'any' })).rejects.toMatchObject({ code: 'invalid_params' })
      } finally { rmSync(folder, { recursive: true, force: true }) }
    })

    it('commits only what is staged and leaves the other file unstaged', async () => {
      const scope = await projectScope()
      write(f.repo, 'a.txt'); write(f.repo, 'b.txt'); git(f.repo, 'add', 'a.txt')
      await client.request('git.commit', { ...scope, message: 'only A' })
      expect(git(f.repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean)).toEqual(['a.txt'])
      expect(porcelain(f.repo)).toEqual(['?? b.txt'])
    })

    it('refuses a commit or push for a branch that is no longer the current one, and leaves HEAD alone', async () => {
      const scope = await projectScope()
      withRemote()
      write(f.repo, 'a.txt')
      const head = git(f.repo, 'rev-parse', 'HEAD')
      await expect(client.request('git.commit', { ...scope, message: 'stale', expectedBranch: 'some-other-branch' })).rejects.toMatchObject({ code: 'git_branch_changed' })
      await expect(client.request('git.push', { ...scope, expectedBranch: 'some-other-branch' })).rejects.toMatchObject({ code: 'git_branch_changed' })
      expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(head)
      await client.request('git.commit', { ...scope, message: 'fresh', expectedBranch: branchOf(f.repo) })
      expect(git(f.repo, 'rev-parse', 'HEAD')).not.toBe(head)
    })

    it('answers a Git failure with its code and classification, not a wrapper', async () => {
      const scope = await projectScope()
      git(f.repo, 'checkout', '-q', '-b', 'other'); write(f.repo, 'value.txt', 'other branch\n'); git(f.repo, 'commit', '-qam', 'other change')
      git(f.repo, 'checkout', '-q', '-')
      write(f.repo, 'value.txt', 'uncommitted work\n')
      const failure = await client.request('git.checkout', { ...scope, branch: 'other' }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(MmsProtocolError)
      expect(failure).toMatchObject({ code: 'git_checkout_dirty', errorInfo: { category: 'conflict', retryable: false } })
      // The daemon passes the dirty-switch choice on: with `stash` the same switch works.
      const result = await client.request<Status>('git.checkout', { ...scope, branch: 'other', dirty: 'stash' })
      expect(result.status.branch).toBe('other')
      await expect(client.request('git.checkout', { ...scope, branch: 'other', dirty: 'bogus' })).rejects.toMatchObject({ code: 'invalid_params' })
    })
  })

  describe('paths and branch names', () => {
    /** A project in a subfolder of the repository, with a same-named untracked file inside and outside it. */
    async function subfolderProject() {
      const sub = join(f.repo, 'sub')
      mkdirSync(sub)
      write(sub, 'keep.txt'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'sub base')
      const project = mms.projects.openProject(sub)
      write(f.repo, 'victim.txt', 'outside\n'); write(sub, 'victim.txt', 'inside\n')
      return { sub, scope: { projectId: project.id } }
    }

    it('names files the way status does and never reaches a namesake outside a subfolder project', async () => {
      const { sub, scope } = await subfolderProject()
      const status = await client.request<Status>('git.status', scope)
      expect(status.status.changes.map((change) => change.path).sort()).toEqual(['sub/victim.txt', 'victim.txt'])
      // The bare name is the file at the top of the repository, which is outside this project.
      for (const method of ['git.discard', 'git.stage', 'git.unstage']) {
        await expect(client.request(method, { ...scope, paths: ['victim.txt'] }), method).rejects.toMatchObject({ code: 'git_path_outside' })
        await expect(client.request(method, { ...scope, paths: [join(f.repo, 'victim.txt')] }), method).rejects.toMatchObject({ code: 'git_path_outside' })
        await expect(client.request(method, { ...scope, paths: ['sub'] }), method).rejects.toMatchObject({ code: 'git_path_outside' })
      }
      expect(readFileSync(join(f.repo, 'victim.txt'), 'utf8')).toBe('outside\n')
      expect(readFileSync(join(sub, 'victim.txt'), 'utf8')).toBe('inside\n')
      expect(staged(f.repo)).toEqual([])

      await client.request('git.stage', { ...scope, paths: ['sub/victim.txt'] })
      expect(staged(f.repo)).toEqual(['sub/victim.txt'])
      await client.request('git.unstage', { ...scope, paths: ['sub/victim.txt'] })
      expect(staged(f.repo)).toEqual([])
      await client.request('git.discard', { ...scope, paths: ['sub/victim.txt'] })
      expect(existsSync(join(sub, 'victim.txt'))).toBe(false)
      expect(readFileSync(join(f.repo, 'victim.txt'), 'utf8')).toBe('outside\n')

      // An absolute path to a file inside the project is converted to the same name.
      write(sub, 'second.txt')
      await client.request('git.discard', { ...scope, paths: [join(sub, 'second.txt')] })
      expect(existsSync(join(sub, 'second.txt'))).toBe(false)
      expect(readFileSync(join(f.repo, 'victim.txt'), 'utf8')).toBe('outside\n')
    })

    it('deletes and renames only a branch named exactly, so a changed case cannot reach the current or a managed branch', async () => {
      const scope = await projectScope()
      const current = branchOf(f.repo)
      const shouted = current.toUpperCase()
      await expect(client.request('git.deleteBranch', { ...scope, name: shouted, force: true })).rejects.toMatchObject({ code: 'git_ref_not_found' })
      await expect(client.request('git.deleteBranch', { ...scope, name: current })).rejects.toMatchObject({ code: 'git_branch_current' })
      expect(branchOf(f.repo)).toBe(current)
      expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseSha)

      git(f.repo, 'branch', 'mousse/thread/ghost')
      for (const name of ['Mousse/thread/ghost', 'MOUSSE/THREAD/GHOST', 'mousse/thread/ghost']) {
        await expect(client.request('git.deleteBranch', { ...scope, name, force: true }), name).rejects.toMatchObject({ code: 'git_branch_protected' })
        await expect(client.request('git.renameBranch', { ...scope, name, newName: 'taken' }), name).rejects.toMatchObject({ code: 'git_branch_protected' })
      }
      await expect(client.request('git.createBranch', { ...scope, name: 'Mousse/new', checkout: false })).rejects.toMatchObject({ code: 'git_branch_protected' })
      expect(git(f.repo, 'branch', '--list', 'mousse/thread/ghost')).toContain('ghost')

      git(f.repo, 'branch', 'topic')
      await expect(client.request('git.renameBranch', { ...scope, name: 'TOPIC', newName: 'moved' })).rejects.toMatchObject({ code: 'git_ref_not_found' })
      await expect(client.request('git.deleteBranch', { ...scope, name: 'Topic' })).rejects.toMatchObject({ code: 'git_ref_not_found' })
      expect(git(f.repo, 'branch', '--list', 'topic')).toContain('topic')
      await client.request('git.deleteBranch', { ...scope, name: 'topic' })
      expect(git(f.repo, 'branch', '--list', 'topic')).toBe('')
    })
  })

  describe('a thread worktree', () => {
    it('refuses pull and the branch actions as authoritative', async () => {
      const t = await threadScope()
      for (const [method, extra] of [
        ['git.pull', {}], ['git.checkout', { branch: 'master' }], ['git.createBranch', { name: 'x' }], ['git.renameBranch', { name: 'a', newName: 'b' }],
        ['git.deleteBranch', { name: 'x' }]
      ] as const) {
        await expect(client.request(method, { threadId: t.threadId, ...extra }), method).rejects.toMatchObject({ code: 'task_branch_authoritative', errorInfo: { category: 'denied' } })
      }
      expect(git(t.path, 'rev-parse', 'HEAD')).toBe(f.baseSha)
    })

    it('refuses without creating the thread worktree first', async () => {
      const project = mms.projects.openProject(f.repo)
      const thread = mms.threads.createThread('No worktree yet', project.id)
      const directory = mms.threads.getThreadDir(thread.id)
      for (const [method, extra, code] of [
        ['git.pull', {}, 'task_branch_authoritative'], ['git.checkout', { branch: 'x' }, 'task_branch_authoritative'], ['git.createBranch', { name: 'x' }, 'task_branch_authoritative'],
        ['git.renameBranch', { name: 'a', newName: 'b' }, 'task_branch_authoritative'], ['git.deleteBranch', { name: 'x' }, 'task_branch_authoritative'],
        ['git.stage', { all: true }, 'thread_worktree_checkpointed'], ['git.unstage', { all: true }, 'thread_worktree_checkpointed']
      ] as const) {
        await expect(client.request(method, { threadId: thread.id, ...extra }), method).rejects.toMatchObject({ code })
      }
      expect(new ThreadWorkspaceManager(directory).load()).toBeUndefined()
    })

    it('gives up a merge a terminal started, back to the recorded head', async () => {
      const t = await threadScope()
      git(f.repo, 'checkout', '-q', '-b', 'side'); write(f.repo, 'value.txt', 'side\n'); git(f.repo, 'commit', '-qam', 'side change'); git(f.repo, 'checkout', '-q', '-')
      write(t.path, 'value.txt', 'thread\n')
      await client.request('git.commit', { threadId: t.threadId, message: 'thread change' })
      const head = git(t.path, 'rev-parse', 'HEAD')
      expect(() => git(t.path, 'merge', 'side')).toThrow()
      const waiting = await client.request<Status>('git.status', { threadId: t.threadId })
      expect(waiting.status.inProgress).toBe('merge')
      const result = await client.request<Status>('git.abortInProgress', { threadId: t.threadId, kind: 'merge' })
      expect(result.status.inProgress ?? null).toBeNull()
      expect(git(t.path, 'rev-parse', 'HEAD')).toBe(head)
      expect(porcelain(t.path)).toEqual([])
      await client.request('files.write', { threadId: t.threadId, path: 'next.txt', content: 'next\n' })
    })

    it('fetches in a thread worktree under the thread locks, so a queued commit is not held up behind it', async () => {
      const t = await threadScope()
      withRemote()
      const result = await client.request<Status & { behindBefore: number }>('git.fetch', { threadId: t.threadId })
      expect(result.behindBefore).toBe(0)
      write(t.path, 'a.txt')
      const [fetched, committed] = await Promise.all([
        client.request('git.fetch', { threadId: t.threadId }),
        client.request('git.commit', { threadId: t.threadId, message: 'during fetch' })
      ])
      expect(fetched).toBeDefined()
      expect(committed).toBeDefined()
      expect(git(t.path, 'log', '--format=%s', '-1')).toBe('during fetch')
      expect(porcelain(t.path)).toEqual([])
    }, 60_000)

    it('refuses to sweep what a hook rewrote after a successful commit, and records the commit once the tree is clean', async () => {
      const t = await threadScope()
      installHook("require('node:fs').writeFileSync('a.txt', 'formatted by the hook\\n')")
      write(t.path, 'a.txt', 'a\n'); git(t.path, 'add', 'a.txt')
      const before = git(t.path, 'rev-parse', 'HEAD')
      await client.request('git.commit', { threadId: t.threadId, message: 'with formatter' })
      // One commit, with the staged content; the hook's edit stays in the tree and is not committed unverified.
      const landed = git(t.path, 'rev-parse', 'HEAD')
      expect(git(t.path, 'log', '--format=%s', `${before}..HEAD`).split('\n')).toEqual(['with formatter'])
      expect(git(t.path, 'show', 'HEAD:a.txt')).toBe('a')
      // The helper trims the first line, so the leading space of " M" may be gone.
      expect(porcelain(t.path)).toEqual([expect.stringMatching(/^ ?M a\.txt$/)])
      const action = new ThreadActionService(t.directory).list().at(-1)!
      expect(new ThreadJournal(t.directory).latestByOperation().get(action.id)?.state).toBe('recovery_required')
      await expect(client.request('git.commit', { threadId: t.threadId, message: 'again' })).rejects.toThrow(/recovery/i)
      expect(git(t.path, 'rev-parse', 'HEAD')).toBe(landed)

      // The user deals with the leftover edit, then recovery records the commit without another one.
      git(t.path, 'checkout', '--', 'a.txt')
      await client.request('operations.recover', { threadId: t.threadId })
      const recovered = new ThreadActionService(t.directory).list().find((item) => item.id === action.id)!
      expect(recovered).toMatchObject({ state: 'completed', commits: [landed] })
      expect(new ThreadJournal(t.directory).latestByOperation().get(action.id)?.state).toBe('completed')
      expect(git(t.path, 'rev-parse', 'HEAD')).toBe(landed)
      expect(new ThreadWorkspaceManager(t.directory).load()!.headSha).toBe(landed)
      await client.request('files.write', { threadId: t.threadId, path: 'next.txt', content: 'next\n' })
    })

    it('refuses stage and unstage because the next checkpoint would sweep the index anyway', async () => {
      const t = await threadScope()
      write(t.path, 'a.txt')
      await expect(client.request('git.stage', { threadId: t.threadId, paths: ['a.txt'] })).rejects.toMatchObject({ code: 'thread_worktree_checkpointed' })
      await expect(client.request('git.unstage', { threadId: t.threadId, all: true })).rejects.toMatchObject({ code: 'thread_worktree_checkpointed' })
      expect(staged(t.path)).toEqual([])
    })

    it('refuses an amend before Git runs, leaves history alone and still admits the next write', async () => {
      const t = await threadScope()
      const head = git(t.path, 'rev-parse', 'HEAD')
      await expect(client.request('git.commit', { threadId: t.threadId, message: 'amend', amend: true })).rejects.toMatchObject({ code: 'git_amend_in_thread' })
      expect(git(t.path, 'rev-parse', 'HEAD')).toBe(head)
      expect(new ThreadActionService(t.directory).list()).toEqual([])
      await client.request('files.write', { threadId: t.threadId, path: 'next.txt', content: 'next\n' })
      expect(git(t.path, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean)).toEqual(['next.txt'])
    })

    it('commits staged A and unstaged B as one commit through the hooks, with no extra checkpoint', async () => {
      const t = await threadScope()
      const log = join(f.root, 'hook-saw.log')
      installHook(recordingHook(log))
      write(t.path, 'a.txt'); write(t.path, 'b.txt'); git(t.path, 'add', 'a.txt')
      const before = git(t.path, 'rev-parse', 'HEAD')
      const result = await client.request<Status>('git.commit', { threadId: t.threadId, message: 'both files', expectedBranch: branchOf(t.path) })
      expect(result.status.changes).toEqual([])
      expect(readFileSync(log, 'utf8')).toBe('a.txt,b.txt')
      expect(git(t.path, 'log', '--format=%s', `${before}..HEAD`).split('\n')).toEqual(['both files'])
      expect(git(t.path, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort()).toEqual(['a.txt', 'b.txt'])
      expect(porcelain(t.path)).toEqual([])
      expect(new ThreadWorkspaceManager(t.directory).load()!.headSha).toBe(git(t.path, 'rev-parse', 'HEAD'))
      await client.request('files.write', { threadId: t.threadId, path: 'next.txt', content: 'next\n' })
    })

    it('records a commit that a hook rejects as failed, with no checkpoint, and keeps the index as it was', async () => {
      for (const prestaged of [true, false]) {
        const t = await threadScope(prestaged ? 'staged' : 'empty index')
        const hook = installHook(rejectingHook)
        write(t.path, 'a.txt'); write(t.path, 'b.txt')
        if (prestaged) git(t.path, 'add', 'a.txt')
        const before = git(t.path, 'rev-parse', 'HEAD')
        await expect(client.request('git.commit', { threadId: t.threadId, message: 'rejected' })).rejects.toMatchObject({ code: 'git_commit_failed', message: expect.stringContaining('hook says no') })
        expect(git(t.path, 'rev-parse', 'HEAD')).toBe(before)
        expect(git(t.path, 'log', '--format=%s', '-1')).not.toContain('mousse: checkpoint')
        expect(staged(t.path)).toEqual(prestaged ? ['a.txt'] : [])
        expect(porcelain(t.path)).toEqual(prestaged ? ['?? b.txt', 'A  a.txt'].sort() : ['?? a.txt', '?? b.txt'])
        const action = new ThreadActionService(t.directory).list().at(-1)!
        expect(action).toMatchObject({ state: 'failed', commits: [], startSha: before, endSha: before })
        const receipt = new ChangeReceiptService(t.directory).list().find((item) => item.id === action.receiptId)!
        expect(receipt.beforeSha).toBe(receipt.afterSha)
        expect(new ThreadJournal(t.directory).latestByOperation().get(action.id)?.state).toBe('completed')
        // The user fixes the hook and commits again.
        rmSync(hook)
        await client.request('git.commit', { threadId: t.threadId, message: 'fixed' })
        expect(porcelain(t.path)).toEqual([])
        expect(git(t.path, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort()).toEqual(['a.txt', 'b.txt'])
      }
    })

    it('discards one of two dirty files and lets the checkpoint keep the other, recording a non-reversible effect', async () => {
      const t = await threadScope()
      write(t.path, 'first.txt')
      await client.request('git.commit', { threadId: t.threadId, message: 'first' })
      write(t.path, 'x.txt'); write(t.path, 'y.txt')
      const result = await client.request<Status>('git.discard', { threadId: t.threadId, paths: ['x.txt'] })
      expect(result.status.changes).toEqual([])
      expect(existsSync(join(t.path, 'x.txt'))).toBe(false)
      expect(git(t.path, 'ls-tree', '--name-only', 'HEAD').split('\n')).toContain('y.txt')
      const action = new ThreadActionService(t.directory).list().at(-1)!
      expect(action.externalEffects).toEqual([expect.objectContaining({ kind: 'unknown', description: 'Discarded 1 file', reversible: false })])
      expect(porcelain(t.path)).toEqual([])
    })

    it('refuses a push while the thread has uncommitted changes, with its own code', async () => {
      const t = await threadScope()
      write(t.path, 'a.txt')
      await expect(client.request('git.push', { threadId: t.threadId })).rejects.toMatchObject({ code: 'git_thread_dirty', errorInfo: { category: 'conflict' } })
    })

    describe('recovery after a rejected commit', () => {
      async function rejectedCommit() {
        const t = await threadScope()
        const hook = installHook(rejectingHook)
        write(t.path, 'a.txt'); write(t.path, 'b.txt'); git(t.path, 'add', 'a.txt')
        return { t, hook, before: git(t.path, 'rev-parse', 'HEAD') }
      }
      async function expectFinishedFailed({ t, hook, before }: Awaited<ReturnType<typeof rejectedCommit>>) {
        const actions = new ThreadActionService(t.directory)
        await new ThreadActionService(t.directory).recoverPending(t.path)
        const action = actions.list().at(-1)!
        expect(action).toMatchObject({ state: 'failed', commits: [], startSha: before, endSha: before })
        expect(new ThreadJournal(t.directory).latestByOperation().get(action.id)?.state).toBe('completed')
        expect(git(t.path, 'rev-parse', 'HEAD')).toBe(before)
        expect(staged(t.path)).toEqual(['a.txt'])
        expect(porcelain(t.path)).toEqual(['?? b.txt', 'A  a.txt'].sort())
        rmSync(hook)
        await client.request('git.commit', { threadId: t.threadId, message: 'retry' })
        expect(porcelain(t.path)).toEqual([])
      }

      it('finishes the action as failed when the receipt was never written', async () => {
        const scenario = await rejectedCommit()
        vi.spyOn(ChangeReceiptService.prototype, 'record').mockImplementationOnce(() => { throw new Error('crash before the receipt') })
        await expect(client.request('git.commit', { threadId: scenario.t.threadId, message: 'rejected' })).rejects.toMatchObject({ code: 'git_commit_failed' })
        const pending = new ThreadJournal(scenario.t.directory).latestByOperation()
        expect([...pending.values()].some((entry) => entry.state === 'recovery_required')).toBe(true)
        await expectFinishedFailed(scenario)
      })

      it('finishes the action as failed when the receipt exists but the journal was not completed', async () => {
        const scenario = await rejectedCommit()
        const spy = vi.spyOn(ThreadActionService.prototype as unknown as { appendCheckpointCompleted(): void }, 'appendCheckpointCompleted')
        spy.mockImplementationOnce(() => { throw new Error('crash after the receipt') })
        await expect(client.request('git.commit', { threadId: scenario.t.threadId, message: 'rejected' })).rejects.toMatchObject({ code: 'git_commit_failed' })
        expect(new ChangeReceiptService(scenario.t.directory).list()).toHaveLength(1)
        await expectFinishedFailed(scenario)
      })

      /** A commit that lands and then reports a failure, as a crash or a failing post-commit step would. */
      function commitThenFail(only?: string) {
        vi.spyOn(mms.gitService, 'commit').mockImplementationOnce(async (cwd: string) => {
          git(cwd, 'add', only ?? '-A'); git(cwd, 'commit', '-qm', 'landed')
          throw new Error('stopped after the commit landed')
        })
      }

      it('records a commit that landed before the failure once the tree is clean, without sweeping', async () => {
        const t = await threadScope()
        write(t.path, 'a.txt')
        const before = git(t.path, 'rev-parse', 'HEAD')
        commitThenFail()
        await expect(client.request('git.commit', { threadId: t.threadId, message: 'x' })).rejects.toThrow()
        const landed = git(t.path, 'rev-parse', 'HEAD')
        expect(landed).not.toBe(before)
        const action = new ThreadActionService(t.directory).list().at(-1)!
        expect(new ThreadJournal(t.directory).latestByOperation().get(action.id)?.state).toBe('recovery_required')
        await new ThreadActionService(t.directory).recoverPending(t.path)
        const recovered = new ThreadActionService(t.directory).list().find((item) => item.id === action.id)!
        expect(recovered).toMatchObject({ state: 'completed', commits: [landed], startSha: before, endSha: landed })
        expect(new ThreadJournal(t.directory).latestByOperation().get(action.id)?.state).toBe('completed')
        expect(git(t.path, 'log', '--format=%s', `${before}..HEAD`).split('\n')).toEqual(['landed'])
        expect(new ThreadWorkspaceManager(t.directory).load()!.headSha).toBe(landed)
      })

      it('asks for recovery, and sweeps nothing, when a commit landed and files are still changed', async () => {
        const t = await threadScope()
        write(t.path, 'a.txt'); write(t.path, 'b.txt')
        const before = git(t.path, 'rev-parse', 'HEAD')
        commitThenFail('a.txt')
        await expect(client.request('git.commit', { threadId: t.threadId, message: 'x' })).rejects.toThrow()
        const landed = git(t.path, 'rev-parse', 'HEAD')
        const action = new ThreadActionService(t.directory).list().at(-1)!
        await expect(new ThreadActionService(t.directory).recoverPending(t.path)).rejects.toThrow(/needs recovery/)
        expect(git(t.path, 'rev-parse', 'HEAD')).toBe(landed)
        expect(git(t.path, 'log', '--format=%s', `${before}..HEAD`).split('\n')).toEqual(['landed'])
        expect(porcelain(t.path)).toEqual(['?? b.txt'])
        expect(new ThreadJournal(t.directory).latestByOperation().get(action.id)?.state).toBe('recovery_required')
      })

      it('still sweeps an interrupted turn, which has no failure policy', async () => {
        const t = await threadScope()
        const actions = new ThreadActionService(t.directory)
        actions.beginTurn({ ...actionOptions(t.path, 'interrupted-turn'), threadId: t.threadId }, f.baseSha)
        write(t.path, 'turn-output.txt')
        await new ThreadActionService(t.directory).recoverPending(t.path)
        expect(git(t.path, 'log', '--format=%s', '-1')).toContain('mousse: checkpoint turn interrupted-turn')
        expect(git(t.path, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean)).toEqual(['turn-output.txt'])
        expect(porcelain(t.path)).toEqual([])
      })
    })
  })

  describe('suggesting a commit message', () => {
    type Suggestion = { message: string; truncated: boolean }
    /** The gateway's one request with no tools (`oneShot`), which the title model runs on. */
    const oneShotOf = () => vi.spyOn((mms.orchestrator as unknown as { harness: Pick<HarnessGateway, 'oneShot'> }).harness, 'oneShot')
    /** A chosen title model whose answer is canned; returns the spy on the model call. */
    function withTitleModel(answer = 'Add the files.') {
      mms.settings.set({ title: { llmProvider: 'openai', model: 'gpt-big' } })
      return oneShotOf().mockResolvedValue({ text: answer })
    }
    const promptOf = (ask: ReturnType<typeof withTitleModel>, call = 0) => ask.mock.calls[call]![0].prompt

    it('says so with a code when no title model is chosen, and reads nothing', async () => {
      const scope = await projectScope()
      const ask = oneShotOf()
      write(f.repo, 'a.txt')
      await expect(client.request('git.suggestCommitMessage', scope)).rejects.toMatchObject({ code: 'git_suggest_no_model', errorInfo: { category: 'unavailable' } })
      expect(ask).not.toHaveBeenCalled()
    })

    it('in a project folder sends the staged changes only and leaves the repository as it was', async () => {
      const scope = await projectScope()
      const ask = withTitleModel('Add the staged file.\n\nIt is new.')
      write(f.repo, 'staged.txt', 'STAGED CONTENT\n'); git(f.repo, 'add', 'staged.txt')
      write(f.repo, 'value.txt', 'UNSTAGED EDIT\n'); write(f.repo, 'untracked.txt', 'UNTRACKED CONTENT\n')
      const before = { head: git(f.repo, 'rev-parse', 'HEAD'), state: porcelain(f.repo) }

      const result = await client.request<Suggestion>('git.suggestCommitMessage', { ...scope, expectedBranch: branchOf(f.repo) })
      expect(result).toEqual({ message: 'Add the staged file\n\nIt is new.', truncated: false })
      expect(promptOf(ask)).toContain('STAGED CONTENT')
      expect(promptOf(ask)).not.toMatch(/UNSTAGED EDIT|UNTRACKED CONTENT|untracked\.txt/)
      expect(ask.mock.calls[0]![0].sessionKey).not.toMatch(/^commit-message:t/)
      expect({ head: git(f.repo, 'rev-parse', 'HEAD'), state: porcelain(f.repo) }).toEqual(before)

      // With nothing staged the commit stages everything, so that is what is described; new files by name only.
      git(f.repo, 'reset', '-q')
      await client.request('git.suggestCommitMessage', scope)
      expect(promptOf(ask, 1)).toMatch(/UNSTAGED EDIT/)
      expect(promptOf(ask, 1)).toContain('- untracked.txt')
      expect(promptOf(ask, 1)).not.toContain('UNTRACKED CONTENT')
    })

    it('in a thread worktree sends every change, as the commit there takes every change, and names the thread', async () => {
      const t = await threadScope()
      const ask = withTitleModel()
      write(t.path, 'staged.txt', 'STAGED CONTENT\n'); git(t.path, 'add', 'staged.txt')
      write(t.path, 'value.txt', 'UNSTAGED EDIT\n')
      const before = { head: git(t.path, 'rev-parse', 'HEAD'), state: porcelain(t.path) }

      await client.request('git.suggestCommitMessage', { threadId: t.threadId })
      expect(promptOf(ask)).toContain('STAGED CONTENT')
      expect(promptOf(ask)).toContain('UNSTAGED EDIT')
      expect(ask.mock.calls[0]![0].sessionKey).toBe(`commit-message:${t.threadId}`)
      expect({ head: git(t.path, 'rev-parse', 'HEAD'), state: porcelain(t.path) }).toEqual(before)
      // The project's own checkout is a different folder and was not read.
      expect(porcelain(f.repo)).toEqual([])
    })

    it('does not create a thread worktree, and with no changes has nothing to describe', async () => {
      const project = mms.projects.openProject(f.repo)
      const thread = mms.threads.createThread('No worktree yet', project.id)
      const ask = withTitleModel()
      await expect(client.request('git.suggestCommitMessage', { threadId: thread.id })).rejects.toMatchObject({ code: 'git_suggest_empty' })
      expect(new ThreadWorkspaceManager(mms.threads.getThreadDir(thread.id)).load()).toBeUndefined()
      expect(ask).not.toHaveBeenCalled()
    })

    it('answers with a fixed failure when the model fails', async () => {
      const scope = await projectScope()
      const ask = withTitleModel()
      ask.mockRejectedValue(new Error('upstream exploded'))
      write(f.repo, 'a.txt')
      await expect(client.request('git.suggestCommitMessage', scope)).rejects.toMatchObject({ code: 'git_suggest_failed' })
    })

    it('rejects a caller folder, both ids, no id, an unknown thread and a branch that moved', async () => {
      const scope = await projectScope()
      const ask = withTitleModel()
      write(f.repo, 'a.txt')
      await expect(client.request('git.suggestCommitMessage', { ...scope, cwd: '/tmp' })).rejects.toThrow(/cwd is not allowed/)
      await expect(client.request('git.suggestCommitMessage', { ...scope, threadId: 't' })).rejects.toThrow(/either threadId or projectId/)
      await expect(client.request('git.suggestCommitMessage', {})).rejects.toThrow(/projectId or threadId is required/)
      await expect(client.request('git.suggestCommitMessage', { threadId: 'missing' })).rejects.toThrow(/not found/i)
      await expect(client.request('git.suggestCommitMessage', { ...scope, expectedBranch: 'not-the-branch' })).rejects.toMatchObject({ code: 'git_branch_changed' })
      expect(ask).not.toHaveBeenCalled()
    })
  })

  describe('long Git actions', () => {
    it('keeps a push open past the client blanket timeout when it names the Git operation timeout', async () => {
      const scope = await projectScope()
      const origin = withRemote()
      installHook("setTimeout(() => process.exit(0), 3000)", 'pre-push')
      const short = new LocalMmsClient({ homeDir: f.home, endpoint, ownerToken, clientType: 'gui', requestTimeoutMs: 1500 })
      extraClients.push(short)
      await short.connect()

      write(f.repo, 'slow.txt'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'slow one')
      const first = git(f.repo, 'rev-parse', 'HEAD')
      // Without the long timeout the client gives up while Git keeps working.
      await expect(short.request('git.push', scope)).rejects.toThrow('Request timeout')
      await vi.waitFor(() => expect(git(origin, 'rev-parse', branchOf(f.repo))).toBe(first), { timeout: 20_000, interval: 250 })

      write(f.repo, 'slow2.txt'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'slow two')
      const second = git(f.repo, 'rev-parse', 'HEAD')
      const result = await short.request<Status>('git.push', scope, MMS_PROTOCOL_GIT_OPERATION_TIMEOUT_MS)
      expect(result.status.ahead).toBe(0)
      expect(git(origin, 'rev-parse', branchOf(f.repo))).toBe(second)
    }, 60_000)

    describe('live output and cancel', () => {
      const blocksUntil = (sentinel: string) => `const t = setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(sentinel)})) { clearInterval(t); process.exit(0) } }, 25)`
      const hangs = (pidFile: string) => `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, process.pid + ',' + child.pid); setInterval(() => {}, 1000)`
      const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
      const allDead = (pidFile: string) => vi.waitFor(() => expect(readFileSync(pidFile, 'utf8').split(',').map(Number).some(alive)).toBe(false), { timeout: 10_000, interval: 100 })
      /** Connection events need the profile binding every desktop window makes. */
      let me: LocalMmsClient
      const bound = async (): Promise<LocalMmsClient> => {
        const bound = new LocalMmsClient({ homeDir: f.home, endpoint, ownerToken, clientType: 'gui', requestedCapabilities: ['profiles-v1'] })
        extraClients.push(bound)
        await bound.connect()
        await bound.request('profiles.bind', { profile: mms.getInstallationHost()!.getDefaultProfileId() })
        return bound
      }
      beforeEach(async () => { me = await bound() })
      /** What a client hears on its own connection about Git actions. */
      function listen(who: LocalMmsClient): GitOperationEvent[] {
        const heard: GitOperationEvent[] = []
        who.onConnectionEvent((event) => { if (event.type === 'git.operation') heard.push((event.data as { event: GitOperationEvent }).event) })
        return heard
      }
      async function bystander(): Promise<{ client: LocalMmsClient; heard: unknown[] }> {
        const other = await bound()
        const heard: unknown[] = []
        other.onConnectionEvent((event) => heard.push(event))
        other.onEvent((event) => { if (event.type.startsWith('git')) heard.push(event) })
        await other.subscribe(0)
        return { client: other, heard }
      }
      const wait = (ready: () => boolean) => vi.waitFor(() => expect(ready()).toBe(true), { timeout: 15_000, interval: 25 })

      it('sends the output of a push to the client that started it while it is still running, and to nobody else', async () => {
        const scope = await projectScope(); const origin = withRemote()
        const sentinel = join(f.root, 'go')
        installHook(blocksUntil(sentinel), 'pre-push')
        const other = await bystander()
        const mine = listen(me)
        write(f.repo, 'live.txt'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'live')
        let settled = false
        const pushing = me.request<Status>('git.push', { ...scope, operationId: 'daemon-push-1' }).finally(() => { settled = true })
        await wait(() => mine.some((event) => event.phase === 'hook'))
        // The hook is still running: the event arrived before the request was answered.
        expect(settled).toBe(false)
        expect(mine[0]).toMatchObject({ phase: 'started', kind: 'push', operationId: 'daemon-push-1', cancellable: true })
        writeFileSync(sentinel, '')
        await pushing
        await wait(() => mine.at(-1)?.phase === 'done')
        expect(mine.map((event) => event.phase)).toEqual(expect.arrayContaining(['started', 'hook', 'done']))
        expect(mine.filter((event) => event.phase === 'hook').map((event) => event.hook)).toEqual([{ name: 'pre-push' }, { name: 'pre-push', exitCode: 0 }])
        expect(git(origin, 'rev-parse', branchOf(f.repo))).toBe(git(f.repo, 'rev-parse', 'HEAD'))
        await new Promise((resolve) => setTimeout(resolve, 200))
        expect(other.heard).toEqual([])
      }, 60_000)

      it('sends nothing for a request that names no operation', async () => {
        const scope = await projectScope(); withRemote()
        const mine = listen(me)
        write(f.repo, 'quiet.txt'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'quiet')
        await me.request('git.push', scope)
        expect(mine).toEqual([])
      })

      it('cancels a push during its hook for the client that started it only, and stops everything the hook started', async () => {
        const scope = await projectScope(); const origin = withRemote()
        const pidFile = join(f.root, 'pids')
        installHook(hangs(pidFile), 'pre-push')
        const remoteHead = git(origin, 'rev-parse', branchOf(f.repo))
        const other = await bystander()
        const mine = listen(me)
        write(f.repo, 'cancel.txt'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'cancel me')
        const pushing = me.request('git.push', { ...scope, operationId: 'daemon-push-2' }).then(() => null, (error: unknown) => error)
        await wait(() => mine.some((event) => event.phase === 'hook'))
        await expect(other.client.request('git.cancelOperation', { operationId: 'daemon-push-2' })).resolves.toEqual({ cancelled: false })
        await expect(me.request('git.cancelOperation', { operationId: 'unknown' })).resolves.toEqual({ cancelled: false })
        await expect(me.request('git.cancelOperation', {})).rejects.toMatchObject({ code: 'invalid_params' })
        await expect(me.request('git.cancelOperation', { operationId: 'daemon-push-2' })).resolves.toEqual({ cancelled: true })
        expect(await pushing).toMatchObject({ code: 'git_cancelled' })
        await wait(() => mine.at(-1)?.phase === 'cancelled')
        expect(git(origin, 'rev-parse', branchOf(f.repo))).toBe(remoteHead)
        await allDead(pidFile)
        expect(other.heard).toEqual([])
        // The folder is free again.
        rmSync(join(f.root, 'hooks', 'pre-push'))
        await me.request('git.push', scope)
        expect(git(origin, 'rev-parse', branchOf(f.repo))).toBe(git(f.repo, 'rev-parse', 'HEAD'))
      }, 60_000)

      it('cancels a commit in a thread worktree: nothing is committed or swept, the index stays, and the action is recorded as failed', async () => {
        const t = await threadScope()
        const pidFile = join(f.root, 'pids')
        installHook(hangs(pidFile))
        write(t.path, 'a.txt'); write(t.path, 'b.txt'); git(t.path, 'add', 'a.txt')
        const before = git(t.path, 'rev-parse', 'HEAD'), state = porcelain(t.path)
        const mine = listen(me)
        const committing = me.request('git.commit', { threadId: t.threadId, message: 'cancelled', operationId: 'daemon-commit-1' }).then(() => null, (error: unknown) => error)
        await wait(() => mine.some((event) => event.phase === 'hook'))
        await me.request('git.cancelOperation', { operationId: 'daemon-commit-1' })
        expect(await committing).toMatchObject({ code: 'git_cancelled' })
        await allDead(pidFile)
        expect(git(t.path, 'rev-parse', 'HEAD')).toBe(before)
        expect(git(t.path, 'log', '--format=%s', '-1')).not.toContain('mousse: checkpoint')
        expect(staged(t.path)).toEqual(['a.txt'])
        expect(porcelain(t.path)).toEqual(state)
        const action = new ThreadActionService(t.directory).list().at(-1)!
        expect(action).toMatchObject({ state: 'failed', commits: [], startSha: before, endSha: before })
        const receipt = new ChangeReceiptService(t.directory).list().find((item) => item.id === action.receiptId)!
        expect(receipt.beforeSha).toBe(receipt.afterSha)
        // The journal recorded the end, so a restart has nothing to recover and the next action is admitted.
        expect(new ThreadJournal(t.directory).latestByOperation().get(action.id)?.state).toBe('completed')
        await new ThreadActionService(t.directory).recoverPending(t.path)
        expect(git(t.path, 'rev-parse', 'HEAD')).toBe(before)
        expect(porcelain(t.path)).toEqual(state)
        rmSync(join(f.root, 'hooks', 'pre-commit'))
        await me.request('git.commit', { threadId: t.threadId, message: 'works now' })
        expect(porcelain(t.path)).toEqual([])
        expect(git(t.path, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort()).toEqual(['a.txt', 'b.txt'])
      }, 60_000)

      it('cancels an action that still waits for its thread locks: Cancel works from the start and answers at once', async () => {
        const t = await threadScope()
        const mine = listen(me)
        let release: () => void = () => undefined
        const held = withGitMutationLocks(t.directory, t.path, 'test-holder', () => new Promise<void>((resolve) => { release = resolve }))
        await new Promise((resolve) => setTimeout(resolve, 200))
        try {
          const fetching = me.request('git.fetch', { threadId: t.threadId, operationId: 'daemon-queued' }).then(() => null, (error: unknown) => error)
          // Registered before the locks are free: the started event arrives and Cancel is accepted.
          await wait(() => mine.some((event) => event.phase === 'started'))
          await expect(me.request('git.cancelOperation', { operationId: 'daemon-queued' })).resolves.toEqual({ cancelled: true })
          expect(await fetching).toMatchObject({ code: 'git_cancelled' })
          await wait(() => mine.at(-1)?.phase === 'cancelled')
        } finally {
          release()
          await held
        }
      }, 60_000)

      it('cancels a pull in its download when the connection that started it closes, and frees the folder', async () => {
        const scope = await projectScope(); withRemote()
        const pidFile = join(f.root, 'pids')
        const script = join(f.root, 'uploadpack.cjs')
        writeFileSync(script, hangs(pidFile))
        git(f.repo, 'config', 'remote.origin.uploadpack', `node "${script.replace(/\\/g, '/')}"`)
        const mineBefore = listen(me)
        const pulling = me.request('git.pull', { ...scope, operationId: 'daemon-pull-gone' }).then(() => null, (error: unknown) => error)
        await wait(() => existsSync(pidFile) && mineBefore.some((event) => event.phase === 'started'))
        // The window goes away (closed, or reloaded onto a new connection) with the pull still downloading.
        extraClients.splice(extraClients.indexOf(me), 1)
        await me.close()
        await pulling
        await allDead(pidFile)
        // Nobody holds the folder any more, and a new connection can use the same id.
        git(f.repo, 'config', '--unset', 'remote.origin.uploadpack')
        const fresh = await bound()
        await expect(fresh.request('git.pull', { ...scope, operationId: 'daemon-pull-gone' })).resolves.toMatchObject({ result: 'up-to-date' })
        await expect(fresh.request('git.cancelOperation', { operationId: 'daemon-pull-gone' })).resolves.toEqual({ cancelled: false })
      }, 60_000)

      it('accepts the connection event only for the types the daemon sends', () => {
        const event = { kind: 'connection_event', type: 'git.operation', profileId: 'p', profileEpoch: 1, data: { event: { phase: 'started' } } }
        expect(parseEnvelope(event)).toMatchObject({ kind: 'connection_event', type: 'git.operation' })
        expect(parseEnvelope({ ...event, type: 'git.other' })).toBeNull()
      })
    })
  })
})
