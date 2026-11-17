/**
 * Keeping the computer awake while runs work. The background service counts the runs that are working in every
 * profile that keeps the computer awake, and sends the count to the app (`power.activeRuns`), whose main process holds
 * the sleep blocker. While no app is attached, the service holds its own. Either one lets go a grace after the last run
 * ends.
 */
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ powerSaveBlocker: { start: () => 0, stop: () => undefined } }))

import { watchKeepAwake } from '../src/main/keepAwake'
import { MousseMainService } from '../src/mms/MousseMainService'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import type { ProtocolEvent } from '../src/mms/protocol/types'
import { ACTIVE_RUNS_EVENT, KEEP_AWAKE_CAPABILITY, KEEP_AWAKE_GRACE_MS, SleepHold } from '../src/shared/keepAwake'

function fakeBlocker() {
  const calls: string[] = []
  let held = false
  return {
    calls,
    get held() { return held },
    start() { held = true; calls.push('start') },
    stop() { held = false; calls.push('stop') }
  }
}

describe('SleepHold', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('holds while runs work and for the grace after the last one, and a run inside the grace keeps the same hold', () => {
    const blocker = fakeBlocker()
    const hold = new SleepHold(blocker, KEEP_AWAKE_GRACE_MS)

    hold.update(false)
    expect(blocker.calls).toEqual([])

    hold.update(true)
    hold.update(true)
    expect(blocker.calls).toEqual(['start'])

    // Back-to-back turns: the next one starts inside the grace, so the blocker is never let go.
    hold.update(false)
    vi.advanceTimersByTime(KEEP_AWAKE_GRACE_MS - 1)
    hold.update(true)
    vi.advanceTimersByTime(KEEP_AWAKE_GRACE_MS * 2)
    expect(blocker.calls).toEqual(['start'])
    expect(blocker.held).toBe(true)

    hold.update(false)
    vi.advanceTimersByTime(KEEP_AWAKE_GRACE_MS - 1)
    expect(blocker.held).toBe(true)
    vi.advanceTimersByTime(1)
    expect(blocker.calls).toEqual(['start', 'stop'])

    // `release` lets go at once, without the grace.
    hold.update(true)
    hold.release()
    expect(blocker.held).toBe(false)
    vi.advanceTimersByTime(KEEP_AWAKE_GRACE_MS)
    expect(blocker.calls).toEqual(['start', 'stop', 'start', 'stop'])
  })
})

describe("the app's blocker (watchKeepAwake)", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("follows the service's installation count, ignores profile events, and lets go a grace after the connection drops", () => {
    const blocker = fakeBlocker()
    const guiMms = new EventEmitter()
    const stop = watchKeepAwake(guiMms, { blocker })

    guiMms.emit('event', { type: ACTIVE_RUNS_EVENT, data: { active: 2 }, profileId: 'p1' })
    expect(blocker.held).toBe(false)
    guiMms.emit('event', { type: ACTIVE_RUNS_EVENT, data: { active: 2 } })
    expect(blocker.held).toBe(true)

    guiMms.emit('event', { type: ACTIVE_RUNS_EVENT, data: { active: 0 } })
    vi.advanceTimersByTime(KEEP_AWAKE_GRACE_MS - 1)
    expect(blocker.held).toBe(true)
    guiMms.emit('event', { type: ACTIVE_RUNS_EVENT, data: { active: 1 } })
    vi.advanceTimersByTime(KEEP_AWAKE_GRACE_MS)
    expect(blocker.calls).toEqual(['start'])

    // The service went away: its runs cannot be working through this app any more, and a service still running holds
    // its own blocker from now on.
    guiMms.emit('state', 'reconnecting')
    vi.advanceTimersByTime(KEEP_AWAKE_GRACE_MS)
    expect(blocker.calls).toEqual(['start', 'stop'])

    guiMms.emit('event', { type: ACTIVE_RUNS_EVENT, data: { active: 1 } })
    stop()
    expect(blocker.held).toBe(false)
    guiMms.emit('event', { type: ACTIVE_RUNS_EVENT, data: { active: 1 } })
    expect(blocker.held).toBe(false)
  })
})

