import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NetDatabase } from '../../../../src/mms/net/store/database'
import { SqliteExecutionLedger } from '../../../../src/mms/net/store/executions'
import { SqliteCompartmentStore } from '../../../../src/mms/bots/compartments'
import { newId } from '../../../../src/shared/net'
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
})
function setup() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'net-bot-context-')))
  cleanup.push(() => rmSync(path, { recursive: true, force: true }))
  let db = new NetDatabase({ profileDir: path })
  cleanup.push(() => db.close())
  let store = new SqliteCompartmentStore(db, 'profile-a')
  const bot = newId('bot'),
    space = newId('space'),
    stream = newId('stream'),
    hash = Buffer.alloc(32, 1).toString('base64url')
  return {
    bot,
    space,
    stream,
    hash,
    get db() {
      return db
    },
    get store() {
      return store
    },
    restart() {
      db.close()
      db = new NetDatabase({ profileDir: path })
      store = new SqliteCompartmentStore(db, 'profile-a')
    }
  }
}
describe('durable audience scoped bot context', () => {
  it('keeps public/private spaces and every visibility epoch separate across restart', () => {
    const f = setup(),
      pub = f.store.publicId(f.bot, f.space),
      private1 = f.store.privateId(f.bot, f.stream, 1),
      private2 = f.store.privateId(f.bot, f.stream, 2),
      binding = { profileId: 'profile-a', space: f.space, bot: f.bot }
    f.store.bind(pub, binding)
    f.store.bind(private1, {
      ...binding,
      privateStream: f.stream,
      visibilityEpoch: 1,
      participantHash: f.hash
    })
    f.store.appendTurn(pub, { role: 'user', text: 'PUBLIC', ts: 1 })
    f.store.appendTurn(private1, { role: 'assistant', text: 'PRIVATE', ts: 2 })
    f.restart()
    f.store.bind(private2, {
      ...binding,
      privateStream: f.stream,
      visibilityEpoch: 2,
      participantHash: Buffer.alloc(32, 2).toString('base64url')
    })
    expect(f.store.history(pub, 100).map((t) => t.text)).toEqual(['PUBLIC'])
    expect(f.store.history(private1, 100).map((t) => t.text)).toEqual(['PRIVATE'])
    expect(f.store.history(private2, 100)).toEqual([])
    expect(() => new SqliteCompartmentStore(f.db, 'profile-b').binding(pub)).toThrow(
      expect.objectContaining({ code: 'forbidden' })
    )
    expect(() =>
      f.store.bind(private1, {
        ...binding,
        privateStream: f.stream,
        visibilityEpoch: 1,
        participantHash: Buffer.alloc(32, 3).toString('base64url')
      })
    ).toThrow(expect.objectContaining({ code: 'conflict' }))
  })
  it('rejects unknown/forged tuples, path syntax, oversized turns and dropping live context', () => {
    const f = setup(),
      pub = f.store.publicId(f.bot, f.space),
      binding = { profileId: 'profile-a', space: f.space, bot: f.bot }
    expect(() => f.store.bind('../escape', binding)).toThrow()
    expect(() => f.store.bind(pub, { ...binding, visibilityEpoch: 1 })).toThrow()
    expect(() => f.store.history(pub, 10)).toThrow()
    f.store.bind(pub, binding)
    expect(() =>
      f.store.appendTurn(pub, { role: 'user', text: 'x'.repeat(65537), ts: 1 })
    ).toThrow()
    const ledger = new SqliteExecutionLedger(f.db),
      record = f.db.transaction(() => {
        const r = ledger.admit(
          { scope: f.space, target: f.bot, trigger: newId('event') },
          'a'.repeat(64),
          1
        ).record
        ledger.bindRun(r.id, {
          ...binding,
          stream: f.stream,
          compartment: pub,
          backingThreadId: 'thread',
          workspaceId: 'workspace',
          definitionRevision: 'v1',
          profileDigest: f.hash
        })
        return r
      })
    expect(() => f.store.drop(pub)).toThrow(expect.objectContaining({ code: 'conflict' }))
    ledger.transition(record.id, 'failed', 2)
    f.store.drop(pub)
    expect(f.store.binding(pub)).toBeUndefined()
    expect(ledger.get(record.id)!.state).toBe('failed')
  })
})
