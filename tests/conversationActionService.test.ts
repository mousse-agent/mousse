import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ConversationActionService } from '../src/mms/actions/ConversationActionService'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { UndoRetentionService } from '../src/mms/actions/UndoRetentionService'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { acquireExecutionLease, releaseExecutionLeaseHandle } from '../src/mms/queue/ThreadExecutionLease'
import type { NativeContextBoundary } from '../src/shared/threadActions'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const boundary = (messageIndex: number, compactionGeneration = 0): NativeContextBoundary => ({ messageIndex, compactionGeneration, fidelity: 'exact', safeBoundaryProof: 'fixture-boundary' })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mousse-conversation-action-')); roots.push(directory)
  const service = new ConversationActionService(directory)
  const actions = new ThreadActionService(directory)
  const journal = new ThreadJournal(directory)
  const record = (turnId = 'turn-one', tools = false, generation = 0) => {
    const lease = acquireExecutionLease(directory, { source: 'fixture-turn' })
    try {
      service.begin(turnId, 'main', 0, boundary(0), lease)
      return service.settle(turnId, 2, boundary(2, generation), 'completed', tools, lease)
    } finally { releaseExecutionLeaseHandle(lease) }
  }
  return { directory, service, actions, journal, record }
}

it('records durable tool-free pre/post boundaries without changing ordinary files', () => {
  const f = fixture(); const file = join(f.directory, 'ordinary.txt'); writeFileSync(file, 'unchanged')
  const action = f.record()
  expect(new ThreadActionService(f.directory).get(action.id)).toMatchObject({ scope: 'conversation', state: 'completed', reversible: true, nativeContextStartBoundary: boundary(0), nativeContextBoundary: boundary(2), changedPaths: [], commits: [] })
  const restore = vi.fn()
  f.service.apply('main', 'undo', f.actions.currentRevision(), action.turnId, () => undefined, restore)
  expect(restore).toHaveBeenCalledWith(expect.objectContaining({ id: action.id, state: 'undone' }), 'undo')
  expect(readFileSync(file, 'utf8')).toBe('unchanged')
})

it.each([{ tools: true, generation: 0 }, { tools: false, generation: 1 }])('refuses unsafe tool or compacted boundaries: %j', ({ tools, generation }) => {
  const f = fixture(); const action = f.record('unsafe', tools, generation); const restore = vi.fn()
  expect(action.reversible).toBe(false)
  expect(() => f.service.apply('main', 'undo', f.actions.currentRevision(), action.turnId, () => undefined, restore)).toThrow()
  expect(restore).not.toHaveBeenCalled()
  expect(f.actions.get(action.id)?.state).toBe('completed')
})

it('fences stale generation, wrong target, and a currently held execution lease', () => {
  const f = fixture(); const action = f.record(); const revision = f.actions.currentRevision(); const restore = vi.fn()
  expect(() => f.service.apply('main', 'undo', revision - 1, action.turnId, () => undefined, restore)).toThrow('STALE_JOURNAL_GENERATION')
  expect(() => f.service.apply('main', 'undo', revision, 'older-turn', () => undefined, restore)).toThrow('no longer the latest')
  const lease = acquireExecutionLease(f.directory, { source: 'active-turn' })
  try { expect(() => f.service.apply('main', 'undo', revision, action.turnId, () => undefined, restore)).toThrow() }
  finally { releaseExecutionLeaseHandle(lease) }
  expect(restore).not.toHaveBeenCalled()
  expect(f.actions.get(action.id)?.state).toBe('completed')
})

it('requires the lease for checkpoint writes and rejects a released handle', () => {
  const f = fixture(); const lease = acquireExecutionLease(f.directory, { source: 'fixture' })
  releaseExecutionLeaseHandle(lease)
  expect(() => f.service.begin('invalid', 'main', 0, boundary(0), lease)).toThrow()
  expect(f.actions.list()).toEqual([])
})

