import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { computeNextRun, isSilentOutput } from '../src/mms/scheduled/computeNextRun'
import { ScheduledJobStore } from '../src/mms/scheduled/ScheduledJobStore'
import { ScheduledJobService } from '../src/mms/scheduled/ScheduledJobService'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { dirname } from 'path'
import { join } from 'path'
import { tmpdir } from 'os'
import { getScheduledTickLockPath } from '../src/mms/data/paths'
import {
  FileLockBusyError,
  FILE_LOCK_CORRUPT_STALE_MS,
  FILE_LOCK_PUBLICATION_GRACE_MS,
  mayReclaimUnreadableLock,
  tryAcquireTickLock,
  withFileLock
} from '../src/mms/scheduled/fileLock'
import { PROCESS_INSTANCE_ID } from '../src/mms/queue/processLiveness'

describe('computeNextRun', () => {
  it('computes interval from last run', () => {
    const lastRunAt = '2026-01-01T12:00:00.000Z'
    const next = computeNextRun({ kind: 'interval', minutes: 30 }, lastRunAt)
    expect(next).toBe('2026-01-01T12:30:00.000Z')
  })

  it('returns null for expired one-shot jobs', () => {
    const runAt = '2020-01-01T00:00:00.000Z'
    const next = computeNextRun({ kind: 'once', runAt }, null, new Date('2026-06-01T00:00:00.000Z'))
    expect(next).toBeNull()
  })

  it('detects silent marker output', () => {
    expect(isSilentOutput('[SILENT]')).toBe(true)
    expect(isSilentOutput('All good\n[SILENT]')).toBe(true)
    expect(isSilentOutput('Hello world')).toBe(false)
  })
})

