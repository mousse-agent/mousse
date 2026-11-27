/**
 * Issue #1160: `thread_read`, `thread_wait`, `thread_send`, `thread_steer` and `thread_interrupt` on a thread this
 * computer's agent launched on another computer, and a person's Stop of the launcher reaching it, over two real daemons
 * linked by Bridge. The caller's agent calls each tool through the app-tool registry over the caller orchestrator's own
 * host, so a call goes through the handler's branch, the reach check, the routed calls (marked as the agent's where they
 * change something) and the owner's handling. The owner's turns are stood in for (no provider runs), so a run's status
 * there is what the test sets on that computer's run engine.
 *
 * Inputs listed before the cases:
 * - reading: events and messages (with textOffset), ids qualified; a thread the caller did not launch;
 * - waiting: the run ends there, it waits on a person there, an older computer without `runs.wait` (polling), nothing to
 *   wait for;
 * - messaging: a send as the agent's, its replay with the same request id, a steer into a looser run;
 * - stopping: an agent-started run, a run a person there started, a person's Stop of the launcher with the link up and
 *   with the link down (kept, delivered after a restart), the launcher deleted;
 * - the working count of thread_create's cap: a run going there, a thread idle there, a computer that cannot be asked;
 * - reachability: offline (tried twice, named), a qualified id of a thread nobody here launched, approval_respond;
 * - a subagent there: named by its id here with that computer's id, and by the id there the delegation tools give.
 * - archiving (`thread_archive`, the app's Archive): an agent's archive and unarchive of a subagent's stand-in (there
 *   first, here once that computer took it; one archived here before), its thread there still working, that computer
 *   offline or its answer lost, that computer older than the marked archive (stand-in and qualified id); a thread there
 *   by its qualified id (launched, a person's with the default reach, still working); a person's Archive of the
 *   stand-in while its task runs there, with that computer offline (sent once it answers), with it older; a parent's
 *   archive, which does not reach its subagent's thread there.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { qualifyId } from '../../../../src/shared/threadRef'
import { DomainRpcError } from '../../../../src/mms/protocol/domainRegistry'
import type { RemoteComputersPort } from '../../../../src/mms/protocol/remoteComputersPort'
import type { SqliteNodePolicy } from '../../../../src/mms/net/store/nodePolicy'
import { localized, RemoteLaunchedThreads, remoteReachRefusal } from '../../../../src/mms/orchestrator/RemoteLaunchedThreads'
import type { RemoteSubagents } from '../../../../src/mms/orchestrator/RemoteSubagents'
import type { AppToolHost } from '../../../../src/mms/run/mcp/appTools'
import { appToolRegistry, appTurn, refusalOf, type ReadRefusal } from '../../../run/appToolsFixture'
import { MousseMainService } from '../../../../src/mms/MousseMainService'
import { cleanups, cleanupAll, homeOf, linked } from './routerFixture'

type Loose = Record<string, any>
let t: Awaited<ReturnType<typeof linked>>
let policy: SqliteNodePolicy
let repo: { path: string; remote: string }
let seq = 0
/** What the owner's turns were handed. */
let turns: Array<{ input: Loose; permissionMode?: string; agent?: Loose }> = []

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim()
const folder = (): string => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'remote-tools-')))
  cleanups.push(() => rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return path
}

const portOf = (): RemoteComputersPort => (t.caller.orchestrator as unknown as { remoteComputers: RemoteComputersPort }).remoteComputers
const remoteOf = (): RemoteLaunchedThreads => (t.caller.orchestrator as unknown as { remoteThreads: RemoteLaunchedThreads }).remoteThreads
const nameOf = (): string => portOf().computers()!.find((entry) => entry.node === t.node)!.name

beforeAll(async () => {
  t = await linked()
  policy = (t.insideOwner.routes as unknown as { options: { policy: SqliteNodePolicy } }).options.policy
  const path = folder()
  git(path, 'init', '-q')
  git(path, 'commit', '-q', '--allow-empty', '-m', 'root')
  const remote = `https://example.com/acme/${Math.random().toString(36).slice(2)}.git`
  git(path, 'remote', 'add', 'origin', remote)
  repo = { path, remote }
  const copy = folder()
  git(copy, 'clone', '-q', path, '.')
  git(copy, 'remote', 'set-url', 'origin', remote)
  t.owner.projects.openProject(copy)
  t.caller.settings.set({ agentAccess: { ...t.caller.settings.get().agentAccess, remoteSubagents: true, computers: [t.node] } } as never)
}, 120_000)
afterAll(cleanupAll)
afterEach(() => {
  vi.restoreAllMocks()
  turns = []
  policy.set(t.callerNode, { maxPermissionMode: 'accept_edits', agentReach: 'launched' })
})

/** The owner's turns are stood in for: what each is handed is recorded, and its run's status is the test's to set. */
function standInForTurns(): void {
  const open = (request: (typeof turns)[number]): Promise<unknown> => {
    turns.push(request)
    return Promise.resolve({ message: '', actions: [] })
  }
  vi.spyOn(t.owner.orchestrator as unknown as Loose, 'startTurn').mockImplementation(((_session: unknown, request: Loose) =>
    open({ input: request.input, permissionMode: request.permissionMode, agent: request.agent })) as never)
  vi.spyOn(t.owner.orchestrator as unknown as Loose, 'runTurnOnSession').mockImplementation(((_session: unknown, input: Loose, _reuse: boolean, _display: boolean, opts: Loose) =>
    open({ input, permissionMode: opts.permissionMode, agent: opts.agent })) as never)
}

/** A thread on the caller with a live run in `mode`, and its agent's tools. */
async function launcher(options: { mode?: 'auto' | 'full' | 'accept_edits' | 'ask'; localOnly?: boolean } = {}) {
  const project = t.caller.projects.openProject(repo.path)
  const thread = t.caller.threads.createThread(`Launcher ${++seq}`, project.id, project.path, { permissionMode: options.mode ?? 'auto', ...(options.localOnly ? { localOnly: true } : {}) } as never)
  const sent = await t.caller.runEngine.dispatch({ kind: 'send', threadId: thread.id, clientRequestId: `launcher-send-${seq}`, source: 'gui' })
  if (sent.status !== 'accepted') throw new Error('launcher run not accepted')
  t.caller.runEngine.markStarting(sent.runId)
  t.caller.runEngine.markRunning(sent.runId)
  const mode = options.mode ?? 'auto'
  const real = t.caller.orchestrator.runPermissionMode.bind(t.caller.orchestrator)
  vi.spyOn(t.caller.orchestrator, 'runPermissionMode').mockImplementation((id) => (id === sent.runId ? mode : real(id)))
  const host = (t.caller.orchestrator as unknown as { mcpToolHost(): AppToolHost }).mcpToolHost()
  const { registry, turns: appTurns, request } = appToolRegistry(t.caller.runEngine, host)
  appTurns.register(appTurn({ threadId: thread.id, runId: sent.runId }))
  /** A refusal's `body` is the fields kept beside it with its words and how it may be retried; `text` is its words. */
  const tool = async (name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; body: Loose; text: string; refusal?: ReadRefusal }> => {
    const out = await registry.call(name, args, request({ threadId: thread.id, runId: sent.runId }))
    const refusal = refusalOf(out)
    if (refusal) return { isError: true, body: { ...refusal.details, message: refusal.message, refused: refusal.refused }, text: refusal.message, refusal }
    let body: Loose = {}
    try {
      body = JSON.parse(out.text)
    } catch {
      // A refusal in words (an argument the tool does not take).
    }
    return { ...(out.isError ? { isError: true } : {}), body, text: out.text }
  }
  /** A thread launched on the owner by this launcher's agent; its id there, and the qualified id here. */
  const launch = async (firstMessage?: string) => {
    const out = await tool('thread_create', { computer: t.node, title: `Launched ${++seq}`, ...(firstMessage ? { firstMessage } : {}), clientRequestId: `launch-${seq}` })
    if (out.isError) throw new Error(JSON.stringify(out.body))
    const far = t.caller.runEngine.remoteLaunches.listForLauncher(thread.id).at(-1)!.remoteThreadId!
    return { far, id: qualifyId(t.node, far), runId: out.body.runId as string | undefined }
  }
  return { thread, runId: sent.runId, tool, launch }
}

/** Every occurrence of the thread id `id` in `text` is qualified with the owner's node (a run id names its thread inside it). */
function expectQualified(text: string, id: string): void {
  let at = text.indexOf(id)
  while (at >= 0) {
    if (!text.slice(0, at).endsWith('run:thread:'))
      expect(text.slice(Math.max(0, at - t.node.length - 1), at), `${id} in …${text.slice(Math.max(0, at - 60), at + 40)}…`).toBe(`${t.node}:`)
    at = text.indexOf(id, at + 1)
  }
}