it('supports undo then redo, rejecting repeated operations and redo after a newer turn', () => {
  const f = fixture(); const first = f.record(); const restored: string[] = []
  const apply = (kind: 'undo' | 'redo', turn = first.turnId) => f.service.apply('main', kind, f.actions.currentRevision(), turn, () => undefined, (_action, operation) => { restored.push(operation) })
  apply('undo'); expect(() => apply('undo')).toThrow()
  apply('redo'); expect(() => apply('redo')).toThrow()
  apply('undo'); f.record('new-turn')
  expect(() => apply('redo')).toThrow()
  expect(restored).toEqual(['undo', 'redo', 'undo'])
})

it('recovers a durable history intent after context persisted but completion failed', () => {
  const f = fixture(); const action = f.record(); const context = join(f.directory, 'synthetic-context.json')
  writeFileSync(context, JSON.stringify({ index: 2 }))
  expect(() => f.service.apply('main', 'undo', f.actions.currentRevision(), action.turnId, () => undefined, () => {
    writeFileSync(context, JSON.stringify({ index: 0 }))
    throw new Error('injected failure after context persistence')
  })).toThrow('injected failure')
  expect(f.actions.get(action.id)?.state).toBe('completed')
  expect([...f.journal.latestByOperation().values()].some(record => record.state === 'context_pending')).toBe(true)
  const recovered = new ConversationActionService(f.directory)
  const lease = acquireExecutionLease(f.directory, { source: 'restart-recovery' })
  const restore = vi.fn((_action, kind) => { expect(kind).toBe('undo'); writeFileSync(context, JSON.stringify({ index: 0 })) })
  try { recovered.recover(lease, restore); recovered.recover(lease, restore) }
  finally { releaseExecutionLeaseHandle(lease) }
  expect(restore).toHaveBeenCalledTimes(1)
  expect(f.actions.get(action.id)?.state).toBe('undone')
  expect(JSON.parse(readFileSync(context, 'utf8'))).toEqual({ index: 0 })
  expect([...f.journal.latestByOperation().values()].every(record => record.state === 'completed')).toBe(true)
})

it('recovers an interrupted turn as non-reversible instead of inventing an end boundary', () => {
  const f = fixture(); const lease = acquireExecutionLease(f.directory, { source: 'turn' })
  const action = f.service.begin('interrupted', 'main', 0, boundary(0), lease)
  releaseExecutionLeaseHandle(lease)
  const restart = acquireExecutionLease(f.directory, { source: 'restart' }); const restore = vi.fn()
  try { new ConversationActionService(f.directory).recover(restart, restore) }
  finally { releaseExecutionLeaseHandle(restart) }
  expect(f.actions.get(action.id)).toMatchObject({ state: 'failed', reversible: false })
  expect(restore).not.toHaveBeenCalled()
})

it.each(['kind', 'identity'])('refuses corrupted recovery %s without restoring context', (corruption) => {
  const f = fixture(); const action = f.record()
  f.journal.append({ operationId: 'corrupt-recovery', operationType: 'conversation-history', state: 'context_pending', details: {
    kind: corruption === 'kind' ? 'unexpected' : 'undo',
    action: { ...action, state: 'undone', ...(corruption === 'identity' ? { turnId: 'different-turn' } : {}) }
  } })
  const lease = acquireExecutionLease(f.directory, { source: 'restart' }); const restore = vi.fn()
  try { expect(() => f.service.recover(lease, restore)).toThrow(/invalid|changed/) }
  finally { releaseExecutionLeaseHandle(lease) }
  expect(restore).not.toHaveBeenCalled()
  expect(f.actions.get(action.id)?.state).toBe('completed')
})

it('honors durable retention expiry rather than restoring an expired conversation', () => {
  const f = fixture(); const action = f.record()
  const lease = acquireExecutionLease(f.directory, { source: 'retention-fixture' })
  try {
    new UndoRetentionService(f.directory).sweepHeld()
    f.journal.append({ operationId: 'fixture-expiry', operationType: 'undo-retention', state: 'completed', details: {
      version: 1, kind: 'expire', at: Date.now(), ids: [`action:${action.id}`]
    } })
  } finally { releaseExecutionLeaseHandle(lease) }
  const restore = vi.fn()
  expect(() => f.service.apply('main', 'undo', f.actions.currentRevision(), action.turnId, () => undefined, restore)).toThrow(/expired/)
  expect(restore).not.toHaveBeenCalled()
  expect(f.actions.get(action.id)?.state).toBe('completed')
})
