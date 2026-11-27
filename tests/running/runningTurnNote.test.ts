/**
 * What an agent is told of what already runs (`RunningRegistry`), at the hops between the list and the model: the
 * "Running now" section of a turn's preamble (a thread's and a bot's), the agent's own commands noted from its tool
 * calls as the transcript records them, and `running_list` through the app-tool registry, for a thread's agent and for
 * a bot under its compiled grant. The computer is a fixed process table here; reading the real one is in
 * runningRegistry.test.ts.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentRegistry } from '../../src/mms/agents/AgentRegistry'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { botManifestDigest, compileBotThread } from '../../src/mms/bots/grants/compile'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { RunningRegistry, type RunningSources, type RunningSystem, type RunningTerminal, type RunningWatcher } from '../../src/mms/running/RunningRegistry'
import type { ListeningPort, ProcessRow } from '../../src/mms/running/snapshot'
import type { StreamingLlmToolEvent } from '../../src/mms/harness/turnEvents'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'
import { PtyManager } from '../../src/mms/terminals/PtyManager'
import { WorktreeManager } from '../../src/mms/worktree/WorktreeManager'
import { botStarterManifest } from '../../src/shared/bots/personal/manifest'
import { getDefaultSettings } from '../../src/shared/settings'
import { appToolRegistry, appTurn, fakeAppToolHost } from '../run/appToolsFixture'
import { delegationFixture, type DelegationFixture } from '../run/delegationFixture'

const SELF = 100
const MINUTE = 60_000

/** A computer whose process table and ports the test sets. */
class FixedComputer {
  rows: ProcessRow[] = [{ pid: SELF, ppid: 1, pgid: SELF, tpgid: 0, command: 'mousse service' }]
  ports: ListeningPort[] = []
  folders = new Map<number, string>()
  readonly system: RunningSystem = {
    processes: async () => this.rows,
    listeners: async () => this.ports,
    workingFolders: async (pids) => new Map(pids.filter((pid) => this.folders.has(pid)).map((pid) => [pid, this.folders.get(pid)!])),
    selfPid: SELF,
    now: () => Date.now(),
    platform: 'darwin'
  }
}

type Internals = {
  getOrCreateSession(threadId: string): { projectCwd: string | null }
  registerAppTurn(session: unknown, runId: string, mode: string, continuation: boolean, bot?: unknown): { turn: unknown }
  completeAppTurn(turn: unknown, input: Record<string, unknown>): Promise<{ instructions(mcp: boolean): { turnPreamble: string } }>
  sessionAls: { run<T>(session: unknown, fn: () => T): T }
  handleStreamingToolEvent(event: StreamingLlmToolEvent): void
}

let base: string
let project: string
let files: string
let computer: FixedComputer
let terminals: RunningTerminal[]
let watchers: RunningWatcher[]
let orch: OrchestratorService
let internals: Internals
let registry: RunningRegistry

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-running-note-')))
  project = join(base, 'project')
  files = join(base, 'profile', 'bots', 'files', 'alpha')
  mkdirSync(project, { recursive: true })
  mkdirSync(files, { recursive: true })
  computer = new FixedComputer()
  terminals = []
  watchers = []
  orch = new OrchestratorService(new AgentRegistry(), new TaskQueue(), new WorktreeManager(base), new PtyManager(), { get: () => getDefaultSettings() } as never, {} as never)
  internals = orch as unknown as Internals
  const sources: RunningSources = {
    terminals: () => terminals,
    terminalOutput: () => '',
    watchers: () => watchers,
    thread: (threadId) => orch.runningSources().thread(threadId)
  }
  registry = new RunningRegistry(sources, computer.system)
  orch.setRunning(registry)
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

