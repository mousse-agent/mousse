/**
 * How a sign-in reaches `opencode:sealed`'s own server (docs/plans/one-shots-every-provider.md §5): never the person's
 * OpenCode database, a copy of it or its folder. An API key is read from their database at the time of each request and
 * handed to the sealed server through its API; a key replaced in their database (the file itself replaced) is the one
 * the next request uses; a provider connected through a variable gets that variable alone. An account sign-in (OAuth)
 * goes in the same way, under its own row id; a renewal the sealed server makes is written back to their row, unless
 * their own OpenCode renewed that row meanwhile, and a request is not sent when their database would not take that
 * write. Otherwise their database is never written. On the real OpenCode (`realOpencode.ts`) against a loopback stub,
 * with dummy keys and a fake account sign-in (`stubAccountPlugin`) whose renewal asks the stub.
 */
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyOneShotFailure, oneShotWasSent } from '../src/mms/harness/oneShot/runner'
import { modelStub, opencodeBinary, opencodeRuntime, placesLeft, sendOnce, STUB_ACCOUNT_METHOD, stubAccount, stubAccountPlugin, stubProviderConfig, throwawayUser, type ModelStub } from './harness/realOpencode'

const binary = opencodeBinary()
const cleanups: Array<() => void | Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** An OpenCode database with one sign-in for the stub provider, the way OpenCode 2.0 keeps it (`credential` rows). */
function database(path: string, value: Record<string, unknown>): void {
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)')
  const insert = db.prepare('INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)')
  // An older, inactive sign-in of the same provider, which is never the one used.
  insert.run('cred_old', 'stub', 'old', JSON.stringify({ type: 'key', key: 'retired-key' }), 0, 1, 1)
  insert.run('cred_now', 'stub', 'default', JSON.stringify(value), 1, 2, 2)
  db.close()
}

const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