describe('the service counts working runs and holds its own blocker while no app is attached', () => {
  let home: string
  let mms: MousseMainService
  let server: MmsProtocolServer
  let serviceBlocker: ReturnType<typeof fakeBlocker>
  const clients: LocalMmsClient[] = []

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-keep-awake-'))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
    serviceBlocker = fakeBlocker()
    server = new MmsProtocolServer({ mms, ownerToken: mms.getOwnerLease()!.owner.token, version: 'test', sleepBlocker: serviceBlocker })
  })

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => undefined)
    await server.stop()
    await mms.stop()
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  /** An app connection that asks for the count, and the counts it has heard. */
  async function attachApp(endpoint: string): Promise<{ client: LocalMmsClient; counts: number[] }> {
    const client = new LocalMmsClient({
      homeDir: home,
      ownerToken: mms.getOwnerLease()!.owner.token,
      endpoint,
      clientType: 'gui',
      requestedCapabilities: [KEEP_AWAKE_CAPABILITY]
    })
    clients.push(client)
    const counts: number[] = []
    client.onEvent((event: ProtocolEvent) => {
      if (event.type === ACTIVE_RUNS_EVENT) counts.push((event.data as { active: number }).active)
    })
    await client.connect()
    await client.subscribe(0)
    return { client, counts }
  }

  /** A run of `source` on a thread of its own, moved to `running` by the run engine. */
  function startRun(source: string): string {
    const thread = mms.threads.createThread(`${source} work`, undefined, undefined, { started: true })
    const run = mms.runEngine.store.createRun({ threadId: thread.id, source })
    mms.runEngine.markStarting(run.runId)
    mms.runEngine.markRunning(run.runId)
    return run.runId
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

  it("counts thread, subagent and bot runs alike, leaves queued and paused ones out, and hands the blocker between the app and the service", async () => {
    const endpoint = await server.start()
    const app = await attachApp(endpoint)
    await settle()
    expect(app.counts.at(-1)).toBe(0)

    // A run waiting in the queue does no work yet.
    const thread = mms.threads.createThread('queued work', undefined, undefined, { started: true })
    mms.runEngine.store.createRun({ threadId: thread.id, source: 'user' })

    const turn = startRun('user')
    const subagent = startRun('delegation')
    const bot = startRun('bot')
    await settle()
    expect(app.counts.at(-1)).toBe(3)
    // The app is attached, so the app holds the blocker, not the service.
    expect(serviceBlocker.calls).toEqual([])

    // A run waiting for a usage limit to reset is idle.
    mms.runEngine.pauseRun({ runId: bot, pause: { reason: 'usage_limit', until: new Date(Date.now() + 3_600_000).toISOString(), estimated: true } })
    await settle()
    expect(app.counts.at(-1)).toBe(2)

    // The app quits while runs work: the service holds its own blocker.
    await app.client.close()
    await settle()
    expect(serviceBlocker.held).toBe(true)

    // The app comes back: it hears the count at once and the service lets go of its own.
    const again = await attachApp(endpoint)
    await settle()
    expect(again.counts.at(-1)).toBe(2)
    expect(serviceBlocker.held).toBe(false)

    mms.runEngine.markTerminal(turn, 'completed')
    mms.runEngine.markTerminal(subagent, 'completed')
    await settle()
    expect(again.counts.at(-1)).toBe(0)
  })

  it('leaves out the runs of a profile whose setting is off, and counts them again when it is turned on', async () => {
    const endpoint = await server.start()
    const app = await attachApp(endpoint)
    startRun('user')
    await settle()
    expect(app.counts.at(-1)).toBe(1)

    await app.client.request('settings.set', { partial: { runs: { ...mms.settings.get().runs, keepAwake: false } } })
    await settle()
    expect(app.counts.at(-1)).toBe(0)
    await app.client.close()
    await settle()
    expect(serviceBlocker.held).toBe(false)

    mms.settings.set({ runs: { ...mms.settings.get().runs, keepAwake: true } })
    await settle()
    expect(serviceBlocker.held).toBe(true)
  })
})
