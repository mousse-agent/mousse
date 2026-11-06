import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProfileDatabase } from '../../../src/mms/run/db/ProfileDatabase'
import { BotMemoryStore, type BotMemoryStoreOptions } from '../../../src/mms/bots/memory/BotMemoryStore'
import { BOT_MEMORY_SCHEMA_SQL } from '../../../src/mms/bots/memory/schema'
import type { BotJournalInput } from '../../../src/mms/bots/seams'

/**
 * A `bots.db`-style database for the memory tests: the memory tables from `BOT_MEMORY_SCHEMA_SQL`
 * (as WP2's v4 migration runs it) and a minimal `bot_messages`, on a real `ProfileDatabase`.
 */

export const T0 = Date.parse('2026-11-07T10:00:00.000Z')
export const TZ = 'Europe/London'

export interface MemoryFixture {
  home: string
  db: ProfileDatabase
  store: BotMemoryStore
  clock: { now: number }
  /** A new store over the same database, as a daemon restart opens it. */
  reopen(options?: Partial<BotMemoryStoreOptions>): BotMemoryStore
  /** Writes a `bot_messages` row and its journal row in one transaction, as WP2's `BotStore` does. */
  message(input: { botId: string; id: string; author: 'owner' | 'bot'; kind?: 'text' | 'run_report' | 'notice'; text: string; activationId?: string; at?: string }): number
  dispose(): void
}

const fixtures: MemoryFixture[] = []

export function memoryFixture(options: Partial<BotMemoryStoreOptions> = {}): MemoryFixture {
  const home = mkdtempSync(join(tmpdir(), 'bot-memory-'))
  const clock = { now: T0 }
  const db = new ProfileDatabase({ profileHome: home, name: 'bots', clock: () => clock.now })
  db.migrate([{
    version: 1,
    sql: `CREATE TABLE bot_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, bot_id TEXT NOT NULL, at TEXT NOT NULL,
      author TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, activation_id TEXT) STRICT;\n${BOT_MEMORY_SCHEMA_SQL}`
  }])
  const open = (extra: Partial<BotMemoryStoreOptions> = {}) => new BotMemoryStore({ db, clock: () => clock.now, timeZone: () => TZ, ...options, ...extra })
  const store = open()
  const fixture: MemoryFixture = {
    home,
    db,
    store,
    clock,
    reopen: open,
    message: (input) => db.transaction(() => {
      const at = input.at ?? new Date(clock.now).toISOString()
      db.statement('INSERT INTO bot_messages(id, bot_id, at, author, kind, text, activation_id) VALUES(?, ?, ?, ?, ?, ?, ?)')
        .run(input.id, input.botId, at, input.author, input.kind ?? 'text', input.text, input.activationId ?? null)
      const kind: BotJournalInput['kind'] = input.author === 'owner' ? 'owner_msg' : input.kind === 'run_report' ? 'run_report' : input.kind === 'notice' ? 'notice' : 'bot_msg'
      return store.appendInTx(db, {
        botId: input.botId,
        kind,
        lane: input.kind === 'run_report' ? 'run' : 'chat',
        ...(input.activationId ? { activationId: input.activationId } : {}),
        sourceKey: `bm:${input.id}`,
        who: input.author === 'owner' ? 'owner' : 'bot',
        text: input.text
      }, at)!
    }),
    dispose: () => {
      db.close()
      rmSync(home, { recursive: true, force: true })
    }
  }
  fixtures.push(fixture)
  return fixture
}

export function disposeFixtures(): void {
  for (const fixture of fixtures.splice(0)) fixture.dispose()
}

/** Advances the fixture clock. */
export function later(fixture: MemoryFixture, ms: number): void {
  fixture.clock.now += ms
}

export const HOUR = 3_600_000
export const DAY = 24 * HOUR
