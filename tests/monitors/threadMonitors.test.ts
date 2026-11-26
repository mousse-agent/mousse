/**
 * Thread monitors (issue #1605): what a thread's monitor, background command or keep_working hold tells the agent, and
 * when. The scripts and sockets here are scripted (a fake child process and a fake socket) and time is faked, so each
 * row picks exactly when lines arrive and how the thing ends. The real-process rows (a stop kills the script's tree,
 * real output reaches the notice) are in threadMonitorsProcess.test.ts.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MONITOR_BATCH_MAX_MS,
  MONITOR_BATCH_MS,
  MONITOR_CHANGE_THROTTLE_MS,
  MONITOR_CHATTY_EVENTS_PER_MINUTE,
  MONITOR_CHATTY_NOTICES_PER_MINUTE,
  MONITOR_DEFAULT_MINUTES,
  MONITOR_EVENT_CHARS,
  MONITOR_KILL_GRACE_MS,
  MONITOR_MAX_MINUTES,
  MONITOR_NOTICE_CHARS,
  MonitorInputError,
  ThreadMonitors,
  monitorUrlProblem,
  withShellPath,
  type MonitorSocket,
  type ThreadMonitorsDeps
} from '../../src/mms/monitors/ThreadMonitors'
import { ThreadRuntimeManager } from '../../src/mms/runtime/ThreadRuntimeManager'
import type { MonitorEventPayload } from '../../src/mms/run/types'

class FakeChild extends EventEmitter {
  readonly stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined })
  readonly stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined })
  pid = 4242
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  print(text: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    this[stream].emit('data', text)
  }
  exit(code: number): void {
    this.exitCode = code
    this.emit('close', code, null)
  }
}

class FakeSocket extends EventEmitter implements MonitorSocket {
  terminated = false
  terminate(): void {
    this.terminated = true
  }
}

function setup(extra: Partial<ThreadMonitorsDeps> = {}) {
  const posted: Array<{ threadId: string; payload: MonitorEventPayload; key: string }> = []
  const children: FakeChild[] = []
  const sockets: FakeSocket[] = []
  const killed: string[] = []
  /** Whether a process is still in the script's process group: on until a row says it emptied. */
  const group = { alive: true }
  const working: Array<[string, boolean]> = []
  const spawned: Array<{ command: string; cwd: unknown }> = []
  const monitors = new ThreadMonitors({
    env: () => ({ PATH: '/usr/bin' }),
    post: (threadId, payload, key) => { posted.push({ threadId, payload: structuredClone(payload), key }) },
    working: (threadId, active) => { working.push([threadId, active]) },
    spawn: (command, options) => {
      const child = new FakeChild()
      children.push(child)
      spawned.push({ command, cwd: options.cwd })
      return child as unknown as ChildProcess
    },
    connect: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    kill: (pid, signal) => { killed.push(`${pid} ${signal}`) },
    groupAlive: () => group.alive,
    platform: 'linux',
    ...extra
  })
  return { monitors, posted, children, sockets, killed, group, working, spawned }
}

const command = (threadId = 't1', extra: Record<string, unknown> = {}) => ({ threadId, description: 'CI for PR 12', command: 'gh pr checks 12 --watch', cwd: '/repo', ...extra })

