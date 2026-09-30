import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { UndoRetentionService } from '../src/mms/actions/UndoRetentionService'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { UndoService } from '../src/mms/actions/UndoService'
import { CodeRevertService } from '../src/mms/actions/CodeRevertService'
import { ConversationBranchService } from '../src/mms/actions/ConversationBranchService'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { actionOptions, git, gitFoundationFixture } from './fixtures/gitFoundation'

let f: ReturnType<typeof gitFoundationFixture>
let now: number
let retention: UndoRetentionService
beforeEach(() => {
  f = gitFoundationFixture()
  now = Date.now()
  retention = new UndoRetentionService(f.thread, () => now)
})
afterEach(() => { vi.restoreAllMocks(); f.dispose() })
async function action(id = 'turn') {
  return (await new ThreadActionService(f.thread).runCheckpointedAction(actionOptions(f.repo, id), () => writeFileSync(join(f.repo, 'value.txt'), `${id}\n`))).action
}
async function policy() {
  now = Date.now(); await retention.configure(f.repo, { windowMs: 10000, migrationGraceMs: 10000, maxForwardStepMs: 100000 }, true)
}

it('adopts existing history with grace, expires at the deadline and keeps audit/conversations/refs', async () => {
  const target = await action()
  const actions = new ThreadActionService(f.thread)
  actions.replace([{ ...target, completedAt: new Date(now - 100000).toISOString() }])
  writeFileSync(join(f.thread, 'messages.json'), JSON.stringify([{ content: 'retained conversation' }]))
  await policy()
  now += 9999
  expect((await retention.sweep(f.repo)).expired).toEqual([])
  now += 1
  expect((await retention.sweep(f.repo)).expired).toEqual([target.receiptId])
  expect(retention.eligibility(target).state).toBe('expired')
  expect((await retention.sweep(f.repo)).expired).toEqual([])
  expect(actions.get(target.id)?.endSha).toEqual(target.endSha)
  expect(f.read(f.thread, 'messages.json')).toContain('retained conversation')
  for (const ref of new ChangeReceiptService(f.thread).list()[0]!.retainedRefs) expect(git(f.repo, 'rev-parse', ref)).toMatch(/^[a-f0-9]{40}$/)
})

it('blocks historical Undo, code revert and exact-code fork even when Git still has every object', async () => {
  const target = await action()
  await policy(); now += 20000; await retention.sweep(f.repo)
  await expect(new UndoService(f.thread).undoLatest('main', f.repo)).rejects.toThrow('expired')
  await expect(new CodeRevertService(f.thread).revertCode(target.id, f.repo)).rejects.toThrow('expired')
  await expect(new ConversationBranchService(f.thread).fork(f.repo, 'main', target.id, 'old code')).rejects.toThrow('expired')
  expect(git(f.repo, 'cat-file', '-t', target.endSha)).toBe('commit')
})

it('pins require human action and block later holes; unpin and bounded sweeps release oldest prefixes', async () => {
  const first = await action('first'), second = await action('second'), third = await action('third')
  await policy()
  await expect(retention.pin(f.repo, second.id, true, false)).rejects.toThrow('human')
  await retention.pin(f.repo, second.id, true, true)
  now += 30000
  expect((await retention.sweep(f.repo)).expired).toEqual([first.receiptId])
  expect(retention.eligibility(second).state).toBe('pinned')
  expect(retention.eligibility(third).state).toBe('available')
  await retention.pin(f.repo, second.id, false, true)
  expect((await retention.sweep(f.repo)).expired).toEqual([second.receiptId, third.receiptId])
  await expect(retention.pin(f.repo, second.id, true, true)).rejects.toThrow('Expired')
})

it('keeps active and crash-recovery material until the owning operation settles', async () => {
  const target = await action()
  await policy()
  const journal = new ThreadJournal(f.thread)
  journal.append({ operationId: 'pending', operationType: 'undo', state: 'prepared', details: { actionId: target.id } })
  now += 30000
  expect((await retention.sweep(f.repo)).expired).toEqual([])
  expect(retention.eligibility(target).state).toBe('blocked')
  journal.append({ operationId: 'pending', operationType: 'undo', state: 'cancelled' })
  expect((await retention.sweep(f.repo)).expired).toEqual([target.receiptId])
})

