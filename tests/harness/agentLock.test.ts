/**
 * The per-agent install lock across processes (agent CLIs plan §4, F16): while another process
 * holds it, a caller waits; once that process dies (killed, never releasing anything), the caller
 * proceeds. There is no stale holder to detect, so no takeover can remove a live holder's lock.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LockBusyError, withLock } from '../../src/mms/harness/agents/lock'

const children: ChildProcess[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
  await new Promise((resolve) => setTimeout(resolve, 50))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Another process that takes the lock the way `withLock` does, says so, and keeps it until killed. */
function holder(lock: string): Promise<ChildProcess> {
  const script = `
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(process.argv[1])
    db.exec('BEGIN IMMEDIATE')
    process.stdout.write('held\\n')
    setInterval(() => {}, 1000)
  `
  const child = spawn(process.execPath, ['-e', script, lock], { stdio: ['ignore', 'pipe', 'inherit'] })
  children.push(child)
  return new Promise((resolve, reject) => {
    child.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('held')) resolve(child)
    })
    child.once('exit', (code) => reject(new Error(`holder exited with ${code}`)))
  })
}

describe('the agent install lock across processes', () => {
  it('waits while another process holds it, and proceeds once that process is killed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-agent-lock-'))
    dirs.push(dir)
    const lock = join(dir, 'demo-agent', 'lock.db')
    await withLock(lock, () => undefined)
    const other = await holder(lock)
    await expect(withLock(lock, () => 'never', { timeoutMs: 300, pollMs: 25 })).rejects.toBeInstanceOf(LockBusyError)
    let entered = false
    const waiting = withLock(lock, () => {
      entered = true
      return 'after'
    }, { timeoutMs: 15_000, pollMs: 25 })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(entered).toBe(false)
    // Killed outright: it releases nothing itself; the OS ends its lock.
    other.kill('SIGKILL')
    await expect(waiting).resolves.toBe('after')
  })
})
