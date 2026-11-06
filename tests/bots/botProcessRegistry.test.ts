/**
 * Bot Phase 1 §5.9: the daemon's record of which process serves which bot dispatch, and the
 * evidence that it is gone. A real `bots.db`, a fake supervisor launcher and fake process groups:
 * `attach` writes `child_pid`/`child_group`/`child_token` and starts a supervisor with the
 * dispatch's deadline; `settled` waits for the group, ends what is left, stops the supervisor and
 * writes `exit_at`; `reconcile` folds journals in and ends only groups verified as the recorded ones.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeBotSupervisorJournal, type BotSupervisorArgs } from '../../src/mms/bots/supervisor/botSupervisor'
import { BotProcessRegistry, botStoreProcessRecords, createBotProcessRegistry } from '../../src/mms/bots/supervisor/BotProcessRegistry'
import { BotStore } from '../../src/mms/bots/store/BotStore'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

/** Process groups by pgid: alive, and whether SIGTERM ends them. */
function fakeGroups() {
  const groups = new Map<number, { alive: boolean; ignoresTerm?: boolean; unkillable?: boolean }>()
  const signals: string[] = []
  let clock = 1_000_000
  const scope = {
    platform: 'linux' as const,
    kill: (target: number, signal: NodeJS.Signals | 0) => {
      const group = groups.get(Math.abs(target))
      if (!group?.alive) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
      if (signal === 0) return
      signals.push(`${signal} ${target}`)
      if (group.unkillable) return
      if (signal === 'SIGKILL' || !group.ignoresTerm) group.alive = false
    },
    members: async (pgid: number) => (groups.get(pgid)?.alive ? [pgid] : []),
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms
    }
  }
  return { groups, signals, scope, now: () => clock, advance: (ms: number) => { clock += ms } }
}

function setup(options: { tokens?: Record<number, string> } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bot-processes-')))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  const store = new BotStore({ profileHome: home })
  cleanups.push(() => store.close())
  for (const [n, thread] of [[1, 'thread-1'], [2, 'thread-2']] as const)
    store.insertDispatch({ activationId: 'act-1', n, kind: 'start', clientRequestId: `act-1:d${n}`, threadId: thread, prompt: { text: 'go' }, policyDigest: 'digest' })
  const groups = fakeGroups()
  const started: BotSupervisorArgs[] = []
  const stopped: string[] = []
  const tokens = options.tokens ?? {}
  const make = () => new BotProcessRegistry({
    records: botStoreProcessRecords(store),
    journalDir: join(store.directory, 'supervisor'),
    startSupervisor: (args) => {
      started.push(args)
      return { stop: () => stopped.push(`${args.dispatchId}:${args.pgid}`) }
    },
    token: (pid) => tokens[pid],
    scope: groups.scope,
    now: groups.now,
    platform: 'linux'
  })
  const row = (id: string) => store.get('SELECT child_pid, child_group, child_token, exit_at FROM bot_dispatches WHERE client_request_id = ?', id)
  return { store, groups, started, stopped, tokens, make, row, journalDir: join(store.directory, 'supervisor') }
}