describe('thread monitors', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('lines that come within the batch window are one notice; a pause starts the next one', () => {
    const { monitors, posted, children } = setup()
    monitors.startMonitor(command())
    const child = children[0]!
    child.print('build started\nstep 1 ok\n')
    vi.advanceTimersByTime(MONITOR_BATCH_MS - 50)
    // An error line on stderr, and a line split across two chunks.
    child.print('step 2 fail', 'stderr')
    child.print('ed\n', 'stderr')
    vi.advanceTimersByTime(MONITOR_BATCH_MS - 50)
    expect(posted).toEqual([])
    vi.advanceTimersByTime(60)
    expect(posted.map((entry) => entry.payload.events)).toEqual([['build started', 'step 1 ok', 'step 2 failed']])
    expect(posted[0]).toMatchObject({ threadId: 't1', payload: { kind: 'monitor_event', monitorKind: 'command', description: 'CI for PR 12', attention: 'needed' } })
    child.print('\n   \n')
    vi.advanceTimersByTime(MONITOR_BATCH_MS * 3)
    // Blank lines are no events.
    expect(posted).toHaveLength(1)
    child.print('step 3 ok\n')
    vi.advanceTimersByTime(MONITOR_BATCH_MS)
    expect(posted.map((entry) => entry.payload.events)).toEqual([['build started', 'step 1 ok', 'step 2 failed'], ['step 3 ok']])
    expect(new Set(posted.map((entry) => entry.key)).size).toBe(2)
  })

  it('a stream that never pauses is still told at the longest batch wait', () => {
    const { monitors, posted, children } = setup()
    monitors.startMonitor(command())
    for (let at = 0; at <= MONITOR_BATCH_MAX_MS; at += MONITOR_BATCH_MS / 2) {
      children[0]!.print(`tick ${at}\n`)
      vi.advanceTimersByTime(MONITOR_BATCH_MS / 2)
    }
    expect(posted).toHaveLength(1)
    expect(posted[0]!.payload.events.length).toBeGreaterThan(10)
  })

  it('cuts a long line, and counts the events a full notice leaves out', () => {
    const { monitors, posted, children } = setup()
    monitors.startMonitor(command())
    const child = children[0]!
    child.print(`${'x'.repeat(MONITOR_EVENT_CHARS * 3)}\n`)
    const lines = Math.ceil(MONITOR_NOTICE_CHARS / 100) + 5
    for (let index = 0; index < lines; index++) child.print(`${String(index).padStart(99, '-')}\n`)
    vi.advanceTimersByTime(MONITOR_BATCH_MS)
    const [notice] = posted.map((entry) => entry.payload)
    expect(notice!.events[0]!.length).toBe(MONITOR_EVENT_CHARS)
    expect(notice!.events.join('\n').length).toBeLessThanOrEqual(MONITOR_NOTICE_CHARS + MONITOR_EVENT_CHARS)
    expect(notice!.events.length + notice!.droppedEvents!).toBe(lines + 1)
    expect(notice!.droppedEvents).toBeGreaterThan(0)
  })

  /**
   * Every way a monitor, a background command or a hold ends, and the one notice it gets: how it ended, and whether it
   * wakes the thread (`needed`) or waits for its next turn (`none`). Lines it printed before the end ride with it.
   */
  const ENDINGS: Array<{ name: string; kind: 'command' | 'url' | 'background' | 'keep_working'; end: (s: ReturnType<typeof setup>, id: string) => void; reason: string; attention?: 'needed' | 'none' }> = [
    { name: 'script exits', kind: 'command', end: (s) => s.children[0]!.exit(3), reason: 'exit', attention: 'needed' },
    { name: 'script fails to start', kind: 'command', end: (s) => s.children[0]!.emit('error', new Error('spawn sh ENOENT')), reason: 'failed', attention: 'needed' },
    { name: 'socket closes', kind: 'url', end: (s) => s.sockets[0]!.emit('close', 1011, Buffer.from('server going away')), reason: 'closed', attention: 'needed' },
    { name: 'socket fails', kind: 'url', end: (s) => s.sockets[0]!.emit('error', new Error('getaddrinfo ENOTFOUND')), reason: 'failed', attention: 'needed' },
    { name: 'monitor times out', kind: 'command', end: () => vi.advanceTimersByTime(MONITOR_DEFAULT_MINUTES * 60_000), reason: 'timeout', attention: 'needed' },
    { name: 'background command exits', kind: 'background', end: (s) => s.children[0]!.exit(0), reason: 'exit', attention: 'needed' },
    { name: 'background command times out', kind: 'background', end: () => vi.advanceTimersByTime(30 * 60_000), reason: 'timeout', attention: 'needed' },
    // The agent's own background_stop: its result says so (below), no notice follows.
    { name: 'stopped by background_stop', kind: 'command', end: (s, id) => s.monitors.stop('t1', id), reason: 'none' },
    { name: 'its thread is stopped', kind: 'url', end: (s) => s.monitors.stopThread('t1'), reason: 'thread_stopped', attention: 'none' },
    { name: 'background command, its thread stopped', kind: 'background', end: (s) => s.monitors.stopThread('t1'), reason: 'thread_stopped', attention: 'none' },
    { name: 'its thread is deleted', kind: 'command', end: (s) => s.monitors.stopThread('t1', false), reason: 'none' },
    { name: 'hold times out', kind: 'keep_working', end: () => vi.advanceTimersByTime(30 * 60_000), reason: 'timeout', attention: 'needed' },
    { name: 'hold released', kind: 'keep_working', end: (s) => s.monitors.release('t1'), reason: 'none' },
    { name: 'hold, its thread stopped', kind: 'keep_working', end: (s) => s.monitors.stopThread('t1'), reason: 'none' }
  ]

  it.each(ENDINGS)('$name: one end notice ($reason)', ({ kind, end, reason, attention }) => {
    const s = setup()
    const view = kind === 'keep_working'
      ? s.monitors.keepWorking({ threadId: 't1', reason: 'waiting for a review' })
      : kind === 'url'
        ? s.monitors.startMonitor({ threadId: 't1', description: 'deploys', url: 'wss://example.test/feed' })
        : kind === 'background'
          ? s.monitors.startBackground(command())
          : s.monitors.startMonitor(command())
    if (kind === 'command') s.children[0]!.print('last words\n')
    if (kind === 'url') s.sockets[0]!.emit('message', Buffer.from('{"deploy":"started"}'), false)
    if (kind === 'background') s.children[0]!.print('compiling\nall tests passed\n')
    end(s, view.id)
    // Anything else that might still fire.
    vi.advanceTimersByTime(MONITOR_MAX_MINUTES * 60_000 * 20)
    s.children[0]?.exit(0)
    s.sockets[0]?.emit('close', 1000, Buffer.from(''))
    const ends = s.posted.filter((entry) => entry.payload.end)
    if (reason === 'none') {
      expect(ends).toEqual([])
    } else {
      expect(ends).toHaveLength(1)
      expect(ends[0]!.payload).toMatchObject({ monitorId: view.id, end: { reason }, attention })
      // Nothing is told after the end.
      expect(s.posted.at(-1)).toBe(ends[0])
      if (kind === 'command' && reason !== 'timeout') expect(s.posted.flatMap((entry) => entry.payload.events)).toContain('last words')
      if (kind === 'url') expect(s.posted.flatMap((entry) => entry.payload.events)).toContain('{"deploy":"started"}')
      if (kind === 'background') {
        expect(s.posted).toHaveLength(1)
        expect(ends[0]!.payload.tail).toContain('all tests passed')
      }
    }
    expect(s.monitors.list('t1')).toEqual([])
    // A script's process group ends with it, however it ended (what it left running included); a socket is closed.
    if (kind === 'command') expect(s.killed[0]).toBe('4242 SIGTERM')
    if (kind === 'url') expect(s.sockets[0]!.terminated).toBe(true)
  })

  it('background_stop tells nothing later: its result carries what was not reported yet, and a command\'s last output', () => {
    const s = setup()
    const monitor = s.monitors.startMonitor(command())
    const background = s.monitors.startBackground(command('t1', { description: 'build' }))
    s.children[0]!.print('unsent line\n')
    s.children[1]!.print('compiling\n')
    expect(s.monitors.stop('t1', monitor.id)).toMatchObject({ id: monitor.id, unreported: ['unsent line'] })
    expect(s.monitors.stop('t1', background.id)).toMatchObject({ id: background.id, tail: 'compiling\n' })
    vi.advanceTimersByTime(MONITOR_MAX_MINUTES * 60_000)
    expect(s.posted).toEqual([])
  })

  describe('ending a script\'s processes', () => {
    it('on macOS and Linux the group gets SIGTERM, then SIGKILL after the grace even once the script itself is gone', () => {
      const s = setup()
      const view = s.monitors.startMonitor(command())
      s.monitors.stop('t1', view.id)
      // The shell leader ended on SIGTERM; what it left in its group had not.
      s.children[0]!.signalCode = 'SIGTERM'
      vi.advanceTimersByTime(MONITOR_KILL_GRACE_MS)
      expect(s.killed).toEqual(['4242 SIGTERM', '4242 SIGKILL'])
    })

    it('on macOS and Linux no SIGKILL follows once the script is reaped and its group is empty: its id may be another process\'s by then', () => {
      const s = setup()
      const view = s.monitors.startMonitor(command())
      s.monitors.stop('t1', view.id)
      s.children[0]!.signalCode = 'SIGTERM'
      s.group.alive = false
      vi.advanceTimersByTime(MONITOR_KILL_GRACE_MS)
      expect(s.killed).toEqual(['4242 SIGTERM'])

      // Exited and reaped, with nothing left in its group: not signalled at all.
      const gone = setup()
      gone.group.alive = false
      gone.monitors.startMonitor(command())
      gone.children[0]!.exit(0)
      vi.advanceTimersByTime(MONITOR_KILL_GRACE_MS)
      expect(gone.killed).toEqual([])
    })

    it('on macOS and Linux a script that exits on its own takes what it left in its group with it', () => {
      const s = setup()
      s.monitors.startMonitor(command())
      s.children[0]!.exit(0)
      vi.advanceTimersByTime(MONITOR_KILL_GRACE_MS)
      expect(s.killed).toEqual(['4242 SIGTERM', '4242 SIGKILL'])
    })

    it('on Windows only a live tree is ended, and one that died by a signal is not killed again', () => {
      const exited = setup({ platform: 'win32' })
      exited.monitors.startMonitor(command())
      exited.children[0]!.exit(0)
      vi.advanceTimersByTime(MONITOR_KILL_GRACE_MS)
      expect(exited.killed).toEqual([])

      const signalled = setup({ platform: 'win32' })
      const view = signalled.monitors.startMonitor(command())
      signalled.monitors.stop('t1', view.id)
      signalled.children[0]!.signalCode = 'SIGTERM'
      vi.advanceTimersByTime(MONITOR_KILL_GRACE_MS)
      expect(signalled.killed).toEqual(['4242 SIGTERM'])
    })
  })

  it('a script exit carries its code; a socket close its code and reason', () => {
    const s = setup()
    s.monitors.startMonitor(command())
    s.monitors.startMonitor({ threadId: 't1', description: 'feed', url: 'wss://example.test/feed' })
    s.children[0]!.exit(3)
    s.sockets[0]!.emit('close', 1011, Buffer.from('server going away'))
    expect(s.posted.map((entry) => entry.payload.end)).toEqual([{ reason: 'exit', code: 3 }, { reason: 'closed', code: 1011, detail: 'server going away' }])
  })

  it('stops a monitor that prints too many events in a minute, and says why', () => {
    const s = setup()
    s.monitors.startMonitor(command())
    s.children[0]!.print(Array.from({ length: MONITOR_CHATTY_EVENTS_PER_MINUTE + 5 }, (_, index) => `line ${index}`).join('\n') + '\n')
    const end = s.posted.find((entry) => entry.payload.end)!
    expect(end.payload.end).toMatchObject({ reason: 'chatty' })
    expect(s.killed[0]).toBe('4242 SIGTERM')
    expect(s.monitors.list()).toEqual([])
  })

  it('stops a monitor that sends too many notices in a minute', () => {
    const s = setup()
    s.monitors.startMonitor(command())
    for (let index = 0; index <= MONITOR_CHATTY_NOTICES_PER_MINUTE; index++) {
      s.children[0]!.print(`tick ${index}\n`)
      vi.advanceTimersByTime(MONITOR_BATCH_MS + 10)
    }
    expect(s.posted.filter((entry) => !entry.payload.end)).toHaveLength(MONITOR_CHATTY_NOTICES_PER_MINUTE)
    expect(s.posted.at(-1)!.payload.end).toMatchObject({ reason: 'chatty' })
  })

  it('a quiet monitor is not chatty: the same events spread over minutes run on', () => {
    const s = setup()
    s.monitors.startMonitor(command('t1', { timeoutMinutes: 30 }))
    for (let index = 0; index < MONITOR_CHATTY_NOTICES_PER_MINUTE * 3; index++) {
      s.children[0]!.print(`tick ${index}\n`)
      vi.advanceTimersByTime(5_000)
    }
    expect(s.posted.some((entry) => entry.payload.end)).toBe(false)
  })

  it('clamps the time limit, and a retry with the same request key starts nothing new', () => {
    const s = setup()
    const first = s.monitors.startMonitor(command('t1', { timeoutMinutes: 500, requestKey: 'k1' }))
    expect(Date.parse(first.until) - Date.parse(first.startedAt)).toBe(MONITOR_MAX_MINUTES * 60_000)
    const again = s.monitors.startMonitor(command('t1', { requestKey: 'k1' }))
    expect(again).toMatchObject({ id: first.id, replayed: true })
    expect(s.children).toHaveLength(1)
  })

  it('refuses bad input before anything starts', () => {
    const s = setup()
    expect(() => s.monitors.startMonitor({ threadId: 't1', description: '', command: 'x', cwd: '/r' })).toThrow(MonitorInputError)
    expect(() => s.monitors.startMonitor({ threadId: 't1', description: 'd', command: 'x', url: 'wss://a.test', cwd: '/r' })).toThrow(/either command or url/)
    expect(() => s.monitors.startMonitor({ threadId: 't1', description: 'd', command: 'x' })).toThrow(/project folder/)
    expect(() => s.monitors.startMonitor({ threadId: 't1', description: 'd', url: 'ws://example.com/feed' })).toThrow(/ws:\/\//)
    expect(s.children).toEqual([])
    expect(s.sockets).toEqual([])
  })

  it('stops only the caller thread\'s own', () => {
    const s = setup()
    const other = s.monitors.startMonitor(command('t2'))
    expect(s.monitors.stop('t1', other.id)).toBeUndefined()
    expect(s.monitors.list('t2')).toHaveLength(1)
  })

  it('keeps the thread Working while anything of it runs, and Done once the last one ends', () => {
    const runtimes = new ThreadRuntimeManager()
    const s = setup({ working: (threadId, active) => runtimes.setPendingMonitors(threadId, active) })
    runtimes.setActivity('t1', 'completed')
    expect(runtimes.getActivity('t1')).toBe('completed')
    const monitor = s.monitors.startMonitor(command())
    const hold = s.monitors.keepWorking({ threadId: 't1', reason: 'waiting for a review', minutes: 60 })
    expect(runtimes.getActivity('t1')).toBe('waiting')
    expect(runtimes.waitsOnWork('t1')).toBe(true)
    s.monitors.stop('t1', monitor.id)
    expect(runtimes.getActivity('t1')).toBe('waiting')
    s.monitors.stop('t1', hold.id)
    expect(runtimes.getActivity('t1')).toBe('completed')
    expect(runtimes.waitsOnWork('t1')).toBe(false)
  })

  it('tells the app at once when one starts or ends, and a new latest line at most every throttle window', () => {
    const changed: string[] = []
    const s = setup({ changed: (threadId) => { changed.push(threadId) } })
    const view = s.monitors.startMonitor(command())
    expect(changed).toEqual(['t1'])
    for (let index = 0; index < 20; index++) {
      s.children[0]!.print(`line ${index}\n`)
      vi.advanceTimersByTime(100)
    }
    // 2 s of lines: one update when the window closed, none per line.
    expect(changed.length).toBeLessThanOrEqual(2)
    vi.advanceTimersByTime(MONITOR_CHANGE_THROTTLE_MS)
    const beforeEnd = changed.length
    s.monitors.stop('t1', view.id)
    expect(changed.length).toBe(beforeEnd + 1)
    // Nothing waits to be told once it has ended.
    vi.advanceTimersByTime(MONITOR_CHANGE_THROTTLE_MS * 3)
    expect(changed.length).toBe(beforeEnd + 1)
  })

  it('a Stop from the app ends it and tells the agent with its next turn', () => {
    const s = setup()
    const view = s.monitors.startMonitor(command())
    s.children[0]!.print('half done\n')
    expect(s.monitors.stopByPerson('t2', view.id)).toBeUndefined()
    expect(s.monitors.stopByPerson('t1', view.id)).toMatchObject({ id: view.id })
    expect(s.posted.map((entry) => entry.payload)).toEqual([expect.objectContaining({ events: ['half done'], end: { reason: 'stopped' }, attention: 'none' })])
    expect(s.killed[0]).toBe('4242 SIGTERM')
  })

  it('summarizes a thread\'s background work for the status row', () => {
    const s = setup()
    s.monitors.startMonitor(command())
    s.monitors.startMonitor({ threadId: 't1', description: 'feed', url: 'wss://example.test/feed' })
    s.monitors.startBackground(command('t1', { description: 'build' }))
    s.monitors.keepWorking({ threadId: 't1', reason: 'review' })
    s.children[0]!.print('first\n')
    vi.advanceTimersByTime(10)
    s.sockets[0]!.emit('message', Buffer.from('newest message'), false)
    expect(s.monitors.summary('t1')).toMatchObject({ monitors: 2, commands: 1, keepWorking: 1, latest: { line: 'newest message' } })
    expect(s.monitors.summary('t2')).toEqual({ monitors: 0, commands: 0, keepWorking: 0 })
  })
})