/** A turn's preamble as its runtime receives it, for a thread whose folder is `project`. */
const threadPreamble = async (threadId = 't1', runId = 'run-1'): Promise<string> => {
  const session = internals.getOrCreateSession(threadId)
  session.projectCwd = project
  const registered = internals.registerAppTurn(session, runId, 'agent', false)
  const app = await internals.completeAppTurn(registered.turn, { userContent: 'start the dev server and check the home page', instanceId: 'pi:x', model: 'm', approvals: 'ask' })
  return app.instructions(false).turnPreamble
}

/** A dev server a quick action started in a terminal of thread `t1`: shell 200, `npm run dev` 300, vite 301 on 5173. */
const quickActionServer = (): void => {
  computer.rows.push(
    { pid: 200, ppid: SELF, pgid: 200, tpgid: 300, command: '/bin/zsh' },
    { pid: 300, ppid: 200, pgid: 300, tpgid: 300, startedAt: Date.now() - 12 * MINUTE, command: 'npm run dev' },
    { pid: 301, ppid: 300, pgid: 300, tpgid: 300, startedAt: Date.now() - 12 * MINUTE, command: 'node node_modules/.bin/vite' }
  )
  computer.ports.push({ pid: 301, host: '::1', port: 5173 })
  terminals.push({ ptyId: 'pty-1', pid: 200, threadId: 't1', cwd: project, label: 'Dev server' })
}

describe('the turn preamble', () => {
  it('a thread\'s turn is told what runs for its folder: the name, who started it, how long it has run and its address', async () => {
    quickActionServer()
    const preamble = await threadPreamble()
    expect(preamble).toContain('## Running now')
    expect(preamble).toContain('Reuse a running server and its address instead of starting another copy')
    expect(preamble).toContain('- Dev server (`npm run dev`), started by the user with a quick action, up 12 min, at http://localhost:5173')
  })

  it('nothing runs: no section', async () => {
    // A terminal at its prompt runs nothing.
    computer.rows.push({ pid: 200, ppid: SELF, pgid: 200, tpgid: 200, command: '/bin/zsh' })
    terminals.push({ ptyId: 'pty-1', pid: 200, threadId: 't1', cwd: project })
    expect(await threadPreamble()).not.toContain('Running now')
  })

  it('a command this thread left running after its tool call is noted from the transcript and told as this thread\'s', async () => {
    const session = internals.getOrCreateSession('t1')
    session.projectCwd = project
    const call = (event: Partial<StreamingLlmToolEvent> & Pick<StreamingLlmToolEvent, 'phase'>) =>
      internals.sessionAls.run(session, () => internals.handleStreamingToolEvent({ kind: 'mcp_tool_call', callId: 'call-1', title: 'Bash', summary: 'Bash', details: [], ...event } as StreamingLlmToolEvent))
    call({ phase: 'start', activity: { toolName: 'Bash', kind: 'command', command: 'npm run dev -- --port 5180' } })
    // Its shell, started by the runtime under the service while the call ran, keeps running after the call returns.
    computer.rows.push({ pid: 500, ppid: SELF, pgid: 500, tpgid: 0, command: 'claude' },
      { pid: 510, ppid: 500, pgid: 510, tpgid: 0, startedAt: Date.now(), command: "/bin/zsh -c -l source snapshot.sh && eval 'npm run dev -- --port 5180' < /dev/null" },
      { pid: 511, ppid: 510, pgid: 510, tpgid: 0, startedAt: Date.now(), command: 'node vite --port 5180' })
    computer.ports.push({ pid: 511, host: '127.0.0.1', port: 5180 })
    // While its call runs it is the turn's own foreground command, not something left running.
    expect(await threadPreamble('t1', 'run-a')).not.toContain('Running now')
    call({ phase: 'complete', response: 'Command running in background with ID: b1' })
    expect(await threadPreamble('t1', 'run-b')).toContain('- `npm run dev -- --port 5180`, started by this thread, up under a minute, at http://localhost:5180')
  })

  it('a bot\'s turn is told of its background command, in its files folder', async () => {
    orch.setBotAppTools({ bots: {} as never, memory: { activationOf: () => ({ botId: 'alpha', activationId: 'act-1', lane: 'chat', memoryLane: 'chat', role: 'home' }) } as never })
    computer.rows.push({ pid: 400, ppid: SELF, pgid: 400, tpgid: 0, startedAt: Date.now() - 3 * MINUTE, command: '/bin/sh -c python3 -m http.server 8000' })
    computer.ports.push({ pid: 400, host: '0.0.0.0', port: 8000 })
    watchers.push({ id: 'rem_1', botId: 'alpha', title: 'Preview', command: 'python3 -m http.server 8000', pid: 400, cwd: files, startedAt: Date.now() - 3 * MINUTE, output: '' })
    // A dev server in a project's terminal is not in the bot's folders.
    quickActionServer()
    const authority = { skills: new Set<string>(), appTools: new Set<string>(), time: { signal: new AbortController().signal }, workspace: { roots: [files], access: 'write', scratch: join(base, 'scratch'), files } }
    const registered = internals.registerAppTurn(internals.getOrCreateSession('bot-home'), 'run-bot', 'agent', false, { authority, skills: [] })
    const app = await internals.completeAppTurn(registered.turn, { userContent: 'go', instanceId: 'pi:x', model: 'm', approvals: 'never', botInstructions: 'You are Alpha.' })
    const preamble = app.instructions(false).turnPreamble
    expect(preamble).toContain('- Preview (`python3 -m http.server 8000`), started by you (watch_start), up 3 min, at http://localhost:8000')
    expect(preamble).not.toContain('Dev server')
    // A bot's person is its owner.
    expect(preamble).toContain('restart one only when your owner asks')
    expect(preamble).not.toContain('the user')
  })
})

