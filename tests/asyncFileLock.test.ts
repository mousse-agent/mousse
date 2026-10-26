import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FileLockBusyError, releaseForTests, setReclaimDepthForTests, setReclaimHookForTests, tryAcquireOnceForTests, withAsyncFileLock } from '../src/mms/platform/asyncFileLock'
import { PROCESS_INSTANCE_ID } from '../src/mms/queue/processLiveness'
import { crashChild } from './support/build'

// Lets a test make the next exclusive creates fail the way Windows does for a delete-pending file.
const fsControl = vi.hoisted(() => ({ failOpen: [] as string[] }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const code = args[1] === 'wx' ? fsControl.failOpen.shift() : undefined
      if (code) throw Object.assign(new Error(`simulated ${code}`), { code })
      return actual.openSync(...args)
    }
  }
})

let childExecutable: string
beforeAll(async () => {
  childExecutable = await crashChild('tests/asyncFileLock-child.ts', { target: 'node24' })
}, 120_000)

const dirs: string[] = []
afterEach(() => {
  setReclaimHookForTests(null)
  fsControl.failOpen = []
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function lockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-async-lock-'))
  dirs.push(dir)
  return join(dir, 'nested', 'test.lock')
}

/** The reclaim marker guarding removal of `path` while it holds the owner `token` (as the module names it). */
function markerFor(root: string, path: string, token: string): string {
  return `${root}.reclaim-${createHash('sha256').update(`${path}\0token:${token}`).digest('hex').slice(0, 16)}`
}

/** An owner record of a process that has exited. */
function owner(token: string): string {
  return JSON.stringify({ pid: deadPid(), processInstanceId: 'gone', token, acquiredAt: new Date().toISOString() })
}

/** A pid that existed and has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''])
  return child.pid!
}

function run(lock: string, log: string, holdMs: number, barrier?: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childExecutable, lock, log, String(holdMs), ...(barrier ? [barrier] : [])], { stdio: ['ignore', 'ignore', 'pipe'] })
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

  it('two processes reclaiming the same stale lock at the same moment never both hold it', async () => {
    const lock = lockPath()
    const root = dirname(dirname(lock))
    const log = join(root, 'contention.log')
    const barrier = join(root, 'barrier')
    mkdirSync(dirname(lock), { recursive: true })
    mkdirSync(barrier)
    writeFileSync(log, '')
    writeFileSync(lock, JSON.stringify({ pid: deadPid(), processInstanceId: 'gone', token: 'dead', acquiredAt: new Date().toISOString() }))
    const children = Promise.all([run(lock, log, 300, barrier), run(lock, log, 300, barrier)])
    // Both have judged the dead owner stale before either acts on it.
    await vi.waitFor(() => expect(readdirSync(barrier).filter((name) => name.startsWith('ready-'))).toHaveLength(2), { timeout: 30_000 })
    writeFileSync(join(barrier, 'go'), '')
    await children
    const lines = readFileSync(log, 'utf8').trim().split('\n').map((line) => line.split(' ')[0])
    expect(lines).toEqual(['start', 'end', 'start', 'end'])
    expect(readdirSync(dirname(lock))).toEqual([])
  }, 60_000)

  it('a reclaimer that arrives late never deletes the lock another reclaimer just took', () => {
    const lock = lockPath()
    mkdirSync(dirname(lock), { recursive: true })
    writeFileSync(lock, JSON.stringify({ pid: deadPid(), processInstanceId: 'gone', token: 'dead', acquiredAt: new Date().toISOString() }))
    let winner: string | null = null
    // B judges the owner dead; before B acts, A reclaims and takes the lock.
    setReclaimHookForTests((step) => {
      if (step !== 'checked' || winner !== null) return
      setReclaimHookForTests(null)
      winner = tryAcquireOnceForTests(lock)
    })
    expect(tryAcquireOnceForTests(lock)).toBeNull()
    expect(winner).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe(winner)
  })

  it('while one reclaimer holds the reclaim marker, another cannot reclaim the same file', () => {
    const lock = lockPath()
    mkdirSync(dirname(lock), { recursive: true })
    writeFileSync(lock, JSON.stringify({ pid: deadPid(), processInstanceId: 'gone', token: 'dead', acquiredAt: new Date().toISOString() }))
    let other: string | null | undefined
    setReclaimHookForTests((step) => {
      if (step !== 'marked' || other !== undefined) return
      other = null
      other = tryAcquireOnceForTests(lock)
    })
    const mine = tryAcquireOnceForTests(lock)
    expect(other).toBeNull()
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe(mine)
    expect(readdirSync(dirname(lock))).toEqual(['test.lock'])
  })

  it('a reclaim marker left by a crashed reclaimer is itself reclaimed', () => {
    const lock = lockPath()
    mkdirSync(dirname(lock), { recursive: true })
    writeFileSync(lock, owner('dead'))
    // A reclaimer that crashed holding the marker for this exact stale file left it behind.
    writeFileSync(markerFor(lock, lock, 'dead'), owner('marker'))
    expect(tryAcquireOnceForTests(lock)).toMatch(/^[0-9a-f]{32}$/)
    expect(readdirSync(dirname(lock))).toEqual(['test.lock'])
  })

  it.each([
    ['through the markers', null],
    ['past the marker depth, by conditional removal', 2]
  ])('three reclaimers that crashed one after another never pin the lock (%s)', (_name, depth) => {
    setReclaimDepthForTests(depth)
    try {
      const lock = lockPath()
      mkdirSync(dirname(lock), { recursive: true })
      writeFileSync(lock, owner('dead'))
      // Each crashed while holding the marker that guards the file the previous one left.
      const first = markerFor(lock, lock, 'dead')
      const second = markerFor(lock, first, 'm1')
      const third = markerFor(lock, second, 'm2')
      writeFileSync(first, owner('m1'))
      writeFileSync(second, owner('m2'))
      writeFileSync(third, owner('m3'))
      const token = tryAcquireOnceForTests(lock)
      expect(token).toMatch(/^[0-9a-f]{32}$/)
      expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe(token)
      expect(existsSync(first)).toBe(false)
      // Through the markers every crashed marker is cleared; past the depth only the deepest one,
      // which guards nothing any more, may stay.
      if (depth === null) expect(readdirSync(dirname(lock))).toEqual(['test.lock'])
    } finally {
      setReclaimDepthForTests(null)
    }
  })

  it('a reclaimer paused before its removal puts back the lock that replaced the stale one', () => {
    const lock = lockPath()
    mkdirSync(dirname(lock), { recursive: true })
    writeFileSync(lock, owner('dead'))
    let replacement: string | null = null
    setReclaimHookForTests((step) => {
      if (step !== 'removing' || replacement !== null) return
      setReclaimHookForTests(null)
      // While B is paused, another process reclaims the stale lock and takes a fresh one.
      unlinkSync(lock)
      replacement = tryAcquireOnceForTests(lock)
    })
    expect(tryAcquireOnceForTests(lock)).toBeNull()
    expect(replacement).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe(replacement)
    expect(readdirSync(dirname(lock))).toEqual(['test.lock'])
  })

  it('a holder paused before its release puts back a lock that replaced its own meanwhile', () => {
    const lock = lockPath()
    mkdirSync(dirname(lock), { recursive: true })
    const mine = tryAcquireOnceForTests(lock)!
    let replacement: string | null = null
    setReclaimHookForTests((step) => {
      if (step !== 'releasing' || replacement !== null) return
      setReclaimHookForTests(null)
      // While the holder is paused past its hold, another process reclaims and takes the lock.
      unlinkSync(lock)
      replacement = tryAcquireOnceForTests(lock)
    })
    releaseForTests(lock, mine)
    expect(replacement).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe(replacement)
    expect(readdirSync(dirname(lock))).toEqual(['test.lock'])
  })

  it('the next acquire clears what a crashed removal set aside, and only that', async () => {
    const lock = lockPath()
    mkdirSync(dirname(lock), { recursive: true })
    const crashed = `test.lock.${deadPid()}.aaaa.removed`
    const inFlight = `test.lock.${process.ppid}.bbbb.removed`
    writeFileSync(join(dirname(lock), crashed), owner('x'))
    writeFileSync(join(dirname(lock), inFlight), owner('y'))
    await withAsyncFileLock(lock, async () => undefined, { waitMs: 0 })
    expect(readdirSync(dirname(lock))).toEqual([inFlight])
  })

  it('reclaims a live pid whose lock is older than maxHoldMs (pid reuse), and only then', async () => {
    const lock = lockPath()
    mkdirSync(dirname(lock), { recursive: true })
    const old = new Date(Date.now() - 10 * 60_000).toISOString()
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, processInstanceId: 'other', token: 'reused', acquiredAt: old }))
    await expect(withAsyncFileLock(lock, async () => 'ran', { waitMs: 0 })).rejects.toBeInstanceOf(FileLockBusyError)
    expect(await withAsyncFileLock(lock, async () => 'ran', { waitMs: 0, maxHoldMs: 5 * 60_000 })).toBe('ran')
  })

  it('a create that fails like a Windows delete-pending file waits and retries', async () => {
    const lock = lockPath()
    fsControl.failOpen = ['EPERM', 'EACCES', 'EBUSY']
    expect(await withAsyncFileLock(lock, async () => 'ran', { waitMs: 5_000 })).toBe('ran')
    expect(fsControl.failOpen).toEqual([])
  })

  it('any other create error is not mistaken for busy', async () => {
    const lock = lockPath()
    fsControl.failOpen = ['EIO']
    await expect(withAsyncFileLock(lock, async () => 'ran', { waitMs: 5_000 })).rejects.toMatchObject({ code: 'EIO' })
  })

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
