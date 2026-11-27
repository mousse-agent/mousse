/**
 * Issue #1160, docs/plans/agent-threads-architecture.md §4.2: an agent that sends with `notify` to a thread it launched on
 * another computer (`thread_send`, or `thread_create` with `computer`) is told when that work settles, as on one computer.
 * Two real daemons linked by Bridge; the caller's agent calls the tools through the app-tool registry over the caller
 * orchestrator's host. The owner's turns are stood in for (no provider runs), so a run's status there is what the test
 * sets on that computer's run engine. A notice is observed where Mousse hands it to the sender (`queueSettleNotice`:
 * its text, its structured item, its count and whether it may start a turn); the queue and the turn it starts from there
 * are the same as on one computer (`tests/run/threadSettleNoticeDaemon.test.ts`).
 *
 * Inputs listed before the cases:
 * - how the watch is made: `thread_create` with `computer` and a first message, `thread_send` to a launched thread;
 * - what happens there: the run ends with a long reply; it waits on a person first, then ends; a person edits the queued
 *   message there, so a new run carries it;
 * - what happens here: this daemon restarts (the watch resumes from its row); the link is down while the run ends;
 * - that computer refuses this device (blocked);
 * - the 24 hours pass;
 * - who hears: an idle launcher (the notice may start a turn, carrying the run's count there) and a
 *   subagent's thread (held).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { qualifyId } from '../../../../src/shared/threadRef'
import { SETTLE_NOTICE_RESULT_CHARS } from '../../../../src/shared/settleNotice'
import { DomainRpcError } from '../../../../src/mms/protocol/domainRegistry'
import type { RemoteComputersPort } from '../../../../src/mms/protocol/remoteComputersPort'
import type { SqliteNodePolicy } from '../../../../src/mms/net/store/nodePolicy'
import type { PlannedSettleNotice, SettleNotices } from '../../../../src/mms/orchestrator/settleNotices'
import { recordRunResultText } from '../../../../src/mms/run/delegation/hold'
import type { RunEngine } from '../../../../src/mms/run/RunEngine'
import type { AppToolHost } from '../../../../src/mms/run/mcp/appTools'
import { NOTIFY_NEXT } from '../../../../src/mms/run/mcp/appTools/thread'
import { appToolRegistry, appTurn } from '../../../run/appToolsFixture'
import { cleanups, cleanupAll, linked } from './routerFixture'

type Loose = Record<string, any>
let t: Awaited<ReturnType<typeof linked>>
let policy: SqliteNodePolicy
let repo: { path: string }
let seq = 0
/** Every notice Mousse handed to a sender on the caller, in order. */
let delivered: Array<{ threadId: string; notice: PlannedSettleNotice; held: boolean }> = []

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim()
const folder = (): string => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'remote-settle-')))
  cleanups.push(() => rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return path
}

const callerOrch = (): Loose => t.caller.orchestrator as unknown as Loose
const portOf = (): RemoteComputersPort => callerOrch().remoteComputers
const nameOf = (): string => portOf().computers()!.find((entry) => entry.node === t.node)!.name
const service = (): SettleNotices => callerOrch().settleNotices
const watchRow = (watchId: string): Loose => t.caller.runEngine.store.db.statement('SELECT * FROM thread_watches WHERE watch_id = ?').get(watchId) as Loose
const noticesFor = (threadId: string) => delivered.filter((entry) => entry.threadId === threadId)
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** What a restart of this daemon does to the watches: the service is made again and reads them from the run database alone. */
function restartWatches(): SettleNotices {
  service().stop()
  callerOrch().settleNotices = callerOrch().startSettleNotices(t.caller.runEngine as RunEngine)
  return service()
}

