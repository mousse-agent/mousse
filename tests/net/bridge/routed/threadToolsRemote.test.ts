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
 * - reachability: offline (tried twice, named), a qualified id of a thread nobody here launched, approval_respond.
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
import { localized, RemoteLaunchedThreads } from '../../../../src/mms/orchestrator/RemoteLaunchedThreads'
import type { AppToolHost } from '../../../../src/mms/run/mcp/appTools'
import { appToolRegistry, appTurn } from '../../../run/appToolsFixture'
import { cleanups, cleanupAll, linked } from './routerFixture'

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
async function launcher(options: { mode?: 'auto' | 'full' | 'accept_edits' | 'ask' } = {}) {
  const project = t.caller.projects.openProject(repo.path)
  const thread = t.caller.threads.createThread(`Launcher ${++seq}`, project.id, project.path, { permissionMode: options.mode ?? 'auto' } as never)
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
  const tool = async (name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; body: Loose; text: string }> => {
    const out = await registry.call(name, args, request({ threadId: thread.id, runId: sent.runId }))
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
    await expect(tool('thread_steer', { threadId: id, runId: run, text: 'Faster.' })).rejects.toMatchObject({ code: 'mousse_conflict', details: { conflict: 'ceiling_exceeded' } })
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
    await expect(tool('thread_interrupt', { threadId: taken.id, runId: person })).rejects.toMatchObject({ code: 'mousse_scope_denied', message: expect.stringContaining('person') })
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
    // that computer answers.
    remoteOf().close()
    vi.mocked(port.versions!).mockRestore()
    const fresh = new RemoteLaunchedThreads({
      records: t.caller.runEngine.remoteLaunches,
      port: () => port,
      denial: () => undefined,
      related: () => false,
      localOnly: () => false,
      note: (threadId, text) => (t.caller.orchestrator as unknown as Loose).noteAgentLaunch(threadId, text)
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
    it('a thread this thread did not launch there is refused, and nothing is asked of that computer', async () => {
      const { launch } = await launcher()
      const { id } = await launch()
      const other = await launcher()
      const calls = vi.spyOn(portOf(), 'call')
      const read = await other.tool('thread_read', { threadId: id })
      expect(read).toMatchObject({ isError: true, body: { ok: false, code: 'not_launched_here', computer: nameOf() } })
      // A thread a person there started, which no agent here launched.
      const own = t.thread('The owner\'s own')
      for (const [name, args] of [
        ['thread_read', {}],
        ['thread_wait', {}],
        ['thread_send', { content: 'hi' }],
        ['thread_steer', { runId: 'run-x', text: 'hi' }],
        ['thread_interrupt', { runId: 'run-x' }]
      ] as const) {
        const out = await other.tool(name, { threadId: t.qualified(own.id), ...args })
        expect(out, name).toMatchObject({ isError: true, body: { code: 'not_launched_here' } })
      }
      expect(calls).not.toHaveBeenCalled()
      // No agent answers an approval on another computer.
      await expect(other.tool('approval_respond', { threadId: id, requestId: 'q-1', answers: { a: 'allow_once' } })).rejects.toMatchObject({ code: 'mousse_scope_denied' })
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