describe('who started an agent\'s background command', () => {
  it('two threads of different projects that run the same command at once each get the process in their own folder', async () => {
    const other = join(base, 'other')
    mkdirSync(other, { recursive: true })
    const started = Date.now()
    // Listed in pid order: the first thread's server comes first, and both started inside both calls' time.
    computer.rows.push(
      { pid: 610, ppid: SELF, pgid: 610, tpgid: 0, startedAt: started, command: '/bin/zsh -c npm run dev' },
      { pid: 620, ppid: SELF, pgid: 620, tpgid: 0, startedAt: started, command: '/bin/zsh -c npm run dev' }
    )
    computer.folders.set(610, project).set(620, other)
    registry.noteCommand({ threadId: 't-a', callId: 'a', command: 'npm run dev', folder: project, ended: true })
    // The second thread's call comes a moment later.
    await new Promise((done) => setTimeout(done, 20))
    registry.noteCommand({ threadId: 't-b', callId: 'b', command: 'npm run dev', folder: other, ended: true })
    expect((await registry.list({ threadId: 't-a', folders: [project] })).map((entry) => [entry.pid, entry.startedBy])).toEqual([[610, { kind: 'thread', threadId: 't-a' }]])
    expect((await registry.list({ threadId: 't-b', folders: [other] })).map((entry) => [entry.pid, entry.startedBy])).toEqual([[620, { kind: 'thread', threadId: 't-b' }]])
  })
})

