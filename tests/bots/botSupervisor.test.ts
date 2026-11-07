/**
 * Bot Phase 1 §5.9, gap 1: the active-time supervisor outside the daemon. Its sequence with fake
 * groups, then the built script (`out/cli/bot-supervisor.js`, bundled here the same way) against a
 * real child that ignores SIGTERM while this process's event loop is blocked: the supervisor ends
 * the group at the deadline and confirms the exit (the child is left a zombie until the loop
 * frees, and does not count), and `exit_at` is written once the loop is free again.
 *
 * Process lane: short-lived `node -e` children and the supervisor script only.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BOT_SUPERVISOR_USAGE, botSupervisorArgv, parseBotSupervisorArgs, readBotSupervisorJournal, runBotSupervisor } from '../../src/mms/bots/supervisor/botSupervisor'
import { BotProcessRegistry, botStoreProcessRecords, spawnBotSupervisor } from '../../src/mms/bots/supervisor/BotProcessRegistry'
import { BotStore } from '../../src/mms/bots/store/BotStore'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe('the supervisor’s arguments', () => {
  it('round-trips, and refuses anything incomplete', () => {
    const args = { dispatchId: 'act-1:d1', pgid: 4242, deadlineAt: 1_700_000_000_000, journal: '/p/bots/supervisor/act-1%3Ad1.4242.json' }
    expect(parseBotSupervisorArgs(botSupervisorArgv(args))).toEqual(args)
    expect(parseBotSupervisorArgs(['--dispatch', 'x', '--pgid', '1', '--deadline', '5', '--journal', '/j'])).toBeUndefined()
    expect(parseBotSupervisorArgs(['--dispatch', 'x', '--pgid', '42', '--journal', '/j'])).toBeUndefined()
    expect(BOT_SUPERVISOR_USAGE).toContain('--deadline <epochMs>')
  })
})

describe('the supervisor’s sequence (fake groups)', () => {
  function groups(initial: { alive: boolean; ignoresTerm?: boolean; unkillable?: boolean }) {
    const group = { ...initial }
    const signals: string[] = []
    let clock = 0
    return {
      group,
      signals,
      deps: {
        platform: 'linux' as const,
        now: () => clock,
        sleep: async (ms: number) => {
          clock += ms
        },
        kill: (target: number, signal: NodeJS.Signals | 0) => {
          if (!group.alive) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
          if (signal === 0) return
          signals.push(`${signal} ${target}`)
          if (!group.unkillable && (signal === 'SIGKILL' || !group.ignoresTerm)) group.alive = false
        },
        members: async () => (group.alive ? [4242] : [])
      }
    }
  }

  it('at the deadline: SIGTERM, SIGKILL after the grace, the exit confirmed and written', async () => {
    const journal = join(tempDir('mousse-bot-supervisor-'), 'j.json')
    const g = groups({ alive: true, ignoresTerm: true })
    expect(await runBotSupervisor({ dispatchId: 'd', pgid: 4242, deadlineAt: 5_000, journal }, g.deps)).toBe(0)
    expect(g.signals).toEqual(['SIGTERM -4242', 'SIGKILL -4242'])
    const written = readBotSupervisorJournal(journal)!
    expect(written).toMatchObject({ dispatchId: 'd', pgid: 4242, killedAt: 5_000 })
    expect(written.exitAt).toBeGreaterThanOrEqual(7_000)
  })

  it('a group gone before the deadline is recorded, and nothing is signalled', async () => {
    const journal = join(tempDir('mousse-bot-supervisor-'), 'j.json')
    const g = groups({ alive: true })
    g.group.alive = false
    expect(await runBotSupervisor({ dispatchId: 'd', pgid: 4242, deadlineAt: 60_000, journal }, g.deps)).toBe(0)
    expect(g.signals).toEqual([])
    expect(readBotSupervisorJournal(journal)).toEqual({ dispatchId: 'd', pgid: 4242, exitAt: 0 })
  })

  it('a group that outlives the kill is written as still alive (exit code 1)', async () => {
    const journal = join(tempDir('mousse-bot-supervisor-'), 'j.json')
    const g = groups({ alive: true, unkillable: true })
    expect(await runBotSupervisor({ dispatchId: 'd', pgid: 4242, deadlineAt: 1_000, journal }, g.deps)).toBe(1)
    expect(readBotSupervisorJournal(journal)).toEqual({ dispatchId: 'd', pgid: 4242, killedAt: 1_000, stillAlive: true })
  })
})

describe.skipIf(process.platform === 'win32')('the built supervisor against a real process group', () => {
  let script = ''
  let buildDir = ''
  beforeAll(async () => {
    buildDir = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bot-supervisor-build-')))
    script = join(buildDir, 'bot-supervisor.js')
    await build({ entryPoints: [fileURLToPath(new URL('../../src/cli/fastpath/botSupervisorMain.ts', import.meta.url))], outfile: script, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent' })
    writeFileSync(join(buildDir, 'package.json'), '{"type":"module"}')
  }, 60_000)
  afterAll(() => rmSync(buildDir, { recursive: true, force: true }))

  function bed() {
    const home = tempDir('mousse-bot-supervisor-home-')
    const store = new BotStore({ profileHome: home })
    cleanups.push(() => store.close())
    store.insertDispatch({ activationId: 'act-1', n: 1, kind: 'start', clientRequestId: 'act-1:d1', threadId: 'thread-1', prompt: { text: 'go' }, policyDigest: 'digest' })
    const registry = new BotProcessRegistry({ records: botStoreProcessRecords(store), journalDir: join(store.directory, 'supervisor'), startSupervisor: spawnBotSupervisor(script) })
    const exitAt = () => store.get('SELECT exit_at FROM bot_dispatches WHERE client_request_id = ?', 'act-1:d1')?.exit_at
    return { store, registry, exitAt, journalDir: join(store.directory, 'supervisor') }
  }

  /** A child in a process group of its own, as a bot's runtime is started. */
  function child(code: string): { proc: ChildProcess; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
    const proc = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' })
    cleanups.push(() => {
      try {
        process.kill(-proc.pid!, 'SIGKILL')
      } catch {
        // Gone.
      }
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })))
    return { proc, exited }
  }

  it('ends a group that ignores SIGTERM at its deadline while the daemon’s loop is blocked; exit_at follows once the loop frees', async () => {
    const b = bed()
    const { proc, exited } = child("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)")
    const pid = proc.pid!
    const deadlineAt = Date.now() + 1_500
    b.registry.arm({ dispatchId: 'act-1:d1', activationId: 'act-1', deadlineAt })
    b.registry.attachThread('thread-1', pid)
    // The daemon's loop is blocked well past the deadline, the grace and the confirmation.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6_500)
    const journal = readBotSupervisorJournal(join(b.journalDir, `act-1%3Ad1.${pid}.json`))
    expect(journal?.killedAt).toBeGreaterThanOrEqual(deadlineAt)
    expect(journal?.exitAt).toBeGreaterThanOrEqual(journal!.killedAt! + 1_900)
    expect(journal?.stillAlive).toBeUndefined()
    // Nothing wrote exit_at while the loop was blocked.
    expect(b.exitAt()).toBeNull()
    expect(await exited).toEqual({ code: null, signal: 'SIGKILL' })
    const settled = await b.registry.settled('act-1:d1')
    expect(settled).toEqual({ exitAt: new Date(journal!.exitAt!).toISOString() })
    expect(b.exitAt()).toBe(journal!.exitAt)
  }, 30_000)

  it('a group that ends first is recorded by its supervisor, which then leaves', async () => {
    const b = bed()
    const { proc, exited } = child('setTimeout(() => {}, 300)')
    const pid = proc.pid!
    b.registry.arm({ dispatchId: 'act-1:d1', activationId: 'act-1', deadlineAt: Date.now() + 60_000 })
    b.registry.attachThread('thread-1', pid)
    expect(await exited).toEqual({ code: 0, signal: null })
    const path = join(b.journalDir, `act-1%3Ad1.${pid}.json`)
    const until = Date.now() + 10_000
    while (!existsSync(path) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100))
    const journal = readBotSupervisorJournal(path)
    expect(journal).toMatchObject({ dispatchId: 'act-1:d1', pgid: pid })
    expect(journal?.killedAt).toBeUndefined()
    expect(await b.registry.settled('act-1:d1')).toEqual({ exitAt: new Date(journal!.exitAt!).toISOString() })
  }, 30_000)
})
