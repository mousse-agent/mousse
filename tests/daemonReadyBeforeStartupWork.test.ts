/**
 * The daemon is ready before the start's slow passes run: they run after ready, in the background, and a request that
 * needs one waits only for it. Here the pass that finishes deletes a crash cut short is held open: the daemon still
 * publishes its readiness (with where its start spent its time), and a delete asked for meanwhile waits for the pass,
 * then goes ahead.
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runDaemonForeground } from '../src/cli/commands/service'
import { setDiagSink } from '../src/mms/log/diag'
import { MousseMainService } from '../src/mms/MousseMainService'

describe('daemon start', () => {
  const homes: string[] = []
  afterEach(() => {
    vi.restoreAllMocks()
    setDiagSink(null)
    // Best effort: on Windows a closing database can hold a file a moment longer.
    for (const home of homes.splice(0)) { try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* left to the temp folder */ } }
  })

  it('is ready while the deletes a crash cut short are still being finished, and a new delete waits for them', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-ready-'))
    homes.push(home)
    // A delete a crash cut short: the archived thread is in the trash with its delete recorded. And one to delete later.
    const setup = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    const cutShort = setup.threads.createThread('Deleted when the service crashed').id
    const other = setup.threads.createThread('Deleted after the restart').id
    for (const id of [cutShort, other]) setup.threads.setThreadArchived(id, true)
    await setup.lifecycle.trash({ taskId: cutShort, operationId: randomUUID() })
    const profileHome = setup.threads.lifecycleStore.profileHome
    await setup.stop()
    writeFileSync(join(profileHome, 'lifecycle', 'delete-intents.json'), JSON.stringify({ [cutShort]: { human: false, discard: false, at: new Date().toISOString() } }))

    // The pass that finishes it is held until released.
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const finish = MousseMainService.prototype.finishCutShortDeletes
    vi.spyOn(MousseMainService.prototype, 'finishCutShortDeletes').mockImplementation(async function (this: MousseMainService, skip) {
      await held
      return finish.call(this, skip)
    })
    let mms: MousseMainService | undefined
    const afterReady = MousseMainService.prototype.afterReady
    vi.spyOn(MousseMainService.prototype, 'afterReady').mockImplementation(function (this: MousseMainService) {
      mms = this
      return afterReady.call(this)
    })
    const diag: string[] = []
    setDiagSink((_level, line) => diag.push(line))
    const logs: string[] = []
    const stop = new AbortController()
    const running = runDaemonForeground({ homeDir: home, skipSignals: true, stopSignal: stop.signal, onLog: (msg) => logs.push(msg) })
    try {
      // Before, the start finished these deletes before it was ready: with the pass held it never became ready.
      await vi.waitFor(() => expect(logs.join('\n')).toContain('Mousse MMS running'), { timeout: 30_000 })
      expect(mms).toBeDefined()
      const services = mms!
      // Where the start spent its time is in the daemon log: the whole start, then each step.
      expect(diag.find((line) => line.startsWith('[info:startup] ready in'))).toMatch(/^\[info:startup\] ready in \d+ ms \{.*"create":\d+.*"start":\d+/)
      expect(services.threads.lifecycleStore.require(cutShort).state).toBe('trashed')

      let deleted = false
      const deleting = services.deleteThreadForGood(other, { human: false, discard: false, internal: true }).then((record) => { deleted = true; return record })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(deleted).toBe(false)
      expect(services.threads.lifecycleStore.require(other).state).toBe('active')

      release()
      expect((await deleting).state).toBe('purged')
      await services.untilStartupLifecycleDone()
      expect(services.threads.lifecycleStore.require(cutShort).state).toBe('purged')
      await vi.waitFor(() => expect(diag.some((line) => /^\[info:startup\] after ready: lifecycle took \d+ ms$/.test(line))).toBe(true))
    } finally {
      release()
      stop.abort()
      await running
    }
  }, 120_000)
})
