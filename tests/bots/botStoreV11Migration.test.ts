/** Storage inputs: populated v10, fresh/v11 reopen, duplicate call, invalid domains, mid-migration failure,
 * deletion/reset/purge, both wipes, another bot, and masked export. No provider or daemon is started. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BOTS_MIGRATIONS, BotStore } from '../../src/mms/bots/store/BotStore'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { BotMemoryStore } from '../../src/mms/bots/memory/BotMemoryStore'
import { createBotMemoryAdmin } from '../../src/mms/bots/memory/admin'
import { botFixture, createBot } from './botFixture'

const dirs: string[] = []
const stores: BotStore[] = []
const T = '2026-11-16T08:00:00.000Z'
function folder() { const dir = mkdtempSync(join(tmpdir(), 'bots-v11-')); dirs.push(dir); return dir }
function open(profileHome: string) { const store = new BotStore({ profileHome }); stores.push(store); return store }
function action(store: BotStore, botId = 'b', id = botId) {
  store.run(`INSERT INTO bot_actions(id, call_key, bot_id, activation_id, lane, kind, target_json,
    exec_args, args_json, args_digest, binding_json, status, created_at)
    VALUES (?, ?, ?, 'a', 'run', 'mcp', '{}', 'private exact arguments', '{"masked":true}', 'digest', '{}', 'open', ?)`, id, id, botId, T)
}
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function buildV10(profileHome: string) {
  const db = new ProfileDatabase({ profileHome, name: 'bots' })
  db.migrate(BOTS_MIGRATIONS.filter((m) => m.version <= 10))
  // Seed every ordinary table, including all optional columns. Respect each closed set in the schema.
  const tables = db.statement("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name LIKE 'bot_%' AND sql LIKE '%STRICT%'").all()
  for (const table of tables) {
    const columns = db.statement(`PRAGMA table_info(${table.name})`).all()
    const values = columns.map((c) => {
      const domain = String(table.sql).match(new RegExp(`\\b${c.name}\\b[^,\\n]*?IN \\(('([^']+)')`))
      if (domain) return domain[2]!
      if (c.type === 'INTEGER' || c.type === 'REAL') return 1
      if (String(c.name).endsWith('_json')) return '{}'
      return 'old bytes\r\n café 🐈'
    })
    db.statement(`INSERT INTO ${table.name}(${columns.map((c) => c.name).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...values)
  }
  const before = Object.fromEntries(tables.map((t) => [String(t.name), db.statement(`SELECT * FROM ${t.name}`).all()]))
  db.close()
  return before
}

describe('bots.db v10 → v11', () => {
  it('preserves every old field in every table, matches a fresh schema, and reopens without changes', () => {
    const home = folder(), before = buildV10(home), store = open(home)
    expect(store.db.userVersion()).toBe(11)
    for (const [table, rows] of Object.entries(before)) {
      const columns = Object.keys(rows[0]!).join(',')
      expect(store.all(`SELECT ${columns} FROM ${table}`)).toEqual(rows)
    }
    expect(store.get('SELECT work_id FROM bot_reminders')).toEqual({ work_id: null })
    const schema = (s: BotStore) => s.all("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
    expect(schema(store)).toEqual(schema(open(folder())))
    const copy = readFileSync(join(home, 'bots', 'bots.db.pre-v11'))
    store.close()
    const again = open(home)
    expect(again.db.userVersion()).toBe(11)
    expect(again.all('SELECT * FROM bot_actions')).toEqual([])
    expect(readFileSync(join(home, 'bots', 'bots.db.pre-v11'))).toEqual(copy)
    expect(again.get('PRAGMA integrity_check')).toEqual({ integrity_check: 'ok' })
  })

  it('rolls back a failure after the new table and before the reminder column', () => {
    const home = folder(), before = buildV10(home)
    const db = new ProfileDatabase({ profileHome: home, name: 'bots' })
    const migration = BOTS_MIGRATIONS.at(-1)!
    expect(() => db.migrate([...BOTS_MIGRATIONS.slice(0, -1), {
      ...migration, sql: migration.sql.replace('ALTER TABLE bot_reminders', 'SELECT * FROM missing_table; ALTER TABLE bot_reminders')
    }])).toThrow()
    expect(db.userVersion()).toBe(10)
    expect(db.statement("SELECT name FROM sqlite_master WHERE name = 'bot_actions'").all()).toEqual([])
    expect(db.statement('PRAGMA table_info(bot_reminders)').all().some((c) => c.name === 'work_id')).toBe(false)
    for (const [table, rows] of Object.entries(before)) expect(db.statement(`SELECT * FROM ${table}`).all()).toEqual(rows)
    db.migrate(BOTS_MIGRATIONS.filter((m) => m.version <= 10))
    db.close()
    expect(open(home).db.userVersion()).toBe(11)
  })

  it('enforces call identity and closed domains and permits cleared arguments and absent lifecycle fields', () => {
    const store = open(folder())
    action(store)
    expect(() => store.run("INSERT INTO bot_actions SELECT 'second', call_key, bot_id, activation_id, lane, kind, target_json, exec_args, args_json, args_digest, binding_json, place_json, card_json, bot_note, status, result_json, message_id, next_at, nudges, expires_at, answered_at, answered_device, created_at, ran_at FROM bot_actions")).toThrow()
    for (const [column, value] of [['kind', 'unknown'], ['status', 'unknown'], ['lane', 'unknown']])
      expect(() => store.run(`UPDATE bot_actions SET ${column} = ?`, value!)).toThrow()
    for (const kind of ['mcp', 'secret_fetch']) store.run('UPDATE bot_actions SET kind = ?', kind)
    for (const status of ['open', 'approved', 'declined', 'expired', 'withdrawn', 'running', 'done', 'failed', 'uncertain'])
      store.run('UPDATE bot_actions SET status = ?', status)
    store.run('UPDATE bot_actions SET exec_args = NULL')
    expect(store.get('SELECT exec_args, nudges, message_id, expires_at FROM bot_actions')).toEqual({ exec_args: null, nudges: 0, message_id: null, expires_at: null })
    store.insertReminder({ id: 'r', botId: 'b', dueAt: T, text: 'Timer', createdAt: T, work: null, replyTo: null })
    expect(store.reminder('r')?.workId).toBeNull()
    expect(store.all('PRAGMA foreign_key_list(bot_actions)')).toEqual([])
    expect(store.all('PRAGMA index_list(bot_actions)').map((r) => r.name)).toEqual(expect.arrayContaining(['bot_actions_due', 'bot_actions_bot', 'bot_actions_activation']))
  })

  it.each(['delete', 'reset', 'purge'] as const)('%s removes only that bot’s actions through its public path', async (operation) => {
    const f = botFixture()
    try {
      const { botId } = await createBot(f)
      action(f.store, botId); action(f.store, 'other')
      if (operation === 'reset') await f.bots.resetBot(botId)
      else if (operation === 'delete') await f.bots.service.delete(botId)
      else {
        await f.bots.service.delete(botId)
        action(f.store, botId)
        await f.bots.sweepDeleted(f.clock.now + 31 * 24 * 60 * 60_000)
      }
      expect(f.store.all('SELECT bot_id FROM bot_actions')).toEqual([{ bot_id: 'other' }])
    } finally { f.close() }
  })

  it.each([true, false])('wipe keepSaved=%s removes actions and leaves another bot alone', (keepSaved) => {
    const store = open(folder()), memory = new BotMemoryStore({ db: store.db })
    action(store); action(store, 'other')
    memory.wipe('b', keepSaved)
    expect(store.all('SELECT bot_id FROM bot_actions')).toEqual([{ bot_id: 'other' }])
  })

  it('exports masked actions without executable arguments and includes them in whole-database backups', async () => {
    const store = open(folder()), memory = new BotMemoryStore({ db: store.db })
    action(store); action(store, 'other')
    const result = await createBotMemoryAdmin({ store: memory }).export('b', folder())
    const file = result.files.find((p) => p.endsWith('actions.jsonl'))!
    const text = readFileSync(file, 'utf8')
    expect(JSON.parse(text)).toMatchObject({ id: 'b', args_json: '{"masked":true}' })
    expect(text).not.toContain('private exact arguments')
    expect(JSON.parse(text)).not.toHaveProperty('exec_args')
    const path = join(folder(), 'backup.db')
    store.db.database.exec(`VACUUM INTO '${path}'`)
    const { DatabaseSync } = await import('node:sqlite')
    const backup = new DatabaseSync(path)
    try { expect(backup.prepare('SELECT * FROM bot_actions').all()).toEqual(store.all('SELECT * FROM bot_actions')) }
    finally { backup.close() }
  })
})