describe.skipIf(!binary)('a sealed OpenCode request’s sign-in (real OpenCode)', () => {
  function setup(stateFile?: Record<string, unknown>, env: Record<string, string> = {}) {
    const user = throwawayUser()
    cleanups.push(user.remove)
    const data = join(user.env.XDG_DATA_HOME!, 'opencode')
    mkdirSync(data, { recursive: true })
    if (stateFile) {
      mkdirSync(join(user.profile, 'state'), { recursive: true })
      writeFileSync(join(user.profile, 'state', 'opencode.json'), JSON.stringify(stateFile))
    }
    return { user, db: join(data, 'opencode.db'), env: { ...user.env, ...env } }
  }

  it('uses the API key in their database at the time of each request; a replaced database file gives the next one its key', async () => {
    const { user, db, env } = setup()
    database(db, { type: 'key', key: 'key-one' })
    const stub = await modelStub()
    cleanups.push(() => stub.close())
    const runtime = opencodeRuntime(binary!, env, user.profile, { oneShotConfigContent: stubProviderConfig(stub) })
    cleanups.push(() => runtime.stop())

    const before = digest(db)
    expect(await sendOnce(runtime).sent).toBe('Fix login bug')
    expect(stub.requests.map((request) => request.authorization)).toEqual(['Bearer key-one'])
    expect(digest(db)).toBe(before)

    // The key is rotated the way a tool replaces a file: a new database written beside it and moved over it.
    const next = `${db}.next`
    database(next, { type: 'key', key: 'key-two' })
    renameSync(next, db)
    const rotated = digest(db)
    expect(await sendOnce(runtime).sent).toBe('Fix login bug')
    expect(stub.requests.map((request) => request.authorization)).toEqual(['Bearer key-one', 'Bearer key-two'])
    expect(digest(db)).toBe(rotated)
    expect(placesLeft(user.profile)).toEqual([])
  }, 120_000)

  /** A runtime whose sealed servers know the fake account sign-in (`stubAccountPlugin`). */
  function accountRuntime(user: ReturnType<typeof setup>['user'], env: Record<string, string>, stub: ModelStub) {
    const config = stubProviderConfig(stub, undefined, 'stub', 'stub-model', [stubAccountPlugin(join(user.root, 'account-plugin'), stub)])
    const runtime = opencodeRuntime(binary!, env, user.profile, { oneShotConfigContent: config })
    cleanups.push(() => runtime.stop())
    return runtime
  }
  const row = (db: string) => {
    const read = new DatabaseSync(db, { readOnly: true })
    try {
      return Object.fromEntries((read.prepare('SELECT id, value FROM credential').all() as Array<{ id: string; value: string }>).map((each) => [each.id, JSON.parse(each.value) as Record<string, unknown>]))
    } finally {
      read.close()
    }
  }

  it.each([
    ['answers', undefined, 'Fix login bug'],
    ['answers 429', 429, undefined]
  ] as const)('an account sign-in renewed during the request is written back to their row (the model %s)', async (_name, status, answer) => {
    const { user, db, env } = setup()
    database(db, stubAccount())
    const stub = await modelStub()
    cleanups.push(() => stub.close())
    if (status) stub.statuses = [status]
    const runtime = accountRuntime(user, env, stub)
    const sent = sendOnce(runtime).sent
    if (answer) expect(await sent).toBe(answer)
    else await expect(sent).rejects.toBeTruthy()
    // The sealed server renewed the expired sign-in with their refresh token and asked the model with the new one.
    expect(stub.renewals).toEqual(['refresh-1'])
    expect(stub.requests.map((request) => request.authorization)).toEqual(['Bearer access-2'])
    // Their row holds the renewal (a renewal can retire the refresh token they had); the retired row is untouched.
    expect(row(db)).toEqual({
      cred_now: expect.objectContaining({ type: 'oauth', methodID: STUB_ACCOUNT_METHOD, access: 'access-2', refresh: 'refresh-2', expires: expect.any(Number) }),
      cred_old: { type: 'key', key: 'retired-key' }
    })
    expect(placesLeft(user.profile)).toEqual([])
  }, 120_000)

  it('an account sign-in not due for renewal is handed in as it is, and their database is left byte for byte', async () => {
    const { user, db, env } = setup()
    database(db, stubAccount(Date.now() + 24 * 60 * 60_000))
    const stub = await modelStub()
    cleanups.push(() => stub.close())
    const runtime = accountRuntime(user, env, stub)
    const before = digest(db)
    expect(await sendOnce(runtime).sent).toBe('Fix login bug')
    expect(stub.renewals).toEqual([])
    expect(stub.requests.map((request) => request.authorization)).toEqual(['Bearer access-1'])
    expect(digest(db)).toBe(before)
  }, 120_000)

  it('a row their own OpenCode renewed meanwhile is kept: the request’s renewal is dropped', async () => {
    const { user, db, env } = setup()
    database(db, stubAccount())
    const stub = await modelStub()
    cleanups.push(() => stub.close())
    // While the sealed server renews, their OpenCode renews the same sign-in itself.
    const theirs = stubAccount(Date.now() + 3_600_000, { access: 'access-theirs', refresh: 'refresh-theirs' })
    stub.onRenewal = () => {
      const write = new DatabaseSync(db)
      try {
        write.prepare('UPDATE credential SET value = ?, time_updated = ? WHERE id = ?').run(JSON.stringify(theirs), Date.now(), 'cred_now')
      } finally {
        write.close()
      }
    }
    const runtime = accountRuntime(user, env, stub)
    expect(await sendOnce(runtime).sent).toBe('Fix login bug')
    expect(stub.renewals).toEqual(['refresh-1'])
    expect(row(db).cred_now).toEqual(theirs)
    expect(placesLeft(user.profile)).toEqual([])
  }, 120_000)

  it.each([
    ['read-only', (db: string) => {
      chmodSync(db, 0o444)
      return () => chmodSync(db, 0o644)
    }],
    ['locked by a running OpenCode', (db: string) => {
      const holder = new DatabaseSync(db)
      holder.exec('BEGIN IMMEDIATE')
      return () => {
        holder.exec('ROLLBACK')
        holder.close()
      }
    }]
  ] as const)('an account sign-in whose database is %s is not sent: nothing starts and nothing reaches the model', async (_name, hold) => {
    const { user, db, env } = setup()
    database(db, stubAccount())
    const stub = await modelStub()
    cleanups.push(() => stub.close())
    const runtime = accountRuntime(user, env, stub)
    const before = digest(db)
    const release = hold(db)
    cleanups.push(release)
    const { seen, sent } = sendOnce(runtime)
    const error = await sent.then(() => undefined, (failure: unknown) => failure)
    expect(classifyOneShotFailure(error)).toBe('not_admitted')
    expect((error as Error).message).toMatch(/could not write to OpenCode's sign-ins/)
    expect(seen.launched).toEqual([])
    expect(seen.sent).toBe(0)
    expect(oneShotWasSent(error)).toBeUndefined()
    expect(stub.requests).toEqual([])
    expect(stub.renewals).toEqual([])
    cleanups.splice(cleanups.indexOf(release), 1)
    release()
    expect(digest(db)).toBe(before)
    expect(placesLeft(user.profile)).toEqual([])
  }, 60_000)

  it('a provider connected through a variable gets that variable, which nothing else of the environment carries', async () => {
    const signIns = { stub: { kind: 'env', names: ['STUB_TEST_KEY'] } }
    const { user, env } = setup({ connected: { providers: ['stub'], checkedAt: new Date().toISOString(), signIns } }, { STUB_TEST_KEY: 'variable-key' })
    const stub = await modelStub()
    cleanups.push(() => stub.close())
    const config = JSON.parse(stubProviderConfig(stub)) as { providers: { stub: Record<string, unknown> } }
    config.providers.stub.env = ['STUB_TEST_KEY']
    const runtime = opencodeRuntime(binary!, env, user.profile, { oneShotConfigContent: JSON.stringify(config) })
    cleanups.push(() => runtime.stop())
    expect(await sendOnce(runtime).sent).toBe('Fix login bug')
    expect(stub.requests.map((request) => request.authorization)).toEqual(['Bearer variable-key'])
  }, 60_000)
})