it('clock rollback cannot accelerate expiry and forward jumps suspend until human acknowledgement', async () => {
  const target = await action()
  await policy()
  now -= 10000
  expect((await retention.sweep(f.repo)).expired).toEqual([])
  now += 2000000
  expect((await retention.sweep(f.repo)).suspended).toBe(true)
  expect(retention.eligibility(target).state).toBe('blocked')
  await expect(retention.configure(f.repo, {}, false, true)).rejects.toThrow('human')
  await retention.configure(f.repo, {}, true, true)
  expect((await retention.sweep(f.repo)).expired).toEqual([target.receiptId])
})

it('Undo refreshes only its matching pair and receipt replay cannot revive expiration', async () => {
  const first = await action('first'), second = await action('second')
  await policy()
  const undo = await new UndoService(f.thread).undoLatest('main', f.repo)
  const pairEvent = new ThreadJournal(f.thread).list().find((entry) => (entry.details as { kind?: string })?.kind === 'refresh-pair')!
  expect((pairEvent.details as { ids: string[] }).ids).toEqual([second.receiptId, undo.receiptId])
  now = (pairEvent.details as { deadline: number }).deadline
  const result = await retention.sweep(f.repo)
  expect(result.expired).toEqual([first.receiptId, second.receiptId, undo.receiptId])
  const receiptService = new ChangeReceiptService(f.thread), receipt = receiptService.list()[0]!
  const { id: _id, workspaceId: _workspaceId, generation: _generation, retainedRefs: _refs, createdAt: _createdAt, ...input } = receipt
  expect(receiptService.record(f.repo, input)).toEqual(receipt)
  expect(retention.isReceiptExpired(receipt.id)).toBe(true)
})

it('bounds sweep batches without expiring one half of a compensation pair', async () => {
  const first = await action('first'), second = await action('second')
  await policy()
  const undo = await new UndoService(f.thread).undoLatest('main', f.repo)
  await retention.configure(f.repo, { batchSize: 2 }, true)
  now = Date.now() + 20000
  expect((await retention.sweep(f.repo)).expired).toEqual([first.receiptId])
  expect(retention.eligibility(second).state).toBe('available')
  expect((await retention.sweep(f.repo)).expired).toEqual([second.receiptId, undo.receiptId])
})

it('projects a thousand history rows with a constant number of journal reads', async () => {
  const target = await action()
  await policy()
  const read = vi.spyOn(ThreadJournal.prototype, 'list')
  const rows = retention.eligibilityMany(Array.from({ length: 1000 }, (_, index) => ({ ...target, id: `audit-${index}` })))
  expect(rows).toHaveLength(1000)
  expect(rows.every((row) => row.retention?.state === 'available')).toBe(true)
  expect(read.mock.calls.length).toBeLessThanOrEqual(2)
})

it('offers conversation-only continuation on current code after exact-code eligibility expires', async () => {
  const target = await action('historical')
  await action('current')
  await policy(); now += 30000; await retention.sweep(f.repo)
  const current = git(f.repo, 'rev-parse', 'HEAD')
  const branch = await new ConversationBranchService(f.thread).fork(f.repo, 'main', target.id, 'Current-code conversation', undefined, 'current')
  expect(git(f.repo, 'rev-parse', branch.retainedRef)).toBe(current)
  expect(branch.contextBoundary).toEqual(target.nativeContextBoundary)
})

it.each([
  { kind: 'expire', ids: 'not-an-array' },
  { kind: 'pin', ids: ['a'.repeat(36)], pinned: 'yes', reason: 'invalid' },
  { kind: 'refresh-pair', ids: ['a'.repeat(36), 'b'.repeat(36)], deadline: 'tomorrow' },
  { kind: 'clock', suspended: 'false' }
])('fails closed on corrupt retention authority: $kind', async (event) => {
  const target = await action()
  await policy()
  new ThreadJournal(f.thread).append({ operationId: 'corrupt', operationType: 'undo-retention', state: 'completed', details: { version: 1, at: now, ...event } })
  expect(() => retention.eligibility(target)).toThrow('authority')
  await expect(retention.sweep(f.repo)).rejects.toThrow('authority')
})