describe('after a restart', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mousse-monitors-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('tells each thread whose monitor or command the last run left that it ended; not a deleted thread, not a hold, and once', async () => {
    const recordFile = join(dir, 'monitors.json')
    const before = setup({ recordFile })
    const kept = before.monitors.startMonitor(command('t1'))
    const background = before.monitors.startBackground(command('t1', { description: 'build' }))
    before.monitors.startMonitor(command('gone'))
    before.monitors.keepWorking({ threadId: 't1', reason: 'review' })
    const ended = before.monitors.startMonitor(command('t1'))
    before.monitors.stop('t1', ended.id)
    await before.monitors.settled()
    before.monitors.close()

    const after = setup({ recordFile, threadExists: (threadId) => threadId !== 'gone' })
    // A monitor started before the old record was read never drops it.
    after.monitors.startMonitor(command('t3'))
    expect(await after.monitors.recoverOnBoot()).toBe(2)
    expect(after.posted.map((entry) => [entry.threadId, entry.payload.monitorId, entry.payload.end, entry.payload.attention])).toEqual([
      ['t1', kept.id, { reason: 'restart' }, 'needed'],
      ['t1', background.id, { reason: 'restart' }, 'needed']
    ])
    await after.monitors.settled()
    after.monitors.close()

    const third = setup({ recordFile, threadExists: () => true })
    await third.monitors.recoverOnBoot()
    // Only the monitor of t3, still running when the second run closed.
    expect(third.posted.map((entry) => entry.threadId)).toEqual(['t3'])
  })

  it('a monitor started just before Mousse closes is still told after the restart: a write waiting in line keeps it', async () => {
    const recordFile = join(dir, 'monitors.json')
    const before = setup({ recordFile })
    // Its write waits behind the read of the old record; close() runs before it.
    const view = before.monitors.startMonitor(command('t1'))
    before.monitors.close()
    await before.monitors.settled()
    const after = setup({ recordFile, threadExists: () => true })
    expect(await after.monitors.recoverOnBoot()).toBe(1)
    expect(after.posted[0]).toMatchObject({ threadId: 't1', payload: { monitorId: view.id, end: { reason: 'restart' } } })
  })
})

