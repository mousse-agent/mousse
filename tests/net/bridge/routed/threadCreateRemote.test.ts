/**
 * Issue #1160: `thread_create` with `computer`, over two real daemons linked by Bridge. The caller's agent calls the tool
 * through the app-tool registry over the caller orchestrator's own host, so the call goes through the tool handler, the
 * local checks, the launch record and the routed calls, marked as the agent's, to the owner. The owner's turns are stood
 * in for (no provider runs), so what is checked is what each computer records and what a turn would be handed.
 *
 * Inputs listed before the cases:
 * - outcome: launched with a first message, without one, first message refused there, a launch cut after the create;
 * - retries: the same clientRequestId again (after a launch, after a cut), the same key with other arguments;
 * - refusals: the computer offline, not sharing its threads, outdated (no agent mark), not allowed here (switch off, not
 *   ticked) or there (agent reach none), no project for the repository, several checkouts (and choosing one).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ROUTED_AGENT_METHODS } from '../../../../src/shared/bridge/routed'
import { qualifyId } from '../../../../src/shared/threadRef'
import { DomainRpcError } from '../../../../src/mms/protocol/domainRegistry'
import type { RemoteComputersPort } from '../../../../src/mms/protocol/remoteComputersPort'
import type { SqliteNodePolicy } from '../../../../src/mms/net/store/nodePolicy'
import { RemoteThreadLaunches } from '../../../../src/mms/orchestrator/RemoteThreadLaunches'
import type { AppToolHost } from '../../../../src/mms/run/mcp/appTools'
import { appToolRegistry, appTurn } from '../../../run/appToolsFixture'
import { cleanups, cleanupAll, linked } from './routerFixture'
import { launchedThreadsOf } from '../../../../src/renderer/components/sideCard/lineageLogic'
import { threadInFilter } from '../../../../src/renderer/lib/threadFilter'
import type { Thread } from '../../../../src/shared/types'

type Loose = Record<string, any>
let t: Awaited<ReturnType<typeof linked>>
let policy: SqliteNodePolicy
let startTurn: ReturnType<typeof vi.fn>
let repo: { path: string; remote: string }
let ownerProject: string
let seq = 0

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim()
const folder = (): string => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'remote-create-')))
  cleanups.push(() => rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return path
}
/** A repository with one commit and a remote, and a clone of it (the same repository on another computer). */
function repository(): { path: string; remote: string } {
  const path = folder()
  git(path, 'init', '-q')
  git(path, 'commit', '-q', '--allow-empty', '-m', `root ${Math.random()}`)
  const remote = `https://example.com/acme/${Math.random().toString(36).slice(2)}.git`
  git(path, 'remote', 'add', 'origin', remote)
  return { path, remote }
}
function clone(source: { path: string; remote: string }): string {
  const path = folder()
  git(path, 'clone', '-q', source.path, '.')
  git(path, 'remote', 'set-url', 'origin', source.remote)
  return path
}

const portOf = (): RemoteComputersPort => (t.caller.orchestrator as unknown as { remoteComputers: RemoteComputersPort }).remoteComputers
const launchesOf = (): RemoteThreadLaunches => (t.caller.orchestrator as unknown as { remoteLaunches: RemoteThreadLaunches }).remoteLaunches
const allow = (on = true, computers: string[] = [t.node]): void => {
  t.caller.settings.set({ agentAccess: { ...t.caller.settings.get().agentAccess, remoteSubagents: on, computers } } as never)
}

beforeAll(async () => {
  t = await linked()
  policy = (t.insideOwner.routes as unknown as { options: { policy: SqliteNodePolicy } }).options.policy
  repo = repository()
  ownerProject = t.owner.projects.openProject(clone(repo)).id
}, 120_000)
afterAll(cleanupAll)
afterEach(() => {
  vi.restoreAllMocks()
  allow()
  policy.set(t.callerNode, { maxPermissionMode: 'accept_edits', agentReach: 'launched' })
})