/** A run there that a person on the owner started, running in `mode`. */
async function personRun(farThreadId: string, mode: 'accept_edits' | 'auto' | 'full' = 'accept_edits'): Promise<string> {
  const person = await t.owner.runEngine.dispatch({ kind: 'send', threadId: farThreadId, clientRequestId: `person-${++seq}`, source: 'gui' })
  if (person.status !== 'accepted') throw new Error('not accepted')
  t.owner.runEngine.markStarting(person.runId)
  t.owner.runEngine.markRunning(person.runId)
  const real = t.owner.runEngine.bindingForRun.bind(t.owner.runEngine)
  vi.spyOn(t.owner.runEngine, 'bindingForRun').mockImplementation((id) => (id === person.runId ? ({ policy: { permissionMode: mode } } as never) : real(id)))
  return person.runId
}

/** The run there starts, as its turn would. */
function running(runId: string): void {
  t.owner.runEngine.markStarting(runId)
  t.owner.runEngine.markRunning(runId)
}

const isTerminal = (runId: string): boolean => ['completed', 'interrupted', 'failed', 'cancelled', 'uncertain'].includes(t.owner.runEngine.getRun(runId)!.status)

describe('the thread tools on a thread launched on another computer (issue #1160)', () => {
  it('reads its events and messages there, every id named the way this computer names it', async () => {
    standInForTurns()
    const { thread, tool, launch } = await launcher()
    const { far, id, runId } = await launch('Run the tests on Linux.')
    running(runId!)
    // A long row in its transcript there (the stood-in turn writes none).
    ;(t.owner.orchestrator as unknown as Loose).noteAgentLaunch(far, `Tests on Linux: ${'x'.repeat(5_000)}`)

    const events = await tool('thread_read', { threadId: id })
    expect(events.isError, JSON.stringify(events.body)).toBeUndefined()
    expect(events.body).toMatchObject({ threadId: id, computer: nameOf(), view: 'events', maxSeq: expect.any(Number) })
    expect(events.body.events.length).toBeGreaterThan(0)
    for (const event of events.body.events) expect(event.threadId).toBe(id)
    const eventText = JSON.stringify(events.body)
    expectQualified(eventText, far)
    // The launcher is this computer's own thread: wherever that computer names it, it reads as its plain id.
    expect(eventText).not.toContain(`${t.callerNode}:${thread.id}`)
    // Paging on from the last event returns nothing new.
    const later = await tool('thread_read', { threadId: id, afterSeq: events.body.nextAfterSeq })
    expect(later.body.events).toEqual([])

    const messages = await tool('thread_read', { threadId: id, view: 'messages', limit: 10 })
    expect(messages.isError, JSON.stringify(messages.body)).toBeUndefined()
    const first = messages.body.messages.find((row: Loose) => row.text.startsWith('Tests on Linux:'))
    expect(first).toMatchObject({ role: 'system', truncated: true, totalChars: 5_016, nextTextOffset: 4096 })
    expect(first.text.length).toBeLessThanOrEqual(4096)
    expect(messages.body).toMatchObject({ threadId: id, total: expect.any(Number), nextAfterIndex: expect.any(Number) })
    expectQualified(JSON.stringify(messages.body), far)
    // textOffset reads on in the long message, from where the first page cut it.
    const on = await tool('thread_read', { threadId: id, view: 'messages', afterIndex: first.index, textOffset: first.nextTextOffset, limit: 1 })
    expect(on.body.messages[0]).toMatchObject({ index: first.index, textOffset: 4096 })
    expect(on.body.messages[0].text.startsWith('x')).toBe(true)

    // The short views are read there too: what the thread is (its run going there), and its last turns, trimmed.
    const summary = await tool('thread_read', { threadId: id, view: 'summary' })
    expect(summary.isError, JSON.stringify(summary.body)).toBeUndefined()
    expect(summary.body).toMatchObject({ threadId: id, computer: nameOf(), view: 'summary', status: 'active', activeRunId: expect.any(String), messages: messages.body.total, lastCompletedAt: null })
    const recent = await tool('thread_read', { threadId: id, view: 'recent' })
    expect(recent.isError, JSON.stringify(recent.body)).toBeUndefined()
    expect(recent.body).toMatchObject({ threadId: id, view: 'recent', total: messages.body.total })
    const step = recent.body.turns.flatMap((turn: Loose) => turn.steps ?? []).find((line: string) => line.startsWith('(system) Tests on Linux:'))
    expect(step.length).toBeLessThanOrEqual(200)
  }, 120_000)

  it('waits until the run ends there, and says needsInput while it waits on a person there', async () => {
    standInForTurns()
    const { tool, launch } = await launcher()
    const { far, id, runId } = await launch('Build it.')
    running(runId!)
    // The run waits on a person there: the wait answers at once, and says so.
    const asking = vi.spyOn(t.owner.questions, 'listPendingForThread').mockImplementation((threadId) => (threadId === far ? ([{}] as never) : []))
    const waiting = await tool('thread_wait', { threadId: id, timeoutMs: 30_000 })
    expect(waiting.body).toMatchObject({ status: 'needs_input', needsInput: true, threadId: id, computer: nameOf(), run: { runId } })
    asking.mockRestore()
    // It ends there while the wait runs: the wait finishes with its outcome.
    const wait = tool('thread_wait', { threadId: id, runId, timeoutMs: 30_000 })
    await new Promise((resolve) => setTimeout(resolve, 500))
    t.owner.runEngine.markTerminal(runId!, 'completed')
    const done = await wait
    expect(done.body).toMatchObject({ status: 'finished', threadId: id, run: { runId } })
    expect(isTerminal(runId!)).toBe(true)
    // Nothing to wait for: idle.
    expect((await tool('thread_wait', { threadId: id, timeoutMs: 1_000 })).body).toMatchObject({ status: 'idle' })
  }, 120_000)

  it('on a computer without runs.wait, asks the run\'s status every few seconds instead', async () => {
    standInForTurns()
    const { tool, launch } = await launcher()
    const { id, runId } = await launch('Build it.')
    running(runId!)
    const client = t.client()
    const real = client.versions.bind(client)
    vi.spyOn(client, 'versions').mockImplementation(async (node, session) => {
      const { 'runs.wait': _wait, ...versions } = (await real(node, session)) ?? {}
      return versions
    })
    const port = portOf()
    const calls = vi.spyOn(port, 'call')
    const wait = tool('thread_wait', { threadId: id, runId, timeoutMs: 30_000 })
    await vi.waitFor(() => expect(calls.mock.calls.some(([, method]) => method === 'runs.get')).toBe(true))
    t.owner.runEngine.markTerminal(runId!, 'completed')
    expect((await wait).body).toMatchObject({ status: 'finished', run: { runId } })
    expect(calls.mock.calls.map(([, method]) => method)).not.toContain('runs.wait')
  }, 120_000)

  it('sends a message there as the agent\'s, and a replay with the same request id makes no second run', async () => {
    standInForTurns()
    const { thread, runId: launcherRun, tool, launch } = await launcher()
    const { far, id } = await launch()
    const sent = await tool('thread_send', { threadId: id, content: 'Now run the integration tests.', clientRequestId: 'send-1' })
    expect(sent.isError, JSON.stringify(sent.body)).toBeUndefined()
    expect(sent.body).toMatchObject({ threadId: id, computer: nameOf(), runId: expect.any(String), delivery: 'started', replayed: false })
    // There: the agent's run, its sender this launcher and its run here, never a person's.
    expect(t.owner.runEngine.getRun(sent.body.runId)).toMatchObject({ threadId: far, source: 'mcp', outcome: { sentByAgent: true } })
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    expect(turns[0]!.agent).toMatchObject({ kind: 'agent', from: { node: t.callerNode, thread: thread.id, run: launcherRun } })
    expect(String(turns[0]!.input.content)).toContain('Now run the integration tests.')
    // The same request id again: the first result, nothing new there.
    const again = await tool('thread_send', { threadId: id, content: 'Now run the integration tests.', clientRequestId: 'send-1' })
    expect(again.body).toMatchObject({ runId: sent.body.runId })
    expect(t.owner.runEngine.listRuns(far, { limit: 10 })).toHaveLength(1)
  }, 120_000)

  it('refuses a steer into a run there that is looser than the agent', async () => {
    standInForTurns()
    const { tool, launch } = await launcher({ mode: 'accept_edits' })
    const { far, id } = await launch()
    policy.set(t.callerNode, { maxPermissionMode: 'full' })
    const run = await personRun(far, 'full')
    expect((await tool('thread_steer', { threadId: id, runId: run, text: 'Faster.' })).refusal).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'ceiling_exceeded' } })
  }, 120_000)

  it('stops a run an agent here started there, and leaves the run of a person who took the thread over', async () => {
    standInForTurns()
    const { tool, launch } = await launcher()
    const agentWork = await launch('Build it.')
    running(agentWork.runId!)
    const stopped = await tool('thread_interrupt', { threadId: agentWork.id, runId: agentWork.runId })
    expect(stopped.isError, JSON.stringify(stopped.body)).toBeUndefined()
    expect(stopped.body).toMatchObject({ threadId: agentWork.id, runId: agentWork.runId, stopped: true })
    await vi.waitFor(() => expect(isTerminal(agentWork.runId!)).toBe(true))

    const taken = await launch()
    const person = await personRun(taken.far)
    expect((await tool('thread_interrupt', { threadId: taken.id, runId: person })).refusal).toMatchObject({ code: 'mousse_scope_denied', message: expect.stringContaining('person'), refused: { retry: 'never' } })
    expect(t.owner.runEngine.getRun(person)!.status).toBe('running')
  }, 120_000)

  it('a person\'s Stop of the launcher stops the work it started there, also when the link was down at the time', async () => {
    standInForTurns()
    const first = await launcher()
    const up = await first.launch('Build it.')
    running(up.runId!)
    await t.caller.orchestrator.stopThread(first.thread.id, 'user', { clientRequestId: `person-stop-${++seq}` })
    await vi.waitFor(() => expect(t.caller.runEngine.remoteLaunches.listForLauncher(first.thread.id)[0]!.stop).toMatchObject({ state: 'sent', reason: 'stopped' }), { timeout: 20_000 })
    expect(isTerminal(up.runId!)).toBe(true)

    // The link is down when the person stops the next launcher: the Stop is kept, and the launcher says so.
    const second = await launcher()
    const down = await second.launch('Build it too.')
    running(down.runId!)
    const port = portOf()
    vi.spyOn(port, 'versions').mockRejectedValue(new DomainRpcError('computer_offline', 'The other computer is offline.'))
    await t.caller.orchestrator.stopThread(second.thread.id, 'user', { clientRequestId: `person-stop-${++seq}` })
    const key = t.caller.runEngine.remoteLaunches.listForLauncher(second.thread.id)[0]!.creationKey
    await vi.waitFor(() => expect(t.caller.runEngine.remoteLaunches.get(key)!.stop).toMatchObject({ state: 'pending', result: expect.stringContaining('undelivered') }), { timeout: 20_000 })
    const notes = () => t.caller.orchestrator.getMessages(second.thread.id).filter((message) => message.role === 'system').map((message) => String(message.content))
    expect(notes().some((text) => text.includes('may still be going'))).toBe(true)
    expect(isTerminal(down.runId!)).toBe(false)

    // A restart: the old service is gone; a new one reads the kept Stop from the run database alone and sends it once
    // that computer answers, however long that took (issue #685: no day-long cutoff).
    remoteOf().close()
    vi.mocked(port.versions!).mockRestore()
    const fresh = new RemoteLaunchedThreads({
      records: t.caller.runEngine.remoteLaunches,
      port: () => port,
      denial: () => undefined,
      related: () => false,
      localOnly: () => false,
      note: (threadId, text) => (t.caller.orchestrator as unknown as Loose).noteAgentLaunch(threadId, text),
      now: () => Date.now() + 2 * 24 * 60 * 60_000
    })
    await fresh.pass()
    expect(t.caller.runEngine.remoteLaunches.get(key)!.stop).toMatchObject({ state: 'sent' })
    await vi.waitFor(() => expect(isTerminal(down.runId!)).toBe(true))
    expect(notes().some((text) => text.includes('The Stop reached'))).toBe(true)
    // Sent once: another pass sends nothing.
    const calls = vi.spyOn(port, 'call')
    await fresh.pass()
    expect(calls).not.toHaveBeenCalled()
    remoteOf().start()
  }, 120_000)

  it('a kept Stop is given up only once that computer is no longer one of the user\'s computers', async () => {
    standInForTurns()
    const { thread, launch } = await launcher()
    const { runId } = await launch('Build it.')
    running(runId!)
    const port = portOf()
    vi.spyOn(port, 'versions').mockRejectedValue(new DomainRpcError('computer_offline', 'The other computer is offline.'))
    await t.caller.orchestrator.stopThread(thread.id, 'user', { clientRequestId: `person-stop-${++seq}` })
    const key = t.caller.runEngine.remoteLaunches.listForLauncher(thread.id)[0]!.creationKey
    await vi.waitFor(() => expect(t.caller.runEngine.remoteLaunches.get(key)!.stop).toMatchObject({ state: 'pending' }), { timeout: 20_000 })
    remoteOf().close()
    vi.mocked(port.versions!).mockRestore()
    // That computer was removed from the device list: nothing can deliver the Stop any more.
    const listed = vi.spyOn(port, 'computers').mockReturnValue([])
    const fresh = new RemoteLaunchedThreads({
      records: t.caller.runEngine.remoteLaunches,
      port: () => port,
      denial: () => undefined,
      related: () => false,
      localOnly: () => false,
      note: (threadId, text) => (t.caller.orchestrator as unknown as Loose).noteAgentLaunch(threadId, text)
    })
    try {
      await fresh.pass()
      expect(t.caller.runEngine.remoteLaunches.get(key)!.stop).toMatchObject({ state: 'expired' })
      const notes = t.caller.orchestrator.getMessages(thread.id).filter((message) => message.role === 'system').map((message) => String(message.content))
      expect(notes.some((text) => text.includes('is no longer one of your computers'))).toBe(true)
    } finally {
      listed.mockRestore()
      // Its run there is still going; the test ends it.
      t.owner.runEngine.markTerminal(runId!, 'cancelled')
      remoteOf().start()
    }
  }, 120_000)

  it('deleting the launcher stops the work it started there and deletes nothing there', async () => {
    standInForTurns()
    const { thread, runId: launcherRun, launch } = await launcher()
    const { far, runId } = await launch('Build it.')
    running(runId!)
    // The launcher is idle when it is deleted: nothing of it runs to stop here, its work there still is.
    t.caller.runEngine.markTerminal(launcherRun, 'completed')
    // The hook the delete calls before it trashes the thread.
    await (t.caller as unknown as Loose).stopRunsForDelete([thread.id])
    await vi.waitFor(() => expect(t.caller.runEngine.remoteLaunches.listForLauncher(thread.id)[0]!.stop).toMatchObject({ state: 'sent', reason: 'deleted' }), { timeout: 20_000 })
    expect(isTerminal(runId!)).toBe(true)
    expect(t.owner.threads.getThread(far)).toBeDefined()
  }, 120_000)

  it('counts the launched threads working there for thread_create\'s cap, as that computer says', async () => {
    standInForTurns()
    const { thread, launch } = await launcher()
    const busy = await launch('Build it.')
    running(busy.runId!)
    await launch()
    // One runs there, one is idle there.
    expect(await remoteOf().working(thread.id)).toBe(1)
    // A computer that cannot be asked: its threads count as working, never as free places.
    const versions = vi.spyOn(portOf(), 'versions').mockRejectedValue(new DomainRpcError('computer_offline', 'offline'))
    expect(await remoteOf().working(thread.id)).toBe(2)
    versions.mockRestore()
    t.owner.runEngine.markTerminal(busy.runId!, 'completed')
    expect(await remoteOf().working(thread.id)).toBe(0)
  }, 120_000)

  describe('reachability: a refusal names which it is, with the computer', () => {
    it('a qualified id of a computer that is not one of the user\'s is refused, and nothing is asked', async () => {
      const { tool } = await launcher()
      const calls = vi.spyOn(portOf(), 'call')
      const out = await tool('thread_read', { threadId: qualifyId('nod_99999999999999999999999999', 'thread-x') })
      expect(out).toMatchObject({ isError: true, body: { ok: false, code: 'unknown_computer' } })
      expect(calls).not.toHaveBeenCalled()
      // No agent answers an approval on another computer.
      const own = t.thread('The owner\'s own')
      expect((await tool('approval_respond', { threadId: t.qualified(own.id), requestId: 'q-1', answers: { a: 'allow_once' } })).refusal).toMatchObject({ code: 'mousse_scope_denied' })
    }, 120_000)

    it('offline: tried once more a second later, then named offline, from this call\'s answer', async () => {
      const { tool, launch } = await launcher()
      const { id } = await launch()
      const port = portOf()
      // Listed as online: the refusal comes from the call, not from the list.
      vi.spyOn(port, 'computers').mockReturnValue([{ node: t.node, name: 'Linux box', online: true }])
      const versions = vi.spyOn(port, 'versions').mockRejectedValue(new DomainRpcError('computer_offline', 'Linux box is offline.'))
      const out = await tool('thread_read', { threadId: id })
      expect(out).toMatchObject({ isError: true, body: { ok: false, code: 'computer_offline', message: expect.stringContaining('is offline') } })
      expect(out.body.computer).toBeDefined()
      expect(versions).toHaveBeenCalledTimes(2)
    }, 120_000)

    it('not allowed: the user turned agents on that computer off since the launch', async () => {
      const { tool, launch } = await launcher()
      const { id } = await launch()
      t.caller.settings.set({ agentAccess: { ...t.caller.settings.get().agentAccess, computers: [] } } as never)
      try {
        expect((await tool('thread_read', { threadId: id })).body).toMatchObject({ code: 'computer_not_allowed' })
      } finally {
        t.caller.settings.set({ agentAccess: { ...t.caller.settings.get().agentAccess, computers: [t.node] } } as never)
      }
    }, 120_000)
  })
})

