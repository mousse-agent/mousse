import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { PROTOCOL_METHODS } from '../src/mms/protocol/types'
import { parsePullRequestDetail } from '../src/mms/git/GitHubCodeHost'
import { relinked, type PullRequestDetail, type PullRequestWatchStatus, type ThreadPullRequestLink } from '../src/shared/pullRequests'
import type { Thread } from '../src/shared/types'
import { gitFoundationFixture } from './fixtures/gitFoundation'

const detailOf = (patch: Partial<PullRequestDetail> = {}): PullRequestDetail => ({
  ...parsePullRequestDetail(
    { host: 'github.com', nameWithOwner: 'acme/app', number: 7 },
    readFileSync(new URL('./fixtures/github/pr-view.json', import.meta.url), 'utf8'),
    []
  )!,
  ...patch
})

const linkOf = (patch: Partial<ThreadPullRequestLink> = {}): ThreadPullRequestLink => ({
  number: 7,
  url: 'https://github.com/acme/app/pull/7',
  host: 'github.com',
  nameWithOwner: 'acme/app',
  headRefName: 'feature/retry',
  baseRefName: 'main',
  headRepository: 'acme/app',
  isCrossRepository: false,
  linkedAt: '2026-10-26T00:00:00Z',
  ...patch
})

describe('a re-link keeps the watch of the same pull request only', () => {
  it('keeps it for the same pull request, drops it for another, and never invents one', () => {
    expect(relinked(linkOf({ watch: 'notify' }), linkOf({ linkedAt: '2026-10-27T00:00:00Z' }))).toMatchObject({ number: 7, watch: 'notify', linkedAt: '2026-10-27T00:00:00Z' })
    expect(relinked(linkOf({ watch: 'notify' }), linkOf({ number: 8 })).watch).toBeUndefined()
    expect(relinked(linkOf({ watch: 'notify' }), linkOf({ nameWithOwner: 'other/app' })).watch).toBeUndefined()
    expect(relinked(linkOf({ watch: 'notify' }), linkOf({ host: 'GITHUB.COM', nameWithOwner: 'Acme/App' })).watch).toBe('notify')
    expect(relinked(undefined, linkOf()).watch).toBeUndefined()
    expect(relinked(linkOf({ watch: 'notify' }), linkOf({ watch: 'off' })).watch).toBe('off')
  })
})