/** What the owner's turns are handed is recorded; no turn runs. */
function standInForTurns(): void {
  startTurn = vi.fn().mockResolvedValue({ message: '', actions: [] })
  vi.spyOn(t.owner.orchestrator as unknown as Loose, 'startTurn').mockImplementation(((_session: unknown, request: Loose) =>
    startTurn({ input: request.input, permissionMode: request.permissionMode, agent: request.agent })) as never)
  vi.spyOn(t.owner.orchestrator as unknown as Loose, 'runTurnOnSession').mockImplementation(((_session: unknown, input: Loose, _reuse: boolean, _display: boolean, opts: Loose) =>
    startTurn({ input, permissionMode: opts.permissionMode, agent: opts.agent })) as never)
}

/**
 * A thread on the caller in the repository's project (`project`: another folder; null: no project at all), with a live
 * run in `mode`, and its agent's `thread_create`.
 */
async function caller(options: { mode?: 'auto' | 'full' | 'accept_edits'; project?: string | null } = {}) {
  allow()
  const project = options.project === null ? undefined : t.caller.projects.openProject(options.project ?? repo.path)
  const thread = t.caller.threads.createThread(`Launcher ${++seq}`, project?.id, project?.path, { permissionMode: options.mode ?? 'auto' } as never)
  const sent = await t.caller.runEngine.dispatch({ kind: 'send', threadId: thread.id, clientRequestId: `launcher-send-${seq}`, source: 'gui' })
  if (sent.status !== 'accepted') throw new Error('launcher run not accepted')
  t.caller.runEngine.markStarting(sent.runId)
  t.caller.runEngine.markRunning(sent.runId)
  // The run's mode, as its turn's binding would record it (no turn runs here).
  vi.spyOn(t.caller.orchestrator, 'runPermissionMode').mockImplementation((id) => (id === sent.runId ? options.mode ?? 'auto' : 'ask'))
  const host = (t.caller.orchestrator as unknown as { mcpToolHost(): AppToolHost }).mcpToolHost()
  const { registry, turns, request } = appToolRegistry(t.caller.runEngine, host)
  turns.register(appTurn({ threadId: thread.id, runId: sent.runId }))
  const create = async (args: Record<string, unknown>): Promise<{ isError?: boolean; body: Loose }> => {
    const out = await registry.call('thread_create', args, request({ threadId: thread.id, runId: sent.runId }))
    return { ...(out.isError ? { isError: true } : {}), body: JSON.parse(out.text) }
  }
  return { thread, runId: sent.runId, create }
}

const launchedBy = (launcherThreadId: string) =>
  t.owner.threads.listAllThreads().filter((thread) => thread.startedFrom?.agent?.thread === launcherThreadId)
const noteOf = (threadId: string) =>
  t.caller.orchestrator.getMessages(threadId).filter((message) => message.role === 'system' && message.launchedThread)

