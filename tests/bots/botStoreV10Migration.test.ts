/** Storage-only phase 1: old rows, repeated opens, backups, downgrade, constraints and pending telling. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BOTS_MIGRATIONS, BotStore } from '../../src/mms/bots/store/BotStore'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'

let profile: string
let store: BotStore | undefined
const T = '2026-11-16T08:00:00.000Z'
const tables = ['bot_registry', 'bot_messages', 'bot_reminders'] as const

function buildV9() {
  const db = new ProfileDatabase({ profileHome: profile, name: 'bots' })
  try {
    db.migrate(BOTS_MIGRATIONS.filter((m) => m.version <= 9))
    db.statement('INSERT INTO bot_registry(bot_id, revision, home_thread_id, created_at, model_json) VALUES (?, ?, ?, ?, ?)')
      .run('b', 'revision', 'home', T, '{"selection":{"instanceId":"pi:test"},"activationId":"a"}')
    db.statement(`INSERT INTO bot_messages(id, bot_id, at, author, kind, text, reply_to, owner_reaction, owner_reaction_at, cards_json)
      VALUES ('m', 'b', ?, 'bot', 'text', 'Hello', 'owner-message', '❤️', ?, '[]')`).run(T, T)
    db.statement(`INSERT INTO bot_reminders(id, bot_id, due_at, text, created_at, status, wake, chain, event_json)
      VALUES ('r', 'b', ?, 'Follow up', ?, 'waiting', 1, 2, '{"kind":"thread","threadId":"t"}')`).run(T, T)
    return Object.fromEntries(tables.map((table) => [table, db.statement(`SELECT * FROM ${table}`).all()]))
  } finally {
    db.close()
  }
}

beforeEach(() => { profile = mkdtempSync(join(tmpdir(), 'mousse-bots-v10-')) })
afterEach(() => {
  store?.close()
  store = undefined
  rmSync(profile, { recursive: true, force: true })
})

describe('bots.db v9 → v10', () => {
  it('preserves every old field, defaults new columns, and leaves a second open unchanged', () => {
    const before = buildV9()
    store = new BotStore({ profileHome: profile })
    expect(store.db.userVersion()).toBe(10)
    for (const table of tables) {
      const rows = store.all(`SELECT * FROM ${table}`)
      expect(rows).toHaveLength(1)
      expect(rows).toMatchObject(before[table])
    }
    expect(store.get('SELECT snoozed_from, owner_set FROM bot_reminders')).toEqual({ snoozed_from: null, owner_set: null })
    expect(store.get('SELECT tell, tell_at, told_at FROM bot_messages')).toEqual({ tell: null, tell_at: null, told_at: null })
    expect(store.get('SELECT tell_json FROM bot_registry')).toEqual({ tell_json: null })
    expect(store.reminder('r')).toMatchObject({ snoozedFrom: null, ownerSet: null, wake: true, chain: 2 })
    expect(store.message('m')).toMatchObject({ tell: null, tellAt: null, toldAt: null, ownerReaction: { emoji: '❤️', at: T } })
    expect(store.registry('b')).toMatchObject({ tellJson: null })
    const rows = tables.map((table) => store!.all(`SELECT * FROM ${table}`))
    const copy = readFileSync(join(profile, 'bots', 'bots.db.pre-v10'))
    store.close()
    store = new BotStore({ profileHome: profile })
    expect(tables.map((table) => store!.all(`SELECT * FROM ${table}`))).toEqual(rows)
    expect(readFileSync(join(profile, 'bots', 'bots.db.pre-v10'))).toEqual(copy)
  })

  it('backs up v9 before altering it and keeps only the newest two copies', () => {
    const before = buildV9()
    const dir = join(profile, 'bots')
    writeFileSync(join(dir, 'bots.db.pre-v8'), 'old')
    writeFileSync(join(dir, 'bots.db.pre-v9'), 'previous')
    store = new BotStore({ profileHome: profile })
    const copy = new DatabaseSync(join(dir, 'bots.db.pre-v10'), { readOnly: true })
    try {
      expect(copy.prepare('PRAGMA user_version').get()).toEqual({ user_version: 9 })
      for (const table of tables) expect(copy.prepare(`SELECT * FROM ${table}`).all()).toEqual(before[table])
      expect(copy.prepare('PRAGMA table_info(bot_messages)').all().some((c) => c.name === 'tell')).toBe(false)
    } finally { copy.close() }
    expect(existsSync(join(dir, 'bots.db.pre-v9'))).toBe(true)
    expect(existsSync(join(dir, 'bots.db.pre-v8'))).toBe(false)
  })

  it('refuses a newer database with the existing code and words', () => {
    buildV9()
    const db = new DatabaseSync(join(profile, 'bots', 'bots.db'))
    db.exec('PRAGMA user_version = 11')
    db.close()
    expect(() => new BotStore({ profileHome: profile })).toThrowError(expect.objectContaining({
      code: 'downgrade_unsupported', message: 'Profile database schema 11 is newer than this build (10).'
    }))
    expect(existsSync(join(profile, 'bots', 'bots.db.pre-v10'))).toBe(false)
  })

  it('reads reserved fields but existing writers leave them at their defaults', () => {
    buildV9()
    store = new BotStore({ profileHome: profile })
    store.run('UPDATE bot_registry SET tell_json = ?', '{"canWakeMe":true}')
    store.run('UPDATE bot_reminders SET snoozed_from = ?, owner_set = 1', 'original')
    store.run("UPDATE bot_messages SET tell = 'soon', tell_at = ?, told_at = ?", T, T)
    expect(store.registry('b')).toMatchObject({ tellJson: '{"canWakeMe":true}' })
    expect(store.reminder('r')).toMatchObject({ snoozedFrom: 'original', ownerSet: true })
    expect(store.message('m')).toMatchObject({ tell: 'soon', tellAt: T, toldAt: T })
    store.insertMessage({ ...store.message('m')!, id: 'm2' })
    store.insertReminder({ ...store.reminder('r')!, id: 'r2' })
    expect(store.message('m2')).toMatchObject({ tell: null, tellAt: null, toldAt: null })
    expect(store.reminder('r2')).toMatchObject({ snoozedFrom: null, ownerSet: null })
  })

  it('enforces the reserved value domains on STRICT tables', () => {
    buildV9()
    store = new BotStore({ profileHome: profile })
    for (const ownerSet of [-1, 2, 'invalid'])
      expect(() => store!.run('UPDATE bot_reminders SET owner_set = ?', ownerSet)).toThrow()
    for (const [value, ownerSet] of [[null, null], [0, false], [1, true]] as const) {
      store.run('UPDATE bot_reminders SET owner_set = ?', value)
      expect(store.reminder('r')?.ownerSet).toBe(ownerSet)
    }
    for (const tell of ['never', '', 1])
      expect(() => store!.run('UPDATE bot_messages SET tell = ?', tell)).toThrow()
    store.run('UPDATE bot_messages SET tell_at = ?', T)
    for (const tell of ['now', 'soon', 'later', null])
      expect(() => store!.run('UPDATE bot_messages SET tell = ?', tell)).not.toThrow()
    for (const table of tables)
      expect(store.get('SELECT strict FROM pragma_table_list WHERE name = ?', table)).toEqual({ strict: 1 })
  })

  it('refuses a telling without its release time', () => {
    buildV9()
    store = new BotStore({ profileHome: profile })
    for (const tell of ['now', 'soon', 'later']) {
      expect(() => store!.run('UPDATE bot_messages SET tell = ?, tell_at = NULL', tell)).toThrow()
      store.run('UPDATE bot_messages SET tell = ?, tell_at = ?', tell, T)
      expect(() => store!.run('UPDATE bot_messages SET tell_at = NULL')).toThrow()
      store.run('UPDATE bot_messages SET tell = NULL, tell_at = NULL')
    }
  })

  it('uses the partial index to find only rows waiting to be told', () => {
    buildV9()
    store = new BotStore({ profileHome: profile })
    for (const [id, tell, tellAt, toldAt] of [
      ['pending', 'now', T, null], ['future', 'later', '2026-11-17T08:00:00.000Z', null],
      ['told', 'soon', T, T], ['never', null, T, null]
    ]) {
      store.run("INSERT INTO bot_messages(id, bot_id, at, author, kind, text, tell, tell_at, told_at) VALUES (?, 'b', ?, 'bot', 'text', 'Report', ?, ?, ?)",
        id, T, tell, tellAt, toldAt)
    }
    const query = 'SELECT id FROM bot_messages WHERE tell IS NOT NULL AND told_at IS NULL AND tell_at <= ? ORDER BY tell_at'
    expect(store.all(query, T)).toEqual([{ id: 'pending' }])
    expect(store.all(`EXPLAIN QUERY PLAN ${query}`, T).some((row) => String(row.detail).includes('bot_messages_tell_due'))).toBe(true)
    for (const perBot of [
      'SELECT MIN(tell_at) AS next FROM bot_messages WHERE bot_id = ? AND tell IS NOT NULL AND told_at IS NULL',
      'SELECT id FROM bot_messages WHERE bot_id = ? AND tell IS NOT NULL AND told_at IS NULL AND tell_at <= ? ORDER BY tell_at LIMIT 1'
    ]) {
      const params = perBot.includes('tell_at <= ?') ? ['b', T] : ['b']
      const plan = store.all(`EXPLAIN QUERY PLAN ${perBot}`, ...params).map((row) => String(row.detail)).join(' ')
      expect(plan).toContain('USING INDEX bot_messages_tell_due (bot_id=?')
      expect(plan).not.toContain('TEMP B-TREE')
    }
    expect(store.all('PRAGMA index_list(bot_messages)')).toContainEqual(expect.objectContaining({ name: 'bot_messages_tell_due', partial: 1 }))
  })
})