describe('the watch through the daemon protocol', () => {
  let f: ReturnType<typeof gitFoundationFixture>
  let mms: MousseMainService
  let server: MmsProtocolServer
  let client: LocalMmsClient
  let events: Array<{ type: string; data?: unknown; threadId?: string }>

  beforeEach(async () => {
    f = gitFoundationFixture()
    mms = await MousseMainService.create({ homeDir: f.home, headless: true, ownerKind: 'test' })
    await mms.start()
    const ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    const endpoint = await server.start()
    client = new LocalMmsClient({ homeDir: f.home, endpoint, ownerToken, clientType: 'gui' })
    events = []
    client.onEvent((event) => events.push(event as never))
    await client.connect()
    await client.subscribe()
    // The host answers from memory; the service's own timer has nothing watched to read.
    const host = mms.gitService.codeHost
    vi.spyOn(host, 'getPullRequestDetail').mockResolvedValue(detailOf())
    vi.spyOn(host, 'viewerLogin').mockResolvedValue('me')
    vi.spyOn(host, 'listLineCommentsSince').mockResolvedValue({ comments: [], drained: true, nextPage: 1, newestUpdatedAt: null })
    vi.spyOn(host, 'listLineCommentsCreatedSince').mockResolvedValue({ comments: [], drained: true, nextPage: 1, newestUpdatedAt: null })
  }, 30_000)

  afterEach(async () => {
    vi.restoreAllMocks()
    await client?.close()
    await server?.stop()
    await mms?.stop()
    f?.dispose()
  })

  const newThread = (name = 'Task A') => {
    const project = mms.projects.openProject(f.repo)
    return mms.threads.createThread(name, project.id)
  }

  it('lists the methods and the event', () => {
    expect(PROTOCOL_METHODS).toContain('pullRequests.watch')
    expect(PROTOCOL_METHODS).toContain('pullRequests.watchStatus')
  })

  it('refuses bad parameters, an unlinked thread and an unknown thread', async () => {
    const thread = newThread()
    await expect(client.request('pullRequests.watch', { threadId: thread.id, watch: 'always' })).rejects.toThrow(/off or notify/)
    await expect(client.request('pullRequests.watch', { threadId: thread.id, watch: 'notify', cwd: '/x' })).rejects.toThrow(/cwd is not allowed/)
    await expect(client.request('pullRequests.watch', { threadId: thread.id })).rejects.toThrow(/watch/)
    await expect(client.request('pullRequests.watch', { threadId: 'missing', watch: 'notify' })).rejects.toThrow(/not found/i)
    await expect(client.request('pullRequests.watch', { threadId: thread.id, watch: 'notify' })).rejects.toMatchObject({ message: expect.stringMatching(/no pull request to watch/) })
    await expect(client.request('pullRequests.watchStatus', { threadId: thread.id, extra: 1 })).rejects.toThrow(/extra is not allowed/)
  })

  it('links the named pull request first, then watches it, and announces the change', async () => {
    const thread = newThread()
    const before = events.filter((event) => event.type === 'threads.updated').length
    const answer = await client.request<{ status: PullRequestWatchStatus; thread: Thread }>('pullRequests.watch', { threadId: thread.id, watch: 'notify', number: 7 })
    expect(answer.status).toMatchObject({ mode: 'notify', state: 'watching', host: 'github.com' })
    expect(answer.thread.pullRequest).toMatchObject({ number: 7, watch: 'notify' })
    expect(mms.threads.getThread(thread.id)?.pullRequest?.watch).toBe('notify')
    await vi.waitFor(() => expect(events.filter((event) => event.type === 'threads.updated').length).toBeGreaterThan(before))
    const status = await client.request<{ status: PullRequestWatchStatus }>('pullRequests.watchStatus', { threadId: thread.id })
    expect(status.status).toMatchObject({ mode: 'notify', state: 'watching', viewer: 'me', host: 'github.com' })
    const off = await client.request<{ status: PullRequestWatchStatus }>('pullRequests.watch', { threadId: thread.id, watch: 'off' })
    expect(off.status).toMatchObject({ mode: 'off', state: 'off' })
    expect(mms.threads.getThread(thread.id)?.pullRequest?.watch).toBe('off')
  })

  it('only notifies: a watch that would wake the agent is refused, and the status has no such mode', async () => {
    const thread = newThread()
    mms.threads.updateThreadMeta(thread.id, { pullRequest: linkOf() })
    await expect(client.request('pullRequests.watch', { threadId: thread.id, watch: 'act' })).rejects.toThrow(/off or notify/)
    const ok = await client.request<{ status: PullRequestWatchStatus }>('pullRequests.watch', { threadId: thread.id, watch: 'notify' })
    expect(ok.status.mode).toBe('notify')
    expect(ok.status).not.toHaveProperty('actRefusal')
  })

  it('keeps the watch when the same pull request is linked again, and drops it for another one', async () => {
    const thread = newThread()
    await client.request('pullRequests.watch', { threadId: thread.id, watch: 'notify', number: 7 })
    await client.request('pullRequests.link', { threadId: thread.id, number: 7 })
    expect(mms.threads.getThread(thread.id)?.pullRequest).toMatchObject({ number: 7, watch: 'notify' })
    vi.spyOn(mms.gitService.codeHost, 'getPullRequestDetail').mockResolvedValue(detailOf({ number: 8, identity: { host: 'github.com', nameWithOwner: 'acme/app', number: 8 } }))
    await client.request('pullRequests.link', { threadId: thread.id, number: 8 })
    expect(mms.threads.getThread(thread.id)?.pullRequest).toMatchObject({ number: 8 })
    expect(mms.threads.getThread(thread.id)?.pullRequest?.watch).toBeUndefined()
    // The watch of the old pull request does not carry over: the service sees another pull request and a link that is not watched.
    expect(mms.pullRequestWatch.status(thread.id)).toMatchObject({ state: 'off' })
  })

  it('ends the watch with a line when the thread is unlinked', async () => {
    const thread = newThread()
    await client.request('pullRequests.watch', { threadId: thread.id, watch: 'notify', number: 7 })
    await client.request('pullRequests.unlink', { threadId: thread.id })
    expect(mms.pullRequestWatch.status(thread.id).state).toBe('off')
    const lines = mms.orchestrator.getMessagesForPersistence(thread.id).filter((message) => message.role === 'system')
    expect(lines.map((message) => message.content)).toEqual([expect.stringContaining('removed, so the watch ended')])
  })

  it('ends the watch as soon as the thread is stopped, through the one Stop path', async () => {
    const thread = newThread()
    await client.request('pullRequests.watch', { threadId: thread.id, watch: 'notify', number: 7 })
    await mms.orchestrator.stopThread(thread.id, 'user')
    expect(mms.pullRequestWatch.status(thread.id)).toMatchObject({ state: 'ended', ended: { reason: 'stopped' } })
    expect(mms.threads.getThread(thread.id)?.pullRequest?.watch).toBe('off')
  })

  it('ends the watch when the thread is archived, saying so, not that it was stopped', async () => {
    const thread = newThread()
    await client.request('pullRequests.watch', { threadId: thread.id, watch: 'notify', number: 7 })
    await client.request('threads.settle', { threadId: thread.id, settled: true })
    expect(mms.pullRequestWatch.status(thread.id)).toMatchObject({ state: 'ended', ended: { reason: 'settled' } })
    const lines = mms.orchestrator.getMessagesForPersistence(thread.id).filter((message) => message.role === 'system').map((message) => message.content)
    expect(lines).toEqual([expect.stringContaining('archived')])
  })

  it('ends the watch of a thread that is moved to the trash, and a restore does not bring it back or report a backlog', async () => {
    const thread = newThread()
    await client.request('pullRequests.watch', { threadId: thread.id, watch: 'notify', number: 7 })
    await mms.trashThread(thread.id)
    // Posted while the thread was in the trash.
    const lineReads = vi.mocked(mms.gitService.codeHost.listLineCommentsSince)
    lineReads.mockClear()
    await mms.pullRequestWatch.tick()
    expect(lineReads).not.toHaveBeenCalled()
    await mms.restoreThread(thread.id)
    expect(mms.threads.getThread(thread.id)?.pullRequest?.watch).toBe('off')
    expect(mms.pullRequestWatch.status(thread.id)).toMatchObject({ state: 'ended', ended: { reason: 'trashed' } })
    await mms.pullRequestWatch.tick()
    expect(lineReads).not.toHaveBeenCalled()
    expect(mms.runEngine.inbox.listForThread(thread.id)).toEqual([])
    expect(mms.orchestrator.getMessagesForPersistence(thread.id).filter((message) => message.role === 'system')).toEqual([])
  }, 30_000)

  it('ends the old watch when the thread is linked to a different pull request, and a later watch of the first starts fresh', async () => {
    const thread = newThread()
    await client.request('pullRequests.watch', { threadId: thread.id, watch: 'notify', number: 7 })
    vi.mocked(mms.gitService.codeHost.getPullRequestDetail).mockImplementation(async (_cwd, number) => detailOf({ number, identity: { host: 'github.com', nameWithOwner: 'acme/app', number } }))
    await client.request('pullRequests.link', { threadId: thread.id, number: 8 })
    const lines = () => mms.orchestrator.getMessagesForPersistence(thread.id).filter((message) => message.role === 'system').map((message) => message.content)
    expect(lines()).toEqual([expect.stringContaining('link to pull request #7 was removed')])
    // The watch of pull request 8 is a different one; nothing of the old one is left running.
    await client.request('pullRequests.watch', { threadId: thread.id, watch: 'notify', number: 7 })
    expect(mms.threads.getThread(thread.id)?.pullRequest).toMatchObject({ number: 7, watch: 'notify' })
    // Pull request 8 was never watched, so nothing more is said; the new watch of 7 has its own record.
    expect(lines()).toHaveLength(1)
    expect(mms.pullRequestWatch.status(thread.id)).toMatchObject({ state: 'watching', mode: 'notify' })
  })

  it('announces a change of a watched pull request to every client', async () => {
    const thread = newThread()
    mms.pullRequestWatch.emit('updated', { threadId: thread.id, number: 7, changes: ['checks_failed'] })
    await vi.waitFor(() => expect(events.find((event) => event.type === 'pullRequests.updated')).toMatchObject({ data: { threadId: thread.id, number: 7, changes: ['checks_failed'] } }))
  })

  describe('a line in the thread is saved before it counts as delivered', () => {
    it('writes it once, keeps it live when saving fails, and acknowledges only after a save', async () => {
      const thread = newThread()
      const text = 'Update on pull request #7'
      const messageId = 'msg:pr-update:t:1:0'
      const lines = () => mms.orchestrator.getMessagesForPersistence(thread.id).filter((message) => message.id === messageId)
      const saved = () => mms.threads.loadThreadData(thread.id).messages.filter((message) => message.id === messageId)
      const save = vi.spyOn(mms.threads, 'mutateThreadData').mockImplementation(() => {
        throw new Error('disk full')
      })
      await expect(mms.orchestrator.noteThreadUpdate(thread.id, text, { messageId })).rejects.toThrow('disk full')
      expect(lines()).toHaveLength(1)
      expect(saved()).toHaveLength(0)
      // The retry adds and announces nothing a second time, and is not acknowledged while the save keeps failing.
      const announced = events.filter((event) => event.type === 'thread.message').length
      for (let attempt = 0; attempt < 3; attempt++) await expect(mms.orchestrator.noteThreadUpdate(thread.id, text, { messageId })).rejects.toThrow('disk full')
      expect(lines()).toHaveLength(1)
      save.mockRestore()
      expect(await mms.orchestrator.noteThreadUpdate(thread.id, text, { messageId })).toBe('already')
      expect(saved()).toHaveLength(1)
      expect(events.filter((event) => event.type === 'thread.message').length).toBe(announced)
      // The match is by id: the same text under another id is another line, and no inbox row was written for either.
      expect(await mms.orchestrator.noteThreadUpdate(thread.id, text, { messageId: 'msg:pr-update:t:1:1' })).toBe('delivered')
      expect(mms.runEngine.inbox.listForThread(thread.id)).toEqual([])
      expect(mms.threads.loadThreadData(thread.id).messages.filter((message) => message.content === text)).toHaveLength(2)
    })
  })
})

