/**
 * After the tray's Quit, the background service really ends, and Mousse opened again meanwhile waits for it instead of
 * failing. A stopping service closes its endpoint first and keeps the home (its lease and readiness record) until its
 * work has drained, so for a while a new window client finds a service that holds the home but cannot be reached.
 *
 * Real services run in this process; only how the window client starts a service is replaced, so the "new" service is
 * another in-process daemon over the same home.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { GuiMmsController, type GuiMmsConnectionState } from '../src/main/mms/GuiMmsController'
import { stopServiceForQuit } from '../src/main/mms/stopServiceForQuit'
import { runDaemonForeground } from '../src/cli/commands/service'
import { sendDaemonStop, type DaemonLifecycleState } from '../src/cli/daemonShutdown'
import { getMmsRuntimePath, readRuntimeRecord, readStopRequest, resolveRuntimeStatus } from '../src/cli/mmsRuntime'
import { readOwnerRecord, resolveOwnerStatus } from '../src/mms/ownership/MmsOwnerLease'

vi.setConfig({ testTimeout: 90_000 })

/** Resolves true when something accepts connections at the endpoint. */
function endpointAccepts(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

/** Holds every service's stop until `release`, like work that takes long to drain. */
function holdServiceStops(): { release: () => void } {
  let open!: () => void
  const gate = new Promise<void>((resolve) => { open = resolve })
  let held = true
  const stop = MousseMainService.prototype.stop
  vi.spyOn(MousseMainService.prototype, 'stop').mockImplementation(async function (this: MousseMainService, options) {
    if (held) await gate
    return stop.call(this, options)
  })
  return { release: () => { held = false; open() } }
}

describe('Quit, then open Mousse again', () => {
  const homes: string[] = []
  const daemons: Array<{ stop: AbortController; running: Promise<DaemonLifecycleState> }> = []
  const newHome = (): string => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-quit-reopen-'))
    homes.push(home)
    process.env.MOUSSE_HOME = home
    return home
  }
  const startDaemon = (home: string, extra: Partial<Parameters<typeof runDaemonForeground>[0]> = {}) => {
    const stop = new AbortController()
    const running = runDaemonForeground({ homeDir: home, skipSignals: true, stopSignal: stop.signal, onLog: () => undefined, ...extra })
    daemons.push({ stop, running })
    return running
  }
  const ready = async (home: string): Promise<string> => {
    await vi.waitFor(() => expect(resolveRuntimeStatus(home).record).toBeTruthy(), { timeout: 60_000, interval: 50 })
    return readRuntimeRecord(home)!.token
  }
  /** A window client whose service start runs another in-process daemon over the home. */
  const reopenedApp = (home: string) => {
    const gui = new GuiMmsController({ homeDir: home, reconnectBaseMs: 5, requestTimeoutMs: 10_000 })
    const states: GuiMmsConnectionState[] = []
    const errors: Error[] = []
    gui.on('state', (state: GuiMmsConnectionState) => states.push(state))
    gui.on('error', (error: Error) => errors.push(error))
    const spawn = vi.spyOn(gui as unknown as { spawnDaemon: () => Promise<unknown> }, 'spawnDaemon').mockImplementation(async () => {
      void startDaemon(home)
      return { exitCode: null, signalCode: null }
    })
    return { gui, states, errors, spawn }
  }

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const daemon of daemons.splice(0)) {
      daemon.stop.abort()
      const state = await daemon.running
      await state.mms?.stop().catch(() => undefined)
    }
    delete process.env.MOUSSE_HOME
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  it('a service still draining after Quit is waited for, then a new one starts and the app connects to it; no error on the way', async () => {
    const home = newHome()
    const first = startDaemon(home)
    const firstToken = await ready(home)
    const quitting = new GuiMmsController({ homeDir: home, disableAutoStart: true })
    await quitting.start()

    const drain = holdServiceStops()
    await stopServiceForQuit(quitting, home)
    // What the reopened app found on Windows: the endpoint closed, the readiness record and the lease still there.
    await vi.waitFor(async () => expect(await endpointAccepts(readOwnerRecord(home)!.endpoint!)).toBe(false), { timeout: 10_000 })
    expect(existsSync(getMmsRuntimePath(home))).toBe(true)
    expect(readStopRequest(home, firstToken)).not.toBeNull()
    expect(resolveOwnerStatus(home).record?.token).toBe(firstToken)

    const app = reopenedApp(home)
    let connected = false
    const starting = app.gui.start().then((hello) => { connected = true; return hello })
    starting.catch(() => undefined)
    // Before, this failed at once with ENOENT and the window showed "Could not connect to workspace" and Retry.
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(connected).toBe(false)
    expect(app.states).not.toContain('failed')
    expect(app.spawn).not.toHaveBeenCalled()

    drain.release()
    const hello = await starting
    expect(app.spawn).toHaveBeenCalledTimes(1)
    expect(app.gui.connected).toBe(true)
    expect(readRuntimeRecord(home)?.token).not.toBe(firstToken)
    expect(hello.instanceId).toBeTruthy()
    expect(app.states).not.toContain('failed')
    expect(app.errors).toEqual([])
    expect((await first).mms).toBeNull()
    await app.gui.stop()
  })

  it('a service that holds the home but whose endpoint is gone is asked to stop, and the app connects to a new one', async () => {
    const home = newHome()
    const servers: MmsProtocolServer[] = []
    const serve = MmsProtocolServer.prototype.start
    vi.spyOn(MmsProtocolServer.prototype, 'start').mockImplementation(function (this: MmsProtocolServer) {
      servers.push(this)
      return serve.call(this)
    })
    const first = startDaemon(home)
    const firstToken = await ready(home)
    // Its server ended without a stop request: nothing would ever make this service go.
    await servers[0]!.stop()
    expect(readStopRequest(home, firstToken)).toBeNull()

    const app = reopenedApp(home)
    await app.gui.start()
    expect(app.spawn).toHaveBeenCalledTimes(1)
    expect(app.gui.connected).toBe(true)
    expect(readRuntimeRecord(home)?.token).not.toBe(firstToken)
    expect(app.states).not.toContain('failed')
    expect((await first).mms).toBeNull()
    await app.gui.stop()
  })

  it('a stopping service exits by its deadline even when its stop never finishes', async () => {
    const home = newHome()
    const drain = holdServiceStops()
    const exits: number[] = []
    let ended = false
    const first = startDaemon(home, {
      exitDeadline: { ms: 300, exit: (code) => exits.push(code) },
      drainWait: { retryDelayMs: 5, stuckAfterMs: 60_000 }
    })
    void first.then(() => { ended = true })
    await ready(home)
    await sendDaemonStop(home, { reason: 'gui-quit' })
    await vi.waitFor(() => expect(exits).toEqual([0]), { timeout: 5_000 })
    // Teardown itself is still waiting for the stop: the deadline is what ends the process.
    expect(ended).toBe(false)
    drain.release()
    await first
  })
})
