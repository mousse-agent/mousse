/**
 * One background job service under a thread's monitors (`ThreadMonitors`) and a bot's background commands
 * (`BotWatchers`), as the profile wires it. The children are scripted and time is faked, so each row picks when output
 * arrives and how a job ends; the real-process rows (environment, the bot's chat slot, restart) are in
 * backgroundJobsProcess.test.ts.
 *
 * Rows: a thread's streaming monitor (batches), a thread's background command (stop tail), a bot's command (match,
 * kept output, retention per owner, stop), each beside the others on the same service; a command without an environment;
 * a bot job asking to hold its owner; how each owner's command ends when it exits by itself (output after the exit,
 * what it left in its group); which process ids are signalled on macOS and Linux; kept output dropped on time with
 * nothing read, and on close with no timer left.
 */
import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackgroundJobService, ENDED_JOB_KEEP_MS, MAX_ENDED_JOBS_PER_OWNER, MONITOR_BATCH_MS } from '../../src/mms/background/BackgroundJobService'
import { MonitorInputError, ThreadMonitors } from '../../src/mms/monitors/ThreadMonitors'
import { BotWatchers, type WatcherEnd, type WatcherSpec } from '../../src/mms/bots/watchers'
import { terminalPage } from '../../src/mms/terminals/terminalText'
import type { MonitorEventPayload } from '../../src/mms/run/types'

class FakeChild extends EventEmitter {
  readonly stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined })
  readonly stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined })
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  constructor(readonly pid: number) { super() }
  print(text: string): void { this.stdout.emit('data', text) }
  exit(code: number): void {
    this.exited(code)
    this.closed()
  }
  /** The shell exits (and is reaped); something it left may still hold its output. */
  exited(code: number): void {
    this.exitCode = code
    this.emit('exit', code, null)
  }
  /** Its output closes. */
  closed(): void {
    this.emit('close', this.exitCode, null)
  }
}

function setup() {
  const children: FakeChild[] = []
  const spawned: Array<{ command: string; options: SpawnOptions }> = []
  const killed: string[] = []
  /** Whether a process is still in the command's process group (what it left running). */
  const group = { alive: true }
  const jobs = new BackgroundJobService({
    spawn: (command, options) => {
      const child = new FakeChild(1000 + children.length)
      children.push(child)
      spawned.push({ command, options })
      return child as unknown as ChildProcess
    },
    kill: (pid, signal) => { killed.push(`${pid} ${signal}`) },
    groupAlive: () => group.alive,
    platform: 'linux'
  })
  const posted: Array<{ threadId: string; payload: MonitorEventPayload }> = []
  const working: Array<[string, boolean]> = []
  const threadEnv = { PATH: '/usr/bin', THREAD_ONLY: '1' }
  const monitors = new ThreadMonitors({ jobs, env: () => threadEnv, post: (threadId, payload) => { posted.push({ threadId, payload: structuredClone(payload) }) }, working: (threadId, active) => { working.push([threadId, active]) } })
  const ends: Array<{ id: string; end: WatcherEnd; tail: string }> = []
  const watchers = new BotWatchers({ jobs, onEnd: (spec, end, tail) => { ends.push({ id: spec.id, end, tail }) } })
  const watcher = (id: string, extra: Partial<WatcherSpec> = {}): WatcherSpec => ({ id, botId: 'bot1', title: `Build ${id}`, command: `make ${id}`, limitMs: 60 * 60_000, cwd: '/bots/bot1/files', env: { PATH: '/bin', BOT_ONLY: '1' }, ...extra })
  return { jobs, children, spawned, killed, group, posted, working, monitors, watchers, ends, watcher }
}