/**
 * Beyond launched threads (issue #1160, phase 4): thread_list and thread_search with computer, and the thread tools on a
 * thread of that computer this computer's agents did not launch.
 *
 * Inputs listed before the cases:
 * - who asks: an ordinary thread; a private thread; a thread another device started (one computer deep); the user's
 *   switch off, or the computer not ticked;
 * - which computer: a name from computer_list; a name that is none; offline; not sharing its threads;
 * - what is there: a thread a person started; a private thread; a thread this thread launched; many long-named threads;
 * - what that computer lets this one's agents change: threads they started (the default), all threads, nothing;
 * - what is asked there: read, send, steer, Stop (a run an agent here started, a run a person there started).
 */
describe('thread_list, thread_search and any thread of an allowed computer (issue #1160)', () => {
  /** A thread a person on the owner started, with a row in its transcript. */
  const personThread = (name: string) => {
    const thread = t.owner.threads.createThread(name, undefined, undefined, { started: true } as never)
    ;(t.owner.orchestrator as unknown as Loose).noteAgentLaunch(thread.id, `Notes of ${name}`)
    return thread
  }
  const allow = (computers: string[], on = true) =>
    t.caller.settings.set({ agentAccess: { ...t.caller.settings.get().agentAccess, remoteSubagents: on, computers } } as never)

  it('lists and searches that computer: qualified ids and links, its name, and never a private thread', async () => {
    const { tool, launch } = await launcher()
    const word = `Quarterly${++seq}`
    const shared = personThread(`${word} report`)
    const secret = t.owner.threads.createThread(`${word} secret`, undefined, undefined, { started: true, localOnly: true } as never)
    // A thread this thread launched there is listed as started by it.
    const launched = await launch()

    const list = await tool('thread_list', { computer: nameOf() })
    expect(list.isError, list.text).toBeUndefined()
    expect(list.body).toMatchObject({ computer: nameOf(), computerId: t.node })
    const row = list.body.threads.find((entry: Loose) => entry.id === t.qualified(shared.id))
    expect(row).toMatchObject({ link: `mousse://thread/${t.qualified(shared.id)}`, name: `${word} report`, computer: nameOf(), status: 'idle' })
    expect(row.startedByYou).toBeUndefined()
    expect(list.body.threads.find((entry: Loose) => entry.id === launched.id)).toMatchObject({ startedByYou: true })
    for (const entry of list.body.threads) expect(entry.id.startsWith(`${t.node}:`), entry.id).toBe(true)
    expect(list.text).not.toContain(secret.id)
    // Archived there, the launched thread leaves the default list and comes back marked with includeArchived.
    await t.owner.orchestrator.archiveThread(launched.far, true)
    expect((await tool('thread_list', { computer: nameOf() })).body.threads.map((entry: Loose) => entry.id)).not.toContain(launched.id)
    const archived = await tool('thread_list', { computer: nameOf(), includeArchived: true })
    expect(archived.body.threads.find((entry: Loose) => entry.id === launched.id)).toMatchObject({ archived: true, archivedAt: expect.any(String), startedByYou: true })

    const search =await tool('thread_search', { computer: nameOf(), query: word })
    expect(search.isError, search.text).toBeUndefined()
    expect(search.body.notSearched).toBeUndefined()
    // Its title and its transcript both match: each hit names the thread qualified, with its link and computer.
    expect(search.body.results.length).toBeGreaterThan(0)
    for (const hit of search.body.results) expect(hit).toMatchObject({ threadId: t.qualified(shared.id), link: `mousse://thread/${t.qualified(shared.id)}`, computer: nameOf() })
    expect(search.text).not.toContain(secret.id)

    // Without computer both stay on this computer.
    const here = await tool('thread_search', { query: word })
    expect(here.body.results).toEqual([])
  }, 120_000)

  it('cuts a long list at the byte cap, and says so', async () => {
    const { tool } = await launcher()
    for (let i = 0; i < 200; i++) t.owner.threads.createThread(`Long ${i} ${'n'.repeat(400)}`, undefined, undefined, { started: true } as never)
    const list = await tool('thread_list', { computer: nameOf(), limit: 500 })
    expect(list.isError, list.text.slice(0, 500)).toBeUndefined()
    expect(Buffer.byteLength(list.text, 'utf8')).toBeLessThanOrEqual(64 * 1024)
    expect(list.body).toMatchObject({ capped: true, hint: expect.stringContaining('64 KB') })
    expect(list.body.threads.length).toBeGreaterThan(10)
    expect(list.body.threads.length).toBeLessThan(200)
  }, 120_000)

  it('reads a thread a person started there', async () => {
    const { tool } = await launcher()
    const theirs = personThread(`Person ${++seq}`)
    const read = await tool('thread_read', { threadId: t.qualified(theirs.id), view: 'messages' })
    expect(read.isError, read.text).toBeUndefined()
    expect(read.body).toMatchObject({ threadId: t.qualified(theirs.id), computer: nameOf(), scope: 'computer' })
    expect(read.body.messages.some((message: Loose) => String(message.text).includes(`Notes of Person ${seq}`))).toBe(true)
  }, 120_000)

  // A page there stops at 64 KB counting from its oldest message: the last turns of a long thread still come back whole.
  it('reads the last turns of a long thread there, its newest, with prompts and answers trimmed as here', async () => {
    const { tool } = await launcher()
    const theirs = t.owner.threads.createThread(`Long ${++seq}`, undefined, undefined, { started: true } as never)
    const at = new Date().toISOString()
    const transcript = Array.from({ length: 20 }, (_, turn) => [
      { role: 'user', content: `Prompt ${turn}` },
      { role: 'assistant', content: `Step ${turn} ${'s'.repeat(4_000)}` },
      { role: 'assistant', content: `Answer ${turn} ${'a'.repeat(4_000)}` }
    ]).flat().map((message, index) => ({ id: `m${index}`, timestamp: at, ...message }))
    t.owner.threads.saveThreadData(theirs.id, { ...t.owner.threads.loadThreadData(theirs.id), messages: transcript as never })

    const recent = await tool('thread_read', { threadId: t.qualified(theirs.id), view: 'recent', turns: 2 })
    expect(recent.isError, recent.text.slice(0, 300)).toBeUndefined()
    expect(recent.body).toMatchObject({ total: 60, fromIndex: 54 })
    expect(recent.body.turns.map((turn: Loose) => [turn.prompt.text, turn.answer.index, turn.answer.cut, turn.answer.totalChars])).toEqual([
      ['Prompt 18', 56, true, transcript[56]!.content.length],
      ['Prompt 19', 59, true, transcript[59]!.content.length]
    ])
    // The answer as far as the view shows it, the step as one line marked cut.
    expect(recent.body.turns[1].answer.text.length).toBeGreaterThan(2_900)
    expect(recent.body.turns[1].steps).toEqual([expect.stringMatching(/^Step 19 s+…$/)])
    expect(recent.body.turns[1].steps[0].length).toBeLessThanOrEqual(161)
  }, 120_000)

  it('reads a turn longer than the newest messages it reads back to its prompt, its older steps counted', async () => {
    const { tool } = await launcher()
    const theirs = t.owner.threads.createThread(`Marathon ${++seq}`, undefined, undefined, { started: true } as never)
    const at = new Date().toISOString()
    const transcript = [{ role: 'user', content: 'Port the whole parser' }, ...Array.from({ length: 130 }, (_, step) => ({ role: 'assistant', content: `Step ${step}` }))]
      .map((message, index) => ({ id: `m${index}`, timestamp: at, ...message }))
    t.owner.threads.saveThreadData(theirs.id, { ...t.owner.threads.loadThreadData(theirs.id), messages: transcript as never })

    const recent = await tool('thread_read', { threadId: t.qualified(theirs.id), view: 'recent', turns: 1 })
    expect(recent.isError, recent.text.slice(0, 300)).toBeUndefined()
    expect(recent.body).toMatchObject({ total: 131, fromIndex: 0 })
    expect(recent.body.turns).toEqual([expect.objectContaining({
      prompt: expect.objectContaining({ index: 0, text: 'Port the whole parser' }),
      steps: Array.from({ length: 8 }, (_, n) => `Step ${121 + n}`),
      stepsLeftOut: 121,
      answer: expect.objectContaining({ index: 130, text: 'Step 129' })
    })])
  }, 120_000)

  // A computer there leaves out system rows with no text (tool markers): a span of them is no reason to stop reading back.
  it('reads the last turn back to its prompt across spans of system rows with no text, the newest messages among them', async () => {
    const { tool } = await launcher()
    const theirs = t.owner.threads.createThread(`Markers ${++seq}`, undefined, undefined, { started: true } as never)
    const at = new Date().toISOString()
    const markers = (count: number) => Array.from({ length: count }, () => ({ role: 'system', content: '' }))
    // The prompt and a step, 130 markers (an empty span), the answer, then 125 markers: the newest 120 hold no row.
    const transcript = [{ role: 'user', content: 'Port the whole parser' }, { role: 'assistant', content: 'Step 0' }, ...markers(130), { role: 'assistant', content: 'Ported.' }, ...markers(125)]
      .map((message, index) => ({ id: `m${index}`, timestamp: at, ...message }))
    t.owner.threads.saveThreadData(theirs.id, { ...t.owner.threads.loadThreadData(theirs.id), messages: transcript as never })

    const recent = await tool('thread_read', { threadId: t.qualified(theirs.id), view: 'recent', turns: 1 })
    expect(recent.isError, recent.text.slice(0, 300)).toBeUndefined()
    expect(recent.body).toMatchObject({ total: 258 })
    expect(recent.body.turns).toEqual([expect.objectContaining({
      prompt: expect.objectContaining({ index: 0, text: 'Port the whole parser' }),
      answer: expect.objectContaining({ index: 132, text: 'Ported.' })
    })])
  }, 120_000)

  it('with the default reach (threads they started), a send to a person\'s thread is refused by that computer, once, and says where it is changed', async () => {
    standInForTurns()
    const { tool } = await launcher()
    const theirs = personThread(`Person ${++seq}`)
    const calls = vi.spyOn(portOf(), 'call')
    const sent = await tool('thread_send', { threadId: t.qualified(theirs.id), content: 'Please run the tests.' })
    expect(sent).toMatchObject({ isError: true, body: { ok: false, code: 'outside_agent_reach', reach: 'launched', computer: nameOf() } })
    expect(sent.body.message).toMatch(/only the threads they started/)
    expect(sent.body.message).toContain('Settings → Devices')
    // Asked once, marked, and never again unmarked.
    const sends = calls.mock.calls.filter(([, method]) => method === 'orchestrator.send')
    expect(sends).toHaveLength(1)
    expect(sends[0]![2]).toHaveProperty('agent')
    expect(t.owner.runEngine.listRuns(theirs.id, { limit: 10 })).toHaveLength(0)
    expect(turns).toHaveLength(0)
  }, 120_000)

  it('with reach "all threads", the message arrives as the agent\'s; its Stop ends that run and leaves a person\'s', async () => {
    standInForTurns()
    policy.set(t.callerNode, { maxPermissionMode: 'accept_edits', agentReach: 'all' })
    const { thread, runId: launcherRun, tool } = await launcher()
    const theirs = personThread(`Person ${++seq}`)
    const sent = await tool('thread_send', { threadId: t.qualified(theirs.id), content: 'Please run the tests.', clientRequestId: `all-${seq}` })
    expect(sent.isError, sent.text).toBeUndefined()
    expect(sent.body).toMatchObject({ threadId: t.qualified(theirs.id), computer: nameOf(), delivery: 'started' })
    expect(t.owner.runEngine.getRun(sent.body.runId)).toMatchObject({ threadId: theirs.id, source: 'mcp', outcome: { sentByAgent: true } })
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    expect(turns[0]!.agent).toMatchObject({ kind: 'agent', from: { node: t.callerNode, thread: thread.id, run: launcherRun } })
    running(sent.body.runId)
    const stopped = await tool('thread_interrupt', { threadId: t.qualified(theirs.id), runId: sent.body.runId })
    expect(stopped.body).toMatchObject({ stopped: true })
    await vi.waitFor(() => expect(isTerminal(sent.body.runId)).toBe(true))

    const person = await personRun(theirs.id)
    expect((await tool('thread_interrupt', { threadId: t.qualified(theirs.id), runId: person })).refusal).toMatchObject({ code: 'mousse_scope_denied', details: { conflict: 'not_started_by_this_computer' } })
    expect(t.owner.runEngine.getRun(person)!.status).toBe('running')
  }, 120_000)

  it('with reach "nothing", no send or steer changes anything there', async () => {
    standInForTurns()
    policy.set(t.callerNode, { maxPermissionMode: 'accept_edits', agentReach: 'none' })
    const { tool } = await launcher()
    const theirs = personThread(`Person ${++seq}`)
    const person = await personRun(theirs.id)
    const sent = await tool('thread_send', { threadId: t.qualified(theirs.id), content: 'Hello.' })
    expect(sent).toMatchObject({ isError: true, body: { code: 'outside_agent_reach', reach: 'none' } })
    expect(sent.body.message).toMatch(/any thread there/)
    const steered = await tool('thread_steer', { threadId: t.qualified(theirs.id), runId: person, text: 'Faster.' })
    expect(steered).toMatchObject({ isError: true, body: { code: 'outside_agent_reach', reach: 'none' } })
    expect(t.owner.runEngine.listRuns(theirs.id, { limit: 10 }).map((run) => run.runId)).toEqual([person])
    expect(turns).toHaveLength(0)
  }, 120_000)

  it('the user\'s switch off, or the computer not ticked, refuses everything there, and nothing is asked of it', async () => {
    const { tool } = await launcher()
    const theirs = personThread(`Person ${++seq}`)
    const calls = vi.spyOn(portOf(), 'call')
    const versions = vi.spyOn(portOf(), 'versions')
    for (const settings of [() => allow([t.node], false), () => allow([])]) {
      settings()
      try {
        for (const [name, args] of [
          ['thread_list', { computer: nameOf() }],
          ['thread_search', { computer: nameOf(), query: 'Person' }],
          ['thread_read', { threadId: t.qualified(theirs.id) }],
          ['thread_wait', { threadId: t.qualified(theirs.id), timeoutMs: 1_000 }],
          ['thread_send', { threadId: t.qualified(theirs.id), content: 'hi' }],
          ['thread_steer', { threadId: t.qualified(theirs.id), runId: 'run-x', text: 'hi' }],
          ['thread_interrupt', { threadId: t.qualified(theirs.id), runId: 'run-x' }]
        ] as const) {
          const out = await tool(name, args)
          expect(out, name).toMatchObject({ isError: true, body: { code: 'computer_not_allowed', computer: nameOf() } })
        }
      } finally {
        allow([t.node])
      }
    }
    expect(calls).not.toHaveBeenCalled()
    expect(versions).not.toHaveBeenCalled()
  }, 120_000)

  it('a private thread, or one another device started, does not reach that computer', async () => {
    const secret = await launcher({ localOnly: true })
    expect((await secret.tool('thread_list', { computer: nameOf() })).body).toMatchObject({ code: 'private_thread' })
    expect((await secret.tool('thread_search', { computer: nameOf(), query: 'x' })).body).toMatchObject({ code: 'private_thread' })

    const relayed = await launcher()
    const real = (t.caller.orchestrator as unknown as Loose).startedFromAnotherDevice.bind(t.caller.orchestrator)
    vi.spyOn(t.caller.orchestrator as unknown as Loose, 'startedFromAnotherDevice').mockImplementation(((id: string) => id === relayed.thread.id || real(id)) as never)
    const theirs = personThread(`Person ${++seq}`)
    expect((await relayed.tool('thread_list', { computer: nameOf() })).body).toMatchObject({ code: 'remote_from_remote', computer: nameOf() })
    expect((await relayed.tool('thread_read', { threadId: t.qualified(theirs.id) })).body).toMatchObject({ code: 'remote_from_remote' })
  }, 120_000)

  it('a computer that is none of the user\'s is refused; one offline, slow or not sharing is refused for a list and named as not searched', async () => {
    const { tool } = await launcher()
    expect((await tool('thread_list', { computer: 'No such box' })).body).toMatchObject({ code: 'unknown_computer' })

    const port = portOf()
    const computers = vi.spyOn(port, 'computers').mockReturnValue([{ node: t.node, name: nameOf(), online: false }])
    expect((await tool('thread_list', { computer: nameOf() })).body).toMatchObject({ code: 'computer_offline', computer: nameOf() })
    const offline = await tool('thread_search', { computer: nameOf(), query: 'Person' })
    expect(offline.isError).toBeUndefined()
    expect(offline.body).toMatchObject({ results: [], notSearched: { code: 'computer_offline' } })
    computers.mockRestore()

    // A computer that does not answer: named as not searched once the search's deadline passes.
    const real = port.call.bind(port)
    const hang = vi.spyOn(port, 'call').mockImplementation(((node: string, method: string, params: Record<string, unknown>, options?: { signal?: AbortSignal }) =>
      method === 'threads.search'
        ? new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DomainRpcError('cancelled', 'cancelled')), { once: true }))
        : real(node, method, params, options)) as never)
    const slow = await tool('thread_search', { computer: nameOf(), query: 'Person' })
    expect(slow.body).toMatchObject({ results: [], notSearched: { code: 'computer_slow', message: expect.stringContaining('10 s') } })
    hang.mockRestore()

    await t.owner.net.request('bridge.workOnThreads', { enabled: false })
    try {
      expect((await tool('thread_list', { computer: nameOf() })).body).toMatchObject({ code: 'computer_not_shared', computer: nameOf() })
      expect((await tool('thread_search', { computer: nameOf(), query: 'Person' })).body).toMatchObject({ results: [], notSearched: { code: 'computer_not_shared' } })
    } finally {
      await t.owner.net.request('bridge.workOnThreads', { enabled: true })
    }
  }, 120_000)
})