describe('thread_create on another computer (issue #1160)', () => {
  it('starts a thread there, in its copy of the repository, held to the narrowed mode, with the first message as the agent\'s', async () => {
    standInForTurns()
    const { thread, runId, create } = await caller({ mode: 'auto' })
    // Named as computer_list names it.
    const name = portOf().computers()!.find((entry) => entry.node === t.node)!.name
    const out = await create({ computer: name, title: 'Run the Linux tests', firstMessage: 'Run the tests on Linux.', clientRequestId: 'launch-1' })
    expect(out.isError, JSON.stringify(out.body)).toBeUndefined()
    const [far] = launchedBy(thread.id)
    expect(far).toBeDefined()
    expect(out.body).toMatchObject({ threadId: qualifyId(t.node, far!.id), link: expect.stringContaining(qualifyId(t.node, far!.id)), firstMessage: 'sent', runId: expect.any(String), replayed: false })
    // There: in the project that is the same repository, recorded as started by this agent, and held to the launcher's
    // Auto narrowed to the limit that computer set for this one (Auto-accept edits).
    expect(far).toMatchObject({ name: 'Run the Linux tests', projectId: ownerProject, permissionMode: 'accept_edits', startedFrom: { node: t.callerNode, agent: { thread: thread.id, mode: 'accept_edits' } } })
    expect(far!.createdByThreadId).toBeUndefined()
    // Out of that computer's sidebar: an agent started it, and not as an independent thread.
    expect(far!.hidden).toBe(true)
    // The first message runs there as the agent's: source mcp, the sender stored, in the narrowed mode.
    const run = t.owner.runEngine.getRun(out.body.runId)!
    expect(run).toMatchObject({ threadId: far!.id, source: 'mcp', outcome: { sentByAgent: true } })
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalled())
    const handed = startTurn.mock.calls.at(-1)![0] as Loose
    expect(handed.permissionMode).toBe('accept_edits')
    expect(handed.agent).toMatchObject({ kind: 'agent', from: { node: t.callerNode, thread: thread.id, run: runId } })
    expect(String(handed.input.content)).toContain('Run the tests on Linux.')
    // Here: the launch is recorded for the tools that follow it, and the launcher's note is a chip naming the thread there.
    expect(t.caller.runEngine.remoteLaunches.listForLauncher(thread.id)).toEqual([
      expect.objectContaining({ node: t.node, remoteThreadId: far!.id, state: 'launched', firstMessageState: 'sent', remoteMode: 'accept_edits' })
    ])
    expect(noteOf(thread.id)).toEqual([expect.objectContaining({ launchedThread: expect.objectContaining({ threadId: qualifyId(t.node, far!.id) }) })])
    // Here too it reaches the window's list, marked hidden: the launcher's side panel (Started threads), All and search
    // find it, and My threads in the sidebar leaves it out.
    const lists = t.caller.bridge.lists
    await lists.reconcile()
    await vi.waitFor(() => expect(lists.threads().find((row) => row.id === qualifyId(t.node, far!.id))).toMatchObject({ hidden: true }), { timeout: 20_000 })
    const rows = (await t.dispatch('threads.list', {})).threads as Thread[]
    expect(launchedThreadsOf(rows, thread.id).map((row) => row.id)).toEqual([qualifyId(t.node, far!.id)])
    const row = rows.find((entry) => entry.id === qualifyId(t.node, far!.id))!
    const filter = { query: '', projectId: null, botId: null, computerIds: [], archived: false }
    const context = { groupOf: (id: string) => id, projectName: () => undefined, botName: () => undefined }
    expect(threadInFilter(row, { ...filter, show: 'mine' }, context)).toBe(false)
    expect(threadInFilter(row, { ...filter, show: 'all' }, context)).toBe(true)
    expect(threadInFilter(row, { ...filter, show: 'all', query: 'Linux tests' }, context)).toBe(true)

    // A retry with the same request id returns the same thread and sends nothing again.
    const again = await create({ computer: name, title: 'Run the Linux tests', firstMessage: 'Run the tests on Linux.', clientRequestId: 'launch-1' })
    expect(again.body).toMatchObject({ threadId: out.body.threadId, firstMessage: 'sent', replayed: true })
    expect(launchedBy(thread.id)).toHaveLength(1)
    expect(t.owner.runEngine.listRuns(far!.id, { limit: 10 })).toHaveLength(1)
    expect(noteOf(thread.id)).toHaveLength(1)
    // The same key with other arguments is a different launch: refused, never a second thread.
    const other = await registryConflict(() => create({ computer: name, title: 'Something else', clientRequestId: 'launch-1' }))
    expect(other).toMatch(/already used/)
    expect(launchedBy(thread.id)).toHaveLength(1)
  }, 120_000)

  it('Full access is used there when both computers allow it: no fixed cap', async () => {
    policy.set(t.callerNode, { maxPermissionMode: 'full' })
    const { thread, create } = await caller({ mode: 'full' })
    // Started as independent: it shows in that computer's sidebar.
    const out = await create({ computer: t.node, hidden: false, clientRequestId: 'full-1' })
    expect(out.isError, JSON.stringify(out.body)).toBeUndefined()
    expect(out.body).not.toHaveProperty('firstMessage')
    expect(launchedBy(thread.id)[0]).toMatchObject({ permissionMode: 'full' })
    expect(launchedBy(thread.id)[0]!.hidden).toBeUndefined()
  }, 120_000)

  it('returns the thread when its first message is refused there, and a retry does not make a second one', async () => {
    const { thread, create } = await caller()
    vi.spyOn(t.owner.orchestrator as unknown as Loose, 'sendForRemoteAgent').mockRejectedValue(
      new DomainRpcError('agent_daily_budget', 'Agents on that computer started 200 runs here in the last day.'))
    const out = await create({ computer: t.node, firstMessage: 'Go.', clientRequestId: 'refused-first' })
    expect(out.isError).toBeUndefined()
    const [far] = launchedBy(thread.id)
    expect(out.body).toMatchObject({ threadId: qualifyId(t.node, far!.id), firstMessage: 'failed', firstMessageReason: expect.stringContaining('200 runs') })
    expect(far!.archivedAt).toBeFalsy()
    const again = await create({ computer: t.node, firstMessage: 'Go.', clientRequestId: 'refused-first' })
    expect(again.body).toMatchObject({ threadId: out.body.threadId, firstMessage: 'failed', replayed: true })
    expect(launchedBy(thread.id)).toHaveLength(1)
  }, 120_000)

  it('a launch cut off after the create is finished after a restart, on the same thread, sending its first message once', async () => {
    standInForTurns()
    const { thread, create } = await caller()
    // The link goes as the thread is set up: the create went through, nothing after it did.
    const port = portOf()
    const real = port.call.bind(port)
    vi.spyOn(port, 'call').mockImplementation(async (node, method, params, options) => {
      if (method === 'composer.options') throw new DomainRpcError('computer_offline', 'The other computer is offline.')
      return real(node, method, params, options)
    })
    const out = await create({ computer: t.node, firstMessage: 'Build it.', clientRequestId: 'cut-1' })
    const [far] = launchedBy(thread.id)
    expect(far).toBeDefined()
    // The thread exists there, so it is returned; its first message is not confirmed, never "failed" or "sent".
    expect(out.body).toMatchObject({ threadId: qualifyId(t.node, far!.id), firstMessage: 'uncertain' })
    expect(t.owner.runEngine.listRuns(far!.id, { limit: 5 })).toHaveLength(0)
    const key = t.caller.runEngine.remoteLaunches.listForLauncher(thread.id)[0]!.creationKey
    expect(t.caller.runEngine.remoteLaunches.get(key)).toMatchObject({ state: 'created', firstMessageState: 'pending' })
    vi.mocked(port.call).mockRestore()

    // A restart: the old service is gone, a new one reads the launch from the run database alone.
    launchesOf().close()
    const notes: string[] = []
    const fresh = new RemoteThreadLaunches({
      records: t.caller.runEngine.remoteLaunches,
      port: () => port,
      allowed: () => true,
      launched: (record) => notes.push(record.creationKey)
    })
    fresh.start()
    fresh.pause()
    await fresh.pass()
    expect(t.caller.runEngine.remoteLaunches.get(key)).toMatchObject({ state: 'launched', firstMessageState: 'sent', remoteThreadId: far!.id, remoteMode: 'accept_edits' })
    expect(notes).toEqual([key])
    expect(launchedBy(thread.id)).toHaveLength(1)
    expect(t.owner.runEngine.listRuns(far!.id, { limit: 5 })).toHaveLength(1)
    // The agent's retry learns the finished launch; another pass sends nothing again.
    await fresh.pass()
    const again = await create({ computer: t.node, firstMessage: 'Build it.', clientRequestId: 'cut-1' })
    expect(again.body).toMatchObject({ threadId: out.body.threadId, firstMessage: 'sent', replayed: true })
    expect(t.owner.runEngine.listRuns(far!.id, { limit: 5 })).toHaveLength(1)
    fresh.close()
    launchesOf().start()
  }, 120_000)

  it('a launch from before hidden whose create reply was lost retries the very same create: no conflict, the thread shows', async () => {
    const { thread, create } = await caller()
    // A row written before the column reads hidden null: its first attempt sent no hidden.
    const records = t.caller.runEngine.remoteLaunches
    const write = records.create.bind(records)
    vi.spyOn(records, 'create').mockImplementation((input) => write({ ...input, hidden: null }))
    // The create goes through there, but its reply is lost.
    const port = portOf()
    const real = port.call.bind(port)
    const sent: Array<Record<string, unknown>> = []
    let lose = true
    vi.spyOn(port, 'call').mockImplementation(async (node, method, params, options) => {
      if (method === 'threads.create') sent.push(params as Record<string, unknown>)
      const result = await real(node, method, params, options)
      if (method === 'threads.create' && lose) {
        lose = false
        throw new DomainRpcError('computer_offline', 'The other computer is offline.')
      }
      return result
    })
    const out = await create({ computer: t.node, clientRequestId: 'before-hidden' })
    expect(out.body.threadId).toBeUndefined()
    expect(launchedBy(thread.id)).toHaveLength(1)
    // The retry repeats it as it was: that computer answers with the thread it made, never a key conflict.
    const again = await create({ computer: t.node, clientRequestId: 'before-hidden' })
    expect(again.isError, JSON.stringify(again.body)).toBeUndefined()
    const [far] = launchedBy(thread.id)
    expect(again.body).toMatchObject({ threadId: qualifyId(t.node, far!.id) })
    expect(launchedBy(thread.id)).toHaveLength(1)
    expect(sent.length).toBeGreaterThanOrEqual(2)
    for (const params of sent) expect(params).not.toHaveProperty('hidden')
    // As before hidden existed, it shows in that computer's sidebar.
    expect(far!.hidden).toBeUndefined()
  }, 120_000)

  it('a launch whose first create went to a computer from before hidden sends none on its retry after that computer is updated', async () => {
    const { thread, create } = await caller()
    // That computer runs the version of threads.create before hidden: the client sends the create without it.
    const client = t.client()
    const realVersions = client.versions.bind(client)
    let older = true
    vi.spyOn(client, 'versions').mockImplementation(async (node, session) => {
      const versions = await realVersions(node, session)
      return older ? { ...versions, 'threads.create': ROUTED_AGENT_METHODS['threads.create']! } : versions
    })
    // The create goes through there, but its reply is lost; then that computer is updated.
    const port = portOf()
    const real = port.call.bind(port)
    const sent: Array<Record<string, unknown>> = []
    vi.spyOn(port, 'call').mockImplementation(async (node, method, params, options) => {
      if (method === 'threads.create') sent.push(params as Record<string, unknown>)
      const result = await real(node, method, params, options)
      if (method === 'threads.create' && older) {
        older = false
        throw new DomainRpcError('computer_offline', 'The other computer is offline.')
      }
      return result
    })
    const out = await create({ computer: t.node, clientRequestId: 'older-then-updated' })
    expect(out.body.threadId).toBeUndefined()
    const key = t.caller.runEngine.remoteLaunches.listForLauncher(thread.id)[0]!.creationKey
    // What the first attempt put on the wire is stored: no hidden.
    expect(t.caller.runEngine.remoteLaunches.get(key)!.hidden).toBeNull()
    // The retry, now to the updated computer, repeats that create: the same thread, never a key conflict.
    const again = await create({ computer: t.node, clientRequestId: 'older-then-updated' })
    expect(again.isError, JSON.stringify(again.body)).toBeUndefined()
    const [far] = launchedBy(thread.id)
    expect(again.body).toMatchObject({ threadId: qualifyId(t.node, far!.id) })
    expect(launchedBy(thread.id)).toHaveLength(1)
    expect(sent.length).toBeGreaterThanOrEqual(2)
    for (const params of sent) expect(params).not.toHaveProperty('hidden')
  }, 120_000)

  it('a new launch sends hidden with every attempt of its create, the same each time', async () => {
    const { thread, create } = await caller()
    const port = portOf()
    const real = port.call.bind(port)
    const sent: Array<Record<string, unknown>> = []
    let lose = true
    vi.spyOn(port, 'call').mockImplementation(async (node, method, params, options) => {
      if (method === 'threads.create') sent.push(params as Record<string, unknown>)
      const result = await real(node, method, params, options)
      if (method === 'threads.create' && lose) {
        lose = false
        throw new DomainRpcError('computer_offline', 'The other computer is offline.')
      }
      return result
    })
    await create({ computer: t.node, clientRequestId: 'new-hidden' })
    const again = await create({ computer: t.node, clientRequestId: 'new-hidden' })
    expect(again.isError, JSON.stringify(again.body)).toBeUndefined()
    expect(sent.length).toBeGreaterThanOrEqual(2)
    for (const params of sent) expect(params).toMatchObject({ hidden: true })
    expect(launchedBy(thread.id)).toHaveLength(1)
    expect(launchedBy(thread.id)[0]!.hidden).toBe(true)
  }, 120_000)

  describe('a project of that computer named with projectId needs nothing here', () => {
    it('starts there from a thread with no project here, with the id as thread_list with computer gives it', async () => {
      const { thread, create } = await caller({ project: null })
      const out = await create({ computer: t.node, projectId: qualifyId(t.node, ownerProject), clientRequestId: 'direct-1' })
      expect(out.isError, JSON.stringify(out.body)).toBeUndefined()
      expect(launchedBy(thread.id)).toEqual([expect.objectContaining({ projectId: ownerProject })])
    }, 120_000)

    it('starts there from a project here whose Git remote is another one, by its plain id too', async () => {
      const fork = repository()
      const { thread, create } = await caller({ project: fork.path })
      const out = await create({ computer: t.node, projectId: ownerProject, clientRequestId: 'direct-2' })
      expect(out.isError, JSON.stringify(out.body)).toBeUndefined()
      expect(launchedBy(thread.id)).toEqual([expect.objectContaining({ projectId: ownerProject })])
    }, 120_000)

    it('fromProjectId still finds that computer\'s checkout of a project here, and refuses one it has none of', async () => {
      const here = t.caller.projects.openProject(repo.path).id
      const { thread, create } = await caller({ project: null })
      const out = await create({ computer: t.node, fromProjectId: here, clientRequestId: 'from-1' })
      expect(out.isError, JSON.stringify(out.body)).toBeUndefined()
      expect(launchedBy(thread.id)).toEqual([expect.objectContaining({ projectId: ownerProject })])
      const other = t.caller.projects.openProject(repository().path).id
      const refused = await create({ computer: t.node, fromProjectId: other, clientRequestId: 'from-2' })
      expect(refused.isError).toBe(true)
      expect(refused.body.data).toMatchObject({ code: 'no_matching_project' })
      // With both, projectId must be one of the checkouts fromProjectId finds.
      const both = await create({ computer: t.node, fromProjectId: other, projectId: ownerProject, clientRequestId: 'from-3' })
      expect(both.body.data).toMatchObject({ code: 'no_matching_project' })
      expect(launchedBy(thread.id)).toHaveLength(1)
    }, 120_000)
  })

  describe('refusals name which they are, with the computer, and make nothing there', () => {
    const before = () => t.owner.threads.listAllThreads().length
    const refusal = async (args: Record<string, unknown>, options: Parameters<typeof caller>[0] = {}, setup?: () => void) => {
      const { create } = await caller(options)
      setup?.()
      const count = before()
      const out = await create({ computer: t.node, firstMessage: 'Hi.', ...args })
      expect(out.isError, JSON.stringify(out.body)).toBe(true)
      expect(before()).toBe(count)
      // A refusal: the fields kept beside it, with its words and how it may be retried.
      const { refused, data } = out.body as { refused: Loose; data: Loose }
      return { ...data, message: refused.message, refused }
    }

    it('offline', async () => {
      const body = await refusal({}, {}, () => {
        const port = portOf()
        vi.spyOn(port, 'computers').mockReturnValue([{ node: t.node, name: 'Linux box', online: false }])
      })
      expect(body).toMatchObject({ ok: false, code: 'computer_offline', computer: 'Linux box', message: expect.stringContaining('Linux box is offline'), refused: { code: 'unavailable', retry: 'later' } })
    }, 120_000)

    it('not allowed here: the switch off, or that computer not ticked', async () => {
      expect(await refusal({}, {}, () => allow(false))).toMatchObject({ code: 'computer_not_allowed' })
      expect(await refusal({}, {}, () => allow(true, []))).toMatchObject({ code: 'computer_not_allowed' })
    }, 120_000)

    it('not allowed there: that computer lets no agent of this one work on it', async () => {
      const body = await refusal({}, {}, () => policy.set(t.callerNode, { agentReach: 'none' }))
      expect(body).toMatchObject({ code: 'computer_not_allowed', refused: { code: 'scope_denied', retry: 'never' } })
    }, 120_000)

    it('outdated: a computer that does not know the agent mark gets no unmarked call', async () => {
      const body = await refusal({}, {}, () => {
        const client = t.client()
        const real = client.versions.bind(client)
        vi.spyOn(client, 'versions').mockImplementation(async (node, session) => {
          const versions = await real(node, session)
          return { ...versions, 'threads.create': ROUTED_AGENT_METHODS['threads.create']! - 1 }
        })
      })
      expect(body).toMatchObject({ code: 'computer_outdated', message: expect.stringContaining('Update Mousse') })
    }, 120_000)

    it('not shared: that computer stopped sharing its threads with this one', async () => {
      await t.owner.net.request('bridge.workOnThreads', { enabled: false })
      try {
        const shared = await refusal({})
        expect(shared).toMatchObject({ code: 'computer_not_shared' })
      } finally {
        await t.owner.net.request('bridge.workOnThreads', { enabled: true })
      }
    }, 120_000)

    it('no project for the repository there', async () => {
      const elsewhere = repository()
      expect(await refusal({}, { project: elsewhere.path })).toMatchObject({ code: 'no_matching_project', message: expect.stringContaining('projectId') })
      expect(await refusal({}, { project: null })).toMatchObject({ code: 'no_matching_project', message: expect.stringContaining('projectId') })
    }, 120_000)

    it('a projectId that computer does not have, or one of another computer, lists its projects', async () => {
      const missing = await refusal({ projectId: 'no-such-project' }, { project: null })
      expect(missing).toMatchObject({ code: 'no_matching_project', candidates: expect.arrayContaining([expect.objectContaining({ projectId: ownerProject })]) })
      expect(await refusal({ projectId: qualifyId('another-node', ownerProject) }, { project: null })).toMatchObject({ code: 'no_matching_project' })
    }, 120_000)

    it('a projectId of that computer still meets the checks of who may start threads there', async () => {
      const direct = { projectId: ownerProject }
      expect(await refusal(direct, { project: null }, () => allow(false))).toMatchObject({ code: 'computer_not_allowed' })
      expect(await refusal(direct, { project: null }, () => policy.set(t.callerNode, { agentReach: 'none' }))).toMatchObject({ code: 'computer_not_allowed' })
      const offline = await refusal(direct, { project: null }, () => {
        vi.spyOn(portOf(), 'computers').mockReturnValue([{ node: t.node, name: 'Linux box', online: false }])
      })
      expect(offline).toMatchObject({ code: 'computer_offline' })
    }, 120_000)

    it('several checkouts there: refused with the candidates, and one of them can be named', async () => {
      const second = t.owner.projects.openProject(clone(repo)).id
      try {
        const body = await refusal({ clientRequestId: 'several-1' })
        expect(body).toMatchObject({ code: 'several_matching_projects' })
        // That computer's own ids, as the agent passes one back in projectId.
        expect(body.candidates.map((entry: { projectId: string }) => entry.projectId).sort()).toEqual([ownerProject, second].sort())
        const { thread, create } = await caller()
        const out = await create({ computer: t.node, projectId: second, clientRequestId: 'several-2' })
        expect(out.isError, JSON.stringify(out.body)).toBeUndefined()
        expect(launchedBy(thread.id)[0]).toMatchObject({ projectId: second })
      } finally {
        t.owner.projects.removeProject(second)
      }
    }, 120_000)
  })
})

/** The words of a call refused as a conflict (a key used for other arguments). */
async function registryConflict(work: () => Promise<{ isError?: boolean; body: Loose }>): Promise<string> {
  const out = await work()
  if (out.isError && out.body.refused?.code === 'conflict') return out.body.refused.message
  throw new Error(`the call went through: ${JSON.stringify(out.body)}`)
}
