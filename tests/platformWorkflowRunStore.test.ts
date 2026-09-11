import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

  it('repairs an incomplete admission and exposes the manifest only after immutable inputs', () => {
    const profileRoot = mkdtempSync(join(tmpdir(), 'mousse-run-admission-'))
    dirs.push(profileRoot)
    const store = new WorkflowRunStore({ profileId: 'p1', profileRoot })
    const runId = '22222222-2222-4222-8222-222222222222'
    const runDir = store.runDir(runId)
    mkdirSync(runDir)
    writeFileSync(join(runDir, 'partial'), 'dead initializer')
    const checkpoint: RunCheckpoint = { seq: 0, ready: [], instances: {}, outputs: {} }
    const manifest = { runId, profileId: 'p1', journalSeq: 0, updatedAt: new Date().toISOString() } as never
    const lease = store.create(manifest, checkpoint, {
      initialize(dir) {
        expect(existsSync(join(dir, 'manifest.json'))).toBe(false)
        expect(existsSync(join(dir, 'partial'))).toBe(false)
        writeFileSync(join(dir, 'input.json'), '{}')
      },
      initialEvent: { seq: 1, at: new Date().toISOString(), kind: 'run-accepted', runId, payload: {} }
    }).lease
    expect(existsSync(join(runDir, 'manifest.json'))).toBe(true)
    expect(store.readJournal(runId).map((event) => event.kind)).toEqual(['run-accepted'])
    expect(store.readManifest(runId).journalSeq).toBe(1)
    store.release(runId, lease.token)
  })
})