describe('a subagent on another computer, named the way its parent knows it', () => {
  // Its parent knows it by its id here (delegate_task's childThreadId); its thread there has another id. Rows: that id
  // here with the computer's id (the id a parent builds), the id there that list_subagents and task_status give.
  it('reads its thread there, and list_subagents and task_status name that thread', async () => {
    standInForTurns()
    // A remote task starts no turn here: the delegation tools only need the engine to say it can record one.
    vi.spyOn(t.caller.orchestrator as unknown as { effectsEnabled(): boolean }, 'effectsEnabled').mockReturnValue(true)
    const service = (t.caller.orchestrator as unknown as { remoteSubagents: RemoteSubagents }).remoteSubagents
    service.pause()
    const { tool } = await launcher()
    const started = await tool('delegate_task', { title: `Far fixer ${++seq}`, prompt: 'Fix it there', workspace: 'isolated', computer: nameOf(), clientRequestId: `far-${seq}` })
    expect(started.isError, JSON.stringify(started.body)).toBeUndefined()
    const launched = await service.launch(started.body.delegationId)
    if (launched.ok !== true) throw new Error(JSON.stringify(launched))
    const there = qualifyId(t.node, launched.remoteThreadId)
    expect(launched.remoteThreadId).not.toBe(started.body.childThreadId)

    const read = await tool('thread_read', { threadId: qualifyId(t.node, started.body.childThreadId), view: 'summary' })
    expect(read.isError, JSON.stringify(read.body)).toBeUndefined()
    expect(read.body).toMatchObject({ threadId: there, computer: nameOf(), view: 'summary' })

    const listed = await tool('list_subagents', {})
    expect(JSON.parse(listed.text)).toEqual(expect.arrayContaining([expect.objectContaining({ childThreadId: started.body.childThreadId, computer: nameOf(), remoteThreadId: there })]))
    const status = await tool('task_status', { delegationId: started.body.delegationId })
    expect(status.body).toMatchObject({ computer: { name: nameOf(), threadId: there } })
    expect((await tool('thread_read', { threadId: there, view: 'summary' })).body).toMatchObject({ threadId: there })
  }, 120_000)
})

