/**
 * B's side of an SSH add (1b §3.4 step 4, §3.6): the request journal and its resumable steps, with a fake profile
 * table and engine around the real store. Rows below are the inputs §3.4's table lists: each crash point, each
 * stored state, the existing-row branch, a removal, and the age rule.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  prepare,
  removeRequestsOf,
  type PrepareEngine,
  type PreparePort,
  type PrepareRequest,
  type PrepareRow
} from '../../src/mms/netEngine/ssh/prepare'
import { SshRequestStore } from '../../src/mms/netEngine/ssh/requests'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const NOW = 1_800_000_000
const A = 'aa'.repeat(32)

/** B with one existing profile (`prof1`), a store, and a crash switch per step. */
function b() {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-requests-'))
  const requests = new SshRequestStore(join(dir, 'ssh-requests.db'))
  cleanups.push(() => {
    requests.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const profiles = new Map<string, { tag?: string }>([['prof1', {}]])
  const rows = new Map<string, PrepareRow & { joiner: string; profile: string }>()
  const grants = new Map<string, { identity: string; receipt?: string }>()
  let nextGrant = 1
  let crashAt: string | undefined
  const crash = (step: string) => {
    if (crashAt === step) {
      crashAt = undefined
      throw new Error(`crash at ${step}`)
    }
  }
  const engine = (profile: string): PrepareEngine => ({
    identity: `b-${profile}`,
    name: 'B',
    rowFor: (joiner) =>
      [...rows.values()].find((row) => row.joiner === joiner && row.profile === profile),
    writeOwnRow: (request) => {
      const key = `row${rows.size + 1}`
      rows.set(key, { key, state: 'ssh_granting', requestId: request.requestId, joiner: request.joiner, profile })
      crash('row')
      return key
    },
    grantAdd: async (request) => {
      const held = [...grants].find(([, grant]) => grant.identity === request.joiner)
      const id = held?.[0] ?? String(nextGrant++)
      grants.set(id, { identity: request.joiner, receipt: request.requestId })
      crash('grant')
      return id
    },
    setRowGrant: (key, grant) => {
      rows.get(key)!.grant = grant
    },
    granted: (key) => {
      rows.get(key)!.state = 'ssh_granted'
      crash('granted')
    },
    grantLive: async (id) => grants.has(id),
    rowGrant: (key) => rows.get(key)?.grant
  })
  const port: PreparePort = {
    requests,
    now: () => NOW,
    maxAgeSecs: 86_400,
    hasProfile: (selector) => profiles.has(selector),
    profileTagged: (tag) => [...profiles].find(([, value]) => value.tag === tag)?.[0],
    createProfile: async (_label, tag) => {
      const selector = `prof${profiles.size + 1}`
      profiles.set(selector, { tag })
      crash('profile')
      return selector
    },
    engine: async (selector) => engine(selector),
    locked: (_selector, _joiner, work) => work(),
    startsAtLogin: () => true
  }
  return {
    port,
    requests,
    profiles,
    rows,
    grants,
    crashAt: (step: string) => (crashAt = step)
  }
}

const request = (fields: Partial<PrepareRequest> = {}): PrepareRequest => ({
  requestId: '0123456789abcdef0123456789abcdef',
  issuedAt: NOW - 10,
  selector: 'prof1',
  joiner: A,
  joinerName: 'A',
  ...fields
})

describe('prepare (B, §3.4 step 4)', () => {
  it('journals, writes its own row, saves the grant on the request and the row, and answers', async () => {
    const s = b()
    const reply = await prepare(s.port, request())
    expect(reply).toMatchObject({ selector: 'prof1', grant_id: '1', existing: false, already: false, starts_at_login: true })
    expect([...s.rows.values()][0]).toMatchObject({ state: 'ssh_granted', grant: '1' })
    expect(s.requests.get(request().requestId)).toMatchObject({ state: 'done', row: 'own', grantId: '1' })
  })

  it.each(['row', 'grant', 'granted'])('resumes after a crash at %s with one row and one grant', async (step) => {
    const s = b()
    s.crashAt(step)
    await expect(prepare(s.port, request())).rejects.toThrow(`crash at ${step}`)
    const reply = await prepare(s.port, request())
    expect(reply.grant_id).toBe('1')
    expect(s.rows.size).toBe(1)
    expect(s.grants.size).toBe(1)
    expect([...s.rows.values()][0]).toMatchObject({ state: 'ssh_granted', grant: '1' })
  })

  it('makes one profile for a new label, even when it crashed right after making it', async () => {
    const s = b()
    s.crashAt('profile')
    const fresh = request({ selector: undefined, newLabel: 'Work' })
    await expect(prepare(s.port, fresh)).rejects.toThrow('crash at profile')
    const reply = await prepare(s.port, fresh)
    expect(reply.selector).toBe('prof2')
    expect(s.profiles.size).toBe(2)
  })

  it('answers a repeat of a done request with its stored reply while its grant still serves', async () => {
    const s = b()
    await prepare(s.port, request())
    expect(await prepare(s.port, request())).toMatchObject({ grant_id: '1', already: true })
  })

  it('marks a done request removed when its grant is gone or the row holds another', async () => {
    const s = b()
    await prepare(s.port, request())
    s.grants.clear()
    await expect(prepare(s.port, request())).rejects.toMatchObject({ details: { reason: 'removed' } })
    expect(s.requests.get(request().requestId)?.state).toBe('removed')
  })

  it('keeps an existing row and its grant, answers existing, and answers the same on a repeat', async () => {
    const s = b()
    s.rows.set('old', { key: 'old', state: 'connected', grant: '7', joiner: A, profile: 'prof1' })
    s.grants.set('7', { identity: A })
    const reply = await prepare(s.port, request())
    expect(reply).toMatchObject({ existing: true, grant_id: '7' })
    expect(s.rows.size).toBe(1)
    expect(s.rows.get('old')).toMatchObject({ state: 'connected', grant: '7' })
    expect(await prepare(s.port, request())).toMatchObject({ existing: true, already: true })
  })

  it('refuses while the row is being removed, a request too old by its clock, and a reused id', async () => {
    const s = b()
    s.rows.set('old', { key: 'old', state: 'removing', joiner: A, profile: 'prof1' })
    await expect(prepare(s.port, request())).rejects.toMatchObject({ details: { reason: 'busy' } })
    const t = b()
    await expect(
      prepare(t.port, request({ requestId: 'ff'.repeat(16), issuedAt: NOW - 90_000 }))
    ).rejects.toMatchObject({ details: { reason: 'expired' } })
    expect(t.requests.get('ff'.repeat(16))).toBeUndefined()
    await prepare(t.port, request())
    await expect(prepare(t.port, request({ joinerName: 'Other' }))).rejects.toMatchObject({
      details: { reason: 'bad_request' }
    })
  })
})

describe('removal of A on B (§3.6)', () => {
  it('marks its requests removed, removing first a grant saved before its id was stored', async () => {
    const s = b()
    s.crashAt('grant')
    await expect(prepare(s.port, request())).rejects.toThrow('crash at grant')
    expect(s.requests.get(request().requestId)?.grantId).toBeUndefined()
    expect(s.grants.size).toBe(1)
    await removeRequestsOf(s.requests, A, 'prof1', {
      list: async () => [...s.grants].map(([grant, value]) => ({ grant, ...value })),
      remove: async (grant) => void s.grants.delete(grant)
    })
    expect(s.grants.size).toBe(0)
    await expect(prepare(s.port, request())).rejects.toMatchObject({ details: { reason: 'removed' } })
  })
})