describe('wake rows an earlier pull request watch left', () => {
  it('are withdrawn at startup before any run engine worker starts, for a thread with no link too', async () => {
    const f = gitFoundationFixture()
    const mms = await MousseMainService.create({ homeDir: f.home, headless: true, ownerKind: 'test' })
    try {
      const project = mms.projects.openProject(f.repo)
      const thread = mms.threads.createThread('No link any more', project.id)
      const row = mms.runEngine.inbox.append({ inboxId: `inbox:pr-update:${thread.id}:1:0`, threadId: thread.id, kind: 'pr_update', payload: { text: 'Address what needs code changes and push when done.' } })
      const services = mms as unknown as { startRunEngineWorkers(): void }
      const startWorkers = services.startRunEngineWorkers.bind(mms)
      let statusWhenWorkersStarted: string | undefined
      vi.spyOn(services, 'startRunEngineWorkers').mockImplementation(() => {
        statusWhenWorkersStarted = mms.runEngine.inbox.get(row.inboxId)?.status
        startWorkers()
      })
      await mms.start()
      expect(statusWhenWorkersStarted).toBe('acknowledged')
      expect(mms.runEngine.store.listNonTerminalRuns().filter((run) => run.threadId === thread.id)).toEqual([])
    } finally {
      vi.restoreAllMocks()
      await mms.stop()
      f.dispose()
    }
  }, 30_000)
})
