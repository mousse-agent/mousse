/**
 * A main thread held for seconds leaves `[warn:stall]` lines in the log that name where it was held: written while
 * the stall still lasts, so a service ended for it keeps them, and closed by a line with how long it lasted.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startDaemonStallWatch } from '../src/cli/daemonStallWatch'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

function logFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-stall-watch-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'logs', 'daemon.log')
}

function watch(log: string, resampleMs = 10_000): void {
  const stallWatch = startDaemonStallWatch({ logPath: log, thresholdMs: 300, resampleMs, heartbeatMs: 50, pollMs: 25 })
  expect(stallWatch).not.toBeNull()
  cleanup.push(() => stallWatch?.stop())
}

const read = (log: string): string => { try { return readFileSync(log, 'utf8') } catch { return '' } }
const stallLines = (log: string): string[] => read(log).split('\n').filter((line) => line.includes('[warn:stall]'))
const fields = (line: string): { stack: string[]; pauseMs: number; busyMs?: number } => JSON.parse(line.slice(line.indexOf('{')))
/** The closing line's stall length and the main thread's CPU time in it, in milliseconds. */
function closing(lines: string[]): { heldMs: number; busyMs: number } {
  const line = lines.find((entry) => entry.includes('main thread was held'))
  expect(line).toBeDefined()
  const heldMs = Number(/was held ([\d.]+) s/.exec(line!)![1]) * 1000
  return { heldMs, busyMs: fields(line!).busyMs! }
}

async function eventually(log: string, found: (lines: string[]) => boolean): Promise<string[]> {
  const until = Date.now() + 10_000
  while (Date.now() < until) {
    if (found(stallLines(log))) return stallLines(log)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return stallLines(log)
}

/** Holds the main thread in JavaScript until the log has what is waited for: nothing on this thread could write it. */
function holdInLoop(log: string, until: (line: string) => boolean): string[] {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    if (stallLines(log).some(until)) break
  }
  return stallLines(log)
}

/**
 * Holds the main thread in one synchronous call into Node, which no pause interrupts, then reads its result, as the
 * service's synchronous Git and file calls do.
 */
function waitInSyncCall(): number {
  const result = spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: 'ignore' })
  return exitStatus(result)
}

function exitStatus(result: ReturnType<typeof spawnSync>): number {
  return result.status ?? -1
}

describe('the daemon stall watch', () => {
  it('logs the function holding the main thread while it is held, then how long the stall lasted and that it was busy', async () => {
    const log = logFile()
    watch(log)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(stallLines(log)).toEqual([])

    const whileHeld = holdInLoop(log, (line) => line.includes('holdInLoop'))
    const sample = whileHeld.find((line) => line.includes('main thread held'))
    expect(sample).toBeDefined()
    expect(fields(sample!).stack.some((frame) => frame.startsWith('holdInLoop '))).toBe(true)

    const lines = await eventually(log, (all) => all.some((line) => line.includes('main thread was held')))
    const { heldMs, busyMs } = closing(lines)
    expect(busyMs).toBeGreaterThan(heldMs / 2)
  })

  it('reads the stack again while the stall lasts', () => {
    const log = logFile()
    watch(log, 300)
    const whileHeld = holdInLoop(log, (line) => line.includes('"sample":2'))
    const samples = whileHeld.filter((line) => line.includes('"stack"')).map(fields)
    expect(samples).toHaveLength(2)
    for (const sample of samples) expect(sample.stack.some((frame) => frame.startsWith('holdInLoop '))).toBe(true)
  })

  it('says a synchronous call holds the thread while it lasts, names its caller once it returns, and that it waited', async () => {
    const log = logFile()
    watch(log, 400)
    await new Promise((resolve) => setTimeout(resolve, 200))
    waitInSyncCall()

    const lines = await eventually(log, (all) => all.some((line) => line.includes('was held')))
    expect(lines.some((line) => line.includes('a synchronous call'))).toBe(true)
    const sample = lines.find((line) => line.includes('"stack"'))
    expect(sample).toBeDefined()
    expect(fields(sample!).stack.some((frame) => frame.startsWith('waitInSyncCall '))).toBe(true)
    expect(fields(sample!).pauseMs).toBeGreaterThan(500)
    const { heldMs, busyMs } = closing(lines)
    expect(busyMs).toBeLessThan(heldMs / 2)
  })
})
