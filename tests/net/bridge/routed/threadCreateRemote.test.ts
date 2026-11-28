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
 *   ticked) or there (agent reach none), no project for the repository, several checkouts (and choosing one);
 * - no project there: the launcher's thread has none, projectId null from a thread in a project, that computer with no
 *   projects at all, and no project with a new worktree (refused).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ROUTED_AGENT_BOT_KEY, ROUTED_AGENT_BOT_SINCE, ROUTED_AGENT_METHODS } from '../../../../src/shared/bridge/routed'
import type { BotAuthority } from '../../../../src/shared/bots/personal/authority'
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
import { computerUseAllowed } from '../../../../src/mms/run/mcp/appTools/computer'
import { withHiddenBots } from '../../../../src/mms/bridge/remote/botReach'
import { HIDDEN_BOT_NAME } from '../../../../src/shared/bots/personal/deviceAccess'
import { NotificationThreadIndex } from '../../../../src/main/notifications/threadNotificationTarget'

type Loose = Record<string, any>
let t: Awaited<ReturnType<typeof linked>>
let policy: SqliteNodePolicy
let startTurn: ReturnType<typeof vi.fn>
let repo: { path: string; remote: string }
let ownerProject: string
let ownerCheckout: string
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
  ownerCheckout = clone(repo)
  ownerProject = t.owner.projects.openProject(ownerCheckout).id
}, 120_000)
afterAll(cleanupAll)
afterEach(() => {
  vi.restoreAllMocks()
  allow()
  policy.set(t.callerNode, { maxPermissionMode: 'accept_edits', agentReach: 'launched' })
  t.caller.orchestrator.setBotThreads(null)
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
    // A handoff (#2004): an agent's thread shows in that computer's sidebar.
    expect(far!.hidden).toBeUndefined()
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
    // Here too it reaches the window's list, shown: the launcher's side panel (Started threads), All and search find it.
    const lists = t.caller.bridge.lists
    await lists.reconcile()
    await vi.waitFor(() => expect(lists.threads().find((row) => row.id === qualifyId(t.node, far!.id))).toBeDefined(), { timeout: 20_000 })
    const rows = (await t.dispatch('threads.list', {})).threads as Thread[]
    expect(launchedThreadsOf(rows, thread.id).map((row) => row.id)).toEqual([qualifyId(t.node, far!.id)])
    const row = rows.find((entry) => entry.id === qualifyId(t.node, far!.id))!
    const filter = { query: '', projectId: null, botId: null, computerIds: [], archived: false }
    const context = { groupOf: (id: string) => id, projectName: () => undefined, botName: () => undefined }
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

  it('an agent\'s create that a computer from before #2004 sends with hidden: true starts shown there', async () => {
    const { thread, create } = await caller()
    // That computer asked to hide every agent's thread here; a handoff shows (#2004), and only a bot's is hidden.
    const records = t.caller.runEngine.remoteLaunches
    const write = records.create.bind(records)
    vi.spyOn(records, 'create').mockImplementation((input) => write({ ...input, hidden: true }))
    const port = portOf()
    const real = port.call.bind(port)
    const sent: Array<Record<string, unknown>> = []
    vi.spyOn(port, 'call').mockImplementation(async (node, method, params, options) => {
      if (method === 'threads.create') sent.push(params as Record<string, unknown>)
      return real(node, method, params, options)
    })
    const out = await create({ computer: t.node, clientRequestId: 'older-hidden' })
    expect(out.isError, JSON.stringify(out.body)).toBeUndefined()
    expect(sent[0]).toMatchObject({ hidden: true })
    const [far] = launchedBy(thread.id)
    expect(far!.hidden).toBeUndefined()
    expect(far!.startedByBot).toBeUndefined()
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

  it('a new launch sends hidden: false with every attempt of its create, the same each time', async () => {
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
    // An agent's thread is a handoff there too (#2004): shown.
    for (const params of sent) expect(params).toMatchObject({ hidden: false })
    expect(launchedBy(thread.id)).toHaveLength(1)
    expect(launchedBy(thread.id)[0]!.hidden).toBeUndefined()
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

  describe('no project there', () => {
    it('a thread in no project here starts one in no project there, even when that computer has no projects', async () => {
      standInForTurns()
      // That computer has no projects at all.
      t.owner.projects.removeProject(ownerProject)
      try {
        expect(t.owner.projects.listProjects()).toEqual([])
        const { thread, create } = await caller({ project: null })
        const out = await create({ computer: t.node, title: 'Look around', firstMessage: 'What is on this computer?', clientRequestId: 'no-project-1' })
        expect(out.isError, JSON.stringify(out.body)).toBeUndefined()
        const [far] = launchedBy(thread.id)
        expect(out.body).toMatchObject({ threadId: qualifyId(t.node, far!.id), firstMessage: 'sent' })
        expect(far!.projectId).toBeUndefined()
        expect(far).toMatchObject({ name: 'Look around', startedFrom: { node: t.callerNode, agent: { thread: thread.id } } })
        await vi.waitFor(() => expect(startTurn).toHaveBeenCalled())
        expect(String((startTurn.mock.calls.at(-1)![0] as Loose).input.content)).toContain('What is on this computer?')
        expect(t.caller.runEngine.remoteLaunches.listForLauncher(thread.id)).toEqual([expect.objectContaining({ remoteProjectId: null, state: 'launched' })])
        // A retry with the same key is the same launch.
        const again = await create({ computer: t.node, title: 'Look around', firstMessage: 'What is on this computer?', clientRequestId: 'no-project-1' })
        expect(again.body).toMatchObject({ threadId: out.body.threadId, replayed: true })
        expect(launchedBy(thread.id)).toHaveLength(1)
      } finally {
        ownerProject = t.owner.projects.openProject(ownerCheckout).id
      }
    }, 120_000)

    it('a personal bot that names no project here starts one in no project there, and its retry is the same launch', async () => {
      standInForTurns()
      // The caller is the owner's bot (its own turn, "use your threads"): its thread's project is not the one it means.
      const { thread, runId } = await caller()
      vi.spyOn(t.caller.orchestrator as unknown as Loose, 'botSenderOf').mockReturnValue({ botId: 'bot1', name: 'Helper', activationId: 'act1', limit: 'auto' })
      const host = (t.caller.orchestrator as unknown as { mcpToolHost(): AppToolHost }).mcpToolHost()
      const actor = { kind: 'agent' as const, threadId: thread.id, runId, toolCallId: 'call-1' }
      const request = { computer: t.node, title: 'Look around', workspace: 'project' as const, firstMessage: 'Look around.', mode: 'agent' as const }
      const first = await host.createRemoteThread!(request, { clientRequestId: 'bot-no-project', actor })
      expect(first, JSON.stringify(first)).toMatchObject({ status: 'launched', firstMessage: 'sent', replayed: false })
      const [far] = launchedBy(thread.id)
      expect(far!.projectId).toBeUndefined()
      expect(t.caller.runEngine.remoteLaunches.listForLauncher(thread.id)).toEqual([expect.objectContaining({ remoteProjectId: null })])
      const again = await host.createRemoteThread!(request, { clientRequestId: 'bot-no-project', actor })
      expect(again).toMatchObject({ status: 'launched', threadId: (first as { threadId: string }).threadId, replayed: true })
      expect(launchedBy(thread.id)).toHaveLength(1)
    }, 120_000)

    it('projectId null from a thread in a project starts it in no project there; the same key without it is another launch', async () => {
      const { thread, create } = await caller()
      const out = await create({ computer: t.node, projectId: null, clientRequestId: 'no-project-2' })
      expect(out.isError, JSON.stringify(out.body)).toBeUndefined()
      const [far] = launchedBy(thread.id)
      expect(far!.projectId).toBeUndefined()
      expect(await registryConflict(() => create({ computer: t.node, clientRequestId: 'no-project-2' }))).toMatch(/already used/)
      expect(launchedBy(thread.id)).toHaveLength(1)
    }, 120_000)

    it('no project with a new worktree is refused, and nothing is made there', async () => {
      const count = t.owner.threads.listAllThreads().length
      const { create } = await caller()
      expect((await create({ computer: t.node, projectId: null, workspace: 'new_worktree', clientRequestId: 'no-project-3' })).isError).toBe(true)
      const bare = await caller({ project: null })
      const out = await bare.create({ computer: t.node, workspace: 'new_worktree', clientRequestId: 'no-project-4' })
      expect(out.isError).toBe(true)
      expect(out.body.data).toMatchObject({ code: 'no_matching_project' })
      expect(t.owner.threads.listAllThreads().length).toBe(count)
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

    it('a thread another device started: never refused going back to that device; a third computer until the person here allows it', async () => {
      standInForTurns()
      const { thread, create } = await caller()
      const startedFrom = (node: string) => t.caller.threads.updateThreadMeta(thread.id, { startedFrom: { node } }, { touch: false })
      const count = before()
      startedFrom('nod_third')
      const chained = await create({ computer: t.node, title: 'Chained', clientRequestId: 'chain-1' })
      expect(chained.isError, JSON.stringify(chained.body)).toBe(true)
      expect(chained.body.data).toMatchObject({ code: 'remote_from_remote', computer: expect.any(String) })
      expect(before()).toBe(count)
      // Started from that computer: the thread goes back there, with nothing more turned on.
      startedFrom(t.node)
      const back = await create({ computer: t.node, title: 'Back', clientRequestId: 'chain-2' })
      expect(back.isError, JSON.stringify(back.body)).toBeUndefined()
      // From a third device again, once the person here allows it: as from a thread started here.
      startedFrom('nod_third')
      t.caller.settings.set({ agentAccess: { ...t.caller.settings.get().agentAccess, fromOtherDevices: true } } as never)
      try {
        const allowed = await create({ computer: t.node, title: 'Allowed', clientRequestId: 'chain-3' })
        expect(allowed.isError, JSON.stringify(allowed.body)).toBeUndefined()
      } finally {
        t.caller.settings.set({ agentAccess: { ...t.caller.settings.get().agentAccess, fromOtherDevices: false } } as never)
      }
      expect(launchedBy(thread.id)).toHaveLength(2)
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
      // A thread with no project here starts one in no project there instead: see 'no project there'.
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

const PIP_LOOK = { colour: 'teal', accessory: 'crown' }

/**
 * The owner's bot "Pip" on the caller, in a chat turn its owner's message started: its chat thread (no project), a live
 * run that holds the thread tools, and the tools it calls through the registry.
 */
async function botCaller() {
  allow()
  const chat = t.caller.threads.createThread(`Pip ${++seq}`, undefined, undefined, { permissionMode: 'auto' } as never)
  const sent = await t.caller.runEngine.dispatch({ kind: 'send', threadId: chat.id, clientRequestId: `bot-send-${seq}`, source: 'gui' })
  if (sent.status !== 'accepted') throw new Error('bot run not accepted')
  t.caller.runEngine.markStarting(sent.runId)
  t.caller.runEngine.markRunning(sent.runId)
  // Its grant allows the calls; what each tool checks for a bot is what runs.
  const bot = { activationId: `act-${seq}`, appTools: new Set(['thread_create', 'thread_send']), check: () => ({ ok: true }) } as unknown as BotAuthority
  t.caller.orchestrator.setBotThreads({
    roleOf: (threadId) => (threadId === chat.id ? 'activation' : undefined),
    botOf: (threadId) => (threadId === chat.id ? { botId: 'bot-pip', name: 'Pip', look: PIP_LOOK } : undefined),
    ownerTurn: () => ({})
  })
  t.caller.orchestrator.appToolTurns.register(appTurn({ threadId: chat.id, runId: sent.runId, bot }))
  const host = (t.caller.orchestrator as unknown as { mcpToolHost(): AppToolHost }).mcpToolHost()
  const { registry, turns, request } = appToolRegistry(t.caller.runEngine, host)
  turns.register(appTurn({ threadId: chat.id, runId: sent.runId, bot }))
  const tool = async (name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; body: Loose }> => {
    const out = await registry.call(name, args, request({ threadId: chat.id, runId: sent.runId }))
    return { ...(out.isError ? { isError: true } : {}), body: JSON.parse(out.text) }
  }
  return { chat, tool, create: (args: Record<string, unknown>) => tool('thread_create', { computer: t.node, projectId: ownerProject, title: 'Build', firstMessage: 'Build it.', ...args }) }
}

/** Who the turns there were handed messages from (the sender each message there is stored with), for the bot's chat. */
const sendersThere = async (chatId: string, count: number): Promise<Loose[]> => {
  const senders = () => startTurn.mock.calls.map(([handed]) => (handed as Loose).agent).filter((agent: Loose | undefined) => agent?.from?.thread === chatId)
  await vi.waitFor(() => expect(senders()).toHaveLength(count), { timeout: 20_000 })
  return senders()
}

describe('a personal bot\'s thread on another computer (issue #2003)', () => {
  it('hidden: true starts it out of that computer\'s sidebar', async () => {
    standInForTurns()
    const { chat, create } = await botCaller()
    const out = await create({ hidden: true, clientRequestId: 'bot-hidden' })
    expect(out.isError, JSON.stringify(out.body)).toBeUndefined()
    const [far] = launchedBy(chat.id)
    // Hidden once its first message named the bot there.
    expect(far).toMatchObject({ hidden: true, startedByBot: { botId: 'bot-pip' }, startedFrom: { node: t.callerNode, agent: { thread: chat.id } } })
  }, 120_000)

  it('a start that names no hidden keeps the key a bot stored before hidden: its retry is the same launch, shown there', async () => {
    standInForTurns()
    const { chat, create } = await botCaller()
    const out = await create({ clientRequestId: 'bot-shown' })
    expect(out.isError, JSON.stringify(out.body)).toBeUndefined()
    const [far] = launchedBy(chat.id)
    expect(far!.hidden).toBeUndefined()
    // The fingerprint a bot's start stored before hidden could be passed: the same arguments, nothing else.
    const record = t.caller.runEngine.remoteLaunches.listForLauncher(chat.id)[0]!
    const stored = t.caller.runEngine.store.getReceipt(record.creationKey)!.result as { fingerprint: string }
    expect(stored.fingerprint).toBe(JSON.stringify(['remote', t.node.toLowerCase(), ownerProject, 'Build', 'project', null, null, null, 'Build it.', 'agent']))
    const again = await create({ clientRequestId: 'bot-shown' })
    expect(again.body).toMatchObject({ threadId: out.body.threadId, replayed: true })
    expect(launchedBy(chat.id)).toHaveLength(1)
  }, 120_000)

  it('its first message and its later messages there carry its name and face', async () => {
    standInForTurns()
    const { chat, tool, create } = await botCaller()
    const out = await create({ clientRequestId: 'bot-face' })
    expect(out.body).toMatchObject({ firstMessage: 'sent' })
    const [far] = launchedBy(chat.id)
    // Named there by the bot's name, not by its chat's title.
    expect(far!.startedFrom?.agent?.title).toBe('Pip')
    const sent = await tool('thread_send', { threadId: out.body.threadId, content: 'Also run the linter.', clientRequestId: 'bot-face-2' })
    expect(sent.isError, JSON.stringify(sent.body)).toBeUndefined()
    for (const sender of await sendersThere(chat.id, 2))
      expect(sender).toMatchObject({ kind: 'agent', from: { node: t.callerNode, thread: chat.id }, bot: { id: 'bot-pip', name: 'Pip', look: PIP_LOOK } })
  }, 120_000)

  it('there, its thread is the bot\'s: in Bot threads, named by it, yet it holds nothing there and goes on as "a bot"', async () => {
    standInForTurns()
    const { chat, create } = await botCaller()
    const out = await create({ clientRequestId: 'bot-own-there' })
    expect(out.isError, JSON.stringify(out.body)).toBeUndefined()
    const [far] = launchedBy(chat.id)
    expect(far).toMatchObject({ startedByBot: { botId: 'bot-pip', name: 'Pip', node: t.callerNode } })
    expect(threadInFilter(far!, { query: '', show: 'bots', projectId: null, botId: null, computerIds: [], archived: false }, { groupOf: (id) => id, projectName: () => undefined, botName: () => undefined })).toBe(true)
    // No bot there has that id: what the thread's agents may do is any agent's.
    expect(computerUseAllowed(far!.id, (id) => t.owner.threads.getThread(id) ?? undefined, () => false)).toBe(true)
    // That computer can't tell who may know the bot: to a third it is "a bot".
    expect(withHiddenBots(far, undefined)!.startedByBot).toEqual({ botId: '', name: HIDDEN_BOT_NAME })
  }, 120_000)

  it('there, its hidden thread is quiet, as a hidden bot thread is', async () => {
    standInForTurns()
    const { chat, create } = await botCaller()
    const out = await create({ hidden: true, clientRequestId: 'bot-quiet-there' })
    expect(out.isError, JSON.stringify(out.body)).toBeUndefined()
    const [far] = launchedBy(chat.id)
    const index = new NotificationThreadIndex()
    index.note('p', { threads: [far] })
    expect(index.resolve('p', far!.id, 'completed')).toBeNull()
    expect(index.resolve('p', far!.id, 'completed', true)).not.toBeNull()
  }, 120_000)

  it('a computer from before it gets neither, so its messages keep the agent label; a retry after it is updated sends the same', async () => {
    standInForTurns()
    const { chat, tool, create } = await botCaller()
    // That computer runs the version of orchestrator.send before the bot's name and face.
    const client = t.client()
    const realVersions = client.versions.bind(client)
    let older = true
    vi.spyOn(client, 'versions').mockImplementation(async (node, session) => {
      const versions = await realVersions(node, session)
      return older ? { ...versions, 'orchestrator.send': ROUTED_AGENT_BOT_SINCE - 1 } : versions
    })
    const port = portOf()
    const real = port.call.bind(port)
    const sends: Array<Record<string, unknown>> = []
    let lose = true
    vi.spyOn(port, 'call').mockImplementation(async (node, method, params, options) => {
      if (method === 'orchestrator.send') sends.push(params as Record<string, unknown>)
      const result = await real(node, method, params, options)
      // The first message goes through there, but its reply is lost; then that computer is updated.
      if (method === 'orchestrator.send' && lose) {
        lose = false
        older = false
        throw new DomainRpcError('computer_offline', 'The other computer is offline.')
      }
      return result
    })
    const out = await create({ clientRequestId: 'bot-older' })
    expect(out.body).toMatchObject({ firstMessage: 'uncertain' })
    expect(t.caller.runEngine.remoteLaunches.listForLauncher(chat.id)[0]!.senderBot).toBeUndefined()
    // The retry repeats the first message as it went: no key conflict there, and still the agent label.
    const again = await create({ clientRequestId: 'bot-older' })
    expect(again.body).toMatchObject({ firstMessage: 'sent' })
    for (const params of sends) expect(params).not.toHaveProperty(ROUTED_AGENT_BOT_KEY)
    const [far] = launchedBy(chat.id)
    expect(far!.startedByBot).toBeUndefined()
    // A later message to a computer from before it reaches it without them too.
    older = true
    const later = await tool('thread_send', { threadId: out.body.threadId, content: 'Also run the linter.', clientRequestId: 'bot-older-2' })
    expect(later.isError, JSON.stringify(later.body)).toBeUndefined()
    for (const sender of await sendersThere(chat.id, 2)) {
      expect(sender).toMatchObject({ kind: 'agent', from: { node: t.callerNode, thread: chat.id, title: 'Pip' } })
      expect(sender).not.toHaveProperty('bot')
    }
  }, 120_000)
})

/** The words of a call refused as a conflict (a key used for other arguments). */
async function registryConflict(work: () => Promise<{ isError?: boolean; body: Loose }>): Promise<string> {
  const out = await work()
  if (out.isError && out.body.refused?.code === 'conflict') return out.body.refused.message
  throw new Error(`the call went through: ${JSON.stringify(out.body)}`)
}
