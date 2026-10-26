import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { CREDENTIAL_IDLE_TTL_MS, hashToken, McpCredentials, type BearerTurn } from '../../src/mms/run/mcp/McpCredentials'
import { RunStore } from '../../src/mms/run/RunStore'

const T0 = Date.parse('2026-10-12T00:00:00.000Z')

describe('McpCredentials (SPEC §15.1)', () => {
  const homes: string[] = []
  const databases: ProfileDatabase[] = []
  afterEach(() => {
    for (const db of databases.splice(0)) db.close()
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  const setup = () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-mcp-credentials-'))
    homes.push(home)
    let clock = T0
    const db = new ProfileDatabase({ profileHome: home, clock: () => clock })
    databases.push(db)
    const credentials = new McpCredentials(new RunStore(db))
    return { db, credentials, advance: (ms: number) => { clock += ms } }
  }
  const turn = (overrides: Partial<BearerTurn> = {}): BearerTurn => ({
    threadId: 't1', instanceId: 'claude', runId: 'r1', modeCeiling: 'default', binding: 'per_call', generation: 'claude|default|0|0', ...overrides
  })

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
      tokenHash: minted.tokenHash, threadId: 't1', runId: 'r1', provider: 'claude-subscription', modeCeiling: 'default', revokedAt: null, epoch: 0, binding: 'rotate'
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
    const kept = credentials.bearerForTurn(turn({ modeCeiling: 'plan' }))
    expect(() => credentials.bearerForTurn(turn({ runId: 'r2', modeCeiling: 'bypass' as never }))).toThrow('modeCeiling must be plan or default.')
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

  it('bearerForTurn keeps a per_call bearer across turns, re-bound to each run; another instance revokes it', () => {
    const { credentials, advance } = setup()
    const first = credentials.bearerForTurn(turn())
    expect(first.reused).toBe(false)
    advance(1000)
    const second = credentials.bearerForTurn(turn({ runId: 'r2', modeCeiling: 'plan' }))
    expect(second).toEqual({ token: first.token, tokenHash: first.tokenHash, reused: true, epoch: first.epoch })
    expect(credentials.resolve(first.token)).toMatchObject({ runId: 'r2', modeCeiling: 'plan', binding: 'per_call', lastSeenAt: new Date(T0 + 1000).toISOString() })
    expect(credentials.listForThread('t1')).toHaveLength(1)

    // Another thread gets its own token.
    const other = credentials.bearerForTurn(turn({ threadId: 't2', runId: 'r9' }))
    expect(other.token).not.toBe(first.token)

    // An instance switch revokes the thread's previous credential.
    const switched = credentials.bearerForTurn(turn({ runId: 'r3', instanceId: 'codex', binding: 'drained_turn', generation: 'codex|default|0|0' }))
    expect(switched.reused).toBe(false)
    expect(credentials.resolve(first.token)).toBeNull()
    expect(credentials.resolve(switched.token)).toMatchObject({ provider: 'codex', runId: 'r3', binding: 'drained_turn' })

    // Revoked or idle credentials are never reused.
    credentials.revokeForThread('t1')
    const fresh = credentials.bearerForTurn(turn({ runId: 'r4', instanceId: 'codex', binding: 'drained_turn', generation: 'codex|default|0|0' }))
    expect(fresh.token).not.toBe(switched.token)
    advance(CREDENTIAL_IDLE_TTL_MS + 1)
    const afterIdle = credentials.bearerForTurn(turn({ runId: 'r5', instanceId: 'codex', binding: 'drained_turn', generation: 'codex|default|0|0' }))
    expect(afterIdle.token).not.toBe(fresh.token)
    expect(credentials.listForThread('t1').filter((row) => !row.revokedAt).map((row) => row.runId)).toEqual(['r5'])
  })

  it('a new runtime (account, settings, home or driver) is a new epoch that closes the old bearer at once', () => {
    const { credentials } = setup()
    const first = credentials.bearerForTurn(turn())
    const sameRuntime = credentials.bearerForTurn(turn({ runId: 'r2' }))
    expect(sameRuntime.reused).toBe(true)
    const signedInAgain = credentials.bearerForTurn(turn({ runId: 'r3', generation: 'claude|default|1|0' }))
    expect(signedInAgain.reused).toBe(false)
    expect(signedInAgain.epoch).toBe(first.epoch + 1)
    expect(credentials.resolve(first.token)).toBeNull()
    expect(credentials.current(first.tokenHash)).toBeNull()
    expect(credentials.currentEpoch('t1', 'claude')).toBe(signedInAgain.epoch)
    // A bump revokes the epoch's credentials; the next turn mints in the new epoch.
    credentials.bumpEpoch('t1', 'claude')
    expect(credentials.resolve(signedInAgain.token)).toBeNull()
    const next = credentials.bearerForTurn(turn({ runId: 'r4', generation: 'claude|default|1|0' }))
    expect(next.epoch).toBe(signedInAgain.epoch + 1)
  })

  it('a rotate binding gets a new bearer every turn', () => {
    const { credentials } = setup()
    const first = credentials.bearerForTurn(turn({ binding: 'rotate' }))
    const second = credentials.bearerForTurn(turn({ runId: 'r2', binding: 'rotate' }))
    expect(second.token).not.toBe(first.token)
    expect(credentials.resolve(first.token)).toBeNull()
  })

  describe('settleTurn (drained-turn proof)', () => {
    const drainedSetup = () => {
      const s = setup()
      const codex = (runId: string) => turn({ runId, instanceId: 'codex', binding: 'drained_turn', generation: 'codex|default|0|0' })
      return { ...s, codex }
    }

    it('keeps a drained_turn bearer only after a completed turn whose announced calls match what Mousse received', () => {
      const { credentials, codex } = drainedSetup()
      const first = credentials.bearerForTurn(codex('r1'))
      credentials.callReceived(first.tokenHash, 'r1')
      credentials.callRunning(first.tokenHash, 'r1', 1)
      credentials.callRunning(first.tokenHash, 'r1', -1)
      expect(credentials.settleTurn(first.tokenHash, 'r1', { status: 'completed', drain: { mousseCalls: 1, toolsSettled: true } })).toBe('kept')
      const next = credentials.bearerForTurn(codex('r2'))
      expect(next).toMatchObject({ token: first.token, reused: true })
    })

    it.each([
      ['a stopped turn', { status: 'aborted' as const, drain: { mousseCalls: 0, toolsSettled: true } }, 0, 0],
      ['a failed turn', { status: 'failed' as const }, 0, 0],
      ['a call still running at settle', { status: 'completed' as const, drain: { mousseCalls: 1, toolsSettled: true } }, 1, 1],
      ['a call Codex started that Mousse never received', { status: 'completed' as const, drain: { mousseCalls: 2, toolsSettled: true } }, 1, 0],
      ['a call Mousse received that Codex did not announce', { status: 'completed' as const, drain: { mousseCalls: 0, toolsSettled: true } }, 1, 0],
      ['a Codex call Codex itself never completed', { status: 'completed' as const, drain: { mousseCalls: 1, toolsSettled: false } }, 1, 0],
      ['a Codex count with no settlement report', { status: 'completed' as const, drain: { mousseCalls: 1 } }, 1, 0],
      ['an ACP tool call that did not complete', { status: 'completed' as const, drain: { toolCalls: 1, toolsSettled: false } }, 0, 0],
      ['more Mousse calls than the ACP agent announced tool calls', { status: 'completed' as const, drain: { toolCalls: 1, toolsSettled: true } }, 2, 0],
      ['an ACP agent that announced nothing while Mousse received a call', { status: 'completed' as const, drain: { toolCalls: 0, toolsSettled: true } }, 1, 0],
      ['no proof at all', { status: 'completed' as const }, 0, 0]
    ])('rotates after %s, revoking the bearer at once', (_name, settlement, received, running) => {
      const { credentials, codex } = drainedSetup()
      const first = credentials.bearerForTurn(codex('r1'))
      for (let index = 0; index < received; index += 1) credentials.callReceived(first.tokenHash, 'r1')
      for (let index = 0; index < running; index += 1) credentials.callRunning(first.tokenHash, 'r1', 1)
      expect(credentials.settleTurn(first.tokenHash, 'r1', settlement)).toBe('rotated')
      expect(credentials.resolve(first.token)).toBeNull()
      const next = credentials.bearerForTurn(codex('r2'))
      expect(next.reused).toBe(false)
      expect(next.token).not.toBe(first.token)
    })

    it('an ACP turn whose tool calls all completed keeps its bearer', () => {
      const { credentials } = setup()
      const acp = (runId: string) => turn({ runId, instanceId: 'antigravity', binding: 'drained_turn', generation: 'antigravity|default|0|0' })
      const first = credentials.bearerForTurn(acp('r1'))
      credentials.callReceived(first.tokenHash, 'r1')
      expect(credentials.settleTurn(first.tokenHash, 'r1', { status: 'completed', drain: { toolCalls: 2, toolsSettled: true } })).toBe('kept')
      expect(credentials.bearerForTurn(acp('r2')).token).toBe(first.token)
    })

    it('a per_call bearer survives a stopped turn and rotates after a failed one', () => {
      const { credentials } = setup()
      const first = credentials.bearerForTurn(turn())
      expect(credentials.settleTurn(first.tokenHash, 'r1', { status: 'aborted' })).toBe('kept')
      expect(credentials.bearerForTurn(turn({ runId: 'r2' })).token).toBe(first.token)
      expect(credentials.settleTurn(first.tokenHash, 'r2', { status: 'failed' })).toBe('rotated')
      expect(credentials.bearerForTurn(turn({ runId: 'r3' })).token).not.toBe(first.token)
    })
  })

  it('survives a reopen of the database (durable, unlike an in-memory registry)', () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-mcp-credentials-'))
    homes.push(home)
    const first = new ProfileDatabase({ profileHome: home })
    const minted = new McpCredentials(new RunStore(first)).mint({ threadId: 't', runId: 'r', provider: 'p', modeCeiling: 'default' })
    first.close()
    const second = new ProfileDatabase({ profileHome: home })
    databases.push(second)
    const credentials = new McpCredentials(new RunStore(second))
    // A row from an earlier process is of epoch 0 and rotates (its epoch and binding were in that process's memory).
    expect(credentials.resolve(minted.token)).toMatchObject({ runId: 'r', epoch: 0, binding: 'rotate' })
    // The token is gone from memory after the restart: the next turn revokes the row and mints anew.
    const next = credentials.bearerForTurn({ threadId: 't', instanceId: 'p', runId: 'r2', modeCeiling: 'default', binding: 'per_call', generation: 'g' })
    expect(next.reused).toBe(false)
    expect(credentials.resolve(minted.token)).toBeNull()
    expect(credentials.revokeForRun('r2')).toBe(1)
  })
})
