import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { MousseMainService } from '../src/mms/MousseMainService'
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
import type { GitStatusSnapshot } from '../src/shared/types'
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

  describe('a thread worktree', () => {
    it('refuses pull and the branch actions as authoritative', async () => {
      const t = await threadScope()
      for (const [method, extra] of [
        ['git.pull', {}], ['git.checkout', { branch: 'master' }], ['git.createBranch', { name: 'x' }], ['git.renameBranch', { name: 'a', newName: 'b' }],
        ['git.deleteBranch', { name: 'x' }], ['git.abortInProgress', { kind: 'merge' }]
      ] as const) {
        await expect(client.request(method, { threadId: t.threadId, ...extra }), method).rejects.toMatchObject({ code: 'task_branch_authoritative', errorInfo: { category: 'denied' } })
      }
      expect(git(t.path, 'rev-parse', 'HEAD')).toBe(f.baseSha)
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
  })
})
