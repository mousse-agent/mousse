/**
 * One background job service under a thread's monitors (`ThreadMonitors`) and a bot's background commands
 * (`BotWatchers`), as the profile wires it. The children are scripted and time is faked, so each row picks when output
 * arrives and how a job ends; the real-process rows (environment, the bot's chat slot, restart) are in
 * backgroundJobsProcess.test.ts.
 *
 * Rows: a thread's streaming monitor (batches), a thread's background command (stop tail), a bot's command (match,
 * kept output, retention per owner, stop), each beside the others on the same service; a command without an environment;
 * a bot job asking to hold its owner.
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
    this.exitCode = code
    this.emit('close', code, null)
  }
}

function setup() {
  const children: FakeChild[] = []
  const spawned: Array<{ command: string; options: SpawnOptions }> = []
  const killed: string[] = []
  const jobs = new BackgroundJobService({
    spawn: (command, options) => {
      const child = new FakeChild(1000 + children.length)
      children.push(child)
      spawned.push({ command, options })
      return child as unknown as ChildProcess
    },
    kill: (pid, signal) => { killed.push(`${pid} ${signal}`) },
    platform: 'linux'
  })
  const posted: Array<{ threadId: string; payload: MonitorEventPayload }> = []
  const working: Array<[string, boolean]> = []
  const threadEnv = { PATH: '/usr/bin', THREAD_ONLY: '1' }
  const monitors = new ThreadMonitors({ jobs, env: () => threadEnv, post: (threadId, payload) => { posted.push({ threadId, payload: structuredClone(payload) }) }, working: (threadId, active) => { working.push([threadId, active]) } })
  const ends: Array<{ id: string; end: WatcherEnd; tail: string }> = []
  const watchers = new BotWatchers({ jobs, onEnd: (spec, end, tail) => { ends.push({ id: spec.id, end, tail }) } })
  const watcher = (id: string, extra: Partial<WatcherSpec> = {}): WatcherSpec => ({ id, botId: 'bot1', title: `Build ${id}`, command: `make ${id}`, limitMs: 60 * 60_000, cwd: '/bots/bot1/files', env: { PATH: '/bin', BOT_ONLY: '1' }, ...extra })
  return { jobs, children, spawned, killed, posted, working, monitors, watchers, ends, watcher }
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