describe('running_list', () => {
  let fx: DelegationFixture | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
  })

  it('a thread\'s agent and its subagent can call it, and get the current list', async () => {
    fx = delegationFixture()
    const run = await fx.runningRun('t1')
    const seen: string[] = []
    const fake = fakeAppToolHost({ running: async (turn) => { seen.push(turn.threadId); return 'LIST-7781' } })
    const { registry: tools, turns, request } = appToolRegistry(fx.engine, fake.host)
    turns.register(appTurn({ threadId: 't1', runId: run.runId }))
    expect(tools.listForThread('t1', run.runId).map((tool) => tool.name)).toContain('running_list')
    expect(await tools.call('running_list', {}, request({ threadId: 't1', runId: run.runId }))).toMatchObject({ text: 'LIST-7781' })
    const child = await fx.runningRun('t1-child')
    turns.register(appTurn({ threadId: 't1-child', runId: child.runId, subagent: true }))
    expect(await tools.call('running_list', {}, request({ threadId: 't1-child', runId: child.runId }))).toMatchObject({ text: 'LIST-7781' })
    expect(seen).toEqual(['t1', 't1-child'])
  })

  it('a bot\'s subagent and consult hold it too', () => {
    const profile = join(base, 'profile')
    const scratch = join(profile, 'bots', 'scratch', 'act-2')
    mkdirSync(scratch, { recursive: true })
    const grant = botStarterManifest()
    for (const botTools of [{ subagent: true }, undefined]) {
      const compiled = compileBotThread({
        grant, digest: botManifestDigest(grant), thread: {}, scratch, profileHome: profile, filesFolder: files,
        nativeNames: (names) => ({ ok: true, names: [...names] }), remaining: { deadlineMs: 600_000 },
        ...(botTools ? { botTools } : {})
      })
      if (!compiled.ok) throw new Error(compiled.error.message)
      expect(compiled.permissions.appTools).toContain('running_list')
      expect(compiled.policy.tools!.allow).toContain('running_list')
    }
  })

  it.each([
    ['a chat turn', { frontDesk: true }],
    ['work', {}]
  ])('a bot holds it in %s without asking for it, and its call runs', async (_name, botTools) => {
    fx = delegationFixture()
    const profile = join(base, 'profile')
    const scratch = join(profile, 'bots', 'scratch', 'act-1')
    mkdirSync(scratch, { recursive: true })
    const grant = botStarterManifest()
    const compiled = compileBotThread({
      grant, digest: botManifestDigest(grant), thread: {}, scratch, profileHome: profile, filesFolder: files,
      nativeNames: (names) => ({ ok: true, names: [...names] }), remaining: { deadlineMs: 600_000 },
      botTools: { escalate: true, consult: false, memory: true, ...botTools }
    })
    if (!compiled.ok) throw new Error(compiled.error.message)
    expect(compiled.permissions.appTools).toContain('running_list')
    const authority = createBotAuthority({
      activationId: 'act-1', role: 'activation', permissions: compiled.permissions, waiting: () => false,
      counters: { charge: () => ({ ok: true, count: 1 }) }, time: { deadline: () => 0, signal: new AbortController().signal }, spend: null
    })
    const home = await fx.runningRun('home')
    const fake = fakeAppToolHost({ running: async () => 'LIST-2290', botRole: (id) => (id === 'home' ? 'activation' : undefined) })
    const { registry: tools, turns, request } = appToolRegistry(fx.engine, fake.host)
    turns.register(appTurn({ threadId: 'home', runId: home.runId, bot: authority, approvals: 'never' }))
    expect(tools.listForThread('home', home.runId).map((tool) => tool.name)).toContain('running_list')
    expect(await tools.call('running_list', {}, request({ threadId: 'home', runId: home.runId }))).toMatchObject({ text: 'LIST-2290' })
  })

  it('the orchestrator\'s tool host answers with the list for the caller\'s folder', async () => {
    quickActionServer()
    const session = internals.getOrCreateSession('t1')
    session.projectCwd = project
    const registered = internals.registerAppTurn(session, 'run-1', 'agent', false) as { turn: Parameters<NonNullable<ReturnType<OrchestratorService['mcpToolHost']>['running']>>[0] }
    const text = await orch.mcpToolHost().running!(registered.turn)
    expect(text).toMatch(/^Running now for your folder\./)
    expect(text).toContain('- Dev server (`npm run dev`), started by the user with a quick action, up 12 min, at http://localhost:5173, pid 300')
    computer.rows = computer.rows.filter((row) => row.pid < 300)
    expect(await orch.mcpToolHost().running!(registered.turn)).toMatch(/^Nothing Mousse can see is running for your folder/)
  })
})
