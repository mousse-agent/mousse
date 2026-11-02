import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { PROTOCOL_METHODS } from '../src/mms/protocol/types'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import type { GitPullRequestInfo, GitPullRequestLookup, Thread } from '../src/shared/types'
import { parsePullRequestDetail, PULL_REQUEST_EXISTS, PullRequestReadError } from '../src/mms/git/GitHubCodeHost'
import { WORKTREE_CONFIG_ENABLED, WORKTREE_CONFIG_NEEDED, type PullRequestDetail } from '../src/shared/pullRequests'
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

/** A pull request read in full, from the recorded `gh pr view` output. */
const detailOf = (patch: Partial<PullRequestDetail> = {}): PullRequestDetail => ({
  ...parsePullRequestDetail(
    { host: 'github.com', nameWithOwner: 'acme/app', number: 7 },
    readFileSync(new URL('./fixtures/github/pr-view.json', import.meta.url), 'utf8'),
    []
  )!,
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
    for (const method of ['pullRequests.get', 'pullRequests.detail', 'pullRequests.draft', 'pullRequests.create', 'pullRequests.merge', 'pullRequests.close', 'pullRequests.baseBranches', 'pullRequests.mergeMethod', 'pullRequests.link', 'pullRequests.unlink']) {
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
    const detail = vi.spyOn(mms.gitService.codeHost, 'getPullRequestDetail').mockResolvedValue(detailOf())
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
    await expect(client.request('pullRequests.detail', { projectId: project.id, number: 7, cwd: '/tmp' })).rejects.toThrow(/cwd is not allowed/)
    await expect(client.request('pullRequests.detail', { projectId: project.id, threadId: thread.id, number: 7 })).rejects.toThrow(/either threadId or projectId/)
    await expect(client.request('pullRequests.detail', { number: 7 })).rejects.toThrow(/projectId or threadId is required/)
    await expect(client.request('pullRequests.detail', { projectId: project.id })).rejects.toThrow(/number/)
    await expect(client.request('pullRequests.detail', { projectId: project.id, number: 0 })).rejects.toThrow(/number/)
    await expect(client.request('pullRequests.detail', { threadId: 'missing', number: 7 })).rejects.toThrow(/not found/i)
    expect(detail).not.toHaveBeenCalled()
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

  describe('merging and closing a pull request', () => {
    it('merges with the method the host offers, in the thread\'s own worktree, passing the shown head', async () => {
      const method = vi.spyOn(mms.gitService.codeHost, 'defaultMergeMethod').mockResolvedValue('merge')
      const merge = vi.spyOn(mms.gitService.codeHost, 'mergePullRequest').mockResolvedValue(info({ state: 'merged' }))
      const project = mms.projects.openProject(f.repo)
      const thread = mms.threads.createThread('Task A', project.id)
      const workspace = await new WorkspaceResolver(mms.threads.getThreadDir(thread.id), thread.id, f.repo).resolve('agent')
      expect(await client.request('pullRequests.merge', { threadId: thread.id, number: 12, headSha: 'abc1234' })).toEqual({
        pullRequest: info({ state: 'merged' }),
        method: 'merge'
      })
      expect(normalized(method.mock.calls[0][0])).toBe(normalized(workspace.workspacePath))
      expect(normalized(merge.mock.calls[0][0])).toBe(normalized(workspace.workspacePath))
      expect(merge.mock.calls[0].slice(1)).toEqual([12, { method: 'merge', headSha: 'abc1234' }])
    })

    it('squashes when the host\'s method cannot be read', async () => {
      vi.spyOn(mms.gitService.codeHost, 'defaultMergeMethod').mockResolvedValue(null)
      const merge = vi.spyOn(mms.gitService.codeHost, 'mergePullRequest').mockResolvedValue(info({ state: 'merged' }))
      const project = mms.projects.openProject(f.repo)
      expect(await client.request('pullRequests.merge', { projectId: project.id, number: 12 })).toMatchObject({ method: 'squash' })
      expect(normalized(merge.mock.calls[0][0])).toBe(normalized(f.repo))
      expect(merge.mock.calls[0].slice(1)).toEqual([12, { method: 'squash' }])
    })

    it('tells the Merge confirmation the method the host offers, null when it cannot be read, and merges nothing', async () => {
      const method = vi.spyOn(mms.gitService.codeHost, 'defaultMergeMethod').mockResolvedValue('rebase')
      const merge = vi.spyOn(mms.gitService.codeHost, 'mergePullRequest').mockResolvedValue(info({ state: 'merged' }))
      const project = mms.projects.openProject(f.repo)
      expect(await client.request('pullRequests.mergeMethod', { projectId: project.id })).toEqual({ method: 'rebase' })
      expect(normalized(method.mock.calls[0][0])).toBe(normalized(f.repo))
      method.mockResolvedValue(null)
      expect(await client.request('pullRequests.mergeMethod', { projectId: project.id })).toEqual({ method: null })
      await expect(client.request('pullRequests.mergeMethod', { projectId: project.id, number: 12 })).rejects.toThrow(/number is not allowed/)
      expect(merge).not.toHaveBeenCalled()
    })

    it('merges with the confirmed method exactly when the host\'s method was read and then cannot be', async () => {
      const method = vi.spyOn(mms.gitService.codeHost, 'defaultMergeMethod').mockResolvedValueOnce('rebase').mockResolvedValue(null)
      const merge = vi.spyOn(mms.gitService.codeHost, 'mergePullRequest').mockResolvedValue(info({ state: 'merged' }))
      const project = mms.projects.openProject(f.repo)
      const { method: confirmed } = await client.request('pullRequests.mergeMethod', { projectId: project.id }) as { method: string }
      expect(await client.request('pullRequests.merge', { projectId: project.id, number: 12, method: confirmed })).toMatchObject({ method: 'rebase' })
      // A rebase confirmed is a rebase: the unreadable second answer never turns it into a squash.
      expect(merge.mock.calls[0].slice(1)).toEqual([12, { method: 'rebase' }])
      expect(method).toHaveBeenCalledTimes(1)
    })

    it('says nothing it cannot back when the method cannot be read and then can, and the merge picks it', async () => {
      vi.spyOn(mms.gitService.codeHost, 'defaultMergeMethod').mockResolvedValueOnce(null).mockResolvedValue('merge')
      const merge = vi.spyOn(mms.gitService.codeHost, 'mergePullRequest').mockResolvedValue(info({ state: 'merged' }))
      const project = mms.projects.openProject(f.repo)
      // The confirmation is told the method is unknown, not "squash", so it does not promise one.
      expect(await client.request('pullRequests.mergeMethod', { projectId: project.id })).toEqual({ method: null })
      expect(await client.request('pullRequests.merge', { projectId: project.id, number: 12 })).toMatchObject({ method: 'merge' })
      expect(merge.mock.calls[0].slice(1)).toEqual([12, { method: 'merge' }])
    })

    it('uses a confirmed method even when the host now offers another, and refuses one it does not know', async () => {
      const method = vi.spyOn(mms.gitService.codeHost, 'defaultMergeMethod').mockResolvedValue('squash')
      const merge = vi.spyOn(mms.gitService.codeHost, 'mergePullRequest').mockResolvedValue(info({ state: 'merged' }))
      const project = mms.projects.openProject(f.repo)
      expect(await client.request('pullRequests.merge', { projectId: project.id, number: 12, method: 'merge' })).toMatchObject({ method: 'merge' })
      expect(merge.mock.calls[0].slice(1)).toEqual([12, { method: 'merge' }])
      expect(method).not.toHaveBeenCalled()
      await expect(client.request('pullRequests.merge', { projectId: project.id, number: 12, method: 'fast-forward' })).rejects.toThrow(/merge, squash or rebase/)
      await expect(client.request('pullRequests.merge', { projectId: project.id, number: 12, method: 'SQUASH' })).rejects.toThrow(/merge, squash or rebase/)
      expect(merge).toHaveBeenCalledTimes(1)
    })

    it('closes in the project folder', async () => {
      const close = vi.spyOn(mms.gitService.codeHost, 'closePullRequest').mockResolvedValue(info({ state: 'closed' }))
      const project = mms.projects.openProject(f.repo)
      expect(await client.request('pullRequests.close', { projectId: project.id, number: 12 })).toEqual({ pullRequest: info({ state: 'closed' }) })
      expect(normalized(close.mock.calls[0][0])).toBe(normalized(f.repo))
      expect(close.mock.calls[0][1]).toBe(12)
    })

    it('says why the host refused, in its own words', async () => {
      vi.spyOn(mms.gitService.codeHost, 'defaultMergeMethod').mockResolvedValue('squash')
      vi.spyOn(mms.gitService.codeHost, 'mergePullRequest').mockRejectedValue(new Error('Pull request acme/app#12 is not mergeable: the base branch policy prohibits the merge.'))
      vi.spyOn(mms.gitService.codeHost, 'closePullRequest').mockRejectedValue(new Error('Pull request acme/app#12 is already closed'))
      const project = mms.projects.openProject(f.repo)
      await expect(client.request('pullRequests.merge', { projectId: project.id, number: 12 })).rejects.toThrow('the base branch policy prohibits the merge')
      await expect(client.request('pullRequests.close', { projectId: project.id, number: 12 })).rejects.toThrow('already closed')
    })

    it('rejects unknown keys, a bad number or commit, and both or no ids before reaching the host', async () => {
      const merge = vi.spyOn(mms.gitService.codeHost, 'mergePullRequest').mockResolvedValue(info())
      const close = vi.spyOn(mms.gitService.codeHost, 'closePullRequest').mockResolvedValue(info())
      const project = mms.projects.openProject(f.repo)
      const thread = mms.threads.createThread('Task A', project.id)
      await expect(client.request('pullRequests.merge', { projectId: project.id, number: 12, deleteBranch: true })).rejects.toThrow(/deleteBranch is not allowed/)
      await expect(client.request('pullRequests.merge', { projectId: project.id, number: 12, headSha: '--admin' })).rejects.toThrow(/not a commit/)
      await expect(client.request('pullRequests.merge', { projectId: project.id, number: 0 })).rejects.toThrow(/number/)
      await expect(client.request('pullRequests.merge', { number: 12 })).rejects.toThrow(/projectId or threadId is required/)
      await expect(client.request('pullRequests.close', { projectId: project.id, threadId: thread.id, number: 12 })).rejects.toThrow(/either threadId or projectId/)
      await expect(client.request('pullRequests.close', { projectId: project.id, number: 12, deleteBranch: true })).rejects.toThrow(/deleteBranch is not allowed/)
      await expect(client.request('pullRequests.close', { threadId: 'missing', number: 12 })).rejects.toThrow(/not found/i)
      expect(merge).not.toHaveBeenCalled()
      expect(close).not.toHaveBeenCalled()
    })
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
      expect(summary.commits).toEqual([{ subject: 'Add b', body: '', authorEmail: 'foundation@example.test' }])
      expect(summary.stat).toContain('b.txt')
      expect(summary.stat).not.toContain('a.txt')
      expect(summary.patch).toContain('+++ b/b.txt')
      const a = await mms.gitService.readBranchSummary(f.repo, { branch: 'feature-a', base, remote: null })
      expect(a.commits).toEqual([{ subject: 'Add a', body: 'Why a', authorEmail: 'foundation@example.test' }])
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

  const detailSpy = (detail: PullRequestDetail = detailOf()) =>
    vi.spyOn(mms.gitService.codeHost, 'getPullRequestDetail').mockResolvedValue(detail)

  describe('reading a pull request in full', () => {
    it('reads in the project folder for a projectId and in the thread\'s own worktree for a threadId', async () => {
      const spy = detailSpy()
      const project = mms.projects.openProject(f.repo)
      const thread = mms.threads.createThread('Task A', project.id)
      const workspace = await new WorkspaceResolver(mms.threads.getThreadDir(thread.id), thread.id, f.repo).resolve('agent')

      const answer = await client.request<{ detail: PullRequestDetail }>('pullRequests.detail', { projectId: project.id, number: 7 })
      await client.request('pullRequests.detail', { threadId: thread.id, number: 7, force: true })

      expect(answer.detail).toMatchObject({ number: 7, reviewDecision: 'changes_requested', headSha: '0123456789abcdef0123456789abcdef01234567' })
      expect(answer.detail.checkRuns.map((check) => check.name)).toEqual(['build', 'test', 'lint', 'docs', 'ci/deploy-preview'])
      expect(normalized(spy.mock.calls[0][0])).toBe(normalized(f.repo))
      expect(spy.mock.calls[0].slice(1)).toEqual([7, { force: false }])
      expect(normalized(spy.mock.calls[1][0])).toBe(normalized(workspace.workspacePath))
      expect(spy.mock.calls[1].slice(1)).toEqual([7, { force: true }])
    })

    it('answers a failed read with the host\'s own message and the kind of failure as the code', async () => {
      const project = mms.projects.openProject(f.repo)
      const host = vi.spyOn(mms.gitService.codeHost, 'getPullRequestDetail')
      host.mockRejectedValueOnce(new PullRequestReadError('GraphQL: Could not resolve to a PullRequest with the number of 7. — pull request #7 is not in acme/app on github.com, or signed in to github.com as octocat, which cannot see it.', 'not-found'))
      const missing = await client.request('pullRequests.detail', { projectId: project.id, number: 7 }).catch((error: unknown) => error as { code?: string; message: string })
      expect(missing).toMatchObject({ code: 'pull_request_not_found' })
      expect((missing as Error).message).toContain('signed in to github.com as octocat')

      host.mockRejectedValueOnce(new PullRequestReadError('GraphQL: API rate limit exceeded for user ID 1.', 'rate-limited'))
      expect(await client.request('pullRequests.detail', { projectId: project.id, number: 7 }).catch((error: unknown) => error)).toMatchObject({
        code: 'pull_request_rate_limited',
        message: 'GraphQL: API rate limit exceeded for user ID 1.'
      })

      host.mockRejectedValueOnce(new PullRequestReadError('To get started with GitHub CLI, please run:  gh auth login — not signed in to github.com for /repo.', 'unauthenticated'))
      expect(await client.request('pullRequests.detail', { projectId: project.id, number: 7 }).catch((error: unknown) => error)).toMatchObject({
        code: 'pull_request_unavailable',
        message: expect.stringContaining('gh auth login')
      })

      // A failure the host did not classify still arrives with its words, not as "something went wrong".
      host.mockRejectedValueOnce(new Error('HTTP 502: Bad Gateway'))
      expect(await client.request('pullRequests.detail', { projectId: project.id, number: 7 }).catch((error: unknown) => error)).toMatchObject({
        code: 'pull_request_unavailable',
        message: 'HTTP 502: Bad Gateway'
      })
    })
  })

  it('links a pull request to a thread, and unlinks it, announcing each change', async () => {
    const spy = detailSpy()
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Task A', project.id)

    const linked = await client.request<{ thread: Thread }>('pullRequests.link', { threadId: thread.id, number: 7 })
    expect(linked.thread.pullRequest).toMatchObject({
      number: 7,
      url: 'https://github.com/acme/app/pull/7',
      host: 'github.com',
      nameWithOwner: 'acme/app',
      headRefName: 'feature/retry',
      baseRefName: 'main',
      headRepository: 'acme/app',
      isCrossRepository: false
    })
    expect(spy.mock.calls[0].slice(1)).toEqual([7, { force: true }])
    expect(Date.parse(linked.thread.pullRequest!.linkedAt)).not.toBeNaN()
    expect(mms.threads.getThread(thread.id)?.pullRequest?.number).toBe(7)
    await vi.waitFor(() => expect(events.filter((event) => event.type === 'threads.updated').length).toBeGreaterThan(0))

    const before = events.filter((event) => event.type === 'threads.updated').length
    const unlinked = await client.request<{ thread: Thread }>('pullRequests.unlink', { threadId: thread.id })
    expect(unlinked.thread.pullRequest).toBeUndefined()
    expect(mms.threads.getThread(thread.id)?.pullRequest).toBeUndefined()
    await vi.waitFor(() => expect(events.filter((event) => event.type === 'threads.updated').length).toBeGreaterThan(before))
  })

  it('links a pull request from a fork, with its head and base repositories, whichever branch the thread is on', async () => {
    detailSpy(detailOf({ number: 12, headRepository: 'forker/app', isCrossRepository: true, headRefName: 'fix-typo' }))
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Task A', project.id)
    const linked = await client.request<{ thread: Thread }>('pullRequests.link', { threadId: thread.id, number: 12 })
    expect(linked.thread.pullRequest).toMatchObject({ number: 12, headRepository: 'forker/app', isCrossRepository: true, headRefName: 'fix-typo', nameWithOwner: 'acme/app' })
  })

  it('links nothing when the pull request cannot be found or read, and says why in the host\'s words', async () => {
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Task A', project.id)
    const host = vi.spyOn(mms.gitService.codeHost, 'getPullRequestDetail')
    host.mockRejectedValueOnce(new PullRequestReadError('GraphQL: Could not resolve to a PullRequest with the number of 99.', 'not-found'))
    await expect(client.request('pullRequests.link', { threadId: thread.id, number: 99 })).rejects.toThrow(/number of 99/)
    host.mockRejectedValueOnce(new PullRequestReadError('You are not logged in to github.com', 'unauthenticated'))
    await expect(client.request('pullRequests.link', { threadId: thread.id, number: 12 })).rejects.toThrow(/not logged in to github\.com/)
    await expect(client.request('pullRequests.link', { threadId: 'missing', number: 12 })).rejects.toThrow(/not found/i)
    expect(mms.threads.getThread(thread.id)?.pullRequest).toBeUndefined()
  })

  it('does not overwrite an unlink that landed while the link was being read', async () => {
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Task A', project.id)
    detailSpy()
    await client.request('pullRequests.link', { threadId: thread.id, number: 7 })

    vi.restoreAllMocks()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const spy = vi.spyOn(mms.gitService.codeHost, 'getPullRequestDetail').mockImplementation(async () => {
      await gate
      return detailOf()
    })
    const relink = client.request('pullRequests.link', { threadId: thread.id, number: 7 })
    const rejected = expect(relink).rejects.toThrow(/changed while/)
    await vi.waitFor(() => expect(spy).toHaveBeenCalled())
    await client.request('pullRequests.unlink', { threadId: thread.id })
    release()
    await rejected
    expect(mms.threads.getThread(thread.id)?.pullRequest).toBeUndefined()
  })

  it('reads the pull request in the thread\'s worktree when linking', async () => {
    const spy = detailSpy()
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Task A', project.id)
    const workspace = await new WorkspaceResolver(mms.threads.getThreadDir(thread.id), thread.id, f.repo).resolve('agent')
    await client.request('pullRequests.link', { threadId: thread.id, number: 7 })
    expect(normalized(spy.mock.calls[0][0])).toBe(normalized(workspace.workspacePath))
    expect(spy.mock.calls[0][2]).toEqual({ force: true })
  })

  describe('starting a thread from a pull request, and pushing to its branch', () => {
    const identity = { host: 'github.com', nameWithOwner: 'acme/app' }
    const link = (patch: Partial<NonNullable<Thread['pullRequest']>> = {}): NonNullable<Thread['pullRequest']> => ({
      number: 7,
      url: 'https://github.com/acme/app/pull/7',
      host: 'github.com',
      nameWithOwner: 'acme/app',
      headRefName: 'fix-thing',
      baseRefName: 'main',
      headRepository: 'acme/app',
      isCrossRepository: false,
      linkedAt: '2026-10-20T10:00:00Z',
      startedFromPullRequest: true,
      ...patch
    })

    beforeEach(() => {
      vi.spyOn(mms.gitService.codeHost, 'repositoryIdentity').mockResolvedValue(identity)
      vi.spyOn(mms.gitService.codeHost, 'listBaseBranches').mockResolvedValue({ defaultBranch: 'main', branches: ['main'] })
    })

    it('lists the methods and rejects unknown keys and bad parameters', async () => {
      for (const method of ['pullRequests.list', 'pullRequests.resolve', 'pullRequests.startThread', 'pullRequests.pushTarget']) expect(PROTOCOL_METHODS).toContain(method)
      const list = vi.spyOn(mms.gitService.codeHost, 'listPullRequests').mockResolvedValue([])
      const project = mms.projects.openProject(f.repo)
      const thread = mms.threads.createThread('Task A', project.id)
      await expect(client.request('pullRequests.list', { projectId: project.id, cwd: '/tmp' })).rejects.toThrow(/cwd is not allowed/)
      await expect(client.request('pullRequests.list', { threadId: thread.id })).rejects.toThrow(/threadId is not allowed/)
      await expect(client.request('pullRequests.list', {})).rejects.toThrow(/projectId or threadId is required/)
      await expect(client.request('pullRequests.list', { projectId: project.id, limit: 0 })).rejects.toThrow(/limit/)
      await expect(client.request('pullRequests.resolve', { projectId: project.id })).rejects.toThrow(/reference/)
      await expect(client.request('pullRequests.resolve', { projectId: project.id, reference: '7', extra: 1 })).rejects.toThrow(/extra is not allowed/)
      await expect(client.request('pullRequests.startThread', { projectId: project.id })).rejects.toThrow(/either number or reference/)
      await expect(client.request('pullRequests.startThread', { projectId: project.id, number: 7, reference: '7' })).rejects.toThrow(/either number or reference/)
      await expect(client.request('pullRequests.startThread', { projectId: project.id, number: 0 })).rejects.toThrow(/number/)
      await expect(client.request('pullRequests.startThread', { projectId: project.id, number: 7, message: 'hi' })).rejects.toThrow(/only sent with send/)
      await expect(client.request('pullRequests.startThread', { projectId: project.id, number: 7, cwd: '/tmp' })).rejects.toThrow(/cwd is not allowed/)
      await expect(client.request('pullRequests.startThread', { projectId: 'missing', number: 7 })).rejects.toMatchObject({ code: 'project_not_found' })
      await expect(client.request('pullRequests.pushTarget', { threadId: thread.id, projectId: project.id })).rejects.toThrow(/projectId is not allowed/)
      expect(list).not.toHaveBeenCalled()
    })

    it('lists the open pull requests in the project folder and names why a list failed', async () => {
      const rows = [{ number: 9, title: 'New', url: 'https://github.com/acme/app/pull/9', isDraft: false, author: 'bob', headRefName: 'new', isCrossRepository: false, updatedAt: '2026-10-20T10:00:00Z' }]
      const list = vi.spyOn(mms.gitService.codeHost, 'listPullRequests').mockResolvedValue(rows)
      const project = mms.projects.openProject(f.repo)
      expect(await client.request('pullRequests.list', { projectId: project.id, limit: 20, force: true })).toEqual({ pullRequests: rows })
      expect(normalized(list.mock.calls[0][0])).toBe(normalized(f.repo))
      expect(list.mock.calls[0][1]).toEqual({ limit: 20, force: true })
      list.mockRejectedValueOnce(new PullRequestReadError('API rate limit exceeded', 'rate-limited'))
      await expect(client.request('pullRequests.list', { projectId: project.id })).rejects.toMatchObject({ code: 'pull_request_rate_limited', message: 'API rate limit exceeded' })
    })

    it('resolves a pasted reference: refuses another repository, reads the pull request, and names threads on it', async () => {
      const detail = detailSpy()
      const project = mms.projects.openProject(f.repo)
      const resolved = await client.request<{ pullRequest: { number: number; title: string }; threads: unknown[] }>('pullRequests.resolve', { projectId: project.id, reference: 'https://github.com/acme/app/pull/7/files' })
      expect(resolved.pullRequest).toMatchObject({ number: 7, state: 'open' })
      expect(resolved.threads).toEqual([])
      expect(detail.mock.calls[0][1]).toBe(7)
      await expect(client.request('pullRequests.resolve', { projectId: project.id, reference: 'https://github.com/other/app/pull/7' })).rejects.toMatchObject({ code: 'pull_request_wrong_repository' })
      await expect(client.request('pullRequests.resolve', { projectId: project.id, reference: 'banana' })).rejects.toMatchObject({ code: 'invalid_params' })
      detail.mockRejectedValueOnce(new PullRequestReadError('Could not resolve to a PullRequest with the number of 99.', 'not-found'))
      await expect(client.request('pullRequests.resolve', { projectId: project.id, reference: '99' })).rejects.toMatchObject({ code: 'pull_request_not_found' })
      expect(detail).toHaveBeenCalledTimes(2)
      mms.threads.updateThreadMeta(mms.threads.createThread('Works on it', project.id).id, { pullRequest: link() })
      expect((await client.request<{ threads: Array<{ name: string }> }>('pullRequests.resolve', { projectId: project.id, reference: '7' })).threads.map((entry) => entry.name)).toEqual(['Works on it'])
    })

    it('starts a thread at the fetched head, tells every client, and refuses a pull request that already has one', async () => {
      const head = git(f.repo, 'rev-parse', 'HEAD')
      detailSpy(detailOf({ headSha: head, headRefName: 'fix-thing' }))
      const fetch = vi.spyOn(mms.gitService.codeHost, 'fetchPullRequestHead').mockResolvedValue(head)
      const project = mms.projects.openProject(f.repo)
      events.length = 0

      // A request that did not agree to the repository setting (as an older client sends it) changes nothing.
      await expect(client.request('pullRequests.startThread', { projectId: project.id, number: 7 })).rejects.toMatchObject({ code: 'pull_request_worktree_config_needed', message: WORKTREE_CONFIG_NEEDED })
      expect(fetch).not.toHaveBeenCalled()
      expect(() => git(f.repo, 'config', '--local', '--get', 'extensions.worktreeConfig')).toThrow()
      expect((await client.request<{ enablesWorktreeConfig: boolean }>('pullRequests.resolve', { projectId: project.id, reference: '7' })).enablesWorktreeConfig).toBe(true)

      const started = await client.request<{ thread: Thread; threads: Thread[]; seed: string; headSha: string; headMoved: boolean; sent: boolean; repositoryConfigChange: string | null }>('pullRequests.startThread', { projectId: project.id, number: 7, allowWorktreeConfig: true })
      expect(started).toMatchObject({ headSha: head, headMoved: false, sent: false, repositoryConfigChange: WORKTREE_CONFIG_ENABLED })
      expect(git(f.repo, 'config', '--local', '--get', 'extensions.worktreeConfig')).toBe('true')
      // The thread says so too, for every client, with a line that wakes nothing.
      expect(mms.orchestrator.getMessages(started.thread.id).filter((message) => message.role === 'system').map((message) => [message.kind, message.content])).toEqual([['warning', WORKTREE_CONFIG_ENABLED]])
      expect(mms.runEngine.inbox.listForThread(started.thread.id)).toEqual([])
      expect(started.thread.pullRequest).toMatchObject({ number: 7, nameWithOwner: 'acme/app', headRefName: 'fix-thing' })
      expect(started.threads.some((thread) => thread.id === started.thread.id)).toBe(true)
      expect(normalized(fetch.mock.calls[0][0])).toBe(normalized(f.repo))
      expect(fetch.mock.calls[0][1]).toEqual({ host: 'github.com', nameWithOwner: 'acme/app', number: 7 })
      expect(events.some((event) => event.type === 'threads.updated')).toBe(true)
      const workspace = new ThreadWorkspaceManager(mms.threads.getThreadDir(started.thread.id)).load()!
      expect(git(workspace.worktreePath, 'rev-parse', 'HEAD')).toBe(head)

      await expect(client.request('pullRequests.startThread', { projectId: project.id, reference: '#7' })).rejects.toMatchObject({ code: 'pull_request_thread_exists', details: { threadId: started.thread.id } })
      await expect(client.request('pullRequests.startThread', { projectId: project.id, reference: '7', allowDuplicate: true })).resolves.toMatchObject({ sent: false })
    })

    it('sends the seed and message as the first message only when asked', async () => {
      const head = git(f.repo, 'rev-parse', 'HEAD')
      detailSpy(detailOf({ headSha: head, author: 'maint', authorAssociation: 'MEMBER', reviews: [], comments: [] }))
      vi.spyOn(mms.gitService.codeHost, 'fetchPullRequestHead').mockResolvedValue(head)
      const send = vi.spyOn(mms.orchestrator, 'send').mockResolvedValue({} as never)
      const project = mms.projects.openProject(f.repo)
      const started = await client.request<{ thread: Thread; seed: string; sent: boolean }>('pullRequests.startThread', { projectId: project.id, number: 7, send: true, message: 'Fix the review comments.', allowWorktreeConfig: true })
      expect(started.sent).toBe(true)
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0][0]).toBe(`${started.seed}\n\nFix the review comments.`)
      expect(send.mock.calls[0][2]).toMatchObject({ threadId: started.thread.id, awaitMode: 'ack' })
    })

    it('does not send a seed that quotes strangers, and returns it with the reason', async () => {
      const head = git(f.repo, 'rev-parse', 'HEAD')
      detailSpy(detailOf({ headSha: head, author: 'stranger', authorAssociation: 'NONE', reviews: [], comments: [] }))
      vi.spyOn(mms.gitService.codeHost, 'fetchPullRequestHead').mockResolvedValue(head)
      const send = vi.spyOn(mms.orchestrator, 'send').mockResolvedValue({} as never)
      const project = mms.projects.openProject(f.repo)
      const started = await client.request<{ seed: string; sent: boolean; withheld: string }>('pullRequests.startThread', { projectId: project.id, number: 7, send: true, allowWorktreeConfig: true })
      expect(started.sent).toBe(false)
      expect(started.withheld).toMatch(/not owners, members or collaborators \(stranger\)/)
      expect(started.seed).toContain('Quoted from GitHub:')
      expect(send).not.toHaveBeenCalled()
    })

    it('tells every client the thread list changed even when the start failed', async () => {
      detailSpy()
      vi.spyOn(mms.gitService.codeHost, 'fetchPullRequestHead').mockRejectedValue(new Error('offline'))
      const project = mms.projects.openProject(f.repo)
      events.length = 0
      await expect(client.request('pullRequests.startThread', { projectId: project.id, number: 7, allowWorktreeConfig: true })).rejects.toMatchObject({ code: 'pull_request_fetch_failed' })
      await vi.waitFor(() => expect(events.some((event) => event.type === 'threads.updated')).toBe(true))
    })

    it('leaves nothing behind and says why when the pull request cannot be fetched', async () => {
      detailSpy()
      vi.spyOn(mms.gitService.codeHost, 'fetchPullRequestHead').mockRejectedValue(new Error("No remote of this checkout points at github.com/acme/app, the pull request's repository."))
      const project = mms.projects.openProject(f.repo)
      const before = mms.threads.listAllThreads().length
      await expect(client.request('pullRequests.startThread', { projectId: project.id, number: 7, allowWorktreeConfig: true })).rejects.toMatchObject({ code: 'pull_request_fetch_failed', message: /No remote of this checkout points at github\.com\/acme\/app/ })
      expect(mms.threads.listAllThreads()).toHaveLength(before)
    })

    describe('Push', () => {
      /** A thread with its own worktree, linked to a pull request. */
      async function linkedWorktreeThread(patch: Partial<NonNullable<Thread['pullRequest']>> = {}) {
        const project = mms.projects.openProject(f.repo)
        const thread = mms.threads.createThread('Linked', project.id)
        await new WorkspaceResolver(mms.threads.getThreadDir(thread.id), thread.id, f.repo).resolve('agent')
        mms.threads.updateThreadMeta(thread.id, { pullRequest: link(patch) })
        return { project, thread, branch: `mousse/thread/${thread.id}/main` }
      }
      const addRemote = (name: string, url: string) => git(f.repo, 'remote', 'add', name, url)

      it('goes to the pull request\'s branch on the remote that is its repository', async () => {
        addRemote('origin', 'git@github.com:me/app.git')
        addRemote('upstream', 'https://github.com/acme/app.git')
        const { thread, branch } = await linkedWorktreeThread()
        const push = vi.spyOn(mms.gitService, 'push').mockResolvedValue()
        await client.request('git.push', { threadId: thread.id, expectedBranch: branch })
        expect(push.mock.calls[0][1]).toMatchObject({ expectedBranch: branch, toRemote: 'upstream', toBranch: 'fix-thing' })
        expect(await client.request('pullRequests.pushTarget', { threadId: thread.id })).toEqual({ target: { remote: 'upstream', branch: 'fix-thing', reason: null } })
      })

      it('keeps the usual push, and says why, when the head is on a fork or no remote is that repository', async () => {
        addRemote('origin', 'git@github.com:me/app.git')
        const push = vi.spyOn(mms.gitService, 'push').mockResolvedValue()
        const noRemote = await linkedWorktreeThread()
        await client.request('git.push', { threadId: noRemote.thread.id, expectedBranch: noRemote.branch })
        expect(push.mock.calls[0][1]).not.toHaveProperty('toRemote')
        expect(push.mock.calls[0][1]).not.toHaveProperty('toBranch')
        expect(await client.request('pullRequests.pushTarget', { threadId: noRemote.thread.id })).toEqual({
          target: { remote: null, branch: null, reason: 'No remote of this checkout fetches from and pushes to acme/app; push by hand' }
        })

        addRemote('upstream', 'https://github.com/acme/app.git')
        const fork = await linkedWorktreeThread({ headRepository: 'bob/app', isCrossRepository: true })
        await client.request('git.push', { threadId: fork.thread.id, expectedBranch: fork.branch })
        expect(push.mock.calls[1][1]).not.toHaveProperty('toRemote')
        expect(await client.request('pullRequests.pushTarget', { threadId: fork.thread.id })).toEqual({
          target: { remote: null, branch: null, reason: "The pull request's branch is on a fork (bob/app); push by hand" }
        })
        // A head whose repository was deleted is not provably this one either.
        const gone = await linkedWorktreeThread({ headRepository: null, isCrossRepository: true })
        expect((await client.request<{ target: { reason: string } }>('pullRequests.pushTarget', { threadId: gone.thread.id })).target.reason).toMatch(/fork \(deleted\)/)
      })

      it('keeps the usual push for a link made by hand, which says nothing about where the thread\'s branch belongs', async () => {
        addRemote('upstream', 'https://github.com/acme/app.git')
        const push = vi.spyOn(mms.gitService, 'push').mockResolvedValue()
        const byHand = await linkedWorktreeThread({ startedFromPullRequest: undefined })
        await client.request('git.push', { threadId: byHand.thread.id, expectedBranch: byHand.branch })
        expect(push.mock.calls[0][1]).not.toHaveProperty('toRemote')
        expect(await client.request('pullRequests.pushTarget', { threadId: byHand.thread.id })).toEqual({ target: { remote: null, branch: null, reason: null } })
      })

      it('keeps the usual push when the remote fetches from the repository but pushes somewhere else', async () => {
        addRemote('upstream', 'https://github.com/acme/app.git')
        git(f.repo, 'remote', 'set-url', '--push', 'upstream', 'https://github.com/me/app.git')
        const push = vi.spyOn(mms.gitService, 'push').mockResolvedValue()
        const { thread, branch } = await linkedWorktreeThread()
        await client.request('git.push', { threadId: thread.id, expectedBranch: branch })
        expect(push.mock.calls[0][1]).not.toHaveProperty('toRemote')
        expect(await client.request('pullRequests.pushTarget', { threadId: thread.id })).toEqual({
          target: { remote: null, branch: null, reason: 'No remote of this checkout fetches from and pushes to acme/app; push by hand' }
        })
        // A push URL that is the repository again makes it usable.
        git(f.repo, 'remote', 'set-url', '--push', 'upstream', 'git@github.com:acme/app.git')
        expect(await client.request('pullRequests.pushTarget', { threadId: thread.id })).toEqual({ target: { remote: 'upstream', branch: 'fix-thing', reason: null } })
      })

      it('never pushes to the repository\'s default branch, nor when it cannot tell which that is', async () => {
        addRemote('upstream', 'https://github.com/acme/app.git')
        const push = vi.spyOn(mms.gitService, 'push').mockResolvedValue()
        const release = await linkedWorktreeThread({ headRefName: 'main', baseRefName: 'release' })
        await client.request('git.push', { threadId: release.thread.id, expectedBranch: release.branch })
        expect(push.mock.calls[0][1]).not.toHaveProperty('toRemote')
        expect((await client.request<{ target: { reason: string } }>('pullRequests.pushTarget', { threadId: release.thread.id })).target.reason).toMatch(/default branch, which Push never updates/)

        vi.mocked(mms.gitService.codeHost.listBaseBranches).mockResolvedValue({ defaultBranch: null, branches: [] })
        const unknown = await linkedWorktreeThread()
        expect((await client.request<{ target: { reason: string } }>('pullRequests.pushTarget', { threadId: unknown.thread.id })).target.reason).toMatch(/could not be read/)
      })

      it('is the usual push for a thread without a link and for a thread on the project\'s checkout', async () => {
        addRemote('upstream', 'https://github.com/acme/app.git')
        const push = vi.spyOn(mms.gitService, 'push').mockResolvedValue()
        const project = mms.projects.openProject(f.repo)
        const plain = mms.threads.createThread('Plain', project.id)
        await new WorkspaceResolver(mms.threads.getThreadDir(plain.id), plain.id, f.repo).resolve('agent')
        await client.request('git.push', { threadId: plain.id, expectedBranch: `mousse/thread/${plain.id}/main` })
        expect(push.mock.calls[0][1]).not.toHaveProperty('toRemote')
        expect(await client.request('pullRequests.pushTarget', { threadId: plain.id })).toEqual({ target: { remote: null, branch: null, reason: null } })

        // On the project's own checkout nothing is redirected, linked or not.
        const onCheckout = mms.threads.createThread('On checkout', project.id)
        mms.threads.updateThreadMeta(onCheckout.id, { pullRequest: link() })
        expect(await client.request('pullRequests.pushTarget', { threadId: onCheckout.id })).toEqual({ target: { remote: null, branch: null, reason: null } })
        await client.request('git.push', { projectId: project.id })
        expect(push.mock.calls[1][1]).not.toHaveProperty('toRemote')
      })
    })
  })
})
