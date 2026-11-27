/**
 * How a sign-in reaches `opencode:sealed`'s own server (docs/plans/one-shots-every-provider.md §5): never the person's
 * OpenCode database, a copy of it or its folder. An API key is read from their database at the time of each request and
 * handed to the sealed server through its API; a key replaced in their database (the file itself replaced) is the one
 * the next request uses; an account sign-in (OAuth), whose renewal the sealed server would keep where their OpenCode
 * never sees it, is refused before anything starts; a provider connected through a variable gets that variable alone.
 * Their database is never written. On the real OpenCode (`realOpencode.ts`) against a loopback stub; dummy keys only.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyOneShotFailure, oneShotWasSent } from '../src/mms/harness/oneShot/runner'
import { modelStub, opencodeBinary, opencodeRuntime, placesLeft, sendOnce, stubProviderConfig, throwawayUser } from './harness/realOpencode'

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

  it('refuses an account sign-in before anything starts, and leaves it as it was', async () => {
    const { user, db, env } = setup()
    database(db, { type: 'oauth', methodID: 'device', refresh: 'refresh-token', access: 'access-token', expires: 1 })
    const stub = await modelStub()
    cleanups.push(() => stub.close())
    const runtime = opencodeRuntime(binary!, env, user.profile, { oneShotConfigContent: stubProviderConfig(stub) })
    cleanups.push(() => runtime.stop())
    const before = digest(db)
    const { seen, sent } = sendOnce(runtime)
    const error = await sent.then(() => undefined, (failure: unknown) => failure)
    expect(classifyOneShotFailure(error)).toBe('not_admitted')
    expect((error as Error).message).toMatch(/signs in to stub with an account/)
    expect(seen.launched).toEqual([])
    expect(seen.sent).toBe(0)
    expect(oneShotWasSent(error)).toBeUndefined()
    expect(stub.requests).toEqual([])
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