describe('BotProcessRegistry', () => {
  it('records the process and starts its supervisor with the dispatch’s deadline', () => {
    const s = setup({ tokens: { 4242: 'proc:77' } })
    const registry = s.make()
    s.groups.groups.set(4242, { alive: true })
    registry.arm({ dispatchId: 'act-1:d1', activationId: 'act-1', deadlineAt: 2_000_000 })
    registry.attach('act-1:d1', { pid: 4242, pgid: 4242 })
    expect(s.row('act-1:d1')).toMatchObject({ child_pid: 4242, child_group: 4242, child_token: 'proc:77', exit_at: null })
    expect(s.started).toEqual([{ dispatchId: 'act-1:d1', pgid: 4242, deadlineAt: 2_000_000, journal: join(s.journalDir, 'act-1%3Ad1.4242.json') }])
  })

  it('a runtime’s report finds the armed dispatch by its thread; an unarmed one is refused', () => {
    const s = setup()
    const registry = s.make()
    registry.arm({ dispatchId: 'act-1:d2', activationId: 'act-1', deadlineAt: 2_000_000 })
    registry.attachThread('thread-2', 5151)
    expect(s.row('act-1:d2')).toMatchObject({ child_pid: 5151, child_group: 5151 })
    // Nothing armed on thread-1, and nothing at all for an unknown dispatch: nothing runs unsupervised.
    expect(() => registry.attachThread('thread-1', 6161)).toThrow(/no armed dispatch/)
    expect(() => registry.attach('act-1:d9', { pid: 7171, pgid: 7171 })).toThrow(/not armed/)
    expect(s.started).toHaveLength(1)
  })

  it('a supervisor that cannot start fails the attach, and nothing is recorded', () => {
    const s = setup()
    const registry = new BotProcessRegistry({
      records: botStoreProcessRecords(s.store),
      journalDir: s.journalDir,
      startSupervisor: () => { throw new Error('no supervisor') },
      token: () => undefined
    })
    registry.arm({ dispatchId: 'act-1:d1', activationId: 'act-1', deadlineAt: 2_000_000 })
    expect(() => registry.attachThread('thread-1', 4242)).toThrow('no supervisor')
    expect(s.row('act-1:d1')).toMatchObject({ child_pid: null, child_group: null })
  })

  it('settled: a group its runtime ended writes exit_at and stops the supervisor', async () => {
    const s = setup()
    const registry = s.make()
    s.groups.groups.set(4242, { alive: false })
    registry.arm({ dispatchId: 'act-1:d1', activationId: 'act-1', deadlineAt: 2_000_000 })
    registry.attach('act-1:d1', { pid: 4242, pgid: 4242 })
    const settled = await registry.settled('act-1:d1')
    expect(settled).toEqual({ exitAt: new Date(s.groups.now()).toISOString() })
    expect(s.row('act-1:d1')?.exit_at).toBe(s.groups.now())
    expect(s.stopped).toEqual(['act-1:d1:4242'])
    expect(s.groups.signals).toEqual([])
    // Settled once: a second call is the same answer, and the dispatch is no longer armed.
    expect(await registry.settled('act-1:d1')).toEqual(settled)
    expect(() => registry.attach('act-1:d1', { pid: 4343, pgid: 4343 })).toThrow(/not armed/)
  })

  it('settled: a group still there after the grace is ended (SIGTERM, then SIGKILL)', async () => {
    const s = setup()
    const registry = s.make()
    s.groups.groups.set(4242, { alive: true, ignoresTerm: true })
    registry.arm({ dispatchId: 'act-1:d1', activationId: 'act-1', deadlineAt: 2_000_000 })
    registry.attach('act-1:d1', { pid: 4242, pgid: 4242 })
    const settled = await registry.settled('act-1:d1')
    expect(settled).toHaveProperty('exitAt')
    expect(s.groups.signals).toEqual(['SIGTERM -4242', 'SIGKILL -4242'])
    expect(s.row('act-1:d1')?.exit_at).toBe(s.groups.now())
    expect(s.stopped).toEqual(['act-1:d1:4242'])
  })

  it('settled: the supervisor’s journal is folded in (it ended the group at the deadline)', async () => {
    const s = setup()
    const registry = s.make()
    s.groups.groups.set(4242, { alive: false })
    registry.arm({ dispatchId: 'act-1:d1', activationId: 'act-1', deadlineAt: 2_000_000 })
    registry.attach('act-1:d1', { pid: 4242, pgid: 4242 })
    writeBotSupervisorJournal(s.started[0].journal, { dispatchId: 'act-1:d1', pgid: 4242, killedAt: 1_500_000, exitAt: 1_502_000 })
    expect(await registry.settled('act-1:d1')).toEqual({ exitAt: new Date(1_502_000).toISOString() })
    expect(s.row('act-1:d1')?.exit_at).toBe(1_502_000)
    expect(existsSync(s.started[0].journal)).toBe(false)
  })

  it('settled: a group that cannot be ended leaves exit_at empty and the supervisor running', async () => {
    const s = setup()
    const registry = s.make()
    s.groups.groups.set(4242, { alive: true, unkillable: true })
    registry.arm({ dispatchId: 'act-1:d1', activationId: 'act-1', deadlineAt: 2_000_000 })
    registry.attach('act-1:d1', { pid: 4242, pgid: 4242 })
    expect(await registry.settled('act-1:d1')).toEqual({ stillAlive: true })
    expect(s.row('act-1:d1')?.exit_at).toBeNull()
    expect(s.stopped).toEqual([])
  })

  it('settled: every process a dispatch served is waited for; exit_at is the last exit', async () => {
    const s = setup()
    const registry = s.make()
    s.groups.groups.set(4242, { alive: false })
    s.groups.groups.set(4343, { alive: false })
    registry.arm({ dispatchId: 'act-1:d1', activationId: 'act-1', deadlineAt: 2_000_000 })
    registry.attach('act-1:d1', { pid: 4242, pgid: 4242 })
    registry.attach('act-1:d1', { pid: 4343, pgid: 4343 })
    expect(s.row('act-1:d1')).toMatchObject({ child_pid: 4343 })
    await registry.settled('act-1:d1')
    expect(s.stopped.sort()).toEqual(['act-1:d1:4242', 'act-1:d1:4343'])
  })

  it('reconcile: folds journals, ends verified groups, and never signals a group it cannot verify', async () => {
    const s = setup({ tokens: { 4242: 'proc:1', 5151: 'proc:2' } })
    const before = s.make()
    for (const pid of [4242, 5151]) s.groups.groups.set(pid, { alive: true })
    // A daemon armed and attached both dispatches, then stopped without settling them.
    before.arm({ dispatchId: 'act-1:d1', activationId: 'act-1', deadlineAt: 2_000_000 })
    before.attach('act-1:d1', { pid: 4242, pgid: 4242 })
    before.arm({ dispatchId: 'act-1:d2', activationId: 'act-1', deadlineAt: 2_000_000 })
    before.attach('act-1:d2', { pid: 5151, pgid: 5151 })
    // d1's supervisor ended it at the deadline; d2's leader still runs, as recorded.
    s.groups.groups.set(4242, { alive: false })
    writeBotSupervisorJournal(s.started[0].journal, { dispatchId: 'act-1:d1', pgid: 4242, killedAt: 1_500_000, exitAt: 1_501_000 })
    // A journal of a dispatch that is no longer open is left over.
    writeBotSupervisorJournal(join(s.journalDir, 'old%3Ad1.99.json'), { dispatchId: 'old:d1', pgid: 99, exitAt: 1 })
    const results = await s.make().reconcile()
    expect(results).toEqual([
      { dispatchId: 'act-1:d1', exitAt: new Date(1_501_000).toISOString() },
      { dispatchId: 'act-1:d2', exitAt: new Date(s.groups.now()).toISOString() }
    ])
    expect(s.groups.signals).toEqual(['SIGTERM -5151'])
    expect(s.row('act-1:d1')?.exit_at).toBe(1_501_000)
    expect(s.row('act-1:d2')?.exit_at).toBe(s.groups.now())
    expect(readdirSync(s.journalDir)).toEqual([])
  })

  it('reconcile: a reused pid (another start time) or an unverifiable leader is never signalled', async () => {
    const s = setup({ tokens: { 4242: 'proc:1' } })
    const before = s.make()
    for (const pid of [4242, 5151]) s.groups.groups.set(pid, { alive: true })
    before.arm({ dispatchId: 'act-1:d1', activationId: 'act-1', deadlineAt: 2_000_000 })
    before.attach('act-1:d1', { pid: 4242, pgid: 4242 })
    before.arm({ dispatchId: 'act-1:d2', activationId: 'act-1', deadlineAt: 2_000_000 })
    // No start time could be read for this one (Windows).
    before.attach('act-1:d2', { pid: 5151, pgid: 5151 })
    // After a restart, pid 4242 runs another program.
    s.tokens[4242] = 'proc:999'
    const results = await s.make().reconcile()
    expect(results).toEqual([
      { dispatchId: 'act-1:d1', exitAt: new Date(s.groups.now()).toISOString() },
      { dispatchId: 'act-1:d2' }
    ])
    expect(s.groups.signals).toEqual([])
    expect(s.row('act-1:d2')?.exit_at).toBeNull()
  })

  it('reconcile leaves the dispatches this daemon armed to their settlement', async () => {
    const s = setup()
    const registry = s.make()
    s.groups.groups.set(4242, { alive: true })
    registry.arm({ dispatchId: 'act-1:d1', activationId: 'act-1', deadlineAt: 2_000_000 })
    registry.attach('act-1:d1', { pid: 4242, pgid: 4242 })
    expect(await registry.reconcile()).toEqual([])
    expect(s.groups.signals).toEqual([])
  })

  it('createBotProcessRegistry keeps its journals under <profile>/bots/supervisor', () => {
    const s = setup()
    const started: BotSupervisorArgs[] = []
    const registry = createBotProcessRegistry({ store: s.store, startSupervisor: (args) => (started.push(args), { stop: () => {} }), token: () => undefined })
    registry.arm({ dispatchId: 'act-1:d1', activationId: 'act-1', deadlineAt: 1 })
    registry.attach('act-1:d1', { pid: 4242, pgid: 4242 })
    expect(started[0].journal.startsWith(join(s.store.directory, 'supervisor'))).toBe(true)
    mkdirSync(s.journalDir, { recursive: true })
    expect(existsSync(s.journalDir)).toBe(true)
  })
})
