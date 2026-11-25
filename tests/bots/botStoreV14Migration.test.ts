/**
 * bots.db v13 → v14: what started each activation (`provenance`). A row an older build wrote keeps NULL and reads the
 * provenance its lane, key and trigger give; a row this build writes stores it; an older build refuses the database.
 * Real SQLite, no engine.
 *
 * Inputs: every start the engine writes (owner message and its continuation, a tapped answer, the bot's first message,
 * a wake, a question's default, a thread's notice and message, another bot's message, the three Resume retries, work,
 * a schedule, a run by hand) and ones no build writes (`future:start`, `resume:chat:`, `resume:answer:`), in both lanes;
 * a stored provenance this build does not know; both writers; reopen; an older build opening the new database.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BOTS_DB_VERSION, BOTS_MIGRATIONS, BotStore, deriveBotProvenance, type BotActivationProvenance } from '../../src/mms/bots/store/BotStore'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { asksOwner, memoryLaneOf, ownerChatTurn, threadsActOf, threadsReadOnlyOf } from '../../src/mms/bots/activation/BotEngine'
import type { BotActivationTrigger, BotLane } from '../../src/shared/bots/personal/definition'

const dirs: string[] = []
const stores: BotStore[] = []
const T = '2026-11-24T08:00:00.000Z'
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function folder() { const dir = mkdtempSync(join(tmpdir(), 'bots-v14-')); dirs.push(dir); return dir }
function open(profileHome: string) { const store = new BotStore({ profileHome }); stores.push(store); return store }

const manual: BotActivationTrigger = { kind: 'manual', input: 'Hi' }
const work: BotActivationTrigger = { kind: 'work', input: 'Look it up', title: 'Research', from: 'chat-1' }
const schedule: BotActivationTrigger = { kind: 'schedule', input: 'Morning news', scheduleId: 's1', occurrenceAt: T }

// [key, lane, trigger, provenance]
const STARTS: Array<[string, BotLane, BotActivationTrigger, BotActivationProvenance]> = [
  ['chat:msg', 'chat', manual, 'owner_message'],
  ['chat:after:msg', 'chat', manual, 'owner_message'],
  ['chat:resume:act0', 'chat', manual, 'owner_message'],
  ['answer:q', 'chat', manual, 'owner_tap'],
  ['answer:resume:act0', 'chat', manual, 'owner_tap'],
  ['create:bot', 'chat', manual, 'first_message'],
  ['resume:create:bot', 'chat', manual, 'first_message'],
  ['wake:w1', 'chat', manual, 'wake'],
  ['resume:wake:w1', 'chat', manual, 'wake'],
  ['question:q:default', 'chat', manual, 'question'],
  ['job:j1:act0', 'chat', manual, 'job'],
  ['resume:resume:job:j1', 'chat', manual, 'job'],
  ['threadmsg:t1:r1', 'chat', manual, 'threadmsg'],
  ['botmsg:b1:m1', 'chat', manual, 'botmsg'],
  // Resume of another bot's message keeps no start of its own (`chatToRetry`).
  ['resume:act1', 'chat', manual, 'botmsg'],
  ['action:a1', 'chat', manual, 'action_result'],
  ['future:start', 'chat', manual, 'unknown'],
  // Nor these: the owner's start behind a `resume:` is never the owner's.
  ['resume:chat:act0', 'chat', manual, 'botmsg'],
  ['resume:answer:act0', 'chat', manual, 'botmsg'],
  ['work:k1', 'run', work, 'work'],
  ['sched:b:s1:t', 'run', schedule, 'schedule'],
  ['manual:m1', 'run', manual, 'manual'],
  // A run's start is its trigger, never its key.
  ['chat:looks-like-owner', 'run', work, 'work']
]

/** A v13 database with one activation per start, written as v13 wrote them (no provenance column). */
function buildV13(profileHome: string) {
  const db = new ProfileDatabase({ profileHome, name: 'bots' })
  db.migrate(BOTS_MIGRATIONS.filter((m) => m.version <= 13))
  STARTS.forEach(([key, lane, trigger], i) => db.statement(
    'INSERT INTO bot_activations(id, bot_id, revision, grant_digest, trigger_json, idempotency_key, status, created_at, lane) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(`old-${i}`, 'b', 'r', 'g', JSON.stringify(trigger), key, 'queued', T, lane))
  db.close()
}

describe('bots.db v13 → v14', () => {
  it('adds an empty provenance column, and an older row reads the provenance its lane, key and trigger give', () => {
    const home = folder()
    buildV13(home)
    const store = open(home)
    expect(store.db.userVersion()).toBe(BOTS_DB_VERSION)
    expect(BOTS_DB_VERSION).toBeGreaterThanOrEqual(14)
    expect(store.all('SELECT provenance FROM bot_activations').every((row) => row.provenance === null)).toBe(true)
    STARTS.forEach(([key, lane, trigger, provenance], i) => {
      const row = store.activation(`old-${i}`)!
      expect({ key: row.idempotencyKey, provenance: row.provenance }).toEqual({ key, provenance })
      expect(deriveBotProvenance({ lane, idempotencyKey: key, trigger })).toBe(provenance)
    })
  })

  it('both writers store the provenance, and the turn-kind rules read stored and derived rows the same', () => {
    const home = folder()
    buildV13(home)
    const store = open(home)
    STARTS.forEach(([key, lane, trigger, provenance], i) => {
      const row = { id: `new-${i}`, botId: 'b', revision: 'r', grantDigest: 'g', trigger, idempotencyKey: key, status: 'queued' as const, createdAt: T, lane }
      // Keys are unique: the older row with this key makes way for the new one.
      store.run('DELETE FROM bot_activations WHERE idempotency_key = ?', key)
      if (i % 2) store.insertActivation(row, {})
      else expect(store.insertActivationOnce(row, {})).toBe(true)
      expect(store.get('SELECT provenance FROM bot_activations WHERE id = ?', row.id)).toEqual({ provenance })
      const stored = store.activation(row.id)!
      const legacy = { lane, idempotencyKey: key, trigger }
      expect([ownerChatTurn(stored), memoryLaneOf(stored), threadsActOf(stored), threadsReadOnlyOf(stored), asksOwner(stored)])
        .toEqual([ownerChatTurn(legacy), memoryLaneOf(legacy), threadsActOf(legacy), threadsReadOnlyOf(legacy), asksOwner(legacy)])
    })
    // The same key again: the second insert finds the first and writes nothing.
    expect(store.insertActivationOnce({ id: 'again', botId: 'b', revision: 'r', grantDigest: 'g', trigger: manual, idempotencyKey: 'chat:msg', status: 'queued', createdAt: T, lane: 'chat' }, {})).toBe(false)
    expect(store.activation('again')).toBeUndefined()
  })

  it('a writer may name a provenance its key does not give; a row spread from another activation never carries that one\'s', () => {
    const store = open(folder())
    store.insertActivation({ id: 'named', botId: 'b', revision: 'r', grantDigest: 'g', trigger: manual, idempotencyKey: 'future:start', status: 'queued', createdAt: T, lane: 'chat' }, {}, { provenance: 'action_result' })
    expect(store.activation('named')!.provenance).toBe('action_result')
    store.insertActivation({ id: 'owner', botId: 'b', revision: 'r', grantDigest: 'g', trigger: manual, idempotencyKey: 'chat:m', status: 'queued', createdAt: T, lane: 'chat' }, {})
    const owner = store.activation('owner')!
    expect(owner.provenance).toBe('owner_message')
    store.insertActivation({ ...owner, id: 'copied', idempotencyKey: 'botmsg:b2:m2' }, {})
    expect(store.activation('copied')!.provenance).toBe('botmsg')
    expect(threadsReadOnlyOf(store.activation('copied')!)).toBe('not_owner')
    store.insertActivation({ ...owner, id: 'copied-work', lane: 'run', idempotencyKey: 'work:copied', trigger: work }, {})
    expect(asksOwner(store.activation('copied-work')!)).toBe(true)
  })

  it('a stored provenance only a newer build knows reads as its lane, key and trigger give', () => {
    const store = open(folder())
    store.insertActivation({ id: 'botmsg', botId: 'b', revision: 'r', grantDigest: 'g', trigger: manual, idempotencyKey: 'botmsg:b2:m2', status: 'queued', createdAt: T, lane: 'chat' }, {})
    store.insertActivation({ id: 'run', botId: 'b', revision: 'r', grantDigest: 'g', trigger: work, idempotencyKey: 'work:k9', status: 'queued', createdAt: T, lane: 'run' }, {})
    store.run("UPDATE bot_activations SET provenance = 'owner_voice'")
    expect([store.activation('botmsg')!.provenance, store.activation('run')!.provenance]).toEqual(['botmsg', 'work'])
    expect(threadsReadOnlyOf(store.activation('botmsg')!)).toBe('not_owner')
  })

  it('reopens without change, and an older build refuses the database', () => {
    const home = folder()
    buildV13(home)
    const first = open(home)
    first.insertActivation({ id: 'kept', botId: 'b', revision: 'r', grantDigest: 'g', trigger: manual, idempotencyKey: 'wake:kept', status: 'queued', createdAt: T, lane: 'chat' }, {})
    const before = first.all('SELECT id, provenance FROM bot_activations ORDER BY id')
    first.close()
    stores.splice(stores.indexOf(first), 1)
    const again = open(home)
    expect(again.all('SELECT id, provenance FROM bot_activations ORDER BY id')).toEqual(before)
    expect(again.activation('kept')!.provenance).toBe('wake')
    again.close()
    stores.splice(stores.indexOf(again), 1)
    const older = new ProfileDatabase({ profileHome: home, name: 'bots' })
    try {
      expect(() => older.migrate(BOTS_MIGRATIONS.filter((m) => m.version <= 13))).toThrowError(expect.objectContaining({ code: 'downgrade_unsupported' }))
    } finally { older.close() }
  })
})