beforeAll(async () => {
  t = await linked()
  policy = (t.insideOwner.routes as unknown as { options: { policy: SqliteNodePolicy } }).options.policy
  const path = folder()
  git(path, 'init', '-q')
  git(path, 'commit', '-q', '--allow-empty', '-m', 'root')
  const remote = `https://example.com/acme/${Math.random().toString(36).slice(2)}.git`
  git(path, 'remote', 'add', 'origin', remote)
  repo = { path }
  const copy = folder()
  git(copy, 'clone', '-q', path, '.')
  git(copy, 'remote', 'set-url', 'origin', remote)
  t.owner.projects.openProject(copy)
  t.caller.settings.set({ agentAccess: { ...t.caller.settings.get().agentAccess, remoteSubagents: true, computers: [t.node] } } as never)
  // A watch that did not reach the computer tries again in a fifth of a second here, not in 5 s.
  callerOrch().remoteWatchRetryMs = 200
  restartWatches()
}, 120_000)
afterAll(cleanupAll)
afterEach(() => {
  vi.restoreAllMocks()
  delivered = []
  policy.set(t.callerNode, { blocked: false, maxPermissionMode: 'accept_edits', agentReach: 'launched' })
})

/** The turns of both computers are stood in for; each notice handed to a sender here is recorded, then queued as usual. */
function standIn(): void {
  const done = (): Promise<unknown> => Promise.resolve({ message: '', actions: [] })
  for (const orch of [t.owner.orchestrator, t.caller.orchestrator] as unknown as Loose[]) {
    vi.spyOn(orch, 'startTurn').mockImplementation(done as never)
    vi.spyOn(orch, 'runTurnOnSession').mockImplementation(done as never)
  }
  const real = callerOrch().queueSettleNotice.bind(t.caller.orchestrator)
  vi.spyOn(callerOrch(), 'queueSettleNotice').mockImplementation(((threadId: string, notice: PlannedSettleNotice, held: boolean) => {
    delivered.push({ threadId, notice, held })
    return real(threadId, notice, held)
  }) as never)
}

/** A thread on the caller with a live run, and its agent's tools. */
async function launcher() {
  const project = t.caller.projects.openProject(repo.path)
  const thread = t.caller.threads.createThread(`Launcher ${++seq}`, project.id, project.path, { permissionMode: 'auto' } as never)
  const sent = await t.caller.runEngine.dispatch({ kind: 'send', threadId: thread.id, clientRequestId: `launcher-send-${seq}`, source: 'gui' })
  if (sent.status !== 'accepted') throw new Error('launcher run not accepted')
  t.caller.runEngine.markStarting(sent.runId)
  t.caller.runEngine.markRunning(sent.runId)
  const real = t.caller.orchestrator.runPermissionMode.bind(t.caller.orchestrator)
  vi.spyOn(t.caller.orchestrator, 'runPermissionMode').mockImplementation((id) => (id === sent.runId ? 'auto' : real(id)))
  const host = callerOrch().mcpToolHost() as AppToolHost
  const { registry, turns: appTurns, request } = appToolRegistry(t.caller.runEngine, host)
  appTurns.register(appTurn({ threadId: thread.id, runId: sent.runId }))
  const tool = async (name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; body: Loose; text: string }> => {
    const out = await registry.call(name, args, request({ threadId: thread.id, runId: sent.runId }))
    let body: Loose = {}
    try {
      body = JSON.parse(out.text)
    } catch {
      // A refusal in words.
    }
    return { ...(out.isError ? { isError: true } : {}), body, text: out.text }
  }
  /** A thread launched on the owner by this launcher's agent (with `notify` when asked). */
  const launch = async (firstMessage?: string, notify = false) => {
    const out = await tool('thread_create', { computer: t.node, title: `Launched ${++seq}`, ...(firstMessage ? { firstMessage } : {}), ...(notify ? { notify: true } : {}), clientRequestId: `launch-${seq}` })
    if (out.isError) throw new Error(out.text)
    const far = t.caller.runEngine.remoteLaunches.listForLauncher(thread.id).at(-1)!.remoteThreadId!
    return { far, id: qualifyId(t.node, far), runId: out.body.runId as string | undefined, body: out.body }
  }
  /** The launcher's own turn ends: a notice may then start a turn of its own. */
  const idle = () => t.caller.runEngine.markTerminal(sent.runId, 'completed')
  return { thread, runId: sent.runId, tool, launch, idle }
}

