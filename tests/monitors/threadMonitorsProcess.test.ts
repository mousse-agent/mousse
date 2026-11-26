/**
 * Thread monitors with real scripts (issue #1605): what a real shell prints reaches the notice, and stopping a thread
 * kills the monitor's whole process tree, a child it started included.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ThreadMonitors } from '../../src/mms/monitors/ThreadMonitors'
import type { MonitorEventPayload } from '../../src/mms/run/types'

const NODE = `"${process.execPath}"`

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean, label: string, ms = 10_000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('thread monitors with real scripts', () => {
  let dir: string | undefined
  let monitors: ThreadMonitors | undefined
  afterEach(() => {
    monitors?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  const start = () => {
    dir = mkdtempSync(join(tmpdir(), 'mousse-monitor-run-'))
    const posted: MonitorEventPayload[] = []
    monitors = new ThreadMonitors({ env: () => process.env, post: (_threadId, payload) => { posted.push(structuredClone(payload)) } })
    return { posted, monitors, cwd: dir }
  }

  it('a monitor\'s printed lines and its exit code reach the agent; a background command\'s output tail and code too', async () => {
    const { posted, monitors, cwd } = start()
    monitors.startMonitor({ threadId: 't1', description: 'lines', cwd, command: `${NODE} -e "console.log('first'); console.error('to stderr'); setTimeout(() => console.log('later'), 400)"` })
    monitors.startBackground({ threadId: 't1', description: 'build', cwd, command: `${NODE} -e "console.log('compiled'); console.error('1 test failed'); process.exit(2)"` })
    await until(() => posted.filter((payload) => payload.end).length === 2, 'both to end')
    const monitor = posted.filter((payload) => payload.monitorKind === 'command')
    expect(monitor.flatMap((payload) => payload.events)).toEqual(expect.arrayContaining(['first', 'to stderr', 'later']))
    expect(monitor.at(-1)!.end).toEqual({ reason: 'exit', code: 0 })
    const background = posted.filter((payload) => payload.monitorKind === 'background')
    expect(background).toHaveLength(1)
    expect(background[0]!.end).toEqual({ reason: 'exit', code: 2 })
    expect(background[0]!.tail).toContain('compiled')
    expect(background[0]!.tail).toContain('1 test failed')
  })

  it('stopping the thread kills the script and the process it started', async () => {
    const { posted, monitors, cwd } = start()
    const script = `${NODE} -e "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log('child ' + c.pid); setInterval(() => {}, 1000)"`
    const view = monitors.startMonitor({ threadId: 't1', description: 'tree', cwd, command: script })
    await until(() => posted.some((payload) => payload.events.some((line) => line.startsWith('child '))), 'the child pid')
    const childPid = Number(posted.flatMap((payload) => payload.events).find((line) => line.startsWith('child '))!.slice(6))
    expect(view.pid).toBeGreaterThan(0)
    expect(alive(view.pid!)).toBe(true)
    expect(alive(childPid)).toBe(true)
    expect(monitors.stopThread('t1')).toBe(1)
    await until(() => !alive(view.pid!) && !alive(childPid), 'the tree to die')
    expect(posted.at(-1)).toMatchObject({ end: { reason: 'thread_stopped' }, attention: 'none' })
  })
})

describe.skipIf(process.platform === 'win32')('thread monitors on macOS and Linux', () => {
  let dir: string | undefined
  let monitors: ThreadMonitors | undefined
  afterEach(() => {
    monitors?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('a script that exits leaving a process behind ends at once, and what it left ends with it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mousse-monitor-group-'))
    const posted: MonitorEventPayload[] = []
    monitors = new ThreadMonitors({ env: () => process.env, post: (_threadId, payload) => { posted.push(structuredClone(payload)) } })
    // The sleep keeps the script's output open: without the exit drain the end would wait for the timeout.
    monitors.startMonitor({ threadId: 't1', description: 'leftover', cwd: dir, command: 'sleep 300 & echo "left $!"; exit 4' })
    await until(() => posted.some((payload) => payload.end), 'the end notice', 5_000)
    const left = Number(posted.flatMap((payload) => payload.events).find((line) => line.startsWith('left '))!.slice(5))
    expect(posted.at(-1)!.end).toEqual({ reason: 'exit', code: 4 })
    await until(() => !alive(left), 'the leftover to die')
  })
})
