import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { FileLockBusyError, withAsyncFileLock } from '../src/mms/platform/asyncFileLock'
import { PROCESS_INSTANCE_ID } from '../src/mms/queue/processLiveness'
import { crashChild } from './support/build'

let childExecutable: string
beforeAll(async () => {
  childExecutable = await crashChild('tests/asyncFileLock-child.ts', { target: 'node24' })
}, 120_000)

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function lockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-async-lock-'))
  dirs.push(dir)
  return join(dir, 'nested', 'test.lock')
}

/** A pid that existed and has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''])
  return child.pid!
}

function run(lock: string, log: string, holdMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childExecutable, lock, log, String(holdMs)], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve(code) : reject(new Error(`child exited ${code}: ${stderr}`))))
  })
}

describe('withAsyncFileLock', () => {
  it('two processes never hold the lock at the same time', async () => {
    const lock = lockPath()
    const log = join(dirname(dirname(lock)), 'contention.log')
    writeFileSync(log, '')
    await Promise.all([run(lock, log, 400), run(lock, log, 400)])
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(4)
    const [first, second, third, fourth] = lines.map((line) => line.split(' '))
    expect([first[0], second[0], third[0], fourth[0]]).toEqual(['start', 'end', 'start', 'end'])
    expect(first[1]).toBe(second[1])
    expect(third[1]).toBe(fourth[1])
    expect(first[1]).not.toBe(third[1])
    expect(existsSync(lock)).toBe(false)
  }, 60_000)

  it('reclaims a lock whose owner process is dead', async () => {
    const lock = lockPath()
    await withAsyncFileLock(lock, async () => undefined, { waitMs: 0 })
    writeFileSync(lock, JSON.stringify({ pid: deadPid(), processInstanceId: 'gone', token: 'dead', acquiredAt: new Date().toISOString() }))
    expect(await withAsyncFileLock(lock, async () => 'ran', { waitMs: 0 })).toBe('ran')
    expect(existsSync(lock)).toBe(false)
  })

  it('reclaims a corrupt lock file only once it is old enough', async () => {
    const lock = lockPath()
    await withAsyncFileLock(lock, async () => undefined, { waitMs: 0 })
    writeFileSync(lock, '{not json')
    await expect(withAsyncFileLock(lock, async () => 'ran', { waitMs: 150 })).rejects.toBeInstanceOf(FileLockBusyError)
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    expect(await withAsyncFileLock(lock, async () => 'ran', { waitMs: 0 })).toBe('ran')
  })

  it('a live foreign owner makes callers wait, then fail busy', async () => {
    const lock = lockPath()
    await withAsyncFileLock(lock, async () => undefined, { waitMs: 0 })
    // The test runner's parent is alive for the whole test.
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, processInstanceId: 'other', token: 'theirs', acquiredAt: new Date().toISOString() }))
    const started = Date.now()
    await expect(withAsyncFileLock(lock, async () => 'ran', { waitMs: 300 })).rejects.toMatchObject({ name: 'FileLockBusyError', owner: { token: 'theirs' } })
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('theirs')
  })

  it('aborting while waiting rejects at once and leaves the holder alone', async () => {
    const lock = lockPath()
    let release!: () => void
    const held = withAsyncFileLock(lock, () => new Promise<string>((resolve) => (release = () => resolve('held'))), { waitMs: 0 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const controller = new AbortController()
    let ran = false
    const waiting = withAsyncFileLock(lock, async () => { ran = true }, { waitMs: 10_000, signal: controller.signal })
    controller.abort(new Error('stop waiting'))
    await expect(waiting).rejects.toThrow('stop waiting')
    release()
    expect(await held).toBe('held')
    expect(ran).toBe(false)
    expect(existsSync(lock)).toBe(false)
  })

  it('aborting while polling another process rejects at once', async () => {
    const lock = lockPath()
    await withAsyncFileLock(lock, async () => undefined, { waitMs: 0 })
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, processInstanceId: 'other', token: 'theirs', acquiredAt: new Date().toISOString() }))
    const controller = new AbortController()
    const waiting = withAsyncFileLock(lock, async () => 'ran', { waitMs: 10_000, signal: controller.signal })
    setTimeout(() => controller.abort(new Error('stop polling')), 50)
    await expect(waiting).rejects.toThrow('stop polling')
  })

  it('never deletes a lock file that carries another token', async () => {
    const lock = lockPath()
    await withAsyncFileLock(
      lock,
      async () => {
        // Something replaced our record while we held the lock.
        writeFileSync(lock, JSON.stringify({ pid: process.pid, processInstanceId: PROCESS_INSTANCE_ID, token: 'foreign', acquiredAt: new Date().toISOString() }))
      },
      { waitMs: 0 }
    )
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('foreign')
  })

  it('callers in one process run one at a time, in the order they asked', async () => {
    const lock = lockPath()
    const order: string[] = []
    let active = 0
    const task = (name: string, ms: number) =>
      withAsyncFileLock(
        lock,
        async () => {
          active++
          expect(active).toBe(1)
          order.push(`start ${name}`)
          await new Promise((resolve) => setTimeout(resolve, ms))
          order.push(`end ${name}`)
          active--
          return name
        },
        { waitMs: 5_000 }
      )
    const results = await Promise.all([task('a', 30), task('b', 5), task('c', 1)])
    expect(results).toEqual(['a', 'b', 'c'])
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
    expect(existsSync(lock)).toBe(false)
  })

  it('releases the lock when the task throws', async () => {
    const lock = lockPath()
    await expect(withAsyncFileLock(lock, async () => { throw new Error('boom') }, { waitMs: 0 })).rejects.toThrow('boom')
    expect(existsSync(lock)).toBe(false)
    expect(await withAsyncFileLock(lock, async () => 'again', { waitMs: 0 })).toBe('again')
  })

  it('a queued caller that runs out of time fails busy without running', async () => {
    const lock = lockPath()
    let release!: () => void
    const held = withAsyncFileLock(lock, () => new Promise<void>((resolve) => (release = resolve)), { waitMs: 0 })
    let ran = false
    await expect(withAsyncFileLock(lock, async () => { ran = true }, { waitMs: 50 })).rejects.toBeInstanceOf(FileLockBusyError)
    release()
    await held
    expect(ran).toBe(false)
  })
})
