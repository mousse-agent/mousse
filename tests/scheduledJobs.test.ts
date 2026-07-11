import { describe, expect, it } from 'vitest'
import { computeNextRun, isSilentOutput } from '../src/mms/scheduled/computeNextRun'
import { ScheduledJobStore } from '../src/mms/scheduled/ScheduledJobStore'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

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
  it('creates, pauses, resumes, and deletes jobs atomically', () => {
    const originalHome = process.env.MOUSSE_HOME
    const tempHome = mkdtempSync(join(tmpdir(), 'mousse-scheduled-test-'))
    process.env.MOUSSE_HOME = tempHome

    try {
      const config = MousseConfigStore.load(tempHome)
      const store = new ScheduledJobStore(config)
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
    } finally {
      if (originalHome === undefined) {
        delete process.env.MOUSSE_HOME
      } else {
        process.env.MOUSSE_HOME = originalHome
      }
      rmSync(tempHome, { recursive: true, force: true })
    }
  })
})
