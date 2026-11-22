/**
 * `mms-startup.log` takes the stdout and stderr of a daemon the app starts, for that daemon's whole life. It stays
 * bounded: an oversized file is moved aside before a start, and a running daemon stops writing at the cap.
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { rotateStartupLogSync, STARTUP_LOG_CAP_ENV } from '../src/cli/startupLog'
import { crashChild } from './support/build'

let childExecutable: string
beforeAll(async () => {
  childExecutable = await crashChild('tests/startupLog-child.ts', { target: 'node24' })
}, 120_000)

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function logPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-startup-log-'))
  dirs.push(dir)
  return join(dir, 'mms-startup.log')
}

/** Starts the stand-in daemon the way the app does: stdout and stderr appended to the log. */
async function runDaemon(path: string, env: NodeJS.ProcessEnv): Promise<void> {
  const fd = openSync(path, 'a')
  try {
    const child = spawn(process.execPath, [childExecutable], { stdio: ['ignore', fd, fd], env: { ...process.env, ...env } })
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))))
    })
  } finally {
    closeSync(fd)
  }
}

describe('the startup log', () => {
  it('stops growing at its cap while the daemon keeps logging', async () => {
    const path = logPath()
    writeFileSync(path, 'earlier start\n')
    await runDaemon(path, { [STARTUP_LOG_CAP_ENV]: '8192' })
    const text = readFileSync(path, 'utf8')
    expect(statSync(path).size).toBeLessThanOrEqual(8192)
    expect(text.startsWith('earlier start\nfirst line\n')).toBe(true)
    expect(text).toContain('reached its size cap; further output goes to logs/daemon.log only')
    expect(text).not.toContain('[heartbeat] 498 ')
  }, 30_000)

  it('is not capped for a daemon the app did not start', async () => {
    const path = logPath()
    await runDaemon(path, { [STARTUP_LOG_CAP_ENV]: undefined })
    expect(readFileSync(path, 'utf8')).toContain('[reconciler] 499 ')
  }, 30_000)

  it('is moved aside before a start once it reaches the cap, replacing the older copy', () => {
    const path = logPath()
    writeFileSync(`${path}.1`, 'oldest')
    writeFileSync(path, 'y'.repeat(2048))
    rotateStartupLogSync(path, 2048)
    expect(existsSync(path)).toBe(false)
    expect(statSync(`${path}.1`).size).toBe(2048)

    writeFileSync(path, 'small')
    rotateStartupLogSync(path, 2048)
    expect(readFileSync(path, 'utf8')).toBe('small')
  })
})