describe('withShellPath', () => {
  it('adds the login shell\'s PATH entries after the inherited ones, once each, under the name the environment uses', () => {
    expect(withShellPath({ PATH: '/usr/bin:/bin', HOME: '/h' }, ['/opt/homebrew/bin', '/usr/bin'], 'darwin')).toEqual({ PATH: '/usr/bin:/bin:/opt/homebrew/bin', HOME: '/h' })
    expect(withShellPath({ Path: 'C:\\Windows' }, ['C:\\Tools'], 'win32')).toEqual({ Path: 'C:\\Windows;C:\\Tools' })
    expect(withShellPath({}, ['/usr/local/bin'], 'linux')).toEqual({ PATH: '/usr/local/bin' })
    const env = { PATH: '/bin' }
    expect(withShellPath(env, [], 'linux')).toBe(env)
  })
})

describe('monitorUrlProblem', () => {
  it.each([
    ['wss://example.com/feed', true],
    ['wss://10.0.0.5:8443/x', true],
    ['ws://localhost:8080/ws', true],
    ['ws://127.0.0.1:9000', true],
    ['ws://[::1]:9000', true],
    ['ws://app.localhost/ws', true],
    ['ws://example.com/feed', false],
    ['ws://10.0.0.5/feed', false],
    ['ws://localhost.example.com/feed', false],
    ['https://example.com', false],
    ['file:///etc/passwd', false],
    ['not a url', false]
  ])('%s → allowed %s', (url, allowed) => {
    expect(monitorUrlProblem(url) === undefined).toBe(allowed)
  })
})