describe('a thread\'s monitors and a bot\'s commands on one service', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('each runs with its own caller\'s environment, and neither sees the other\'s jobs', () => {
    const s = setup()
    const monitor = s.monitors.startMonitor({ threadId: 't1', description: 'CI', command: 'gh pr checks --watch', cwd: '/repo' })
    s.watchers.start(s.watcher('rem_1'))
    expect(s.spawned.map((entry) => entry.options.env)).toEqual([{ PATH: '/usr/bin', THREAD_ONLY: '1' }, { PATH: '/bin', BOT_ONLY: '1' }])
    expect(s.monitors.list().map((view) => view.id)).toEqual([monitor.id])
    expect(s.watchers.list().map((view) => view.id)).toEqual(['rem_1'])
    // Stopping the thread ends its monitor only; the bot's command runs on.
    s.monitors.stopThread('t1')
    expect(s.watchers.has('rem_1')).toBe(true)
    // Closing the bots ends theirs only.
    const again = s.monitors.startMonitor({ threadId: 't1', description: 'CI again', command: 'gh pr checks --watch', cwd: '/repo' })
    s.watchers.close()
    expect(s.watchers.list()).toEqual([])
    expect(s.monitors.list().map((view) => view.id)).toEqual([again.id])
  })

  it('a thread\'s monitor sends its lines in batches while a bot\'s command beside it matches a line and ends', () => {
    const s = setup()
    s.monitors.startMonitor({ threadId: 't1', description: 'CI', command: 'tail -f ci.log', cwd: '/repo' })
    s.watchers.start(s.watcher('rem_1', { match: 'build (passed|failed)' }))
    const [monitor, command] = s.children
    monitor!.print('one\ntwo\n')
    command!.print('step 1\nbuild passed in 12s\nnever read\n')
    vi.advanceTimersByTime(MONITOR_BATCH_MS)
    expect(s.posted.map((entry) => entry.payload.events)).toEqual([['one', 'two']])
    expect(s.ends).toEqual([{ id: 'rem_1', end: { kind: 'match', line: 'build passed in 12s' }, tail: 'step 1\nbuild passed in 12s\nnever read\n' }])
    expect(s.killed).toContain(`${command!.pid} SIGTERM`)
    // The monitor runs on, and keeps its thread Working.
    expect(s.monitors.has('t1')).toBe(true)
    expect(s.working).toEqual([['t1', true]])
  })

  it('a thread\'s background_stop gets the stop tail; a bot\'s stop ends it as stopped, with its own tail', () => {
    const s = setup()
    const background = s.monitors.startBackground({ threadId: 't1', description: 'build', command: 'npm run build', cwd: '/repo' })
    s.watchers.start(s.watcher('rem_1'))
    s.children[0]!.print('compiling\n')
    s.children[1]!.print('waiting\n')
    expect(s.monitors.stop('t1', background.id)).toMatchObject({ id: background.id, tail: 'compiling\n' })
    expect(s.watchers.stop('rem_1')).toBe(true)
    expect(s.ends).toEqual([{ id: 'rem_1', end: { kind: 'stopped' }, tail: 'waiting\n' }])
    expect(s.posted).toEqual([])
    expect(s.working.at(-1)).toEqual(['t1', false])
  })

  it('a bot\'s command\'s output stays readable after it ends, paged, for six hours and the last five of each owner', () => {
    const s = setup()
    s.watchers.start(s.watcher('rem_long'))
    s.children[0]!.print(Array.from({ length: 300 }, (_, n) => `line ${n + 1}`).join('\n') + '\n')
    s.children[0]!.exit(2)
    const kept = s.watchers.output('bot1', 'rem_long')!
    expect(kept.end).toEqual({ kind: 'exit', code: 2 })
    const page = terminalPage(kept.output, { lines: 10, droppedLines: kept.droppedLines })
    expect(page).toMatchObject({ fromLine: 291, toLine: 300, lastLine: 300 })
    expect(terminalPage(kept.output, { lines: 5, before: page.fromLine, droppedLines: kept.droppedLines }).text).toBe('line 286\nline 287\nline 288\nline 289\nline 290')
    // Another bot reads nothing of it.
    expect(s.watchers.output('bot2', 'rem_long')).toBeUndefined()
    // A thread's jobs ending don't push the bot's out: retention counts per owner.
    for (let n = 0; n < MAX_ENDED_JOBS_PER_OWNER + 2; n++) {
      const view = s.monitors.startBackground({ threadId: 't1', description: `build ${n}`, command: 'make', cwd: '/repo' })
      s.monitors.stop('t1', view.id)
    }
    expect(s.watchers.output('bot1', 'rem_long')).toBeDefined()
    // The bot's own later ones do, past five.
    for (let n = 0; n < MAX_ENDED_JOBS_PER_OWNER - 1; n++) {
      s.watchers.start(s.watcher(`rem_${n}`))
      s.watchers.stop(`rem_${n}`)
    }
    expect(s.watchers.output('bot1', 'rem_long')).toBeDefined()
    s.watchers.start(s.watcher('rem_last'))
    s.watchers.stop('rem_last')
    expect(s.watchers.output('bot1', 'rem_long')).toBeUndefined()
    // And after six hours, none is kept.
    vi.advanceTimersByTime(ENDED_JOB_KEEP_MS)
    expect(s.watchers.output('bot1', 'rem_last')).toBeUndefined()
  })
})

