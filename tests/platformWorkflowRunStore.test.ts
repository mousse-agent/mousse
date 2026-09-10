import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkflowRunStore, type RunCheckpoint } from '../src/mms/workflows/engine/runStore'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('WorkflowRunStore leases', () => {
  it('fences concurrent acquisition in one process and permits acquisition after owned release', () => {
    const profileRoot = mkdtempSync(join(tmpdir(), 'mousse-run-store-'))
    dirs.push(profileRoot)
    const store = new WorkflowRunStore({ profileId: 'p1', profileRoot })
    const runId = '11111111-1111-4111-8111-111111111111'
    const checkpoint: RunCheckpoint = {
      seq: 0,
      ready: ['start'],
      instances: { start: { instanceKey: 'start', nodeId: 'start', type: 'start', path: '', status: 'ready', attempt: 0 } },
      outputs: {}
    }
    const first = store.create({
      runId,
      profileId: 'p1',
      updatedAt: new Date().toISOString()
    } as never, checkpoint).lease
    store.append(runId, { seq: 1, at: new Date().toISOString(), kind: 'run-started', runId, payload: {} }, first.token)
    appendFileSync(join(profileRoot, 'workflow-runs', runId, 'journal.ndjson'), '{"seq":2')
    expect(store.readJournal(runId).map((event) => event.seq)).toEqual([1])
    expect(() => store.acquire(runId, new Date().toISOString())).toThrow(/leased/)
    store.release(runId, first.token)
    const second = store.acquire(runId, new Date().toISOString())
    expect(second.token).not.toBe(first.token)
    store.release(runId, second.token)
  })
})
