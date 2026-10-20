import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { CREDENTIAL_IDLE_TTL_MS, hashToken, McpCredentials } from '../../src/mms/run/mcp/McpCredentials'
import { RunStore } from '../../src/mms/run/RunStore'

const T0 = Date.parse('2026-10-12T00:00:00.000Z')

describe('McpCredentials (SPEC §15.1)', () => {
  const homes: string[] = []
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  const setup = () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-mcp-credentials-'))
    homes.push(home)
    let clock = T0
    const db = new ProfileDatabase({ profileHome: home, clock: () => clock })
    const credentials = new McpCredentials(new RunStore(db))
    return { db, credentials, advance: (ms: number) => { clock += ms } }
  }

  it('mints a random token and stores only its SHA-256', () => {
    const { db, credentials } = setup()
    const minted = credentials.mint({ threadId: 't1', runId: 'r1', provider: 'claude-subscription', modeCeiling: 'default' })
    const other = credentials.mint({ threadId: 't1', runId: 'r1', provider: 'claude-subscription', modeCeiling: 'default' })
    expect(minted.token).not.toBe(other.token)
    expect(Buffer.from(minted.token, 'base64url')).toHaveLength(32)
    expect(minted.tokenHash).toBe(hashToken(minted.token))
    expect(minted.tokenHash).not.toBe(minted.token)
    const rows = db.database.prepare('SELECT * FROM credentials').all()
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(Object.values(row)).not.toContain(minted.token)
    expect(credentials.resolve(minted.token)).toMatchObject({
      tokenHash: minted.tokenHash, threadId: 't1', runId: 'r1', provider: 'claude-subscription', modeCeiling: 'default', revokedAt: null
    })
    expect(credentials.resolve('not-a-token')).toBeNull()
    expect(credentials.resolve('')).toBeNull()
    expect(credentials.resolve(minted.tokenHash)).toBeNull()
  })

  it('refuses a mode ceiling other than plan or default, minting nothing and leaving a reusable credential as it was', () => {
    const { db, credentials } = setup()
    const bad = { threadId: 't1', runId: 'r1', provider: 'p', modeCeiling: 'bypass' as never }
    expect(() => credentials.mint(bad)).toThrow('modeCeiling must be plan or default.')
    expect(db.database.prepare('SELECT * FROM credentials').all()).toEqual([])
    const kept = credentials.mintOrReuse({ threadId: 't1', runId: 'r1', provider: 'p', modeCeiling: 'plan' })
    expect(() => credentials.mintOrReuse({ ...bad, runId: 'r2' })).toThrow('modeCeiling must be plan or default.')
    expect(db.database.prepare('SELECT * FROM credentials').all()).toHaveLength(1)
    expect(credentials.resolve(kept.token)).toMatchObject({ runId: 'r1', modeCeiling: 'plan' })
  })

  it('revokes by run and by thread', () => {
    const { credentials } = setup()
    const a = credentials.mint({ threadId: 't1', runId: 'r1', provider: 'p', modeCeiling: 'plan' })
    const b = credentials.mint({ threadId: 't1', runId: 'r2', provider: 'p', modeCeiling: 'default' })
    const c = credentials.mint({ threadId: 't2', runId: 'r3', provider: 'p', modeCeiling: 'default' })
    expect(credentials.revokeForRun('r1')).toBe(1)
    expect(credentials.revokeForRun('r1')).toBe(0)
    expect(credentials.resolve(a.token)).toBeNull()
    expect(credentials.resolve(b.token)).not.toBeNull()
    expect(credentials.revokeForThread('t1')).toBe(1)
    expect(credentials.resolve(b.token)).toBeNull()
    expect(credentials.resolve(c.token)).not.toBeNull()
    const listed = credentials.listForThread('t1')
    expect(listed.map((row) => [row.runId, row.modeCeiling, Boolean(row.revokedAt)])).toEqual([['r1', 'plan', true], ['r2', 'default', true]])
    for (const row of listed) expect(row).not.toHaveProperty('tokenHash')
  })

  it('expires after 24 h idle; a request touches last_seen_at; pruneExpired deletes dead rows', () => {
    const { credentials, advance } = setup()
    const live = credentials.mint({ threadId: 't1', runId: 'r1', provider: 'p', modeCeiling: 'default' })
    const idle = credentials.mint({ threadId: 't1', runId: 'r2', provider: 'p', modeCeiling: 'default' })
    const revoked = credentials.mint({ threadId: 't1', runId: 'r3', provider: 'p', modeCeiling: 'default' })
    credentials.revokeForRun('r3')
    advance(CREDENTIAL_IDLE_TTL_MS - 1000)
    expect(credentials.resolve(live.token)?.lastSeenAt).toBe(new Date(T0 + CREDENTIAL_IDLE_TTL_MS - 1000).toISOString())
    expect(credentials.pruneExpired()).toBe(0)
    advance(2000)
    expect(credentials.resolve(idle.token)).toBeNull()
    expect(credentials.resolve(live.token)).not.toBeNull()
    expect(credentials.resolve(revoked.token)).toBeNull()
    expect(credentials.pruneExpired()).toBe(2)
    expect(credentials.listForThread('t1').map((row) => row.runId)).toEqual(['r1'])
    advance(CREDENTIAL_IDLE_TTL_MS + 1)
    expect(credentials.resolve(live.token)).toBeNull()
  })

  it('mintOrReuse keeps one token per thread and provider, re-pointed at each turn', () => {
    const { credentials, advance } = setup()
    const first = credentials.mintOrReuse({ threadId: 't1', runId: 'r1', provider: 'claude-subscription', modeCeiling: 'default' })
    expect(first.reused).toBe(false)
    advance(1000)
    const second = credentials.mintOrReuse({ threadId: 't1', runId: 'r2', provider: 'claude-subscription', modeCeiling: 'plan' })
    expect(second).toEqual({ token: first.token, tokenHash: first.tokenHash, reused: true })
    expect(credentials.resolve(first.token)).toMatchObject({ runId: 'r2', modeCeiling: 'plan', lastSeenAt: new Date(T0 + 1000).toISOString() })
    expect(credentials.listForThread('t1')).toHaveLength(1)

    // Another thread gets its own token.
    const other = credentials.mintOrReuse({ threadId: 't2', runId: 'r9', provider: 'claude-subscription', modeCeiling: 'default' })
    expect(other.token).not.toBe(first.token)

    // A provider switch revokes the thread's previous credential.
    const switched = credentials.mintOrReuse({ threadId: 't1', runId: 'r3', provider: 'antigravity', modeCeiling: 'default' })
    expect(switched.reused).toBe(false)
    expect(credentials.resolve(first.token)).toBeNull()
    expect(credentials.resolve(switched.token)).toMatchObject({ provider: 'antigravity', runId: 'r3' })

    // Revoked or idle credentials are never reused.
    credentials.revokeForThread('t1')
    const fresh = credentials.mintOrReuse({ threadId: 't1', runId: 'r4', provider: 'antigravity', modeCeiling: 'default' })
    expect(fresh.token).not.toBe(switched.token)
    advance(CREDENTIAL_IDLE_TTL_MS + 1)
    const afterIdle = credentials.mintOrReuse({ threadId: 't1', runId: 'r5', provider: 'antigravity', modeCeiling: 'default' })
    expect(afterIdle.token).not.toBe(fresh.token)
    expect(credentials.listForThread('t1').filter((row) => !row.revokedAt).map((row) => row.runId)).toEqual(['r5'])
  })

  it('survives a reopen of the database (durable, unlike an in-memory registry)', () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-mcp-credentials-'))
    homes.push(home)
    const first = new ProfileDatabase({ profileHome: home })
    const minted = new McpCredentials(new RunStore(first)).mint({ threadId: 't', runId: 'r', provider: 'p', modeCeiling: 'default' })
    first.close()
    const second = new ProfileDatabase({ profileHome: home })
    const credentials = new McpCredentials(new RunStore(second))
    expect(credentials.resolve(minted.token)).toMatchObject({ runId: 'r' })
    // The token is gone from memory after the restart: the next turn revokes the row and mints anew.
    const next = credentials.mintOrReuse({ threadId: 't', runId: 'r2', provider: 'p', modeCeiling: 'default' })
    expect(next.reused).toBe(false)
    expect(credentials.resolve(minted.token)).toBeNull()
    expect(credentials.revokeForRun('r2')).toBe(1)
    second.close()
  })
})