describe('ScheduledJobStore', () => {
  let originalHome: string | undefined
  let tempHome: string
  let store: ScheduledJobStore

  beforeEach(() => {
    originalHome = process.env.MOUSSE_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'mousse-scheduled-test-'))
    process.env.MOUSSE_HOME = tempHome
    const config = MousseConfigStore.load(tempHome)
    store = new ScheduledJobStore(config)
  })

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.MOUSSE_HOME
    } else {
      process.env.MOUSSE_HOME = originalHome
    }
    rmSync(tempHome, { recursive: true, force: true })
  })

  it('creates, pauses, resumes, and deletes jobs atomically', () => {
    const job = store.createJob({
      name: 'Test job',
      prompt: 'Say hello',
      schedule: { kind: 'interval', minutes: 15 }
    })

    expect(job.enabled).toBe(true)
    expect(job.nextRunAt).toBeTruthy()

    const paused = store.pauseJob(job.id, 'testing')
    expect(paused?.state).toBe('paused')

    const resumed = store.resumeJob(job.id)
    expect(resumed?.state).toBe('scheduled')

    expect(store.deleteJob(job.id)).toBe(true)
    expect(store.getJob(job.id)).toBeUndefined()
  })

  it('claims due jobs with durable runClaim ownership', () => {
    const job = store.createJob({
      name: 'Due',
      prompt: 'run',
      schedule: { kind: 'interval', minutes: 15 }
    })
    // Force due immediately.
    store.updateJob(job.id, { nextRunAt: '2000-01-01T00:00:00.000Z', state: 'scheduled' })
    const due = store.claimDueJobs(new Date('2026-01-01T00:00:00.000Z'))
    expect(due).toHaveLength(1)
    expect(due[0].id).toBe(job.id)
    expect(due[0].state).toBe('running')
    expect(due[0].runClaim?.pid).toBe(process.pid)
    expect(due[0].runClaim?.processInstanceId).toBe(PROCESS_INSTANCE_ID)
    expect(due[0].runClaim?.token).toBeTruthy()

    const persisted = store.getJob(job.id)
    expect(persisted?.state).toBe('running')
    expect(persisted?.runClaim?.token).toBe(due[0].runClaim?.token)
  })

  it('reconciles killed running-job owners and preserves live owners', () => {
    const dead = store.createJob({
      name: 'Dead owner',
      prompt: 'x',
      schedule: { kind: 'interval', minutes: 10 }
    })
    const live = store.createJob({
      name: 'Live owner',
      prompt: 'y',
      schedule: { kind: 'interval', minutes: 10 }
    })

    // Plant running states: dead claim vs live claim.
    store.updateJob(dead.id, {
      state: 'running',
      runClaim: {
        pid: 2_147_000_090,
        processInstanceId: 'dead-scheduler',
        token: 'dead-tok',
        claimedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString()
      }
    })
    store.updateJob(live.id, {
      state: 'running',
      runClaim: {
        pid: process.pid,
        processInstanceId: PROCESS_INSTANCE_ID,
        token: 'live-tok',
        claimedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString()
      }
    })

    const interrupted = store.reconcileStaleRunningJobs()
    expect(interrupted.map((j) => j.id)).toContain(dead.id)
    expect(interrupted.map((j) => j.id)).not.toContain(live.id)

    const deadAfter = store.getJob(dead.id)!
    expect(deadAfter.state).toBe('scheduled')
    expect(deadAfter.lastStatus).toBe('interrupted')
    expect(deadAfter.runClaim).toBeUndefined()

    const liveAfter = store.getJob(live.id)!
    expect(liveAfter.state).toBe('running')
    expect(liveAfter.runClaim?.token).toBe('live-tok')
  })

  it('fences stale completion after claim was reclaimed', () => {
    const job = store.createJob({
      name: 'Fence',
      prompt: 'z',
      schedule: { kind: 'interval', minutes: 30 }
    })
    store.updateJob(job.id, { nextRunAt: '2000-01-01T00:00:00.000Z', state: 'scheduled' })
    const claimed = store.claimDueJobs(new Date('2026-01-01T00:00:00.000Z'))[0]
    expect(claimed).toBeTruthy()
    const oldToken = claimed.runClaim!.token

    // Simulate another instance reclaiming and re-claiming with a new token.
    store.updateJob(job.id, {
      state: 'running',
      runClaim: {
        pid: process.pid,
        processInstanceId: PROCESS_INSTANCE_ID,
        token: 'new-owner-token',
        claimedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString()
      }
    })

    expect(store.isRunClaimCurrent(job.id, oldToken)).toBe(false)
    expect(store.isRunClaimCurrent(job.id, 'new-owner-token')).toBe(true)

    // Stale finisher must not overwrite current owner result.
    expect(
      store.markJobRun(job.id, true, 'stale-output', undefined, false, oldToken)
    ).toBeNull()
    expect(store.getJob(job.id)?.state).toBe('running')
    expect(store.getJob(job.id)?.runClaim?.token).toBe('new-owner-token')

    // Current owner may finalize.
    expect(
      store.markJobRun(job.id, true, 'fresh-output', undefined, false, 'new-owner-token')
    ).not.toBeNull()
    expect(store.getJob(job.id)?.state).toBe('scheduled')
    expect(store.getJob(job.id)?.runClaim).toBeUndefined()
  })

  it('interrupted one-shot jobs become error/disabled, not completed', () => {
    const job = store.createJob({
      name: 'Once',
      prompt: 'side-effect',
      schedule: { kind: 'once', runAt: '2099-01-01T00:00:00.000Z' }
    })
    store.updateJob(job.id, {
      state: 'running',
      enabled: true,
      nextRunAt: '2000-01-01T00:00:00.000Z',
      runClaim: {
        pid: 2_147_000_093,
        processInstanceId: 'dead',
        token: 'dead-once',
        claimedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString()
      }
    })

    const interrupted = store.reconcileStaleRunningJobs()
    expect(interrupted.map((j) => j.id)).toContain(job.id)
    const after = store.getJob(job.id)!
    expect(after.state).toBe('error')
    expect(after.enabled).toBe(false)
    expect(after.lastStatus).toBe('interrupted')
    expect(after.runClaim).toBeUndefined()
    expect(after.nextRunAt).toBeNull()
    expect(after.lastError).toMatch(/manual trigger/i)
  })

  it('markJobRun rejects unclaimed or non-running jobs even without a token', () => {
    const job = store.createJob({
      name: 'Unclaimed',
      prompt: 'x',
      schedule: { kind: 'interval', minutes: 5 }
    })
    expect(store.markJobRun(job.id, true, 'nope')).toBeNull()
    expect(store.getJob(job.id)?.state).toBe('scheduled')
    expect(store.isRunClaimCurrent(job.id, undefined)).toBe(false)
  })
})

