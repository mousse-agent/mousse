import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { PROTOCOL_METHODS } from '../src/mms/protocol/types'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import type { GitPullRequestInfo, GitPullRequestLookup, Thread } from '../src/shared/types'
import { gitFoundationFixture } from './fixtures/gitFoundation'

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
    for (const method of ['pullRequests.get', 'pullRequests.create', 'pullRequests.baseBranches', 'pullRequests.link', 'pullRequests.unlink']) {
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
    await expect(client.request('pullRequests.baseBranches', { projectId: project.id, extra: 1 })).rejects.toThrow(/extra is not allowed/)
    await expect(client.request('pullRequests.link', { threadId: thread.id, number: 1, branch: 'x' })).rejects.toThrow(/branch is not allowed/)
    await expect(client.request('pullRequests.unlink', { threadId: thread.id, number: 1 })).rejects.toThrow(/number is not allowed/)
    await expect(client.request('pullRequests.unlink', { threadId: 'missing' })).rejects.toThrow(/not found/i)
    await expect(client.request('pullRequests.get', { threadId: 'missing' })).rejects.toThrow(/not found/i)
    expect(spy).not.toHaveBeenCalled()
  })

  it('creates through the host in the resolved folder, allows an empty description, and reads base branches', async () => {
    const created = info({ number: 30 })
    const create = vi.spyOn(mms.gitService.codeHost, 'createPullRequest').mockResolvedValue(created)
    const branches = vi.spyOn(mms.gitService.codeHost, 'listBaseBranches').mockResolvedValue({ defaultBranch: 'main', branches: ['main', 'dev'] })
    const project = mms.projects.openProject(f.repo)

    expect(await client.request('pullRequests.create', { projectId: project.id, title: 'Add thing', base: 'main', draft: true, head: 'feature' }))
      .toEqual({ pullRequest: created })
    expect(normalized(create.mock.calls[0][0])).toBe(normalized(f.repo))
    expect(create.mock.calls[0][1]).toEqual({ title: 'Add thing', body: '', base: 'main', draft: true, head: 'feature' })

    expect(await client.request('pullRequests.baseBranches', { projectId: project.id })).toEqual({
      baseBranches: { defaultBranch: 'main', branches: ['main', 'dev'] }
    })
    expect(normalized(branches.mock.calls[0][0])).toBe(normalized(f.repo))
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
