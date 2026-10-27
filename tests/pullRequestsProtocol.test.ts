import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { PROTOCOL_METHODS } from '../src/mms/protocol/types'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import type { GitPullRequestInfo, GitPullRequestLookup, Thread } from '../src/shared/types'
import { PULL_REQUEST_EXISTS } from '../src/mms/git/GitHubCodeHost'
import { git, gitFoundationFixture } from './fixtures/gitFoundation'

const info = (patch: Partial<GitPullRequestInfo> = {}): GitPullRequestInfo => ({
  number: 12,
  title: 'Add thing',
  url: 'https://github.com/acme/app/pull/12',
  state: 'open',
  isDraft: false,
  headRefName: 'feature',
  baseRefName: 'main',
  checks: 'passing',
  checkCounts: { passed: 1, failed: 0, pending: 0, waiting: 0, total: 1 },
  ...patch
})

describe('pull request methods through the daemon protocol', () => {
  let f: ReturnType<typeof gitFoundationFixture>
  let mms: MousseMainService
  let server: MmsProtocolServer
  let client: LocalMmsClient
  let events: Array<{ type: string }>

  beforeEach(async () => {
    f = gitFoundationFixture()
    mms = await MousseMainService.create({ homeDir: f.home, headless: true, ownerKind: 'test' })
    await mms.start()
    const ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    const endpoint = await server.start()
    client = new LocalMmsClient({ homeDir: f.home, endpoint, ownerToken, clientType: 'gui' })
    events = []
    client.onEvent((event) => events.push(event))
    await client.connect()
    await client.subscribe()
  }, 30_000)

  afterEach(async () => {
    vi.restoreAllMocks()
    await client?.close()
    await server?.stop()
    await mms?.stop()
    f?.dispose()
  })

  const lookupSpy = (lookup: GitPullRequestLookup = { state: 'found', pullRequest: info() }) =>
    vi.spyOn(mms.gitService.codeHost, 'lookupPullRequest').mockResolvedValue(lookup)
  /** The folder a call ran in, with Windows and macOS path spellings made comparable. */
  const normalized = (path: unknown) => String(path).replace(/\\/g, '/').toLowerCase()

  it('lists the methods', () => {
    for (const method of ['pullRequests.get', 'pullRequests.draft', 'pullRequests.create', 'pullRequests.baseBranches', 'pullRequests.link', 'pullRequests.unlink']) {
      expect(PROTOCOL_METHODS).toContain(method)
    }
  })

  it('looks up in the project folder for a projectId and in the thread\'s own worktree for a threadId', async () => {
    const spy = lookupSpy()
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Task A', project.id)
    const workspace = await new WorkspaceResolver(mms.threads.getThreadDir(thread.id), thread.id, f.repo).resolve('agent')
    expect(workspace.workspacePath).not.toBe(f.repo)

    expect(await client.request('pullRequests.get', { projectId: project.id, branch: 'feature' })).toEqual({
      lookup: { state: 'found', pullRequest: info() }
    })
    await client.request('pullRequests.get', { threadId: thread.id, branch: 'feature', force: true })

    expect(normalized(spy.mock.calls[0][0])).toBe(normalized(f.repo))
    expect(spy.mock.calls[0].slice(1)).toEqual(['feature', { force: false }])
    expect(normalized(spy.mock.calls[1][0])).toBe(normalized(workspace.workspacePath))
    expect(spy.mock.calls[1].slice(1)).toEqual(['feature', { force: true }])
  })

  it('rejects unknown keys, both ids, and no id', async () => {
    const spy = lookupSpy()
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Task A', project.id)
    await expect(client.request('pullRequests.get', { projectId: project.id, cwd: '/tmp' })).rejects.toThrow(/cwd is not allowed/)
    await expect(client.request('pullRequests.get', { projectId: project.id, threadId: thread.id })).rejects.toThrow(/either threadId or projectId/)
    await expect(client.request('pullRequests.get', {})).rejects.toThrow(/projectId or threadId is required/)
    await expect(client.request('pullRequests.create', { projectId: project.id, title: 't', base: 'main', cwd: '/tmp' })).rejects.toThrow(/cwd is not allowed/)
    await expect(client.request('pullRequests.create', { projectId: project.id, expectedBranch: 'feature', title: 't', base: 'main', head: 'other' })).rejects.toThrow(/head is not allowed/)
    await expect(client.request('pullRequests.draft', { projectId: project.id, expectedBranch: 'feature', cwd: '/tmp' })).rejects.toThrow(/cwd is not allowed/)
    await expect(client.request('pullRequests.draft', { projectId: project.id, threadId: thread.id, expectedBranch: 'feature' })).rejects.toThrow(/either threadId or projectId/)
    await expect(client.request('pullRequests.draft', { projectId: project.id })).rejects.toThrow(/expectedBranch/)
    await expect(client.request('pullRequests.draft', { projectId: project.id, expectedBranch: '--web' })).rejects.toThrow(/not a branch name/)
    await expect(client.request('pullRequests.draft', { projectId: project.id, expectedBranch: 'feature', originThreadId: 'missing' })).rejects.toThrow(/not found/i)
    await expect(client.request('pullRequests.baseBranches', { projectId: project.id, extra: 1 })).rejects.toThrow(/extra is not allowed/)
    await expect(client.request('pullRequests.link', { threadId: thread.id, number: 1, branch: 'x' })).rejects.toThrow(/branch is not allowed/)
    await expect(client.request('pullRequests.unlink', { threadId: thread.id, number: 1 })).rejects.toThrow(/number is not allowed/)
    await expect(client.request('pullRequests.unlink', { threadId: 'missing' })).rejects.toThrow(/not found/i)
    await expect(client.request('pullRequests.get', { threadId: 'missing' })).rejects.toThrow(/not found/i)
    expect(spy).not.toHaveBeenCalled()
  })

  it('reads base branches in the resolved folder', async () => {
    const branches = vi.spyOn(mms.gitService.codeHost, 'listBaseBranches').mockResolvedValue({ defaultBranch: 'main', branches: ['main', 'dev'] })
    const project = mms.projects.openProject(f.repo)
    expect(await client.request('pullRequests.baseBranches', { projectId: project.id })).toEqual({
      baseBranches: { defaultBranch: 'main', branches: ['main', 'dev'] }
    })
    expect(normalized(branches.mock.calls[0][0])).toBe(normalized(f.repo))
  })

  describe('drafting and creating for the branch a form opened on', () => {
    /** A project whose primary checkout is on `feature-a`, one commit ahead of its base. */
    function openOnFeature(options: { push?: boolean } = {}) {
      const base = git(f.repo, 'rev-parse', '--abbrev-ref', 'HEAD')
      git(f.repo, 'checkout', '-q', '-b', 'feature-a')
      f.commit(f.repo, 'changed\n')
      if (options.push !== false) {
        // A pull request is made from a pushed branch.
        git(f.root, 'init', '-q', '--bare', join(f.root, 'remote.git'))
        git(f.repo, 'remote', 'add', 'origin', join(f.root, 'remote.git'))
        git(f.repo, 'push', '-q', '-u', 'origin', 'feature-a')
      }
      const project = mms.projects.openProject(f.repo)
      const thread = mms.threads.createThread('Task A', project.id)
      return { base, project, thread }
    }
    const stubHost = (base: string) => {
      const codeHost = mms.gitService.codeHost
      vi.spyOn(codeHost, 'repositoryIdentity').mockResolvedValue({ host: 'github.com', nameWithOwner: 'acme/app' })
      vi.spyOn(codeHost, 'listBaseBranches').mockResolvedValue({ defaultBranch: base, branches: [base, 'release'] })
      vi.spyOn(codeHost, 'remoteForRepository').mockResolvedValue(null)
      return {
        lookup: vi.spyOn(codeHost, 'lookupPullRequest').mockResolvedValue({ state: 'none', isDefaultBranch: false }),
        create: vi.spyOn(codeHost, 'createPullRequest').mockResolvedValue(info({ number: 30, headRefName: 'feature-a' })),
        branches: codeHost.listBaseBranches as ReturnType<typeof vi.fn>
      }
    }
    const threadUpdates = () => events.filter((event) => event.type === 'threads.updated').length

    it('drafts from the branch\'s commits and the conversation\'s name, with the default branch as base', async () => {
      const { base, project, thread } = openOnFeature()
      stubHost(base)
      const draft = await client.request<{ title: string; body: string; base: string; source: string }>('pullRequests.draft', {
        projectId: project.id,
        originThreadId: thread.id,
        expectedBranch: 'feature-a'
      })
      expect(draft).toEqual({ title: 'Task A', body: '- fixture change', base, source: 'heuristic' })
      const chosen = await client.request<{ base: string }>('pullRequests.draft', { projectId: project.id, expectedBranch: 'feature-a', base: 'release' })
      expect(chosen.base).toBe('release')
    })

    it('creates for the captured branch in the resolved folder, with the description allowed to be empty, and links the originating thread', async () => {
      const { base, project, thread } = openOnFeature()
      const host = stubHost(base)
      const before = threadUpdates()
      expect(await client.request('pullRequests.create', {
        projectId: project.id,
        originThreadId: thread.id,
        expectedBranch: 'feature-a',
        title: 'Add thing',
        base,
        draft: true
      })).toEqual({ pullRequest: info({ number: 30, headRefName: 'feature-a' }), existing: false })
      expect(normalized(host.create.mock.calls[0][0])).toBe(normalized(f.repo))
      expect(host.create.mock.calls[0][1]).toEqual({ title: 'Add thing', body: '', base, draft: true, head: 'feature-a' })
      expect(host.lookup.mock.calls[0].slice(1)).toEqual(['feature-a', { force: true }])
      expect(mms.threads.getThread(thread.id)?.pullRequest).toMatchObject({ number: 30, headRefName: 'feature-a', host: 'github.com', nameWithOwner: 'acme/app' })
      await vi.waitFor(() => expect(threadUpdates()).toBeGreaterThan(before))
    })

    it('works in a worktree thread\'s own folder and branch', async () => {
      const base = git(f.repo, 'rev-parse', '--abbrev-ref', 'HEAD')
      const project = mms.projects.openProject(f.repo)
      const thread = mms.threads.createThread('Task A', project.id)
      const workspace = await new WorkspaceResolver(mms.threads.getThreadDir(thread.id), thread.id, f.repo).resolve('agent')
      const branch = git(workspace.workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD')
      git(f.root, 'init', '-q', '--bare', join(f.root, 'remote.git'))
      git(f.repo, 'remote', 'add', 'origin', join(f.root, 'remote.git'))
      git(workspace.workspacePath, 'push', '-q', '-u', 'origin', branch)
      const host = stubHost(base)
      await client.request('pullRequests.create', { threadId: thread.id, originThreadId: thread.id, expectedBranch: branch, title: 'T', base })
      expect(normalized(host.create.mock.calls[0][0])).toBe(normalized(workspace.workspacePath))
      expect(host.create.mock.calls[0][1]).toMatchObject({ head: branch })
      expect(mms.threads.getThread(thread.id)?.pullRequest?.number).toBe(30)
    })

    it('shows an open pull request the branch already has instead of creating another, and links it', async () => {
      const { base, project, thread } = openOnFeature()
      const host = stubHost(base)
      host.lookup.mockResolvedValue({ state: 'found', pullRequest: info({ number: 12 }) })
      expect(await client.request('pullRequests.create', {
        projectId: project.id,
        originThreadId: thread.id,
        expectedBranch: 'feature-a',
        title: 'Add thing',
        base
      })).toEqual({ pullRequest: info({ number: 12 }), existing: true })
      expect(host.create).not.toHaveBeenCalled()
      expect(mms.threads.getThread(thread.id)?.pullRequest?.number).toBe(12)
    })

    it('creates a new pull request when the branch\'s earlier one is closed or merged', async () => {
      const { base, project } = openOnFeature()
      const host = stubHost(base)
      host.lookup.mockResolvedValue({ state: 'found', pullRequest: info({ number: 12, state: 'merged' }) })
      const result = await client.request<{ existing: boolean }>('pullRequests.create', { projectId: project.id, expectedBranch: 'feature-a', title: 'Again', base })
      expect(result.existing).toBe(false)
      expect(host.create).toHaveBeenCalledTimes(1)
    })

    it('still returns the created pull request when it cannot be linked', async () => {
      const { base, project, thread } = openOnFeature()
      const host = stubHost(base)
      vi.spyOn(mms.gitService.codeHost, 'repositoryIdentity').mockRejectedValue(new Error('rate limited'))
      const result = await client.request<{ pullRequest: { number: number } }>('pullRequests.create', {
        projectId: project.id,
        originThreadId: thread.id,
        expectedBranch: 'feature-a',
        title: 'T',
        base
      })
      expect(result.pullRequest.number).toBe(30)
      expect(host.create).toHaveBeenCalledTimes(1)
      expect(mms.threads.getThread(thread.id)?.pullRequest).toBeUndefined()
    })

    it('refuses a branch that is not pushed, or is pushed under another name, and creates nothing', async () => {
      const unpushed = openOnFeature({ push: false })
      const host = stubHost(unpushed.base)
      await expect(client.request('pullRequests.create', { projectId: unpushed.project.id, expectedBranch: 'feature-a', title: 'T', base: unpushed.base })).rejects.toThrow(/Push the branch first/)
      // Pushed, but as another branch: --head would name a branch the remote does not have.
      git(f.root, 'init', '-q', '--bare', join(f.root, 'remote.git'))
      git(f.repo, 'remote', 'add', 'origin', join(f.root, 'remote.git'))
      git(f.repo, 'push', '-q', '-u', 'origin', 'feature-a:renamed')
      await expect(client.request('pullRequests.create', { projectId: unpushed.project.id, expectedBranch: 'feature-a', title: 'T', base: unpushed.base })).rejects.toThrow(/pushed as "renamed"/)
      expect(host.create).not.toHaveBeenCalled()
      // An open pull request is still shown for a branch whose upstream cannot be read.
      host.lookup.mockResolvedValue({ state: 'found', pullRequest: info({ number: 12 }) })
      await expect(client.request('pullRequests.create', { projectId: unpushed.project.id, expectedBranch: 'feature-a', title: 'T', base: unpushed.base })).resolves.toMatchObject({ existing: true })
    })

    it('shows the pull request another client created in the same moment, and links it', async () => {
      const { base, project, thread } = openOnFeature()
      const host = stubHost(base)
      host.lookup.mockResolvedValueOnce({ state: 'none', isDefaultBranch: false }).mockResolvedValue({ state: 'found', pullRequest: info({ number: 12 }) })
      host.create.mockRejectedValue(Object.assign(new Error('A pull request for this branch already exists.'), { code: PULL_REQUEST_EXISTS }))
      expect(await client.request('pullRequests.create', { projectId: project.id, originThreadId: thread.id, expectedBranch: 'feature-a', title: 'T', base })).toEqual({
        pullRequest: info({ number: 12 }),
        existing: true
      })
      expect(host.lookup).toHaveBeenCalledTimes(2)
      expect(host.lookup.mock.calls[1][2]).toEqual({ force: true })
      expect(mms.threads.getThread(thread.id)?.pullRequest?.number).toBe(12)
      // When the other pull request cannot be found either, the host's own error is what the user sees.
      host.lookup.mockReset().mockResolvedValue({ state: 'none', isDefaultBranch: false })
      await expect(client.request('pullRequests.create', { projectId: project.id, expectedBranch: 'feature-a', title: 'T', base })).rejects.toThrow(/already exists/)
      // gh's own message reaches the form, not a generic failure.
      host.create.mockRejectedValue(new Error("GraphQL: Head sha can't be blank"))
      await expect(client.request('pullRequests.create', { projectId: project.id, expectedBranch: 'feature-a', title: 'T', base })).rejects.toThrow(/Head sha can't be blank/)
    })

    it('takes an originating thread only from the folder it acts on', async () => {
      const { base, project, thread } = openOnFeature()
      const host = stubHost(base)
      const otherDirectory = join(f.root, 'other-project')
      mkdirSync(otherDirectory)
      const otherProject = mms.projects.openProject(otherDirectory)
      const elsewhere = mms.threads.createThread('Elsewhere', otherProject.id)
      const worktreeThread = mms.threads.createThread('Worktree', project.id)
      await new WorkspaceResolver(mms.threads.getThreadDir(worktreeThread.id), worktreeThread.id, f.repo).resolve('agent')
      const refused = /not the thread of this folder/
      // Another project's thread, for a project call and for a thread call.
      await expect(client.request('pullRequests.draft', { projectId: project.id, originThreadId: elsewhere.id, expectedBranch: 'feature-a' })).rejects.toThrow(refused)
      await expect(client.request('pullRequests.create', { threadId: thread.id, originThreadId: elsewhere.id, expectedBranch: 'feature-a', title: 'T', base })).rejects.toThrow(refused)
      // A thread with its own worktree is not the thread of the project's checkout, and another thread is not this thread.
      await expect(client.request('pullRequests.draft', { projectId: project.id, originThreadId: worktreeThread.id, expectedBranch: 'feature-a' })).rejects.toThrow(refused)
      await expect(client.request('pullRequests.create', { threadId: thread.id, originThreadId: worktreeThread.id, expectedBranch: 'feature-a', title: 'T', base })).rejects.toThrow(refused)
      expect(host.create).not.toHaveBeenCalled()
      expect(mms.threads.getThread(elsewhere.id)?.pullRequest).toBeUndefined()
      // A thread on the project's checkout is accepted for the project's folder.
      await expect(client.request('pullRequests.draft', { projectId: project.id, originThreadId: thread.id, expectedBranch: 'feature-a' })).resolves.toMatchObject({ source: 'heuristic' })
    })

    it('refuses a draft and a create when the folder moved to another branch, and does nothing', async () => {
      const { base, project, thread } = openOnFeature()
      const host = stubHost(base)
      git(f.repo, 'checkout', '-q', '-b', 'other')
      const draft = client.request('pullRequests.draft', { projectId: project.id, originThreadId: thread.id, expectedBranch: 'feature-a' })
      await expect(draft).rejects.toThrow(/branch changed/)
      await expect(client.request('pullRequests.draft', { projectId: project.id, expectedBranch: 'feature-a' })).rejects.toMatchObject({ code: 'git_branch_changed' })
      const create = client.request('pullRequests.create', { projectId: project.id, originThreadId: thread.id, expectedBranch: 'feature-a', title: 'T', base })
      await expect(create).rejects.toThrow(/branch changed/)
      await expect(client.request('pullRequests.create', { projectId: project.id, expectedBranch: 'feature-a', title: 'T', base })).rejects.toMatchObject({ code: 'git_branch_changed' })
      expect(host.lookup).not.toHaveBeenCalled()
      expect(host.create).not.toHaveBeenCalled()
      expect(host.branches).not.toHaveBeenCalled()
      expect(mms.threads.getThread(thread.id)?.pullRequest).toBeUndefined()
      // The branch it was opened on is still accepted once the folder is back on it.
      git(f.repo, 'checkout', '-q', 'feature-a')
      await expect(client.request('pullRequests.draft', { projectId: project.id, expectedBranch: 'feature-a' })).resolves.toMatchObject({ source: 'heuristic' })
    })

    it('refuses a detached HEAD and the default branch with the reason', async () => {
      const { base, project } = openOnFeature()
      const host = stubHost(base)
      git(f.repo, 'checkout', '-q', base)
      await expect(client.request('pullRequests.draft', { projectId: project.id, expectedBranch: base })).rejects.toThrow(/default branch cannot get a pull request/)
      host.lookup.mockResolvedValue({ state: 'none', isDefaultBranch: true })
      await expect(client.request('pullRequests.create', { projectId: project.id, expectedBranch: base, title: 'T', base: 'release' })).rejects.toThrow(/default branch cannot get a pull request/)
      git(f.repo, 'checkout', '-q', '--detach')
      await expect(client.request('pullRequests.draft', { projectId: project.id, expectedBranch: 'feature-a' })).rejects.toThrow(/Check out a branch/)
      await expect(client.request('pullRequests.create', { projectId: project.id, expectedBranch: 'feature-a', title: 'T', base: 'release' })).rejects.toThrow(/Check out a branch/)
      expect(host.create).not.toHaveBeenCalled()
    })

    it('creates nothing when the duplicate check cannot be answered, and says why', async () => {
      const { base, project } = openOnFeature()
      const host = stubHost(base)
      host.lookup.mockResolvedValue({ state: 'unavailable', reason: 'unauthenticated', message: 'You are not logged in to github.com' })
      await expect(client.request('pullRequests.create', { projectId: project.id, expectedBranch: 'feature-a', title: 'T', base })).rejects.toThrow(/not logged in to github\.com/)
      expect(host.create).not.toHaveBeenCalled()
    })

    it('refuses a title that is too long or a base that looks like a flag before touching anything', async () => {
      const { base, project } = openOnFeature()
      const host = stubHost(base)
      await expect(client.request('pullRequests.create', { projectId: project.id, expectedBranch: 'feature-a', title: 'x'.repeat(257), base })).rejects.toThrow(/title/)
      await expect(client.request('pullRequests.create', { projectId: project.id, expectedBranch: 'feature-a', title: 'T', base: '--web' })).rejects.toThrow(/not a branch name/)
      expect(host.lookup).not.toHaveBeenCalled()
    })
  })

  describe('what a branch adds to its base', () => {
    const write = (name: string, text: string) => writeFileSync(join(f.repo, name), text)

    it('reads the commits, the diffstat and the patch of the named branch, never of HEAD', async () => {
      const base = git(f.repo, 'rev-parse', '--abbrev-ref', 'HEAD')
      git(f.repo, 'checkout', '-q', '-b', 'feature-a')
      write('a.txt', 'from a\n')
      git(f.repo, 'add', '.')
      git(f.repo, 'commit', '-qm', 'Add a', '-m', 'Why a')
      git(f.repo, 'checkout', '-q', '-b', 'feature-b', base)
      write('b.txt', 'from b\n')
      git(f.repo, 'add', '.')
      git(f.repo, 'commit', '-qm', 'Add b')
      git(f.repo, 'checkout', '-q', 'feature-a')

      const summary = await mms.gitService.readBranchSummary(f.repo, { branch: 'feature-b', base, remote: null })
      expect(summary.commits).toEqual([{ subject: 'Add b', body: '' }])
      expect(summary.stat).toContain('b.txt')
      expect(summary.stat).not.toContain('a.txt')
      expect(summary.patch).toContain('+++ b/b.txt')
      const a = await mms.gitService.readBranchSummary(f.repo, { branch: 'feature-a', base, remote: null })
      expect(a.commits).toEqual([{ subject: 'Add a', body: 'Why a' }])
    })

    it('prefers the remote-tracking base, and reads nothing for a base or branch that does not exist or looks like a flag', async () => {
      const base = git(f.repo, 'rev-parse', '--abbrev-ref', 'HEAD')
      git(f.repo, 'update-ref', 'refs/remotes/origin/trunk', git(f.repo, 'rev-parse', 'HEAD'))
      git(f.repo, 'checkout', '-q', '-b', 'feature-a')
      f.commit(f.repo, 'changed\n')
      const gitService = mms.gitService
      expect((await gitService.readBranchSummary(f.repo, { branch: 'feature-a', base: 'trunk', remote: 'origin' })).commits).toHaveLength(1)
      const none = { commits: [], stat: '', patch: '' }
      expect(await gitService.readBranchSummary(f.repo, { branch: 'feature-a', base: 'trunk', remote: null })).toEqual(none)
      expect(await gitService.readBranchSummary(f.repo, { branch: 'missing', base, remote: null })).toEqual(none)
      expect(await gitService.readBranchSummary(f.repo, { branch: '--stat', base, remote: null })).toEqual(none)
      expect(await gitService.readBranchSummary(f.repo, { branch: 'feature-a', base: '--stat', remote: null })).toEqual(none)
      expect(await gitService.readBranchSummary(f.repo, { branch: 'feature-a', base, remote: '--x' })).toEqual(none)
    })

    it('bounds a huge patch, and ignores a configured external diff program', async () => {
      const base = git(f.repo, 'rev-parse', '--abbrev-ref', 'HEAD')
      git(f.repo, 'checkout', '-q', '-b', 'feature-a')
      write('big.txt', 'line of text\n'.repeat(40_000))
      git(f.repo, 'add', '.')
      git(f.repo, 'commit', '-qm', 'Add big')
      git(f.repo, 'config', 'diff.external', 'false')
      const summary = await mms.gitService.readBranchSummary(f.repo, { branch: 'feature-a', base, remote: null })
      expect(summary.patch.startsWith('diff --git')).toBe(true)
      expect(summary.patch.length).toBeLessThanOrEqual(48 * 1024)
      expect(summary.patch.length).toBeGreaterThan(40 * 1024)
    })
  })

  it('links a pull request to a thread, and unlinks it, announcing each change', async () => {
    lookupSpy()
    vi.spyOn(mms.gitService.codeHost, 'repositoryIdentity').mockResolvedValue({ host: 'github.com', nameWithOwner: 'acme/app' })
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Task A', project.id)

    const linked = await client.request<{ thread: Thread }>('pullRequests.link', { threadId: thread.id, number: 12 })
    expect(linked.thread.pullRequest).toMatchObject({
      number: 12,
      url: 'https://github.com/acme/app/pull/12',
      host: 'github.com',
      nameWithOwner: 'acme/app',
      headRefName: 'feature',
      baseRefName: 'main',
      headRepository: 'acme/app',
      isCrossRepository: false
    })
    expect(Date.parse(linked.thread.pullRequest!.linkedAt)).not.toBeNaN()
    expect(mms.threads.getThread(thread.id)?.pullRequest?.number).toBe(12)
    await vi.waitFor(() => expect(events.filter((event) => event.type === 'threads.updated').length).toBeGreaterThan(0))

    const before = events.filter((event) => event.type === 'threads.updated').length
    const unlinked = await client.request<{ thread: Thread }>('pullRequests.unlink', { threadId: thread.id })
    expect(unlinked.thread.pullRequest).toBeUndefined()
    expect(mms.threads.getThread(thread.id)?.pullRequest).toBeUndefined()
    await vi.waitFor(() => expect(events.filter((event) => event.type === 'threads.updated').length).toBeGreaterThan(before))
  })

  it('refuses to link a number that is not the thread\'s branch\'s pull request, and links nothing', async () => {
    lookupSpy({ state: 'found', pullRequest: info({ number: 12 }) })
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Task A', project.id)
    await expect(client.request('pullRequests.link', { threadId: thread.id, number: 99 })).rejects.toThrow(/#99/)
    vi.restoreAllMocks()
    lookupSpy({ state: 'none', isDefaultBranch: false })
    await expect(client.request('pullRequests.link', { threadId: thread.id, number: 12 })).rejects.toThrow(/#12/)
    await expect(client.request('pullRequests.link', { threadId: 'missing', number: 12 })).rejects.toThrow(/not found/i)
    expect(mms.threads.getThread(thread.id)?.pullRequest).toBeUndefined()
  })

  it('gives the real reason when the branch lookup is unavailable, instead of a wrong-number error', async () => {
    lookupSpy({ state: 'unavailable', reason: 'unauthenticated', message: 'You are not logged in to github.com' })
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Task A', project.id)
    await expect(client.request('pullRequests.link', { threadId: thread.id, number: 12 })).rejects.toThrow(/not logged in to github\.com/)
    expect(mms.threads.getThread(thread.id)?.pullRequest).toBeUndefined()
  })

  it('does not overwrite an unlink that landed while the link was being read', async () => {
    vi.spyOn(mms.gitService.codeHost, 'repositoryIdentity').mockResolvedValue({ host: 'github.com', nameWithOwner: 'acme/app' })
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Task A', project.id)
    lookupSpy()
    await client.request('pullRequests.link', { threadId: thread.id, number: 12 })

    vi.restoreAllMocks()
    vi.spyOn(mms.gitService.codeHost, 'repositoryIdentity').mockResolvedValue({ host: 'github.com', nameWithOwner: 'acme/app' })
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const spy = vi.spyOn(mms.gitService.codeHost, 'lookupPullRequest').mockImplementation(async () => {
      await gate
      return { state: 'found', pullRequest: info() }
    })
    const relink = client.request('pullRequests.link', { threadId: thread.id, number: 12 })
    const rejected = expect(relink).rejects.toThrow(/changed while/)
    await vi.waitFor(() => expect(spy).toHaveBeenCalled())
    await client.request('pullRequests.unlink', { threadId: thread.id })
    release()
    await rejected
    expect(mms.threads.getThread(thread.id)?.pullRequest).toBeUndefined()
  })

  it('looks the branch up in the thread\'s worktree when linking', async () => {
    const spy = lookupSpy()
    vi.spyOn(mms.gitService.codeHost, 'repositoryIdentity').mockResolvedValue({ host: 'github.com', nameWithOwner: 'acme/app' })
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Task A', project.id)
    const workspace = await new WorkspaceResolver(mms.threads.getThreadDir(thread.id), thread.id, f.repo).resolve('agent')
    await client.request('pullRequests.link', { threadId: thread.id, number: 12 })
    expect(normalized(spy.mock.calls[0][0])).toBe(normalized(workspace.workspacePath))
    expect(spy.mock.calls[0][2]).toEqual({ force: true })
  })
})
