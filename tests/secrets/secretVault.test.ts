// #595: how long a secret given in a thread is kept, which threads may use it, and what Settings and the saved-key list
// show. Values are kept in the profile's secret store, and each thread that may use one gets a private copy to read.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeProfileSecret } from '../../src/mms/profiles/secrets'
import { SecretRequests } from '../../src/mms/secrets/SecretRequests'
import { RETIRED_SECRET_GRACE_MS, SecretVault } from '../../src/mms/secrets/SecretVault'
import { SECRET_DAY_MS } from '../../src/shared/secretRequests'

const VALUE = 'tok_0123456789abcdef'

describe('the secrets a thread asked for', () => {
  let home: string
  let now: number
  let alive: Set<string>
  let roots: Map<string, string>
  let busy: Set<string>
  let vault: SecretVault
  let requests: SecretRequests

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-vault-'))
    now = Date.parse('2026-11-15T10:00:00Z')
    alive = new Set(['t1', 't2'])
    roots = new Map()
    busy = new Set()
    vault = new SecretVault({ profileRoot: home, threadAlive: (id) => alive.has(id), ancestorsOf: (id) => (roots.has(id) ? [roots.get(id)!] : []), threadBusy: (id) => busy.has(id), now: () => now })
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
    // The thread's readable copy goes with the secret, and with the thread.
    expect(existsSync(fileOf('t1'))).toBe(kept && alive.has('t1'))
  })

  const fileOf = (threadId: string, name = 'API_TOKEN') => join(home, 'secrets', 'threads', threadId, name)
  /** Every readable copy, as `thread/NAME`. */
  const copies = () => (existsSync(join(home, 'secrets', 'threads')) ? readdirSync(join(home, 'secrets', 'threads')).flatMap((thread) => readdirSync(join(home, 'secrets', 'threads', thread)).map((name) => `${thread}/${name}`)) : [])

  it('gives the thread that asked a private file holding the value, and tells the agent its path', async () => {
    const outcome = await give('t1', 'day')
    expect(outcome).toMatchObject({ kind: 'stored', name: 'API_TOKEN', file: fileOf('t1') })
    expect(vault.fileFor('API_TOKEN', 't1')).toBe(fileOf('t1'))
    expect(readFileSync(fileOf('t1'), 'utf8')).toBe(VALUE)
    expect(vault.fileFor('API_TOKEN', 't2')).toBeUndefined()
    expect(copies()).toEqual(['t1/API_TOKEN'])
  })

  // What happens to the readable copies: [what happens, the copies left]
  const COPIES: Array<[string, () => void, string[]]> = [
    ['Use saved gives one to another thread', () => {
      requests.request('t2', { label: 'API token', reason: 'x', name: 'API_TOKEN' })
      requests.useSaved('t2', requests.list('t2')[0].requestId)
    }, ['t1/API_TOKEN', 't2/API_TOKEN']],
    ['removing it in Settings', () => vault.delete('API_TOKEN'), []],
    ['the thread that asked is archived', () => { alive.delete('t1'); vault.sweep() }, []],
    ['another secret is removed', () => { writeProfileSecret(home, 'OTHER', 'x1234'); vault.refresh(); vault.delete('OTHER') }, ['t1/API_TOKEN']]
  ]
  it.each(COPIES)('keeps the copies in step with the store: %s', async (_what, happen, left) => {
    await give('t1', 'saved')
    happen()
    expect(copies()).toEqual(left)
  })

  it('rewrites a copy when its value changes in the store, and never leaves a stray file in a thread folder', async () => {
    await give('t1', 'saved')
    writeProfileSecret(home, 'API_TOKEN', 'tok_new_value')
    vault.refresh()
    expect(readFileSync(fileOf('t1'), 'utf8')).toBe('tok_new_value')
    rmSync(join(home, 'secrets', 'threads', 't1'), { recursive: true })
    vault.sweep()
    expect(readFileSync(fileOf('t1'), 'utf8')).toBe('tok_new_value')
  })

  it('keeps no value in its record or in what Settings lists; the record holds names and times', async () => {
    await give('t1', 'day')
    expect(readFileSync(join(home, 'secrets', 'meta.json'), 'utf8')).not.toContain(VALUE)
    expect(JSON.stringify(vault.list())).not.toContain(VALUE)
    expect(vault.list()).toEqual([{ name: 'API_TOKEN', keep: 'day', label: 'API token', expiresAt: '2026-11-16T10:00:00.000Z', threadId: 't1', createdAt: '2026-11-15T10:00:00.000Z' }])
  })

  it('never overwrites another secret: a taken name gets the next free one, and the agent is told that name', async () => {
    writeProfileSecret(home, 'API_TOKEN', 'automation-key')
    expect(await give('t1', 'day')).toEqual({ kind: 'stored', name: 'API_TOKEN_2', keep: 'day', file: fileOf('t1', 'API_TOKEN_2') })
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
    expect(await asked).toEqual({ kind: 'saved_reused', name: 'API_TOKEN', file: fileOf('t2') })
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

  /** What the thread's masker leaves of `text`. */
  const masked = (threadId: string, text: string) => vault.maskerFor(threadId)?.(text) ?? text

  it("masks a subagent's thread with the secrets of the thread it belongs to, and no other thread", async () => {
    await give('t1', 'day')
    roots.set('c1', 't1')
    expect(masked('c1', `x ${VALUE} y`)).toBe('x [secret API_TOKEN hidden] y')
    expect(masked('c2', `x ${VALUE} y`)).toBe(`x ${VALUE} y`)
    // It gets no file of its own: only the thread that asked does.
    expect(vault.fileFor('API_TOKEN', 'c1')).toBeUndefined()
  })

  // A value removed or changed while a turn runs: [what happens]. Its output may still hold the old value.
  const MID_RUN: Array<[string, () => void]> = [
    ['removed in Settings', () => vault.delete('API_TOKEN')],
    ['changed in the store', () => { writeProfileSecret(home, 'API_TOKEN', 'tok_rotated_value'); vault.refresh() }],
    ['expired', () => { now += SECRET_DAY_MS + 1000; vault.sweep() }]
  ]
  it.each(MID_RUN)('keeps masking a value %s during a running turn, until shortly after it ends', async (_what, happen) => {
    await give('t1', 'day')
    roots.set('c1', 't1')
    busy.add('t1').add('c1')
    expect(masked('t1', VALUE)).toBe('[secret API_TOKEN hidden]')
    expect(masked('c1', VALUE)).toBe('[secret API_TOKEN hidden]')
    happen()
    expect(masked('t1', VALUE)).toBe('[secret API_TOKEN hidden]')
    expect(masked('c1', VALUE)).toBe('[secret API_TOKEN hidden]')
    if (vault.value('API_TOKEN')) expect(masked('t1', 'tok_rotated_value')).toBe('[secret API_TOKEN hidden]')
    // However long the turn still runs.
    now += RETIRED_SECRET_GRACE_MS * 3
    expect(masked('t1', `late ${VALUE}`)).toBe('late [secret API_TOKEN hidden]')
    expect(masked('c1', `late ${VALUE}`)).toBe('late [secret API_TOKEN hidden]')
    // The turn ends: its last output may still arrive for a short while.
    busy.clear()
    expect(masked('t1', VALUE)).toBe('[secret API_TOKEN hidden]')
    now += RETIRED_SECRET_GRACE_MS + 1
    expect(masked('t1', VALUE)).toBe(VALUE)
    expect(masked('c1', VALUE)).toBe(VALUE)
    if (vault.value('API_TOKEN')) expect(masked('t1', 'tok_rotated_value')).toBe('[secret API_TOKEN hidden]')
  })

  it.each(MID_RUN)('stops masking a value %s at once when no turn of the thread runs', async (_what, happen) => {
    await give('t1', 'day')
    expect(masked('t1', VALUE)).toBe('[secret API_TOKEN hidden]')
    happen()
    expect(masked('t1', VALUE)).toBe(VALUE)
  })
})