describe('archiving a subagent that runs on another computer, and a thread there by its qualified id', () => {
  const service = (): RemoteSubagents => (t.caller.orchestrator as unknown as { remoteSubagents: RemoteSubagents }).remoteSubagents
  const archivedThere = (farThreadId: string): boolean => Boolean(t.owner.threads.getThread(farThreadId)?.archivedAt)

  /** A launcher whose turn a person started: thread_archive needs one. */
  async function personLauncher() {
    const made = await launcher()
    const real = (t.caller.orchestrator as unknown as Loose).runHoldsPerson.bind(t.caller.orchestrator)
    vi.spyOn(t.caller.orchestrator as unknown as Loose, 'runHoldsPerson').mockImplementation(((caller: Loose) => caller.runId === made.runId || real(caller)) as never)
    return made
  }

  /** A subagent its parent started on the owner: its stand-in here, its task's run here, and its thread there. */
  async function farSubagent(tool: Awaited<ReturnType<typeof launcher>>['tool']) {
    vi.spyOn(t.caller.orchestrator as unknown as { effectsEnabled(): boolean }, 'effectsEnabled').mockReturnValue(true)
    service().pause()
    const started = await tool('delegate_task', { title: `Far worker ${++seq}`, prompt: 'Work there', workspace: 'isolated', computer: nameOf(), clientRequestId: `far-${seq}` })
    if (started.isError) throw new Error(JSON.stringify(started.body))
    const launched = await service().launch(started.body.delegationId)
    if (launched.ok !== true) throw new Error(JSON.stringify(launched))
    const childThreadId = started.body.childThreadId as string
    const task = t.caller.runEngine.remoteSubagents.listForChildThread(childThreadId)[0]!
    return { childThreadId, childRunId: task.childRunId, far: launched.remoteThreadId, farRunId: launched.remoteRunId }
  }

  /** The task ends here and the passes take its Stop there, as they do once its run there is over. */
  async function finish(sub: Awaited<ReturnType<typeof farSubagent>>): Promise<void> {
    await t.caller.runEngine.settleRemoteRun(sub.childRunId, 'completed', undefined, 'Done.')
    await service().pass()
    await vi.waitFor(async () => {
      await service().pass()
      expect(t.caller.runEngine.remoteSubagents.listForChildThread(sub.childThreadId).every((task) => task.state === 'done')).toBe(true)
      expect(t.owner.runEngine.getActiveRun(sub.far)).toBeFalsy()
    }, { timeout: 20_000 })
  }

  const archivedHere = (threadId: string): boolean => Boolean(t.caller.threads.getThread(threadId)?.archivedAt)
  const archiveCalls = (calls: { mock: { calls: unknown[][] } }): unknown[][] => calls.mock.calls.filter(([, method]) => method === 'threads.archive')
  /** That computer as one from before the marked archive. */
  function olderPeer(): void {
    const client = t.client()
    const real = client.versions.bind(client)
    vi.spyOn(client, 'versions').mockImplementation(async (node, session) => ({ ...(await real(node, session)), 'threads.archive': 1 }))
  }

  it('thread_archive of a stand-in archives its thread there first, as the agent\'s, and here only once that computer took it; archived: false brings both back', async () => {
    standInForTurns()
    const { tool } = await personLauncher()
    const sub = await farSubagent(tool)
    await finish(sub)
    const port = portOf()
    const real = port.call.bind(port)
    const hereWhenSent: boolean[] = []
    const calls = vi.spyOn(port, 'call').mockImplementation(((node: string, method: string, params: Record<string, unknown>, options?: Loose) => {
      if (method === 'threads.archive') hereWhenSent.push(archivedHere(sub.childThreadId))
      return real(node, method, params, options as never)
    }) as never)
    const archived = await tool('thread_archive', { threadId: sub.childThreadId })
    expect(archived.isError, archived.text).toBeUndefined()
    expect(archived.body).toMatchObject({ threadId: sub.childThreadId, archived: true, changed: true, computer: nameOf(), remoteThreadId: qualifyId(t.node, sub.far), changedThere: true })
    expect(archivedHere(sub.childThreadId)).toBe(true)
    expect(archivedThere(sub.far)).toBe(true)
    const sent = archiveCalls(calls)
    expect(sent).toHaveLength(1)
    expect(sent[0]![2]).toMatchObject({ threadId: sub.far, archived: true, agent: expect.objectContaining({ title: expect.any(String) }) })
    expect(sent[0]![3]).toMatchObject({ idem: expect.stringContaining('thread_archive:') })
    expect(hereWhenSent).toEqual([false])

    const back = await tool('thread_archive', { threadId: sub.childThreadId, archived: false })
    expect(back.body).toMatchObject({ archived: false, changed: true, changedThere: true })
    expect(archivedHere(sub.childThreadId)).toBe(false)
    expect(archivedThere(sub.far)).toBe(false)
    expect(hereWhenSent).toEqual([false, true])
  }, 120_000)

  it('a stand-in archived here before while its thread there stayed open: thread_archive archives it there', async () => {
    standInForTurns()
    const { tool } = await personLauncher()
    const sub = await farSubagent(tool)
    await finish(sub)
    t.caller.threads.setThreadArchived(sub.childThreadId, true)
    expect(archivedThere(sub.far)).toBe(false)
    const again = await tool('thread_archive', { threadId: sub.childThreadId })
    expect(again.isError, again.text).toBeUndefined()
    expect(again.body).toMatchObject({ archived: true, changed: false, changedThere: true })
    expect(archivedThere(sub.far)).toBe(true)
  }, 120_000)

  it('thread_archive of a stand-in whose thread there still works is refused, and nothing changes here', async () => {
    standInForTurns()
    const { tool } = await personLauncher()
    const sub = await farSubagent(tool)
    await finish(sub)
    // A person there works in it now.
    await personRun(sub.far)
    const refused = await tool('thread_archive', { threadId: sub.childThreadId })
    expect(refused).toMatchObject({ isError: true, body: { code: 'thread_running' } })
    expect(archivedHere(sub.childThreadId)).toBe(false)
    expect(archivedThere(sub.far)).toBe(false)
  }, 120_000)

  it('thread_archive of a stand-in with that computer offline, or its answer lost, changes nothing and says so', async () => {
    standInForTurns()
    const { tool } = await personLauncher()
    const sub = await farSubagent(tool)
    await finish(sub)
    const port = portOf()
    const versions = vi.spyOn(port, 'versions').mockRejectedValue(new DomainRpcError('computer_offline', 'The other computer is offline.'))
    const offline = await tool('thread_archive', { threadId: sub.childThreadId })
    expect(offline).toMatchObject({ isError: true, body: { code: 'computer_offline', computer: nameOf() } })
    expect(archivedHere(sub.childThreadId)).toBe(false)
    versions.mockRestore()

    vi.spyOn(port, 'call').mockRejectedValue(new DomainRpcError('computer_offline', 'The other computer is offline.'))
    const lost = await tool('thread_archive', { threadId: sub.childThreadId })
    expect(lost.body).toMatchObject({ ok: false, status: 'uncertain', computer: nameOf() })
    expect(archivedHere(sub.childThreadId)).toBe(false)
    expect(t.caller.runEngine.remoteArchive.get(sub.childThreadId)).toBeNull()
  }, 120_000)

  it('a computer from before the marked archive: thread_archive of a stand-in or a qualified id is refused as outdated, with no change on either side', async () => {
    standInForTurns()
    const { tool, launch } = await personLauncher()
    const sub = await farSubagent(tool)
    await finish(sub)
    const launched = await launch()
    olderPeer()
    const calls = vi.spyOn(portOf(), 'call')
    for (const [threadId, far] of [[sub.childThreadId, sub.far], [launched.id, launched.far]] as const) {
      const out = await tool('thread_archive', { threadId })
      expect(out, threadId).toMatchObject({ isError: true, body: { code: 'computer_outdated', computer: nameOf() } })
      expect(out.text).toContain('Update Mousse')
      expect(archivedThere(far)).toBe(false)
    }
    expect(archivedHere(sub.childThreadId)).toBe(false)
    // Never sent as a person's plain archive instead.
    expect(archiveCalls(calls)).toHaveLength(0)
  }, 120_000)

  it('thread_archive with a qualified id: a launched thread there is archived and unarchived; a person\'s is outside the default reach; one still working is refused', async () => {
    standInForTurns()
    const { tool, launch } = await personLauncher()
    const launched = await launch()
    const archived = await tool('thread_archive', { threadId: launched.id })
    expect(archived.isError, archived.text).toBeUndefined()
    expect(archived.body).toMatchObject({ threadId: launched.id, computer: nameOf(), archived: true, changed: true })
    expect(archivedThere(launched.far)).toBe(true)
    expect(t.owner.orchestrator.getMessages(launched.far).some((message) => String(message.content).includes('Archived by an agent in'))).toBe(true)
    expect((await tool('thread_archive', { threadId: launched.id, archived: false })).body).toMatchObject({ archived: false, changed: true })
    expect(archivedThere(launched.far)).toBe(false)

    const theirs = t.owner.threads.createThread(`Person ${++seq}`, undefined, undefined, { started: true } as never)
    const refused = await tool('thread_archive', { threadId: t.qualified(theirs.id) })
    expect(refused).toMatchObject({ isError: true, body: { code: 'outside_agent_reach', reach: 'launched' } })
    expect(archivedThere(theirs.id)).toBe(false)

    const busy = await launch('Build it.')
    running(busy.runId!)
    const working = await tool('thread_archive', { threadId: busy.id })
    expect(working).toMatchObject({ isError: true, body: { code: 'thread_running' } })
    expect(archivedThere(busy.far)).toBe(false)
  }, 120_000)

  it('a person\'s Archive of the stand-in, while its task runs there, stops it there and archives its thread there; Unarchive brings it back', async () => {
    standInForTurns()
    const { tool } = await launcher()
    const sub = await farSubagent(tool)
    running(sub.farRunId)
    await t.caller.orchestrator.archiveThread(sub.childThreadId, true)
    await vi.waitFor(async () => {
      await service().pass()
      expect(archivedThere(sub.far)).toBe(true)
    }, { timeout: 20_000 })
    expect(isTerminal(sub.farRunId)).toBe(true)
    expect(t.caller.runEngine.remoteArchive.get(sub.childThreadId)).toMatchObject({ archived: true, state: 'sent' })

    await t.caller.orchestrator.archiveThread(sub.childThreadId, false)
    await service().pass()
    expect(archivedThere(sub.far)).toBe(false)
    expect(t.caller.runEngine.remoteArchive.get(sub.childThreadId)).toMatchObject({ archived: false, state: 'sent' })
  }, 120_000)

  it('a person\'s Archive of the stand-in with that computer offline: archived here at once, and archived there once it answers', async () => {
    standInForTurns()
    const { tool } = await launcher()
    const sub = await farSubagent(tool)
    await finish(sub)
    const port = portOf()
    const versions = vi.spyOn(port, 'versions').mockRejectedValue(new DomainRpcError('computer_offline', 'The other computer is offline.'))
    const calls = vi.spyOn(port, 'call').mockRejectedValue(new DomainRpcError('computer_offline', 'The other computer is offline.'))
    await t.caller.orchestrator.archiveThread(sub.childThreadId, true)
    await service().pass()
    expect(archivedHere(sub.childThreadId)).toBe(true)
    expect(archivedThere(sub.far)).toBe(false)
    expect(t.caller.runEngine.remoteArchive.get(sub.childThreadId)).toMatchObject({ state: 'pending', lastError: expect.stringContaining('offline') })

    versions.mockRestore()
    calls.mockRestore()
    const sent = vi.spyOn(port, 'call')
    await service().pass()
    expect(archivedThere(sub.far)).toBe(true)
    expect(t.caller.runEngine.remoteArchive.get(sub.childThreadId)).toMatchObject({ state: 'sent' })
    // As an agent's archive, under the key of this change.
    expect(archiveCalls(sent)[0]![2]).toHaveProperty('agent')
    expect(archiveCalls(sent)[0]![3]).toMatchObject({ idem: `remote-archive:${sub.childThreadId}:1.0` })
  }, 120_000)

  it('a person\'s Archive of the stand-in, that computer older than the marked archive: archived here, its thread there left open and never sent unmarked', async () => {
    standInForTurns()
    const { tool } = await launcher()
    const sub = await farSubagent(tool)
    await finish(sub)
    olderPeer()
    const calls = vi.spyOn(portOf(), 'call')
    await t.caller.orchestrator.archiveThread(sub.childThreadId, true)
    await service().pass()
    await service().pass()
    expect(archivedHere(sub.childThreadId)).toBe(true)
    expect(archivedThere(sub.far)).toBe(false)
    expect(t.caller.runEngine.remoteArchive.get(sub.childThreadId)).toMatchObject({ state: 'left_open', lastError: expect.stringContaining('Update Mousse') })
    expect(archiveCalls(calls)).toHaveLength(0)
  }, 120_000)

  it('a person\'s Archive refused while its thread there still works is sent again as a new request, and archives it once the run there ended', async () => {
    standInForTurns()
    const { tool } = await launcher()
    const sub = await farSubagent(tool)
    await finish(sub)
    const busy = await personRun(sub.far)
    const calls = vi.spyOn(portOf(), 'call')
    await t.caller.orchestrator.archiveThread(sub.childThreadId, true)
    await service().pass()
    expect(archivedThere(sub.far)).toBe(false)
    expect(t.caller.runEngine.remoteArchive.get(sub.childThreadId)).toMatchObject({ state: 'pending', attempt: 1, lastError: expect.stringContaining('still working') })

    await t.owner.orchestrator.stopThread(sub.far, 'user', { clientRequestId: `person-stop-${++seq}` })
    await vi.waitFor(() => expect(isTerminal(busy)).toBe(true))
    await service().pass()
    expect(archivedThere(sub.far)).toBe(true)
    expect(t.caller.runEngine.remoteArchive.get(sub.childThreadId)).toMatchObject({ state: 'sent' })
    // That computer keeps its refusal under the first key: the second send is a request of its own.
    expect(archiveCalls(calls).map(([, , , options]) => (options as Loose).idem)).toEqual([`remote-archive:${sub.childThreadId}:1.0`, `remote-archive:${sub.childThreadId}:1.1`])
  }, 120_000)

  it('a lost answer, then a retry with the same clientRequestId: the first answer comes back, and nothing is archived there again', async () => {
    standInForTurns()
    const { tool, launch } = await personLauncher()
    const sub = await farSubagent(tool)
    await finish(sub)
    const launched = await launch()
    const port = portOf()
    const real = port.call.bind(port)
    for (const [threadId, far] of [[sub.childThreadId, sub.far], [launched.id, launched.far]] as const) {
      const lose = vi.spyOn(port, 'call').mockImplementation((async (node: string, method: string, params: Record<string, unknown>, options?: Loose) => {
        const result = await real(node, method, params, options as never)
        if (method === 'threads.archive') throw new DomainRpcError('computer_offline', 'The link dropped.')
        return result
      }) as never)
      const clientRequestId = `archive-${++seq}`
      const lost = await tool('thread_archive', { threadId, clientRequestId })
      expect(lost.body, threadId).toMatchObject({ ok: false, status: 'uncertain', computer: nameOf() })
      expect(archivedThere(far)).toBe(true)
      if (threadId === sub.childThreadId) expect(archivedHere(sub.childThreadId)).toBe(false)
      lose.mockRestore()

      // A person there unarchives it before the retry: the retry learns the first answer and archives nothing again.
      await t.owner.orchestrator.archiveThread(far, false)
      const retry = await tool('thread_archive', { threadId, clientRequestId })
      expect(retry.isError, retry.text).toBeUndefined()
      expect(retry.body, threadId).toMatchObject({ archived: true })
      expect(archivedThere(far)).toBe(false)
      if (threadId === sub.childThreadId) expect(archivedHere(sub.childThreadId)).toBe(true)
    }
  }, 120_000)

  it('a person\'s Archive on its way there while an agent unarchives the stand-in: the unarchive goes after it, and both computers end unarchived', async () => {
    standInForTurns()
    const { tool } = await personLauncher()
    const sub = await farSubagent(tool)
    await finish(sub)
    const port = portOf()
    const real = port.call.bind(port)
    let reached!: () => void
    const atGate = new Promise<void>((resolve) => (reached = resolve))
    let open!: () => void
    const gate = new Promise<void>((resolve) => (open = resolve))
    const order: boolean[] = []
    vi.spyOn(port, 'call').mockImplementation((async (node: string, method: string, params: Record<string, unknown>, options?: Loose) => {
      if (method === 'threads.archive' && params.archived === true) {
        reached()
        await gate
      }
      const result = await real(node, method, params, options as never)
      if (method === 'threads.archive') order.push(params.archived as boolean)
      return result
    }) as never)
    await t.caller.orchestrator.archiveThread(sub.childThreadId, true)
    const pass = service().pass()
    await atGate
    const unarchive = tool('thread_archive', { threadId: sub.childThreadId, archived: false })
    await new Promise((resolve) => setTimeout(resolve, 200))
    open()
    const [, out] = await Promise.all([pass, unarchive])
    expect(out.isError, out.text).toBeUndefined()
    expect(order).toEqual([true, false])
    expect(archivedHere(sub.childThreadId)).toBe(false)
    expect(archivedThere(sub.far)).toBe(false)
    expect(t.caller.runEngine.remoteArchive.get(sub.childThreadId)).toMatchObject({ archived: false, state: 'sent' })
  }, 120_000)

  it('the request for that computer is kept before the archive here: one that cannot be kept archives nothing, and one whose archive here never happened is dropped', async () => {
    standInForTurns()
    const { tool } = await launcher()
    const sub = await farSubagent(tool)
    await finish(sub)
    const want = vi.spyOn(t.caller.runEngine.remoteArchive, 'want').mockImplementation(() => {
      throw new Error('disk full')
    })
    await expect(t.caller.orchestrator.archiveThread(sub.childThreadId, true)).rejects.toThrow('disk full')
    expect(archivedHere(sub.childThreadId)).toBe(false)
    want.mockRestore()

    // The process ends between the two writes: the request is kept, the archive here never happens.
    const store = t.caller.threads
    const write = vi.spyOn(store, 'setThreadArchived').mockImplementationOnce(() => {
      throw new Error('process ended')
    })
    await expect(t.caller.orchestrator.archiveThread(sub.childThreadId, true)).rejects.toThrow('process ended')
    write.mockRestore()
    expect(t.caller.runEngine.remoteArchive.get(sub.childThreadId)).toMatchObject({ archived: true, state: 'pending' })
    const calls = vi.spyOn(portOf(), 'call')
    await service().pass()
    expect(archiveCalls(calls)).toHaveLength(0)
    expect(archivedThere(sub.far)).toBe(false)
    expect(t.caller.runEngine.remoteArchive.get(sub.childThreadId)).toMatchObject({ archived: false, state: 'sent' })
  }, 120_000)

  it('archiving a parent only stops its subagent there: its thread there stays open', async () => {
    standInForTurns()
    const { thread, tool } = await launcher()
    const sub = await farSubagent(tool)
    await finish(sub)
    await t.caller.orchestrator.archiveThread(thread.id, true)
    await service().pass()
    expect(archivedThere(sub.far)).toBe(false)
    expect(t.caller.runEngine.remoteArchive.get(sub.childThreadId)).toBeNull()
  }, 120_000)
})