describe('fileLock + tick lock recovery', () => {
  let originalHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    originalHome = process.env.MOUSSE_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'mousse-flock-'))
    process.env.MOUSSE_HOME = tempHome
  })

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.MOUSSE_HOME
    } else {
      process.env.MOUSSE_HOME = originalHome
    }
    rmSync(tempHome, { recursive: true, force: true })
  })

  it('lock contention never executes mutation (throws FileLockBusyError)', () => {
    const lockPath = join(tempHome, 'jobs.lock')
    const { spawn } = require('child_process') as typeof import('child_process')
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true
    })
    try {
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: child.pid,
          processInstanceId: 'peer',
          token: 'peer-tok',
          acquiredAt: new Date().toISOString()
        }),
        'utf-8'
      )
      let mutated = false
      expect(() =>
        withFileLock(lockPath, () => {
          mutated = true
        })
      ).toThrow(FileLockBusyError)
      expect(mutated).toBe(false)
    } finally {
      child.kill()
    }
  })

  it('withFileLock is re-entrant in-process', () => {
    const lockPath = join(tempHome, 'reenter.lock')
    const value = withFileLock(lockPath, () => withFileLock(lockPath, () => 7))
    expect(value).toBe(7)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('empty lock publication cannot be stolen; old corrupt lock reclaimed', () => {
    const lockPath = join(tempHome, 'pub.lock')
    const fd = openSync(lockPath, 'wx')
    closeSync(fd)
    expect(mayReclaimUnreadableLock(lockPath)).toBe(false)
    let mutated = false
    expect(() =>
      withFileLock(lockPath, () => {
        mutated = true
      })
    ).toThrow(FileLockBusyError)
    expect(mutated).toBe(false)

    const now = Date.now()
    const old = now - FILE_LOCK_CORRUPT_STALE_MS - 5_000
    utimesSync(lockPath, new Date(old), new Date(old))
    expect(mayReclaimUnreadableLock(lockPath, now)).toBe(true)
    expect(
      withFileLock(lockPath, () => {
        return 'ok'
      })
    ).toBe('ok')
  })

  it('file lock release does not delete unreadable/new publication', () => {
    const lockPath = join(tempHome, 'release-safe.lock')
    // Acquire and drop via withFileLock, then plant empty publication.
    withFileLock(lockPath, () => 1)
    const fd = openSync(lockPath, 'wx')
    closeSync(fd)
    // A subsequent withFileLock must not steal during grace (busy), and empty file remains.
    expect(() => withFileLock(lockPath, () => 2)).toThrow(FileLockBusyError)
    expect(existsSync(lockPath)).toBe(true)
    expect(readFileSync(lockPath, 'utf-8').trim()).toBe('')
  })

  it('recent corrupt lock within stale threshold is held', () => {
    const lockPath = join(tempHome, 'corrupt.lock')
    writeFileSync(lockPath, '%%%', 'utf-8')
    const recent = Date.now() - FILE_LOCK_PUBLICATION_GRACE_MS - 50
    utimesSync(lockPath, new Date(recent), new Date(recent))
    expect(mayReclaimUnreadableLock(lockPath)).toBe(false)
    expect(() => withFileLock(lockPath, () => 1)).toThrow(FileLockBusyError)
  })

  it('dead tick lock owner is reclaimed so scheduling is not disabled forever', () => {
    const tickPath = getScheduledTickLockPath()
    mkdirSync(dirname(tickPath), { recursive: true })
    writeFileSync(
      tickPath,
      JSON.stringify({
        pid: 2_147_000_091,
        processInstanceId: 'dead-ticker',
        token: 'dead-tick',
        acquiredAt: new Date().toISOString()
      }),
      'utf-8'
    )
    const release = tryAcquireTickLock(tickPath)
    expect(release).not.toBeNull()
    release!()
    expect(existsSync(tickPath)).toBe(false)
  })

  it('live tick lock owner is not stolen', () => {
    const tickPath = getScheduledTickLockPath()
    mkdirSync(dirname(tickPath), { recursive: true })
    const { spawn } = require('child_process') as typeof import('child_process')
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true
    })
    try {
      writeFileSync(
        tickPath,
        JSON.stringify({
          pid: child.pid,
          processInstanceId: 'live-ticker',
          token: 'live-tick',
          acquiredAt: new Date().toISOString()
        }),
        'utf-8'
      )
      expect(tryAcquireTickLock(tickPath)).toBeNull()
      expect(existsSync(tickPath)).toBe(true)
    } finally {
      child.kill()
    }
  })

  it('no event-loop busy-spin helper remains in fileLock module', () => {
    const src = readFileSync(
      join(__dirname, '../src/mms/scheduled/fileLock.ts'),
      'utf-8'
    )
    expect(src).not.toMatch(/while\s*\(\s*Date\.now\(\)/)
    expect(src).not.toMatch(/Atomics\.wait/)
    expect(src).not.toMatch(/sleepMs\s*\(/)
  })
})