describe('what the service refuses', () => {
  it('a command with no environment: nothing starts, and nothing falls back to this process\'s', () => {
    const s = setup()
    const bare = new ThreadMonitors({ jobs: s.jobs, post: () => undefined } as unknown as ConstructorParameters<typeof ThreadMonitors>[0])
    expect(() => bare.startBackground({ threadId: 't1', description: 'build', command: 'make', cwd: '/repo' })).toThrow(MonitorInputError)
    expect(() => bare.startMonitor({ threadId: 't1', description: 'CI', command: 'tail -f x', cwd: '/repo' })).toThrow(/environment/)
    expect(() => s.watchers.start({ ...s.watcher('rem_1'), env: undefined as unknown as NodeJS.ProcessEnv })).toThrow(/environment/)
    expect(s.spawned).toEqual([])
    expect(bare.list()).toEqual([])
    expect(s.watchers.list()).toEqual([])
    // A hold runs nothing, so it needs none.
    expect(bare.keepWorking({ threadId: 't1', reason: 'waiting on CI' })).toMatchObject({ kind: 'keep_working' })
  })

  it('a bot\'s job that would hold its owner: a bot\'s chat has one slot, so its commands are always detached', () => {
    const s = setup()
    expect(() => s.jobs.start({ owner: { kind: 'bot', botId: 'bot1' }, kind: 'watcher', label: 'x', command: 'make', cwd: '/b', env: {}, limitMs: 60_000, holdsOwner: true, sink: { end: () => undefined } })).toThrow(/never holds its chat/)
    expect(s.spawned).toEqual([])
    s.watchers.start(s.watcher('rem_1'))
    expect(s.jobs.holds({ kind: 'bot', botId: 'bot1' })).toBe(false)
  })
})

describe('a command that exits by itself', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /**
   * Who started it, and how it ended, against what happens to its group (on macOS and Linux) and to output that comes
   * after the shell exits. A thread's command ends 1 s after its exit and takes its leftovers with it; a bot's waits for
   * its output to close and leaves a daemon it started running.
   */
  const ROWS: Array<{ name: string; owner: 'thread' | 'bot'; end: 'exits' | 'stopped'; killed: string[] }> = [
    { name: 'a thread\'s command exits: what it left in its group ends', owner: 'thread', end: 'exits', killed: ['1000 SIGTERM', '1000 SIGKILL'] },
    { name: 'a bot\'s command exits: a daemon it left running keeps running', owner: 'bot', end: 'exits', killed: [] },
    { name: 'a thread\'s command is stopped: its group ends', owner: 'thread', end: 'stopped', killed: ['1000 SIGTERM', '1000 SIGKILL'] },
    { name: 'a bot\'s command is stopped: its group ends', owner: 'bot', end: 'stopped', killed: ['1000 SIGTERM', '1000 SIGKILL'] }
  ]

  it.each(ROWS)('$name', ({ owner, end, killed }) => {
    const s = setup()
    const thread = owner === 'thread' ? s.monitors.startBackground({ threadId: 't1', description: 'deploy', command: 'start-server &', cwd: '/repo' }) : undefined
    if (owner === 'bot') s.watchers.start(s.watcher('rem_1'))
    if (end === 'exits') s.children[0]!.exit(0)
    else if (thread) s.monitors.stop('t1', thread.id)
    else s.watchers.stop('rem_1')
    vi.advanceTimersByTime(10_000)
    expect(s.killed).toEqual(killed)
  })

  it('a bot\'s command whose child prints the result after the shell exited: the end and its kept output carry it', () => {
    const s = setup()
    s.watchers.start(s.watcher('rem_1'))
    s.children[0]!.print('started\n')
    s.children[0]!.exited(0)
    vi.advanceTimersByTime(5_000)
    expect(s.ends).toEqual([])
    s.children[0]!.print('result: 42 passed\n')
    s.children[0]!.closed()
    expect(s.ends).toEqual([{ id: 'rem_1', end: { kind: 'exit', code: 0 }, tail: 'started\nresult: 42 passed\n' }])
    expect(s.watchers.output('bot1', 'rem_1')?.output).toContain('result: 42 passed')
  })

  it('a thread\'s command whose child prints after the shell exited: it ends a second after the exit, as before', () => {
    const s = setup()
    const view = s.monitors.startBackground({ threadId: 't1', description: 'build', command: 'make &', cwd: '/repo' })
    s.children[0]!.exited(0)
    vi.advanceTimersByTime(1_000)
    expect(s.posted.at(-1)?.payload).toMatchObject({ monitorId: view.id, end: { reason: 'exit', code: 0 } })
  })
})

