/**
 * The journal of agent commands on queues (issue #184): a command is written in full before the queue file
 * changes, finished from its entry after a crash, replayed by its request key, and its effects commit together with
 * its marker. Pure over a fake queue file and a real run database; no orchestrator.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueuedMessage } from '../src/shared/types'
import { ProfileDatabase } from '../src/mms/run/db/ProfileDatabase'
import { RUN_MIGRATIONS } from '../src/mms/run/db/migrations'
import { QUEUE_COMMAND_MAX_ATTEMPTS, QUEUE_COMMAND_RETENTION_MS, QueueCommands, type QueueIntent } from '../src/mms/run/QueueCommands'
import { enqueueMessage, listPendingQueue, normalizeQueuedMessages, claimNextNormal } from '../src/mms/queue/ThreadMessageQueue'
import { recoverQueueJournal, runQueueCommand, type QueueEffects, type QueueJournal, type QueueStoreLike } from '../src/mms/queue/queueJournal'

const THREAD = 'thread-1'
const actor = { kind: 'agent' as const, threadId: 'caller', runId: 'run-caller', toolCallId: 'mcp:1' }
const base = { threadId: THREAD, actor, cancelRunIds: [] as string[], releaseInboxIds: [] as string[] }

describe('queue command journal', () => {
  let home: string
  let db: ProfileDatabase
  let file: QueuedMessage[]
  let activeRun: string | null
  let effectLog: string[]
  let failEffects: number
  let audits: string[]
  let repairs: number
  let store: QueueStoreLike & { saves: number; failSave: number }

  const effects = (): QueueEffects => ({
    activeRunId: () => activeRun,
    applyEffects: (intent) => {
      if (failEffects > 0) {
        failEffects -= 1
        throw new Error('the effect did not commit')
      }
      effectLog.push(`${intent.op}:${intent.itemId}:cancel=${intent.cancelRunIds.join(',')}:release=${intent.releaseInboxIds.join(',')}`)
    },
    abandonWorkflow: (invocationId) => void effectLog.push(`abandon:${invocationId}`),
    audit: (intent, entry) => void audits.push(`${intent.threadId}:${entry.action}`),
    scheduleRepair: () => void (repairs += 1)
  })

  const seed = (count = 2): QueuedMessage[] => {
    let items: QueuedMessage[] = []
    for (let index = 0; index < count; index += 1) items = enqueueMessage(items, { threadId: THREAD, content: `message ${index}` }).items
    return items
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-queue-journal-'))
    db = new ProfileDatabase({ profileHome: home })
    db.migrate(RUN_MIGRATIONS)
    file = []
    activeRun = null
    effectLog = []
    failEffects = 0
    audits = []
    repairs = 0
    const journal: QueueJournal = { commands: new QueueCommands(db), effects: effects() }
    store = {
      saves: 0,
      failSave: 0,
      loadMessageQueue: () => structuredClone(file),
      saveMessageQueue: function (this: unknown, _threadId: string, queue: QueuedMessage[]) {
        const self = store
        if (self.failSave > 0) {
          self.failSave -= 1
          throw new Error('the queue file could not be written')
        }
        self.saves += 1
        file = normalizeQueuedMessages(structuredClone(queue), THREAD)
      },
      getQueueJournal: () => journal
    }
  })

  afterEach(() => {
    db.close()
    rmSync(home, { recursive: true, force: true })
  })

  const repairsSoFar = (): number => repairs
  const command = (key: string, plan: Parameters<typeof runQueueCommand>[4]) => runQueueCommand(store, THREAD, key, store.loadMessageQueue(THREAD), plan)
  const edit = (itemId: string, content: string): Parameters<typeof runQueueCommand>[4] => () => ({
    intent: { ...base, op: 'edit', itemId, patch: { content, origin: { kind: 'agent', threadId: 'caller', runId: 'run-caller', hops: 1 }, permissionMode: 'ask' } }
  })
  const rowOf = (key: string) => new QueueCommands(db).get(key)

  it('writes the entry, applies the change and the effects, and marks it applied with the stored result', () => {
    file = seed()
    const target = file[0]
    const outcome = command('queue_edit:caller:1', () => ({
      intent: { ...base, op: 'edit', itemId: target.id, patch: { content: 'changed' }, cancelRunIds: ['run-old'] },
      audit: { action: 'edited_queued_message', details: { itemId: target.id } }
    }))
    expect(outcome).toMatchObject({ replayed: false, effectsSettled: true, result: { outcome: 'edited', itemId: target.id, recorded: true } })
    expect(file[0].content).toBe('changed')
    expect(effectLog).toEqual([`edit:${target.id}:cancel=run-old:release=`])
    expect(audits).toEqual([`${THREAD}:edited_queued_message`])
    expect(rowOf('queue_edit:caller:1')).toMatchObject({ status: 'applied', result: { outcome: 'edited' } })
  })

  it('keeps no message text in an applied entry', () => {
    file = seed(1)
    command('queue_edit:caller:1', edit(file[0].id, 'a secret the journal must not keep'))
    const raw = db.statement('SELECT intent, result FROM queue_commands').get() as { intent: string; result: string }
    expect(raw.intent).not.toContain('secret')
    expect(JSON.parse(raw.intent)).toEqual({ op: 'edit', threadId: THREAD, itemId: file[0].id, cancelRunIds: [], releaseInboxIds: [] })
  })

  it('returns the first result of a finished command whatever the queue looks like now, without planning or applying anything', () => {
    file = seed()
    const target = file[0]
    const first = command('queue_remove:caller:1', () => ({ intent: { ...base, op: 'remove', itemId: target.id } }))
    expect(file.map((item) => item.id)).not.toContain(target.id)
    // The queue changed since: another message arrived; the removed item is not there to find.
    file = enqueueMessage(file, { threadId: THREAD, content: 'later' }).items
    const plan = vi.fn(() => { throw new Error('a replay never plans') })
    const saves = store.saves
    const again = command('queue_remove:caller:1', plan)
    expect(plan).not.toHaveBeenCalled()
    expect(again).toMatchObject({ replayed: true, effectsSettled: true, result: first.result })
    expect(store.saves).toBe(saves)
    expect(effectLog).toHaveLength(1)
  })

  it('an enqueue replays its item id after a turn claimed it, and the stored result holds no message text', () => {
    const planned = () => command('queue_enqueue:caller:1', (items) => {
      const { item } = enqueueMessage(items, { threadId: THREAD, content: 'run this later', source: 'mcp', permissionMode: 'ask' })
      return { intent: { ...base, op: 'enqueue', itemId: item.id, item } }
    })
    const first = planned()
    const item = file[0]
    expect(first.result.itemId).toBe(item.id)
    expect(JSON.stringify(first.result)).not.toContain('run this later')
    expect(db.statement('SELECT result FROM queue_commands').get()).toEqual({ result: expect.not.stringContaining('run this later') })
    expect(listPendingQueue(file).map((entry) => entry.id)).toEqual([item.id])
    file = claimNextNormal(file, { ownerPid: process.pid, ownerToken: 'tok' }).items
    file = file.filter((entry) => entry.id !== item.id)
    const again = planned()
    expect(again).toMatchObject({ replayed: true, result: { outcome: 'enqueued', itemId: item.id } })
    expect(file).toEqual([])
  })

  it('a crash after the entry and before the file write is finished from the entry alone, by the next change to the queue', () => {
    file = seed()
    const target = file[0]
    store.failSave = 1
    expect(() => command('queue_edit:caller:1', edit(target.id, 'rewritten'))).toThrow(/could not be written/)
    expect(file[0].content).toBe('message 0')
    expect(rowOf('queue_edit:caller:1')).toMatchObject({ status: 'pending', intent: { patch: { content: 'rewritten' } } })
    expect(effectLog).toEqual([])

    // Any other change to the thread's queue (a claim, an ack, another command) recovers first.
    const recovered = recoverQueueJournal(store, THREAD, store.loadMessageQueue(THREAD))
    expect(recovered[0]).toMatchObject({ content: 'rewritten', permissionMode: 'ask', origin: { kind: 'agent', threadId: 'caller' } })
    expect(file[0].content).toBe('rewritten')
    expect(rowOf('queue_edit:caller:1')).toMatchObject({ status: 'applied', result: { outcome: 'edited', itemId: target.id } })

    // The retry, without any of its original arguments, returns what the command did.
    const plan = vi.fn(() => { throw new Error('a retry never plans') })
    expect(command('queue_edit:caller:1', plan)).toMatchObject({ replayed: true, effectsSettled: true, result: { outcome: 'edited', itemId: target.id } })
    expect(plan).not.toHaveBeenCalled()
  })

  it('a crash after the file write and before the marker is finished without changing the file twice, and the effects run once', () => {
    file = seed()
    const target = file[0]
    // The file write happened; the process died before the effects and the marker: the entry is still pending.
    store.saveMessageQueue(THREAD, file.map((item) => (item.id === target.id ? { ...item, content: 'rewritten' } : item)))
    new QueueCommands(db).insertPending('queue_edit:caller:1', { ...base, op: 'edit', itemId: target.id, patch: { content: 'rewritten' }, cancelRunIds: ['run-old'] })
    const saves = store.saves
    recoverQueueJournal(store, THREAD, store.loadMessageQueue(THREAD))
    expect(store.saves).toBe(saves + 1)
    expect(file.filter((item) => item.content === 'rewritten')).toHaveLength(1)
    expect(effectLog).toEqual([`edit:${target.id}:cancel=run-old:release=`])
    // Recovering again finds nothing to do.
    recoverQueueJournal(store, THREAD, store.loadMessageQueue(THREAD))
    expect(effectLog).toHaveLength(1)
  })

  it('a failed effect is never marked applied: the entry waits as effects_pending, the caller\'s next change goes through, and the repair commits the effects once', () => {
    file = seed()
    const target = file[0]
    failEffects = 1
    const outcome = command('queue_remove:caller:1', () => ({ intent: { ...base, op: 'remove', itemId: target.id, cancelRunIds: ['run-old'], releaseInboxIds: ['inbox-1'] } }))
    expect(outcome).toMatchObject({ replayed: false, effectsSettled: false, result: { outcome: 'removed' } })
    expect(file.map((item) => item.id)).not.toContain(target.id)
    expect(rowOf('queue_remove:caller:1')).toMatchObject({ status: 'effects_pending' })
    expect(effectLog).toEqual([])
    expect(repairs).toBe(1)

    // A retry while the effects are still pending returns the same result and says so.
    failEffects = 1
    expect(command('queue_remove:caller:1', () => { throw new Error('no plan') })).toMatchObject({ replayed: true, effectsSettled: false, result: { outcome: 'removed' } })
    expect(effectLog).toEqual([])

    // The next change to the queue repairs it first and then proceeds.
    const next = command('queue_enqueue:caller:2', (items) => {
      const { item } = enqueueMessage(items, { threadId: THREAD, content: 'meanwhile' })
      return { intent: { ...base, op: 'enqueue', itemId: item.id, item } }
    })
    expect(next).toMatchObject({ effectsSettled: true })
    expect(effectLog[0]).toBe(`remove:${target.id}:cancel=run-old:release=inbox-1`)
    expect(effectLog.filter((line) => line.startsWith('remove:'))).toHaveLength(1)
    expect(rowOf('queue_remove:caller:1')).toMatchObject({ status: 'applied' })
    expect(command('queue_remove:caller:1', () => { throw new Error('no plan') })).toMatchObject({ replayed: true, effectsSettled: true })
  })

  it('a workflow command is abandoned before the effects commit, once', () => {
    file = seed(1)
    command('queue_remove:caller:1', () => ({ intent: { ...base, op: 'remove', itemId: file[0].id, abandonWorkflowInvocationId: '123e4567-e89b-42d3-a456-426614174000' } }))
    expect(effectLog[0]).toBe('abandon:123e4567-e89b-42d3-a456-426614174000')
  })

  it('writes the entry and its audit event in one transaction: an event that fails leaves no entry and no change', () => {
    file = seed(1)
    const target = file[0]
    const journal = store.getQueueJournal()!
    journal.effects.audit = () => { throw new Error('the event could not be written') }
    expect(() => command('queue_edit:caller:1', () => ({
      intent: { ...base, op: 'edit', itemId: target.id, patch: { content: 'x' } },
      audit: { action: 'edited_queued_message', details: {} }
    }))).toThrow(/event could not be written/)
    expect(rowOf('queue_edit:caller:1')).toBeNull()
    expect(file[0].content).toBe('message 0')
  })

  it('a request key used for a change to another thread is a conflict, not a replay', () => {
    file = seed(1)
    command('queue_remove:caller:1', () => ({ intent: { ...base, op: 'remove', itemId: file[0].id } }))
    expect(() => runQueueCommand(store, 'thread-2', 'queue_remove:caller:1', [], () => ({ intent: { ...base, threadId: 'thread-2', op: 'remove', itemId: 'x' } })))
      .toThrow(expect.objectContaining({ code: 'request_conflict' }))
  })

  it('a promotion recovered after its run is no longer the active one goes back to a pending message without its run, and is reported as requeued', () => {
    file = seed(1)
    const item = { ...file[0], runId: 'run-queued', permissionMode: 'ask' as const }
    file = [item]
    activeRun = 'run-b'
    new QueueCommands(db).insertPending('queue_promote_to_steer:caller:1', { ...base, op: 'promote', itemId: item.id, steerRunId: 'run-a', permissionMode: 'ask', cancelRunIds: ['run-queued'] })
    recoverQueueJournal(store, THREAD, store.loadMessageQueue(THREAD))
    expect(file[0]).toMatchObject({ id: item.id, intent: 'normal', state: 'pending', permissionMode: 'ask' })
    expect(file[0].runId).toBeUndefined()
    expect(file[0].steerRunId).toBeUndefined()
    expect(effectLog).toEqual([`promote:${item.id}:cancel=run-queued:release=`])
    expect(rowOf('queue_promote_to_steer:caller:1')).toMatchObject({ status: 'applied', result: { outcome: 'requeued', steerRunId: 'run-a' } })
  })

  it('a promotion recovered while its run is still the active one is steering, bound to it, and keeps its mode limit', () => {
    file = seed(1)
    activeRun = 'run-a'
    new QueueCommands(db).insertPending('queue_promote_to_steer:caller:1', { ...base, op: 'promote', itemId: file[0].id, steerRunId: 'run-a', permissionMode: 'ask' })
    recoverQueueJournal(store, THREAD, store.loadMessageQueue(THREAD))
    expect(file[0]).toMatchObject({ intent: 'steer', state: 'steering', steerRunId: 'run-a', permissionMode: 'ask' })
    expect(rowOf('queue_promote_to_steer:caller:1')).toMatchObject({ status: 'applied', result: { outcome: 'promoted' } })
  })

  it('each operation is idempotent against its own effect when recovery meets a file that already has it', () => {
    file = seed(3)
    const [a, b, c] = file
    const intents: QueueIntent[] = [
      { ...base, op: 'reorder', itemId: c.id, orderedIds: [c.id, a.id, b.id] },
      { ...base, op: 'remove', itemId: a.id },
      { ...base, op: 'edit', itemId: b.id, patch: { content: 'b2' } }
    ]
    intents.forEach((intent, index) => command(`k:${index}`, () => ({ intent })))
    const after = structuredClone(file)
    // The same entries found pending again (a crash before their markers): applying them changes nothing more.
    intents.forEach((intent, index) => {
      db.statement("UPDATE queue_commands SET status = 'pending', intent = ? WHERE command_key = ?").run(JSON.stringify(intent), `k:${index}`)
    })
    recoverQueueJournal(store, THREAD, store.loadMessageQueue(THREAD))
    expect(file).toEqual(after)
  })

  it('leaves recovery alone inside another transaction, and costs one indexed query when nothing is unfinished', () => {
    file = seed(1)
    new QueueCommands(db).insertPending('queue_remove:caller:1', { ...base, op: 'remove', itemId: file[0].id })
    db.transaction(() => {
      expect(recoverQueueJournal(store, THREAD, store.loadMessageQueue(THREAD))).toHaveLength(1)
    })
    expect(rowOf('queue_remove:caller:1')).toMatchObject({ status: 'pending' })
    recoverQueueJournal(store, THREAD, store.loadMessageQueue(THREAD))
    expect(rowOf('queue_remove:caller:1')).toMatchObject({ status: 'applied' })
    const plan = db.database.prepare("EXPLAIN QUERY PLAN SELECT * FROM queue_commands WHERE thread_id = ? AND status IN ('pending','effects_pending')").all(THREAD).map((step) => String(step.detail)).join(' ')
    expect(plan).toContain('queue_commands_thread_status')
  })

  it('an edit recovered after its item moved on edits nothing and cancels no run: the item keeps the run it owns', () => {
    file = seed(2)
    const [a, b] = file
    // `a` is steering now (a later promotion), `b` is gone: the entries of two earlier edits are still pending.
    file = [{ ...a, runId: 'run-a', intent: 'steer', state: 'steering' }]
    for (const [key, item] of [['k:a', a], ['k:b', b]] as const)
      new QueueCommands(db).insertPending(key, { ...base, op: 'edit', itemId: item.id, patch: { content: 'late', dropRun: true }, cancelRunIds: [`run-${item.id}`] })
    recoverQueueJournal(store, THREAD, store.loadMessageQueue(THREAD))
    // The entries are finished, but no run was named for cancelling.
    expect(effectLog).toHaveLength(2)
    expect(effectLog.every((line) => line.endsWith(':cancel=:release='))).toBe(true)
    expect(file[0]).toMatchObject({ id: a.id, runId: 'run-a', content: 'message 0' })
    expect(rowOf('k:a')).toMatchObject({ status: 'applied' })
    expect(rowOf('k:b')).toMatchObject({ status: 'applied' })
  })

  it('an entry that keeps failing is tried a few times and then left alone: it no longer blocks or retries on every change, and its key says so', () => {
    file = seed(2)
    const target = file[0]
    new QueueCommands(db).insertPending('queue_edit:caller:1', { ...base, op: 'edit', itemId: target.id, patch: { content: 'never lands' } })
    store.failSave = 1000
    const unrelated = (key: string) => command(key, (items) => {
      const { item } = enqueueMessage(items, { threadId: THREAD, content: key })
      return { intent: { ...base, op: 'enqueue', itemId: item.id, item } }
    })
    // The file cannot be written, so every change meets the entry again until it is given up.
    for (let attempt = 1; attempt <= QUEUE_COMMAND_MAX_ATTEMPTS; attempt += 1) {
      expect(rowOf('queue_edit:caller:1')).toMatchObject({ status: 'pending', attempts: attempt - 1 })
      expect(() => recoverQueueJournal(store, THREAD, store.loadMessageQueue(THREAD))).not.toThrow()
    }
    expect(rowOf('queue_edit:caller:1')).toMatchObject({ status: 'failed', attempts: QUEUE_COMMAND_MAX_ATTEMPTS })
    // Given up: a change to the queue goes through without retrying it (the first save it makes is its own).
    store.failSave = 0
    const saves = store.saves
    unrelated('queue_enqueue:caller:2')
    expect(store.saves).toBe(saves + 1)
    expect(rowOf('queue_edit:caller:1')).toMatchObject({ status: 'failed' })
    // And a retry of that key is told it was given up, so it can be sent again under a new key.
    expect(() => command('queue_edit:caller:1', () => { throw new Error('no plan') })).toThrow(expect.objectContaining({ code: 'command_failed' }))
  })

  it('effects that can never commit stop being retried too, and a retry of the key still gets the result with the effects marked unsettled', () => {
    file = seed(1)
    const target = file[0]
    failEffects = 1000
    const first = command('queue_remove:caller:1', () => ({ intent: { ...base, op: 'remove', itemId: target.id, cancelRunIds: ['run-old'] } }))
    expect(first.effectsSettled).toBe(false)
    for (let attempt = 1; attempt < QUEUE_COMMAND_MAX_ATTEMPTS; attempt += 1) recoverQueueJournal(store, THREAD, store.loadMessageQueue(THREAD))
    expect(rowOf('queue_remove:caller:1')).toMatchObject({ status: 'failed' })
    const repairs = repairsSoFar()
    recoverQueueJournal(store, THREAD, store.loadMessageQueue(THREAD))
    expect(repairsSoFar()).toBe(repairs)
    expect(command('queue_remove:caller:1', () => { throw new Error('no plan') })).toMatchObject({ replayed: true, effectsSettled: false, result: { outcome: 'removed' } })
  })

  it('a request key that comes back with other fields is a conflict, not a replay; the same fields (and another revision) are a retry', () => {
    file = seed(2)
    const [a, b] = file
    const plan = (itemId: string): Parameters<typeof runQueueCommand>[4] => () => ({ intent: { ...base, op: 'remove', itemId } })
    runQueueCommand(store, THREAD, 'queue_remove:caller:1', store.loadMessageQueue(THREAD), plan(a.id), 'fp-a')
    expect(() => runQueueCommand(store, THREAD, 'queue_remove:caller:1', store.loadMessageQueue(THREAD), plan(b.id), 'fp-b')).toThrow(expect.objectContaining({ code: 'request_conflict' }))
    expect(file.map((item) => item.id)).toEqual([b.id])
    expect(runQueueCommand(store, THREAD, 'queue_remove:caller:1', store.loadMessageQueue(THREAD), plan(a.id), 'fp-a')).toMatchObject({ replayed: true, result: { outcome: 'removed', itemId: a.id } })
  })

  it('finished entries are pruned after their retention, and the entries of a deleted thread go; recent and unfinished ones stay', () => {
    const commands = new QueueCommands(db)
    const now = Date.now()
    const insert = (key: string, thread: string, status: string, ageMs: number) =>
      db.statement('INSERT INTO queue_commands(command_key, thread_id, intent, status, created_at, applied_at) VALUES(?, ?, ?, ?, ?, ?)')
        .run(key, thread, '{}', status, new Date(now - ageMs).toISOString(), status === 'pending' ? null : new Date(now - ageMs).toISOString())
    const day = 24 * 60 * 60 * 1000
    insert('old-applied', THREAD, 'applied', QUEUE_COMMAND_RETENTION_MS + day)
    insert('old-failed', THREAD, 'failed', QUEUE_COMMAND_RETENTION_MS + day)
    insert('new-applied', THREAD, 'applied', day)
    insert('old-pending', THREAD, 'pending', QUEUE_COMMAND_RETENTION_MS + day)
    expect(commands.prune(now)).toBe(2)
    expect(db.statement('SELECT command_key FROM queue_commands ORDER BY command_key').all()).toEqual([{ command_key: 'new-applied' }, { command_key: 'old-pending' }])
    insert('gone-1', 'thread-gone', 'applied', day)
    expect(commands.deleteForThread('thread-gone')).toBe(1)
    expect(commands.get('new-applied')).not.toBeNull()
  })

  it('a store without a journal never recovers and refuses an agent command', () => {
    const bare: QueueStoreLike = { loadMessageQueue: () => [], saveMessageQueue: () => undefined, getQueueJournal: () => undefined }
    const items = seed(1)
    expect(recoverQueueJournal(bare, THREAD, items)).toBe(items)
    expect(() => runQueueCommand(bare, THREAD, 'k', items, () => ({ intent: { ...base, op: 'remove', itemId: items[0].id } }))).toThrow(/need the run engine/)
  })
})