describe('ids an agent here reads from another computer (issue #1160)', () => {
  // Rows: an id of that computer (already qualified by the router), one of this computer that it named, an agent sender
  // on that computer, on this one, and on a third.
  const self = 'nod_00000000000000000000000000'
  const far = 'nod_11111111111111111111111111'
  const third = 'nod_22222222222222222222222222'
  it.each([
    ['that computer\'s thread stays qualified', { threadId: `${far}:t1` }, { threadId: `${far}:t1` }],
    ['this computer\'s thread is plain again', { parentThreadId: `${self}:t2` }, { parentThreadId: 't2' }],
    ['a sender there is named by its thread there', { origin: { kind: 'agent', from: { node: far, thread: 't3', run: 'r', title: 'A' } } }, { origin: { kind: 'agent', from: { node: far, thread: `${far}:t3`, run: 'r', title: 'A' } } }],
    ['a sender here is this computer\'s own thread', { origin: { kind: 'agent', from: { node: self, thread: 't4', run: 'r', title: 'B' } } }, { origin: { kind: 'agent', from: { node: self, thread: 't4', run: 'r', title: 'B' } } }],
    ['a sender on a third computer is named by its own', { items: [{ origin: { kind: 'agent', from: { node: third, thread: 't5', run: 'r', title: 'C' } } }] }, { items: [{ origin: { kind: 'agent', from: { node: third, thread: `${third}:t5`, run: 'r', title: 'C' } } }] }]
  ])('%s', (_name, given, expected) => {
    expect(localized(given, self)).toEqual(expected)
  })
})