describe('ScheduledJobService stop + startup reconcile', () => {
  let originalHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    originalHome = process.env.MOUSSE_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'mousse-sched-svc-'))
    process.env.MOUSSE_HOME = tempHome
  })

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.MOUSSE_HOME
    } else {
      process.env.MOUSSE_HOME = originalHome
    }
    rmSync(tempHome, { recursive: true, force: true })
  })

  it('start reconciles dead running jobs; stop prevents future ticks', async () => {
    const config = MousseConfigStore.load(tempHome)
    const store = new ScheduledJobStore(config)
    const job = store.createJob({
      name: 'Orphan',
      prompt: 'hi',
      schedule: { kind: 'interval', minutes: 5 }
    })
    store.updateJob(job.id, {
      state: 'running',
      runClaim: {
        pid: 2_147_000_092,
        processInstanceId: 'gone',
        token: 'gone-tok',
        claimedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString()
      }
    })

    let runs = 0
    const service = new ScheduledJobService(
      {
        runIsolated: async () => {
          runs += 1
          return { text: 'ok', silent: true }
        }
      },
      store
    )

    service.start()
    // Reconcile happens on start before first tick claims.
    expect(store.getJob(job.id)?.state).toBe('scheduled')
    expect(store.getJob(job.id)?.lastStatus).toBe('interrupted')

    service.stop()
    expect(service.getStatus().running).toBe(false)
    // stop is idempotent and must not leave a held tick lock from a finished tick.
    const tickPath = getScheduledTickLockPath()
    // Allow any in-flight tick finally to run.
    await new Promise((r) => setTimeout(r, 50))
    if (existsSync(tickPath)) {
      const release = tryAcquireTickLock(tickPath)
      expect(release).not.toBeNull()
      release?.()
    }
    void runs
  })

  it('status emission survives lock contention without throwing', () => {
    const config = MousseConfigStore.load(tempHome)
    const store = new ScheduledJobStore(config)
    const service = new ScheduledJobService(
      { runIsolated: async () => ({ text: '', silent: true }) },
      store
    )
    const listSpy = vi.spyOn(store, 'listJobs').mockImplementation(() => {
      throw new FileLockBusyError(join(tempHome, 'scheduled', '.jobs.lock'), null)
    })
    expect(() => service.getStatus()).not.toThrow()
    const status = service.getStatus()
    expect(status.jobCount).toBe(0)
    expect(status.lastTickError).toMatch(/lock busy/i)
    listSpy.mockRestore()
  })

  it('stale finisher produces no thread append and no job-state overwrite', async () => {
    const config = MousseConfigStore.load(tempHome)
    const store = new ScheduledJobStore(config)
    const projects = new ProjectManager()
    const threads = new ThreadDataStore(projects)
    const thread = threads.createThread('Sched target')

    const job = store.createJob({
      name: 'Stale finisher',
      prompt: 'write me',
      schedule: { kind: 'interval', minutes: 10 },
      threadId: thread.id
    })
    store.updateJob(job.id, { nextRunAt: '2000-01-01T00:00:00.000Z', state: 'scheduled' })

    const service = new ScheduledJobService(
      {
        runIsolated: async () => {
          // While runner is "in flight", reclaim and re-claim with a new owner token.
          store.updateJob(job.id, {
            state: 'running',
            runClaim: {
              pid: process.pid,
              processInstanceId: PROCESS_INSTANCE_ID,
              token: 'replacement-token',
              claimedAt: new Date().toISOString(),
              heartbeatAt: new Date().toISOString()
            }
          })
          return { text: 'should-not-append', silent: false }
        }
      },
      store,
      threads
    )

    // Claim under the service path: mark running with a claim, then execute.
    const [claimed] = store.claimDueJobs(new Date('2026-01-01T00:00:00.000Z'))
    expect(claimed.runClaim?.token).toBeTruthy()
    // Force the in-memory job to the first claim so executeJob uses the stale token.
    await (service as unknown as {
      executeJob: (j: typeof claimed) => Promise<void>
    }).executeJob(claimed)

    // Thread must not receive the stale output.
    expect(
      threads.loadThreadData(thread.id).messages.some((m) => m.content.includes('should-not-append'))
    ).toBe(false)
    // Current owner claim remains; state not finalized by stale finisher.
    expect(store.getJob(job.id)?.state).toBe('running')
    expect(store.getJob(job.id)?.runClaim?.token).toBe('replacement-token')
  })
})