/** The run there starts, as its turn would. */
function running(runId: string): void {
  t.owner.runEngine.markStarting(runId)
  t.owner.runEngine.markRunning(runId)
}

/** The run there ends with `reply` as its final text, as its turn would. */
function finish(runId: string, reply?: string, status: 'completed' | 'failed' = 'completed'): void {
  if (reply) recordRunResultText(t.owner.runEngine.store, t.owner.runEngine.getRun(runId)!, reply)
  t.owner.runEngine.markTerminal(runId, status)
}

describe('notify on a thread launched on another computer (issue #1160)', () => {
  it('thread_create with notify: the end is told once, with the reply cut to 2,000 characters and the thread as a qualified link', async () => {
    standIn()
    const { thread, launch, idle } = await launcher()
    const { far, id, runId, body } = await launch('Run the tests on Linux.', true)
    expect(body.notify).toMatchObject({ watchId: expect.any(String), next: NOTIFY_NEXT })
    expect(watchRow(body.notify.watchId)).toMatchObject({ state: 'active', target_node: t.node, target_thread_id: far, run_id: runId })
    running(runId!)
    idle()
    await pause(500)
    // Still going there: nothing told.
    expect(noticesFor(thread.id)).toHaveLength(0)

    const reply = `${'a'.repeat(SETTLE_NOTICE_RESULT_CHARS)}${'b'.repeat(2_996)}TAIL`
    finish(runId!, reply)
    await vi.waitFor(() => expect(noticesFor(thread.id)).toHaveLength(1), { timeout: 20_000 })
    const [{ notice, held }] = noticesFor(thread.id)
    expect(held).toBe(false)
    expect(notice.item).toMatchObject({ watchId: body.notify.watchId, threadId: id, event: 'ended', status: 'completed', runId, cut: true })
    expect(notice.text).toContain(`mousse://thread/${id}`)
    expect(notice.text).toContain(`on ${nameOf()}`)
    expect(notice.text).toContain('finished')
    expect(notice.text).toContain('a'.repeat(SETTLE_NOTICE_RESULT_CHARS))
    expect(notice.text).not.toContain('aab')
    expect(notice.text).not.toContain('TAIL')
    // The pointer gives the reply's full length, not the 4,000 that computer sent, and the id to read it by.
    expect(notice.text).toContain(`of ${reply.length.toLocaleString('en-US')} characters; read the rest with thread_read on thread ${id}`)
    expect(watchRow(body.notify.watchId)).toMatchObject({ state: 'ended', end_status: 'completed', end_notice: 'sent', needs_input: null })
    // Told once, and nothing follows the thread any more.
    await pause(1_500)
    expect(noticesFor(thread.id)).toHaveLength(1)
    expect(service().remote!.following()).not.toContain(body.notify.watchId)
  }, 120_000)

  it('thread_send with notify: waiting on a person there is told first, and does not use up the end; the notice carries that run\'s count', async () => {
    standIn()
    const { thread, tool, launch, idle } = await launcher()
    const first = await launch('Set it up.')
    running(first.runId!)
    finish(first.runId!)
    const sent = await tool('thread_send', { threadId: first.id, content: 'Now run the tests.', notify: true, clientRequestId: 'send-1' })
    expect(sent.isError, sent.text).toBeUndefined()
    expect(sent.body).toMatchObject({ threadId: first.id, computer: nameOf(), delivery: 'started', notify: { next: NOTIFY_NEXT } })
    const runId = sent.body.runId as string
    // That computer counts this run as the third agent message in a row there (it takes the larger of its own count and
    // the 1 this send carried), so the notice must read the count there.
    const outcome = { ...t.owner.runEngine.getRun(runId)!.outcome, agentHops: 3 }
    t.owner.runEngine.store.db.statement('UPDATE runs SET outcome = ? WHERE run_id = ?').run(JSON.stringify(outcome), runId)
    expect(t.owner.runEngine.getRun(runId)!.outcome?.agentHops).toBe(3)
    // A retry with the same request id keeps the one watch.
    const again = await tool('thread_send', { threadId: first.id, content: 'Now run the tests.', notify: true, clientRequestId: 'send-1' })
    expect(again.body.notify.watchId).toBe(sent.body.notify.watchId)
    idle()
    running(runId)

    const asking = vi.spyOn(t.owner.questions, 'listPendingForThread').mockImplementation((threadId) => (threadId === first.far ? ([{}] as never) : []))
    await vi.waitFor(() => expect(noticesFor(thread.id)).toHaveLength(1), { timeout: 20_000 })
    expect(noticesFor(thread.id)[0]!.notice.item).toMatchObject({ event: 'needs_input', threadId: first.id, runId })
    expect(noticesFor(thread.id)[0]!.notice.text).toContain('waiting for a person')
    // The count of the run there (3), not the one the send carried from here (1).
    expect(noticesFor(thread.id)[0]!.notice.hops).toBe(3)
    // Still waiting a while later: told once.
    await pause(1_000)
    expect(noticesFor(thread.id)).toHaveLength(1)
    asking.mockRestore()

    finish(runId, 'All green.')
    await vi.waitFor(() => expect(noticesFor(thread.id)).toHaveLength(2), { timeout: 20_000 })
    const end = noticesFor(thread.id)[1]!.notice
    expect(end.item).toMatchObject({ event: 'ended', status: 'completed', runId })
    expect(end.text).toContain('All green.')
    expect(end.hops).toBe(3)
    expect(watchRow(sent.body.notify.watchId)).toMatchObject({ state: 'ended', needs_input: 'sent', end_notice: 'sent' })
    // The idle launcher's turn for it carries that count and adds none.
    await vi.waitFor(() => expect(t.caller.runEngine.listRuns(thread.id, { limit: 10 }).some((run) => run.source === 'thread-notice')).toBe(true), { timeout: 20_000 })
    expect(t.caller.runEngine.listRuns(thread.id, { limit: 10 }).find((run) => run.source === 'thread-notice')!.outcome?.agentHops).toBe(3)
  }, 120_000)

  it('follows a message a person edited in that computer\'s queue into the run it gets there', async () => {
    standIn()
    const { thread, tool, launch, idle } = await launcher()
    const { far, id } = await launch()
    // A person works in the thread there: the agent's message queues behind them.
    const person = await t.owner.runEngine.dispatch({ kind: 'send', threadId: far, clientRequestId: `person-${++seq}`, source: 'gui' })
    if (person.status !== 'accepted') throw new Error('not accepted')
    running(person.runId)
    const owned = (t.owner.orchestrator as unknown as Loose)
    // Its turn runs there (stood in for), so a message from here waits in that thread's queue.
    const session = owned.getOrCreateSession(far)
    const turnRunning = vi.spyOn(session, 'isTurnRunning').mockReturnValue(true)
    const sent = await tool('thread_send', { threadId: id, content: 'Then run the tests.', notify: true })
    expect(sent.isError, sent.text).toBeUndefined()
    idle()
    expect(sent.body.delivery).toBe('queued')
    const item = t.owner.orchestrator.queueSnapshot(far).items.find((entry) => entry.runId === sent.body.runId)!
    expect(item).toBeDefined()
    await pause(1_500)
    expect(watchRow(sent.body.notify.watchId).queue_item_id).toBe(item.id)
    // The person edits it there: its run is cancelled, and it gets a fresh run when it drains.
    t.owner.orchestrator.editQueuedItem(far, item.id, { content: 'Then run the integration tests.' })
    expect(t.owner.runEngine.getRun(sent.body.runId)!.status).toBe('cancelled')
    await pause(1_500)
    expect(noticesFor(thread.id)).toHaveLength(0)
    turnRunning.mockRestore()
    finish(person.runId)
    owned.scheduleQueueDrain(owned.getOrCreateSession(far))
    let next: string | undefined
    await vi.waitFor(() => {
      next = t.owner.runEngine.listRuns(far, { limit: 10 }).find((run) => run.clientRequestId === `queue:${item.id}`)?.runId
      expect(next).toBeDefined()
    }, { timeout: 20_000 })
    if (t.owner.runEngine.getRun(next!)!.status === 'queued') running(next!)
    finish(next!, 'Integration tests pass.')
    await vi.waitFor(() => expect(noticesFor(thread.id)).toHaveLength(1), { timeout: 20_000 })
    expect(noticesFor(thread.id)[0]!.notice.item).toMatchObject({ event: 'ended', status: 'completed', runId: next })
    expect(noticesFor(thread.id)[0]!.notice.text).toContain('Integration tests pass.')
  }, 120_000)

  it('thread_send with notify to a thread a person started there (reach "all threads"): followed the same way, the notice naming that computer', async () => {
    standIn()
    policy.set(t.callerNode, { blocked: false, maxPermissionMode: 'accept_edits', agentReach: 'all' })
    const { thread, tool, idle } = await launcher()
    // Nobody here launched it: no remote_launches row names it.
    const theirs = t.owner.threads.createThread(`Person ${++seq}`, undefined, undefined, { started: true } as never)
    const id = qualifyId(t.node, theirs.id)
    expect(t.caller.runEngine.remoteLaunches.getByRemoteThread(t.node, theirs.id)).toBeNull()
    const sent = await tool('thread_send', { threadId: id, content: 'Please run the tests.', notify: true, clientRequestId: `theirs-${seq}` })
    expect(sent.isError, sent.text).toBeUndefined()
    expect(sent.body).toMatchObject({ threadId: id, computer: nameOf(), delivery: 'started', notify: { watchId: expect.any(String), next: NOTIFY_NEXT } })
    expect(watchRow(sent.body.notify.watchId)).toMatchObject({ state: 'active', target_node: t.node, target_thread_id: theirs.id })
    const runId = sent.body.runId as string
    running(runId)
    idle()
    finish(runId, 'All green.')
    await vi.waitFor(() => expect(noticesFor(thread.id)).toHaveLength(1), { timeout: 20_000 })
    const [{ notice }] = noticesFor(thread.id)
    expect(notice.item).toMatchObject({ watchId: sent.body.notify.watchId, threadId: id, event: 'ended', status: 'completed', runId })
    expect(notice.text).toContain(`on ${nameOf()}`)
    expect(notice.text).toContain('All green.')
    expect(watchRow(sent.body.notify.watchId)).toMatchObject({ state: 'ended', end_notice: 'sent' })
  }, 120_000)

  it('survives a restart of this daemon and a link that was down: the computer offline is never a false end', async () => {
    standIn()
    const { thread, launch, idle } = await launcher()
    const { runId, body } = await launch('Build it.', true)
    running(runId!)
    idle()
    // The link goes down, and this daemon restarts: the new service has only the watch's row.
    const versions = vi.spyOn(portOf(), 'versions').mockRejectedValue(new DomainRpcError('computer_offline', 'The other computer is offline.'))
    const fresh = restartWatches()
    expect(fresh.remote!.following()).toContain(body.notify.watchId)
    // The run ends there while nobody can ask: no notice, the watch stays, and it keeps trying.
    finish(runId!, 'Built.')
    await vi.waitFor(() => expect(versions.mock.calls.length).toBeGreaterThan(4), { timeout: 20_000 })
    expect(noticesFor(thread.id)).toHaveLength(0)
    expect(watchRow(body.notify.watchId)).toMatchObject({ state: 'active', end_notice: null })
    // The link is back.
    versions.mockRestore()
    fresh.remoteReachable()
    await vi.waitFor(() => expect(noticesFor(thread.id)).toHaveLength(1), { timeout: 20_000 })
    expect(noticesFor(thread.id)[0]!.notice.item).toMatchObject({ event: 'ended', status: 'completed', runId })
    expect(noticesFor(thread.id)[0]!.notice.text).toContain('Built.')
  }, 120_000)

  it('a computer that refuses this device ends the watch with one notice that names it', async () => {
    standIn()
    const { thread, launch, idle } = await launcher()
    const { runId, body } = await launch('Build it.', true)
    running(runId!)
    idle()
    await pause(500)
    policy.set(t.callerNode, { blocked: true })
    await vi.waitFor(() => expect(noticesFor(thread.id)).toHaveLength(1), { timeout: 30_000 })
    const { notice, held } = noticesFor(thread.id)[0]!
    expect(held).toBe(false)
    expect(notice.item).toMatchObject({ event: 'ended', status: 'unreachable' })
    expect(notice.text).toContain(`${nameOf()} refused this device`)
    expect(watchRow(body.notify.watchId)).toMatchObject({ state: 'ended', end_status: 'unreachable:computer_not_shared:blocked', end_notice: 'sent' })
    // It does not try again.
    const calls = vi.spyOn(portOf(), 'call')
    await pause(1_500)
    expect(calls).not.toHaveBeenCalled()
    expect(noticesFor(thread.id)).toHaveLength(1)
  }, 120_000)

  it('after 24 hours the watch ends with one notice that wakes nobody', async () => {
    standIn()
    const { thread, launch, idle } = await launcher()
    const { runId, body } = await launch('Build it.', true)
    running(runId!)
    idle()
    await pause(500)
    t.caller.runEngine.store.db.statement('UPDATE thread_watches SET expires_at = ? WHERE watch_id = ?').run(new Date(Date.now() - 1_000).toISOString(), body.notify.watchId)
    service().expireDue()
    expect(noticesFor(thread.id)).toHaveLength(1)
    expect(noticesFor(thread.id)[0]).toMatchObject({ held: true, notice: { item: { event: 'expired' } } })
    expect(noticesFor(thread.id)[0]!.notice.text).toContain(`had not ended when Mousse last reached ${nameOf()}`)
    expect(service().remote!.following()).not.toContain(body.notify.watchId)
    // The work ending later tells nothing more.
    finish(runId!, 'Done late.')
    await pause(1_500)
    expect(noticesFor(thread.id)).toHaveLength(1)
  }, 120_000)

  it.each([
    ['a subagent\'s thread', (threadId: string) => {
      const real = t.caller.runEngine.delegations.getLineage.bind(t.caller.runEngine.delegations)
      vi.spyOn(t.caller.runEngine.delegations, 'getLineage').mockImplementation((id) => (id === threadId ? ({ relationship: 'subagent', parentThreadId: 'parent' } as never) : real(id)))
    }]
  ])('never starts a turn in %s: the notice waits in its queue', async (_name, arrange) => {
    standIn()
    const { thread, launch, idle } = await launcher()
    const { runId } = await launch('Build it.', true)
    running(runId!)
    idle()
    arrange(thread.id)
    finish(runId!, 'Built.')
    await vi.waitFor(() => expect(noticesFor(thread.id)).toHaveLength(1), { timeout: 20_000 })
    expect(noticesFor(thread.id)[0]!.held).toBe(true)
    await pause(1_000)
    expect(t.caller.orchestrator.queueSnapshot(thread.id).items.find((item) => item.settleNotice)).toMatchObject({ heldNotice: true })
    expect(t.caller.runEngine.listRuns(thread.id, { limit: 10 }).some((run) => run.source === 'thread-notice')).toBe(false)
  }, 120_000)
})