describe('a refusal of that computer\'s agent reach, as the agent reads it (issue #1160)', () => {
  // Rows: the reach in the refusal's details, and a computer from before that detail, which says it only in words.
  it.each([
    ['launched, in details', { reach: 'launched' }, 'Agents on that computer may change only the threads they started here.', 'launched'],
    ['none, in details', { reach: 'none' }, 'This computer does not let agents on that computer work here.', 'none'],
    ['launched, in words only', undefined, 'Agents on that computer may change only the threads they started here.', 'launched'],
    ['none, in words only', undefined, 'This computer does not let agents on that computer work here.', 'none']
  ] as const)('%s', (_name, details, message, reach) => {
    const refusal = remoteReachRefusal(new DomainRpcError('agent_reach', message, details), 'Linux box', 'the message')
    expect(refusal).toMatchObject({ code: 'outside_agent_reach', computer: 'Linux box', details: { reach } })
    expect(refusal.message).toContain(reach === 'none' ? 'any thread there' : 'only the threads they started')
    expect(refusal.message).toContain('Settings → Devices')
  })
})

// Last in this file: it restarts the caller's daemon, and no test after it uses the linked pair.
describe('the app\'s Archive of a stand-in across a real restart', () => {
  it('kept while that computer is offline, it is sent by the restarted daemon once that computer answers', async () => {
    standInForTurns()
    vi.spyOn(t.caller.orchestrator as unknown as { effectsEnabled(): boolean }, 'effectsEnabled').mockReturnValue(true)
    const service = (t.caller.orchestrator as unknown as { remoteSubagents: RemoteSubagents }).remoteSubagents
    service.pause()
    const { tool } = await launcher()
    const started = await tool('delegate_task', { title: `Far worker ${++seq}`, prompt: 'Work there', workspace: 'isolated', computer: nameOf(), clientRequestId: `far-${seq}` })
    if (started.isError) throw new Error(JSON.stringify(started.body))
    const launched = await service.launch(started.body.delegationId)
    if (launched.ok !== true) throw new Error(JSON.stringify(launched))
    const childThreadId = started.body.childThreadId as string
    const task = t.caller.runEngine.remoteSubagents.listForChildThread(childThreadId)[0]!
    await t.caller.runEngine.settleRemoteRun(task.childRunId, 'completed', undefined, 'Done.')
    await vi.waitFor(async () => {
      await service.pass()
      expect(t.caller.runEngine.remoteSubagents.listForChildThread(childThreadId).every((row) => row.state === 'done')).toBe(true)
    }, { timeout: 20_000 })

    const port = portOf()
    vi.spyOn(port, 'versions').mockRejectedValue(new DomainRpcError('computer_offline', 'The other computer is offline.'))
    vi.spyOn(port, 'call').mockRejectedValue(new DomainRpcError('computer_offline', 'The other computer is offline.'))
    await t.caller.orchestrator.archiveThread(childThreadId, true)
    await service.pass()
    expect(t.caller.runEngine.remoteArchive.get(childThreadId)).toMatchObject({ state: 'pending' })
    vi.restoreAllMocks()

    const home = homeOf.get(t.caller)!
    await t.caller.stop()
    const restarted = await MousseMainService.create({ homeDir: home, repoRoot: home, headless: true, requireOwnership: false })
    cleanups.push(() => restarted.stop())
    // The fixture's daemons run Net without the rest of a daemon's start; the restarted one does the same.
    await restarted.net.start()
    await restarted.net.request('net.unlock', { passphrase: 'bridge-router-caller' })
    ;(restarted.net as unknown as { config: { features: { netBridgeThreads: boolean } } }).config.features.netBridgeThreads = true
    expect(restarted.threads.getThread(childThreadId)?.archivedAt).toBeTruthy()
    expect(restarted.runEngine.remoteArchive.get(childThreadId)).toMatchObject({ archived: true, state: 'pending' })
    // Its own passes send it, once the link is up again.
    await vi.waitFor(() => expect(Boolean(t.owner.threads.getThread(launched.remoteThreadId)?.archivedAt)).toBe(true), { timeout: 60_000, interval: 500 })
    expect(restarted.runEngine.remoteArchive.get(childThreadId)).toMatchObject({ state: 'sent' })
  }, 180_000)
})
