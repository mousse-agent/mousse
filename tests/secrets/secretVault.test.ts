// #595: how long a secret given in a thread is kept, which threads may use it, and what Settings and the saved-key list
// show. Values are kept in the profile's secret store, and each thread that may use one gets a private copy to read.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeProfileSecret } from '../../src/mms/profiles/secrets'
import { SecretRequests } from '../../src/mms/secrets/SecretRequests'
import { RETIRED_SECRET_GRACE_MS, SecretCopyRemovalError, SecretVault, secretThreadBusy } from '../../src/mms/secrets/SecretVault'
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
    // Both threads run on a runtime that masks its own tool results (Claude Code), so they get copies.
    vault.allowCopies('t1', true)
    vault.allowCopies('t2', true)
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

  // What the copies' folder may hold before a sync: [what is there, how it gets there]. Every sync leaves exactly the
  // live threads' copies, whatever else was there.
  const LEFTOVERS: Array<[string, (root: string) => void]> = [
    ['a stray file where a thread folder goes', (root) => writeFileSync(join(root, 'notes.txt'), 'x')],
    ['a file in place of the thread folder', (root) => { rmSync(join(root, 't1'), { recursive: true }); writeFileSync(join(root, 't1'), 'x') }],
    ['a stray file in the thread folder', (root) => writeFileSync(join(root, 't1', 'OLD_TOKEN'), 'old')],
    ['a folder inside the thread folder', (root) => mkdirSync(join(root, 't1', 'nested'), { recursive: true })],
    ['the folder of a thread that has no secret', (root) => mkdirSync(join(root, 't9'), { recursive: true })]
  ]
  it.each(LEFTOVERS)('clears %s and still writes the copies', async (_what, plant) => {
    await give('t1', 'saved')
    plant(join(home, 'secrets', 'threads'))
    writeProfileSecret(home, 'API_TOKEN', 'tok_new_value')
    vault.refresh()
    expect(readdirSync(join(home, 'secrets', 'threads'))).toEqual(['t1'])
    expect(readdirSync(join(home, 'secrets', 'threads', 't1'))).toEqual(['API_TOKEN'])
    expect(readFileSync(fileOf('t1'), 'utf8')).toBe('tok_new_value')
  })

  it('never writes a copy through a link to another folder', async () => {
    await give('t1', 'saved')
    const outside = mkdtempSync(join(tmpdir(), 'mousse-vault-outside-'))
    try {
      rmSync(join(home, 'secrets', 'threads', 't1'), { recursive: true })
      // A junction on Windows (no special rights needed), a symbolic link elsewhere.
      symlinkSync(outside, join(home, 'secrets', 'threads', 't1'), 'junction')
      writeProfileSecret(home, 'API_TOKEN', 'tok_new_value')
      vault.refresh()
      expect(readdirSync(outside)).toEqual([])
      expect(lstatSync(join(home, 'secrets', 'threads', 't1')).isDirectory()).toBe(true)
      expect(readFileSync(fileOf('t1'), 'utf8')).toBe('tok_new_value')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('never writes a copy through a link in place of the copy', async () => {
    await give('t1', 'saved')
    const outside = join(mkdtempSync(join(tmpdir(), 'mousse-vault-outside-')), 'target')
    try {
      writeFileSync(outside, 'untouched')
      rmSync(fileOf('t1'))
      symlinkSync(outside, fileOf('t1'))
      writeProfileSecret(home, 'API_TOKEN', 'tok_new_value')
      vault.refresh()
      expect(readFileSync(outside, 'utf8')).toBe('untouched')
      expect(lstatSync(fileOf('t1')).isFile()).toBe(true)
      expect(readFileSync(fileOf('t1'), 'utf8')).toBe('tok_new_value')
    } finally {
      rmSync(join(outside, '..'), { recursive: true, force: true })
    }
  })

  // Turns on a runtime that keeps its tools' results hold copies off: [what happens while held, the copies left]
  const HOLDS: Array<[string, () => void, string[]]> = [
    ['nothing else', () => {}, []],
    ['the parent is allowed again (its Claude Code turn)', () => vault.allowCopies('t1', true), []],
    ['the store changes', () => { writeProfileSecret(home, 'API_TOKEN', 'tok_new_value'); vault.refresh() }, []]
  ]
  it.each(HOLDS)('keeps the held threads without copies until the release: %s', async (_what, happen, left) => {
    await give('t1', 'saved')
    requests.useSaved('t2', (requests.request('t2', { label: 'API token', reason: 'x', name: 'API_TOKEN' }), requests.list('t2')[0].requestId))
    expect(copies()).toEqual(['t1/API_TOKEN', 't2/API_TOKEN'])
    // A subagent t3 of t1 runs on Codex: it holds its own thread and t1.
    const release = vault.holdCopies(['t3', 't1'])
    happen()
    expect(copies()).toEqual([...left, 't2/API_TOKEN'])
    release()
    expect(copies()).toEqual(['t1/API_TOKEN', 't2/API_TOKEN'])
    release()
    expect(copies()).toEqual(['t1/API_TOKEN', 't2/API_TOKEN'])
  })

  it('keeps a thread held until every turn holding it has settled, and the holding thread itself loses its copies', async () => {
    await give('t1', 'saved')
    const first = vault.holdCopies(['t1'])
    const second = vault.holdCopies(['t9', 't1'])
    first()
    expect(copies()).toEqual([])
    second()
    // t1 held itself (its own turn ran on Codex): it has no copy until its next Claude Code turn allows one.
    expect(copies()).toEqual([])
    vault.allowCopies('t1', true)
    expect(copies()).toEqual(['t1/API_TOKEN'])
  })

  it('refuses the hold, and holds nothing, when a copy cannot be removed', async () => {
    let locked = false
    vault = new SecretVault({ profileRoot: home, threadAlive: (id) => alive.has(id), now: () => now, removePath: (path) => { if (locked) throw new Error('EBUSY: resource busy or locked'); rmSync(path, { recursive: true, force: true }) } })
    requests = new SecretRequests(vault, () => now)
    vault.allowCopies('t1', true)
    await give('t1', 'saved')
    locked = true
    expect(() => vault.holdCopies(['t2', 't1'])).toThrow(SecretCopyRemovalError)
    // The copy is still there, and nothing stays held: the failed hold released itself.
    expect(existsSync(fileOf('t1'))).toBe(true)
    locked = false
    const release = vault.holdCopies(['t2', 't1'])
    expect(existsSync(fileOf('t1'))).toBe(false)
    release()
    expect(readFileSync(fileOf('t1'), 'utf8')).toBe(VALUE)
  })

  it('keeps the exact value in the copy: line breaks, spaces and other scripts', async () => {
    const value = '-----BEGIN KEY-----\r\n  ключ 鍵 =\n-----END KEY-----\n'
    await give('t1', 'day', 'PEM_KEY', value)
    expect(readFileSync(fileOf('t1', 'PEM_KEY'), 'utf8')).toBe(value)
  })

  it('gives no copy to a thread id that cannot name a folder, and writes nothing outside the folder', async () => {
    alive.add('../escape')
    vault.allowCopies('../escape', true)
    expect(await give('../escape', 'day')).toEqual({ kind: 'stored', name: 'API_TOKEN', keep: 'day' })
    expect(vault.fileFor('API_TOKEN', '../escape')).toBeUndefined()
    expect(existsSync(join(home, 'secrets', 'escape'))).toBe(false)
    expect(copies()).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('makes the copies and their folders readable by this account only', async () => {
    await give('t1', 'day')
    for (const path of [join(home, 'secrets', 'threads'), join(home, 'secrets', 'threads', 't1'), fileOf('t1')]) {
      expect({ path, othersMayRead: (statSync(path).mode & 0o077) !== 0 }).toEqual({ path, othersMayRead: false })
    }
    // A copy rewritten with a new value stays private.
    writeProfileSecret(home, 'API_TOKEN', 'tok_new_value')
    vault.refresh()
    expect(statSync(fileOf('t1')).mode & 0o077).toBe(0)
  })

  it('rewrites a copy when its value changes in the store, and puts back a copy that was deleted', async () => {
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

  it.each(MID_RUN)("keeps a parent's value %s masking its subagent's running turn, though the subagent's own text was never masked before", async (_what, happen) => {
    await give('t1', 'day')
    roots.set('c1', 't1')
    // The parent's turn runs and its text is masked; its subagent has not written anything yet.
    busy.add('t1').add('c1')
    expect(masked('t1', VALUE)).toBe('[secret API_TOKEN hidden]')
    happen()
    // The parent's turn ends; the subagent's keeps running, long past the parent's grace.
    busy.delete('t1')
    now += RETIRED_SECRET_GRACE_MS * 3
    expect(masked('c1', `late ${VALUE}`)).toBe('late [secret API_TOKEN hidden]')
    // Once the subagent's turn has ended too, the old value stops masking after the grace.
    busy.clear()
    now += RETIRED_SECRET_GRACE_MS + 1
    expect(masked('c1', VALUE)).toBe(VALUE)
    expect(masked('t1', VALUE)).toBe(VALUE)
  })

  it.each(MID_RUN)("keeps a parent's value %s for its running subagent even after the settled parent's own masker was asked for first", async (_what, happen) => {
    await give('t1', 'day')
    roots.set('c1', 't1')
    busy.add('t1').add('c1')
    expect(masked('t1', VALUE)).toBe('[secret API_TOKEN hidden]')
    happen()
    // The parent settles, and its own text is masked again past its grace, before the subagent writes anything.
    busy.delete('t1')
    now += RETIRED_SECRET_GRACE_MS * 3
    expect(masked('t1', VALUE)).toBe(VALUE)
    expect(masked('c1', `late ${VALUE}`)).toBe('late [secret API_TOKEN hidden]')
    // A subagent that is not running does not pick it up.
    roots.set('c2', 't1')
    expect(masked('c2', VALUE)).toBe(VALUE)
    busy.clear()
    now += RETIRED_SECRET_GRACE_MS + 1
    expect(masked('c1', VALUE)).toBe(VALUE)
  })

  it('counts a thread as running when looking up its run fails, so a masker still builds', async () => {
    const turns = { isTurnActive: () => false }
    expect(secretThreadBusy('t1', turns, { getActiveRun: () => null })).toBe(false)
    expect(secretThreadBusy('t1', turns, { getActiveRun: () => ({ runId: 'r' }) })).toBe(true)
    expect(secretThreadBusy('t1', turns, { getActiveRun: () => { throw new Error('run conflict') } })).toBe(true)
    // Wired into a vault: a removed value keeps masking instead of the masker throwing.
    vault = new SecretVault({ profileRoot: home, threadAlive: (id) => alive.has(id), threadBusy: (id) => secretThreadBusy(id, turns, { getActiveRun: () => { throw new Error('run conflict') } }), now: () => now })
    requests = new SecretRequests(vault, () => now)
    await give('t1', 'day')
    expect(masked('t1', VALUE)).toBe('[secret API_TOKEN hidden]')
    vault.delete('API_TOKEN')
    expect(masked('t1', VALUE)).toBe('[secret API_TOKEN hidden]')
  })
})