describe('which processes are signalled on macOS and Linux', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('only the group, never the bare process id; and no SIGKILL once the command is reaped and its group is empty', () => {
    const signals: Array<[number, NodeJS.Signals | number | undefined]> = []
    let groupLeft = true
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      signals.push([pid, signal])
      if (signal === 0 && !groupLeft) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
      return true
    }) as typeof process.kill)
    const children: FakeChild[] = []
    const jobs = new BackgroundJobService({ spawn: () => { const child = new FakeChild(4242); children.push(child); return child as unknown as ChildProcess }, platform: 'linux' })
    const start = (id: string) => jobs.start({ id, owner: { kind: 'thread', threadId: 't1' }, kind: 'background', label: 'x', command: 'make', cwd: '/r', env: {}, limitMs: 60_000, sink: { end: () => undefined } })

    // Stopped while running: the group gets SIGTERM, and SIGKILL after the grace while something is still in it.
    start('a')
    jobs.stop({ kind: 'thread', threadId: 't1' }, 'a')
    children[0]!.signalCode = 'SIGTERM'
    vi.advanceTimersByTime(10_000)
    expect(signals.filter(([, signal]) => signal !== 0)).toEqual([[-4242, 'SIGTERM'], [-4242, 'SIGKILL']])

    // Stopped, then its whole group gone within the grace: no SIGKILL, since its id may be another's by then.
    signals.length = 0
    start('b')
    jobs.stop({ kind: 'thread', threadId: 't1' }, 'b')
    children[1]!.signalCode = 'SIGTERM'
    groupLeft = false
    vi.advanceTimersByTime(10_000)
    expect(signals.filter(([, signal]) => signal !== 0)).toEqual([[-4242, 'SIGTERM']])
    expect(signals.every(([pid]) => pid < 0)).toBe(true)
  })
})

describe('kept output of ended jobs', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('goes when its six hours are up, with nothing ending or read meanwhile', () => {
    const s = setup()
    s.watchers.start(s.watcher('rem_1'))
    s.children[0]!.print('x'.repeat(10_000))
    s.children[0]!.exit(0)
    expect(s.jobs.keptOutput()).toEqual({ jobs: 1, chars: 10_000 })
    vi.advanceTimersByTime(ENDED_JOB_KEEP_MS - 60_000)
    expect(s.jobs.keptOutput().jobs).toBe(1)
    vi.advanceTimersByTime(60_000)
    expect(s.jobs.keptOutput()).toEqual({ jobs: 0, chars: 0 })
  })

  it('goes with the profile as it closes, and no timer is left holding the service', () => {
    const s = setup()
    s.watchers.start(s.watcher('rem_1'))
    s.children[0]!.print('built\n')
    s.children[0]!.exit(0)
    s.monitors.startBackground({ threadId: 't1', description: 'build', command: 'make', cwd: '/work' })
    s.children[1]!.print('done\n')
    s.children[1]!.exit(0)
    vi.advanceTimersByTime(10_000)
    expect(s.jobs.keptOutput().jobs).toBe(2)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    // The profile closes: its bots' commands, then its threads' monitors.
    s.watchers.close()
    expect(s.jobs.keptOutput().jobs).toBe(1)
    s.monitors.close()
    expect(s.jobs.keptOutput()).toEqual({ jobs: 0, chars: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })
})
