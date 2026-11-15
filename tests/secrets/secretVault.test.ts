// #595: how long a secret given in a thread is kept, which threads may use it, and what Settings and the saved-key list
// show. Values are kept only in the profile's secret store.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeProfileSecret } from '../../src/mms/profiles/secrets'
import { SecretRequests } from '../../src/mms/secrets/SecretRequests'
import { SecretVault } from '../../src/mms/secrets/SecretVault'
import { SECRET_DAY_MS } from '../../src/shared/secretRequests'

const VALUE = 'tok_0123456789abcdef'

describe('the secrets a thread asked for', () => {
  let home: string
  let now: number
  let alive: Set<string>
  let vault: SecretVault
  let requests: SecretRequests

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-vault-'))
    now = Date.parse('2026-11-15T10:00:00Z')
    alive = new Set(['t1', 't2'])
    vault = new SecretVault({ profileRoot: home, threadAlive: (id) => alive.has(id), now: () => now })
    requests = new SecretRequests(vault, () => now)
  })
  afterEach(() => {
    requests.dispose()
    rmSync(home, { recursive: true, force: true })
  })

  const give = async (threadId: string, keep: string, name = 'API_TOKEN', value = VALUE) => {
    const asked = requests.request(threadId, { label: 'API token', reason: 'x', name })
    const [card] = requests.list(threadId)
    requests.answer(threadId, card.requestId, value, keep)
    return asked
  }

  // How long each choice keeps it: [keep, what happens, still there?]
  const KEEPS: Array<[string, (ctx: { advance(ms: number): void; drop(id: string): void }) => void, boolean]> = [
    ['day', ({ advance }) => advance(SECRET_DAY_MS - 1000), true],
    ['day', ({ advance }) => advance(SECRET_DAY_MS + 1000), false],
    ['thread', ({ advance }) => advance(30 * SECRET_DAY_MS), true],
    ['thread', ({ drop }) => drop('t1'), false],
    ['saved', ({ advance, drop }) => { advance(365 * SECRET_DAY_MS); drop('t1') }, true]
  ]
  it.each(KEEPS)('keeps a %s secret until its end: %#', async (keep, happen, kept) => {
    await give('t1', keep)
    happen({ advance: (ms) => { now += ms }, drop: (id) => alive.delete(id) })
    vault.sweep()
    expect(vault.has('API_TOKEN')).toBe(kept)
    expect(vault.value('API_TOKEN')).toBe(kept ? VALUE : undefined)
    expect(vault.list().map((entry) => entry.name)).toEqual(kept ? ['API_TOKEN'] : [])
  })

  it('keeps the values in the secret store only; its record beside it holds names and times', async () => {
    await give('t1', 'day')
    expect(readFileSync(join(home, 'secrets', 'meta.json'), 'utf8')).not.toContain(VALUE)
    expect(JSON.stringify(vault.list())).not.toContain(VALUE)
    expect(vault.list()).toEqual([{ name: 'API_TOKEN', keep: 'day', label: 'API token', expiresAt: '2026-11-16T10:00:00.000Z', threadId: 't1', createdAt: '2026-11-15T10:00:00.000Z' }])
  })

  it('never overwrites another secret: a taken name gets the next free one, and the agent is told that name', async () => {
    writeProfileSecret(home, 'API_TOKEN', 'automation-key')
    expect(await give('t1', 'day')).toEqual({ kind: 'stored', name: 'API_TOKEN_2', keep: 'day' })
    expect(vault.value('API_TOKEN')).toBe('automation-key')
    expect(vault.value('API_TOKEN_2')).toBe(VALUE)
  })

  it('lets only the threads it was given to use it; Use saved gives a saved one to another thread', async () => {
    await give('t1', 'saved')
    expect(vault.usableIn('API_TOKEN', 't1')).toBe(true)
    expect(vault.usableIn('API_TOKEN', 't2')).toBe(false)
    expect(vault.maskerFor('t2')).toBeUndefined()

    const asked = requests.request('t2', { label: 'API token', reason: 'x', name: 'API_TOKEN' })
    const [card] = requests.list('t2')
    expect(card.savedExists).toBe(true)
    requests.useSaved('t2', card.requestId)
    expect(await asked).toEqual({ kind: 'saved_reused', name: 'API_TOKEN' })
    expect(vault.usableIn('API_TOKEN', 't2')).toBe(true)
    expect(vault.maskerFor('t2')?.(`x ${VALUE} y`)).toBe('x [secret API_TOKEN hidden] y')
  })

  it('offers Use saved only for a saved secret, never one kept for a while in another thread', async () => {
    await give('t1', 'day')
    requests.request('t2', { label: 'API token', reason: 'x', name: 'API_TOKEN' })
    const [card] = requests.list('t2')
    expect(card.savedExists).toBe(false)
    expect(() => requests.useSaved('t2', card.requestId)).toThrow(/No saved secret/)
    expect(vault.usableIn('API_TOKEN', 't2')).toBe(false)
  })

  it('lists only saved ones as saved keys for automations; Settings lists them all, and removing one deletes it', async () => {
    writeProfileSecret(home, 'GITHUB_TOKEN', 'ghp_x1234')
    await give('t1', 'day')
    await give('t1', 'saved', 'NPM_TOKEN')
    expect(vault.savedKeyNames()).toEqual(['GITHUB_TOKEN', 'NPM_TOKEN'])
    expect(vault.list().map((entry) => [entry.name, entry.keep])).toEqual([['API_TOKEN', 'day'], ['GITHUB_TOKEN', 'key'], ['NPM_TOKEN', 'saved']])
    expect(vault.delete('API_TOKEN')).toBe(true)
    expect(vault.value('API_TOKEN')).toBeUndefined()
    expect(vault.usableIn('API_TOKEN', 't1')).toBe(false)
  })
})
