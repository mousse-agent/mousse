import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { execRunner, type ExecutableRunner } from '../src/mms/git/ghRunner'
import { GitHubCodeHost, parsePullRequestDetail } from '../src/mms/git/GitHubCodeHost'
import { PullRequestThreadError, PullRequestThreadService } from '../src/mms/git/PullRequestThreadService'
import { WORKTREE_CONFIG_ENABLED, WORKTREE_CONFIG_NEEDED, type PullRequestDetail } from '../src/shared/pullRequests'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { git, gitFoundationFixture } from './fixtures/gitFoundation'

const REMOTES = 'origin\thttps://github.com/bob/app.git (fetch)\norigin\thttps://github.com/bob/app.git (push)\nupstream\thttps://github.com/acme/app.git (fetch)\nupstream\thttps://github.com/acme/app.git (push)\n'

describe('starting a thread from a pull request', () => {
  let f: ReturnType<typeof gitFoundationFixture>
  let mms: MousseMainService
  let host: GitHubCodeHost
  let service: PullRequestThreadService
  let send: ReturnType<typeof vi.fn<(threadId: string, content: string) => Promise<void>>>
  let trash: ReturnType<typeof vi.fn<(threadId: string) => Promise<unknown>>>
  let projectId: string
  let baseBare: string
  let author: string
  let prSha: string
  let remoteSpelling: string

  const detailOf = (patch: Partial<PullRequestDetail> = {}): PullRequestDetail => ({
    ...parsePullRequestDetail(
      { host: 'github.com', nameWithOwner: 'acme/app', number: 7 },
      readFileSync(new URL('./fixtures/github/pr-view.json', import.meta.url), 'utf8'),
      []
    )!,
    title: 'Fix the thing',
    state: 'open',
    headRefName: 'pr-head-branch',
    headSha: prSha,
    headRepository: 'bob/app',
    baseRepository: 'acme/app',
    isCrossRepository: true,
    // Everyone in it is a maintainer, unless a test says otherwise.
    author: 'maint',
    authorAssociation: 'MEMBER',
    reviews: [],
    comments: [],
    ...patch
  })

  /** Pushes a new commit to the pull request's head ref of the base repository, from a clone that is not the project. */
  const pushHead = (value: string, options: { force?: boolean } = {}): string => {
    writeFileSync(join(author, 'value.txt'), value)
    git(author, 'add', '--', 'value.txt')
    git(author, 'commit', '-qm', 'pull request change')
    git(author, 'push', '-q', ...(options.force ? ['--force'] : []), 'origin', 'HEAD:refs/pull/7/head')
    return git(author, 'rev-parse', 'HEAD')
  }

  const workspaceOf = (threadId: string) => new ThreadWorkspaceManager(mms.threads.getThreadDir(threadId)).load()!
  const start = (patch: Partial<Parameters<PullRequestThreadService['startThread']>[0]> = {}) =>
    service.startThread({ projectId, reference: '7', allowWorktreeConfig: true, ...patch })

  beforeEach(async () => {
    f = gitFoundationFixture()
    baseBare = join(f.root, 'base.git')
    const forkBare = join(f.root, 'fork.git')
    git(f.root, 'init', '-q', '--bare', baseBare)
    git(f.root, 'init', '-q', '--bare', forkBare)
    // `origin` is the contributor's fork, `upstream` the pull request's base repository.
    git(f.repo, 'remote', 'add', 'origin', forkBare)
    git(f.repo, 'remote', 'add', 'upstream', baseBare)
    git(f.repo, 'push', '-q', 'upstream', 'HEAD:refs/heads/main')
    git(f.repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
    author = join(f.root, 'author')
    git(f.root, 'clone', '-q', '--branch', 'main', baseBare, author)
    git(author, 'config', 'user.name', 'Contributor')
    git(author, 'config', 'user.email', 'contributor@example.test')
    git(author, 'config', 'core.autocrlf', 'false')
    prSha = pushHead('pull request value\n')

    // The folder's remotes point at local bare repositories; the host reads them as GitHub URLs, as it would for a clone.
    remoteSpelling = REMOTES
    const runner: ExecutableRunner = async (executable, args, options) =>
      executable === 'git' && args[0] === 'remote' && args[1] === '-v' ? { stdout: remoteSpelling, stderr: '' } : execRunner(executable, args, options)
    host = new GitHubCodeHost(runner)
    vi.spyOn(host, 'repositoryIdentity').mockResolvedValue({ host: 'github.com', nameWithOwner: 'acme/app' })
    vi.spyOn(host, 'getPullRequestDetail').mockImplementation(async () => detailOf())

    mms = await MousseMainService.create({ homeDir: f.home, headless: true, ownerKind: 'test' })
    await mms.start()
    projectId = mms.projects.openProject(f.repo).id
    send = vi.fn(async () => {})
    trash = vi.fn(async () => ({}))
    service = new PullRequestThreadService({
      codeHost: host,
      projects: mms.projects,
      threads: mms.threads,
      trashThread: trash,
      send
    })
  }, 30_000)

  afterEach(async () => {
    vi.restoreAllMocks()
    await mms?.stop()
    f?.dispose()
  })

  it('fetches from the remote that is the base repository and starts the worktree at the fork pull request\'s head', async () => {
    // The fork's own remote must never be asked: its URL leads nowhere.
    git(f.repo, 'remote', 'set-url', 'origin', join(f.root, 'does-not-exist.git'))
    const remotesBefore = git(f.repo, 'remote')
    const primaryBranch = git(f.repo, 'rev-parse', '--abbrev-ref', 'HEAD')
    const primaryHead = git(f.repo, 'rev-parse', 'HEAD')

    const result = await start()

    expect(result.headSha).toBe(prSha)
    expect(result.headMoved).toBe(false)
    expect(result.sent).toBe(false)
    expect(send).not.toHaveBeenCalled()
    const workspace = workspaceOf(result.thread.id)
    expect(workspace).toMatchObject({ lifecycle: 'ready', untrusted: true })
    // FETCH_HEAD of the primary checkout is not written by the fetch.
    expect(existsSync(join(f.repo, '.git', 'FETCH_HEAD'))).toBe(false)
    expect(git(workspace.worktreePath, 'rev-parse', 'HEAD')).toBe(prSha)
    expect(f.read(workspace.worktreePath)).toBe('pull request value\n')
    // The thread's branch is its own; no remote or branch was added for the fork, and the primary checkout stays put.
    expect(workspace.branch).toBe(`mousse/thread/${result.thread.id}/main`)
    expect(git(f.repo, 'remote')).toBe(remotesBefore)
    expect(git(f.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(primaryBranch)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(primaryHead)
    // The fetched ref was only the way in: the thread's own branch and retained ref hold the commit.
    expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/mousse/pull')).toBe('')
    expect(git(f.repo, 'rev-parse', workspace.retainedRef)).toBe(prSha)
    expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads')).not.toContain('pr-head-branch')
    // The integration target is still the primary checkout.
    expect(workspace.integrationTarget.baseSha).toBe(primaryHead)

    expect(result.thread).toMatchObject({ name: 'PR #7: Fix the thing', worktreeEnabled: true, projectId })
    expect(result.thread.pullRequest).toMatchObject({
      number: 7,
      host: 'github.com',
      nameWithOwner: 'acme/app',
      headRefName: 'pr-head-branch',
      headRepository: 'bob/app',
      isCrossRepository: true,
      startedFromPullRequest: true
    })
    expect(mms.threads.listAllThreads().find((thread) => thread.id === result.thread.id)?.pullRequest?.number).toBe(7)
    expect(result.seed).toContain('This thread starts from pull request #7 in acme/app.')
    expect(result.seed).toContain('> Fix the thing')
  })

  it('does not mind uncommitted work in the primary checkout, and leaves it as it was', async () => {
    writeFileSync(join(f.repo, 'value.txt'), 'my unsaved edit\n')
    writeFileSync(join(f.repo, 'notes.txt'), 'untracked\n')
    const result = await start()
    expect(f.read(f.repo)).toBe('my unsaved edit\n')
    expect(f.read(f.repo, 'notes.txt')).toBe('untracked\n')
    expect(f.read(workspaceOf(result.thread.id).worktreePath)).toBe('pull request value\n')
  })

  it('sends the seed with the message as the first message when asked, once', async () => {
    const result = await start({ send: true, message: 'Please address the review.' })
    expect(result.sent).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(result.thread.id, `${result.seed}\n\nPlease address the review.`)
    const alone = await start({ send: true, allowDuplicate: true })
    expect(send).toHaveBeenLastCalledWith(alone.thread.id, alone.seed)
  })

  it('does not send text from people who are not owners, members or collaborators, and says so; the seed is still returned', async () => {
    const stranger = { author: 'stranger', authorAssociation: 'NONE' }
    vi.mocked(host.getPullRequestDetail).mockImplementation(async () => detailOf(stranger))
    const result = await start({ send: true, message: 'Please address the review.' })
    expect(send).not.toHaveBeenCalled()
    expect(result.sent).toBe(false)
    expect(result.withheld).toMatch(/^Not sent: the message quotes people who are not owners, members or collaborators \(stranger\)/)
    expect(result.seed).toContain('> Fix the thing')
    expect(workspaceOf(result.thread.id).lifecycle).toBe('ready')

    // A review or comment from a stranger counts as much as the author.
    vi.mocked(host.getPullRequestDetail).mockImplementation(async () => detailOf({
      reviews: [{ id: 'r', author: 'drive-by', authorAssociation: 'CONTRIBUTOR', state: 'changes_requested', body: 'Do this', bodyTruncated: false, submittedAt: '2026-10-20T10:00:00Z', edited: false, url: 'https://github.com/acme/app/pull/7#r' }]
    }))
    const again = await start({ send: true, allowDuplicate: true })
    expect(again.sent).toBe(false)
    expect(again.withheld).toContain('drive-by')
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps the thread, and says why, when its first message cannot be sent', async () => {
    send.mockRejectedValueOnce(new Error('the daemon is busy'))
    const result = await start({ send: true })
    expect(result.sent).toBe(false)
    expect(result.withheld).toBe('The first message could not be sent: the daemon is busy')
    expect(workspaceOf(result.thread.id).lifecycle).toBe('ready')
    expect(mms.threads.listAllThreads().some((thread) => thread.id === result.thread.id && thread.pullRequest?.number === 7)).toBe(true)
  })

  it('lets only one of two simultaneous starts of the same pull request through', async () => {
    // Both reach the fetch before either has linked a thread; the second must still see the first's link.
    const realFetch = host.fetchPullRequestHead.bind(host)
    let reached = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(host, 'fetchPullRequestHead').mockImplementation(async (...args) => {
      reached++
      await gate
      return realFetch(...args)
    })
    const first = start().catch((error: unknown) => error)
    const second = start().catch((error: unknown) => error)
    // The second waits for the first, so only one fetch is in flight.
    await vi.waitFor(() => expect(reached).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(reached).toBe(1)
    release()
    const results = await Promise.all([first, second])

    const started = results.filter((result) => !(result instanceof Error))
    const refused = results.filter((result) => result instanceof PullRequestThreadError)
    expect(started).toHaveLength(1)
    expect(refused).toHaveLength(1)
    expect(refused[0]).toMatchObject({ code: 'pull_request_thread_exists' })
    expect(mms.threads.listAllThreads().filter((thread) => thread.pullRequest)).toHaveLength(1)
    expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/mousse/pull')).toBe('')
  })

  it('lets simultaneous starts that are meant to be duplicates fetch one after the other into the same ref', async () => {
    const realFetch = host.fetchPullRequestHead.bind(host)
    let inFlight = 0
    let overlapped = false
    vi.spyOn(host, 'fetchPullRequestHead').mockImplementation(async (...args) => {
      inFlight++
      overlapped ||= inFlight > 1
      await new Promise((resolve) => setTimeout(resolve, 50))
      try {
        return await realFetch(...args)
      } finally {
        inFlight--
      }
    })
    const results = await Promise.all([start({ allowDuplicate: true }), start({ allowDuplicate: true })])
    expect(overlapped).toBe(false)
    expect(new Set(results.map((result) => result.thread.id)).size).toBe(2)
    expect(results.every((result) => result.headSha === prSha)).toBe(true)
  })

  it('reports a head that moved after the host answered and starts at the commit it fetched', async () => {
    vi.mocked(host.getPullRequestDetail).mockImplementation(async () => detailOf({ headSha: 'b'.repeat(40) }))
    const result = await start()
    expect(result.headMoved).toBe(true)
    expect(result.headSha).toBe(prSha)
    expect(git(workspaceOf(result.thread.id).worktreePath, 'rev-parse', 'HEAD')).toBe(prSha)
  })

  it('refreshes the fetched ref when the pull request was force-pushed, and leaves a local branch of the same name alone', async () => {
    // A local branch that happens to be named like the pull request's head branch.
    git(f.repo, 'branch', 'pr-head-branch', 'HEAD')
    const before = git(f.repo, 'rev-parse', 'pr-head-branch')
    await start()
    git(author, 'reset', '-q', '--hard', 'HEAD~1')
    const rewritten = pushHead('rewritten value\n', { force: true })
    vi.mocked(host.getPullRequestDetail).mockImplementation(async () => detailOf({ headSha: rewritten }))

    const second = await start({ allowDuplicate: true })
    expect(second.headSha).toBe(rewritten)
    expect(second.headMoved).toBe(false)
    expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/mousse/pull')).toBe('')
    expect(f.read(workspaceOf(second.thread.id).worktreePath)).toBe('rewritten value\n')
    expect(git(f.repo, 'rev-parse', 'pr-head-branch')).toBe(before)
  })

  it('fails clearly, without a thread, when no remote of the checkout is the pull request\'s repository', async () => {
    remoteSpelling = 'origin\thttps://github.com/bob/app.git (fetch)\n'
    const threadsBefore = mms.threads.listAllThreads().length
    const failed = await start().catch((error: unknown) => error)
    expect(failed).toBeInstanceOf(PullRequestThreadError)
    expect(failed).toMatchObject({ code: 'pull_request_fetch_failed' })
    expect((failed as Error).message).toContain("No remote of this checkout points at github.com/acme/app, the pull request's repository.")
    expect((failed as Error).message).toContain('SSH host alias')
    expect(mms.threads.listAllThreads()).toHaveLength(threadsBefore)
  })

  it('surfaces a failed fetch with the ref, the remote and what Git said, and creates no thread', async () => {
    git(f.repo, 'remote', 'set-url', 'upstream', join(f.root, 'gone.git'))
    const threadsBefore = mms.threads.listAllThreads().length
    await expect(start()).rejects.toMatchObject({ code: 'pull_request_fetch_failed', message: expect.stringMatching(/Could not fetch refs\/pull\/7\/head from upstream \(github\.com\/acme\/app\):/) })
    expect(mms.threads.listAllThreads()).toHaveLength(threadsBefore)
  })

  it('refuses a merged or closed pull request unless asked', async () => {
    vi.mocked(host.getPullRequestDetail).mockImplementation(async () => detailOf({ state: 'merged' }))
    await expect(start()).rejects.toMatchObject({ code: 'pull_request_closed' })
    expect(mms.threads.listAllThreads()).toHaveLength(0)
    const result = await start({ allowClosed: true })
    expect(workspaceOf(result.thread.id).lifecycle).toBe('ready')
  })

  it('refuses a URL of another repository or host before reading anything', async () => {
    await expect(service.startThread({ projectId, reference: 'https://github.com/other/app/pull/7' })).rejects.toMatchObject({ code: 'pull_request_wrong_repository' })
    await expect(service.startThread({ projectId, reference: 'https://ghe.example.com/acme/app/pull/7' })).rejects.toMatchObject({ code: 'pull_request_wrong_repository' })
    await expect(service.startThread({ projectId, reference: 'not a pull request' })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(service.startThread({ projectId, reference: '0' })).rejects.toMatchObject({ code: 'invalid_params' })
    expect(host.getPullRequestDetail).not.toHaveBeenCalled()
    const result = await service.startThread({ projectId, reference: 'https://github.com/acme/app/pull/7/files', allowWorktreeConfig: true })
    expect(result.thread.pullRequest?.number).toBe(7)
  })

  it('refuses a pull request another thread already works on, unless asked, and ignores archived threads', async () => {
    const first = await start()
    const refused = await start().catch((error: unknown) => error)
    expect(refused).toMatchObject({ code: 'pull_request_thread_exists', details: { threadId: first.thread.id, threadName: 'PR #7: Fix the thing' } })
    expect(mms.threads.listAllThreads().filter((thread) => thread.pullRequest)).toHaveLength(1)
    expect((await service.resolve(projectId, '7')).threads).toEqual([{ id: first.thread.id, name: 'PR #7: Fix the thing' }])

    const second = await start({ allowDuplicate: true })
    expect(second.thread.id).not.toBe(first.thread.id)
    expect(mms.threads.listAllThreads().filter((thread) => thread.pullRequest)).toHaveLength(2)

    mms.threads.setThreadSettled(first.thread.id, true)
    mms.threads.setThreadSettled(second.thread.id, true)
    const third = await start()
    expect(third.thread.id).not.toBe(second.thread.id)
  })

  it('runs no hook while the worktree is made, wherever core.hooksPath points', async () => {
    // A hook that would run on every checkout: some Git versions look a relative hooks path up in the new checkout,
    // which holds the pull request's files. An absolute folder stands in for it, so the test can tell on any Git.
    const marker = join(f.root, 'hook-ran')
    const hooks = join(f.root, 'hooks')
    mkdirSync(hooks)
    writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\n`, { mode: 0o755 })
    git(f.repo, 'config', 'core.hooksPath', hooks)

    // Control: an ordinary worktree runs it.
    git(f.repo, 'worktree', 'add', '-q', join(f.root, 'control-worktree'), 'HEAD')
    expect(existsSync(marker)).toBe(true)
    git(f.repo, 'worktree', 'remove', '--force', join(f.root, 'control-worktree'))
    rmSync(marker)

    const result = await start()
    expect(git(workspaceOf(result.thread.id).worktreePath, 'rev-parse', 'HEAD')).toBe(prSha)
    expect(existsSync(marker)).toBe(false)
    // The setting itself is left as the project had it.
    expect(git(f.repo, 'config', '--get', 'core.hooksPath')).toBe(hooks)
  })

  it('turns on per-worktree Git settings only when the person agreed, once, says so, and never turns them off', async () => {
    const setting = () => { try { return git(f.repo, 'config', '--local', '--get', 'extensions.worktreeConfig') } catch { return null } }
    const note = vi.fn(async () => 'delivered')
    service = new PullRequestThreadService({ codeHost: host, projects: mms.projects, threads: mms.threads, trashThread: trash, send, note })
    expect(setting()).toBeNull()
    expect((await service.resolve(projectId, '7')).enablesWorktreeConfig).toBe(true)

    // Not agreed (an older client sends no flag): refused before anything is fetched or made.
    const threadsBefore = mms.threads.listAllThreads().length
    await expect(start({ allowWorktreeConfig: undefined })).rejects.toMatchObject({ code: 'pull_request_worktree_config_needed', message: WORKTREE_CONFIG_NEEDED })
    expect(setting()).toBeNull()
    expect(mms.threads.listAllThreads()).toHaveLength(threadsBefore)
    expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/mousse')).toBe('')

    const first = await start()
    expect(first.repositoryConfigChange).toBe(WORKTREE_CONFIG_ENABLED)
    expect(setting()).toBe('true')
    expect(note).toHaveBeenCalledWith(first.thread.id, WORKTREE_CONFIG_ENABLED, `msg:worktree-config:${first.thread.id}`)
    expect((await service.resolve(projectId, '7')).enablesWorktreeConfig).toBe(false)
    // Once it is on, a start needs no agreement and changes nothing.
    const second = await start({ allowDuplicate: true, allowWorktreeConfig: undefined })
    expect(second.repositoryConfigChange).toBeNull()
    expect(note).toHaveBeenCalledTimes(1)

    // Turned off by the person later: a restore refuses rather than turning it on again behind their back.
    const workspace = workspaceOf(first.thread.id)
    git(f.repo, 'worktree', 'remove', '--force', workspace.worktreePath)
    git(f.repo, 'config', '--local', '--unset', 'extensions.worktreeConfig')
    await expect(new ThreadWorkspaceManager(mms.threads.getThreadDir(first.thread.id)).restore(f.repo)).rejects.toThrow(/per-worktree Git settings are off/)
    expect(setting()).toBeNull()
    expect(existsSync(workspace.worktreePath)).toBe(false)
  })

  describe('when the worktree cannot be made', () => {
    /** Makes `git worktree add` fail after provisioning began: the thread's branch name is already taken. */
    function blockWorktree(): { threadId: () => string } {
      let id = ''
      const create = mms.threads.createThread.bind(mms.threads)
      vi.spyOn(mms.threads, 'createThread').mockImplementation((...args) => {
        const thread = create(...args)
        id = thread.id
        git(f.repo, 'branch', `mousse/thread/${thread.id}/main`, 'HEAD')
        return thread
      })
      return { threadId: () => id }
    }

    it('removes the thread, its folder and what provisioning left in the repository, and says why', async () => {
      const blocked = blockWorktree()
      const threadsBefore = mms.threads.listAllThreads().length
      const failed = await start().catch((error: unknown) => error)
      expect(failed).toBeInstanceOf(PullRequestThreadError)
      expect(failed).toMatchObject({ code: 'pull_request_workspace_failed' })
      expect((failed as Error).message).toMatch(/^Could not create the worktree for pull request #7: /)

      const id = blocked.threadId()
      expect(mms.threads.listAllThreads()).toHaveLength(threadsBefore)
      expect(mms.threads.listAllThreads().some((thread) => thread.id === id)).toBe(false)
      expect(git(f.repo, 'for-each-ref', '--format=%(refname)', `refs/heads/mousse/thread/${id}`, `refs/mousse/threads/${id}`)).toBe('')
      expect(git(f.repo, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '))).toHaveLength(1)
      expect(trash).not.toHaveBeenCalled()
      // Nothing was sent and nothing is left to retry against; the fetched ref went too, so no fork history stays reachable.
      expect(send).not.toHaveBeenCalled()
      expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/mousse/pull')).toBe('')
      // A retry is not refused as a duplicate.
      vi.mocked(mms.threads.createThread).mockRestore()
      await expect(start()).resolves.toMatchObject({ sent: false })
    })

    it('removes the thread when it cannot be set up after its worktree was made', async () => {
      const failing = new PullRequestThreadService({
        codeHost: host,
        projects: mms.projects,
        threads: mms.threads,
        trashThread: trash,
        send,
        prepareThread: () => { throw new Error('model store unavailable') }
      })
      const threadsBefore = mms.threads.listAllThreads().length
      await expect(failing.startThread({ projectId, reference: '7', allowWorktreeConfig: true })).rejects.toMatchObject({
        code: 'pull_request_workspace_failed',
        message: expect.stringContaining('model store unavailable')
      })
      expect(mms.threads.listAllThreads()).toHaveLength(threadsBefore)
      expect(git(f.repo, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '))).toHaveLength(1)
      expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/mousse', 'refs/mousse')).toBe('')
      await expect(start()).resolves.toMatchObject({ sent: false })
    })

    it('removes only its own worktree: the person\'s other stale worktree registrations stay', async () => {
      // A worktree of the person's whose folder is gone: `git worktree prune` would drop its registration.
      const theirs = join(f.root, 'their-worktree')
      git(f.repo, 'worktree', 'add', '-q', '-b', 'their-branch', theirs, 'HEAD')
      rmSync(theirs, { recursive: true, force: true })
      const failing = new PullRequestThreadService({
        codeHost: host,
        projects: mms.projects,
        threads: mms.threads,
        trashThread: trash,
        send,
        prepareThread: () => { throw new Error('model store unavailable') }
      })
      await expect(failing.startThread({ projectId, reference: '7', allowWorktreeConfig: true })).rejects.toMatchObject({ code: 'pull_request_workspace_failed' })
      const registered = git(f.repo, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '))
      expect(registered).toHaveLength(2)
      expect(registered.some((line) => line.endsWith('their-worktree'))).toBe(true)
      expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/mousse', 'refs/mousse')).toBe('')
      expect(trash).not.toHaveBeenCalled()
    })

    it('trashes the thread instead, leaving its worktree and branch, when the worktree cannot be removed', async () => {
      const blocked = blockWorktree()
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      // A worktree whose folder stays (a file in it is held open) must not be half removed.
      const realRemove = mms.threads.discardUnusedThread.bind(mms.threads)
      const discard = vi.spyOn(mms.threads, 'discardUnusedThread').mockImplementation((id) => realRemove(id))
      // Provisioning resolves the repository once; the cleanup that follows cannot.
      const original = ThreadWorkspaceManager.prototype.resolveRepository
      let calls = 0
      vi.spyOn(ThreadWorkspaceManager.prototype, 'resolveRepository').mockImplementation(function (this: ThreadWorkspaceManager, path: string) {
        if (++calls > 1) throw new Error('repository is busy')
        return original.call(this, path)
      })
      await expect(start()).rejects.toMatchObject({ code: 'pull_request_workspace_failed' })
      expect(discard).not.toHaveBeenCalled()
      expect(trash).toHaveBeenCalledWith(blocked.threadId())
    })

    it('does not send the first message', async () => {
      blockWorktree()
      await expect(start({ send: true })).rejects.toMatchObject({ code: 'pull_request_workspace_failed' })
      expect(send).not.toHaveBeenCalled()
    })

    it('trashes the thread when it cannot be discarded', async () => {
      const blocked = blockWorktree()
      vi.spyOn(mms.threads, 'discardUnusedThread').mockImplementation(() => {
        throw new Error('only an unused new thread can be discarded')
      })
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      await expect(start()).rejects.toMatchObject({ code: 'pull_request_workspace_failed' })
      expect(trash).toHaveBeenCalledWith(blocked.threadId())
    })
  })
})
