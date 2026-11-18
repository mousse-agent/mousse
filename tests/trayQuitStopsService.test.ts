/**
 * The tray's Quit ends Mousse at once and stops its background service, also while that service is still starting:
 * the window client stops connecting and never starts a service again, the stop reaches the service as soon as it
 * holds the home, and nothing waits for the service to become ready or to finish stopping.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { GuiMmsController } from '../src/main/mms/GuiMmsController'
import { stopServiceForQuit } from '../src/main/mms/stopServiceForQuit'
import { runDaemonForeground } from '../src/cli/commands/service'
import { getMmsRuntimePath, readStopRequest } from '../src/cli/mmsRuntime'
import { acquireMmsOwnerLease, resolveOwnerStatus } from '../src/mms/ownership/MmsOwnerLease'

function fakeWindow(id: number): WebContents {
  return Object.assign(new EventEmitter(), { id, isDestroyed: () => false }) as unknown as WebContents
}

describe('Quit from the tray', () => {
  const homes: string[] = []
  const newHome = (): string => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-tray-quit-'))
    homes.push(home)
    return home
  }

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.MOUSSE_HOME
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  it('while the service is starting: returns before it is ready, it stops without starting, and none starts again', async () => {
    const home = newHome()
    process.env.MOUSSE_HOME = home
    // Holds the service's creation after it took the home's lease, like a slow start does.
    let releaseCreation!: () => void
    const creationGate = new Promise<void>((resolve) => { releaseCreation = resolve })
    const initialize = MousseMainService.prototype.initialize
    vi.spyOn(MousseMainService.prototype, 'initialize').mockImplementation(async function (this: MousseMainService) {
      await creationGate
      return initialize.call(this)
    })
    const serviceStart = vi.spyOn(MousseMainService.prototype, 'start')
    const logs: string[] = []
    // Only for cleanup when the test fails.
    const cleanup = new AbortController()
    const service = runDaemonForeground({ homeDir: home, skipSignals: true, stopSignal: cleanup.signal, onLog: (msg) => logs.push(msg) })
    const gui = new GuiMmsController({ homeDir: home, reconnectBaseMs: 5 })
    const spawn = vi.spyOn(gui as unknown as { spawnDaemon: () => Promise<unknown> }, 'spawnDaemon').mockRejectedValue(new Error('spawned'))
    try {
      await vi.waitFor(() => expect(resolveOwnerStatus(home).owned).toBe(true), { timeout: 20_000 })
      // The window client waits for the service to become ready, as it does at launch.
      const connecting = gui.start()
      connecting.catch(() => undefined)

      // Returns while the service is still being created. Before, the client's disconnect waited for that start
      // until the 30-second readiness wait ran out.
      let quitDone = false
      const quit = stopServiceForQuit(gui, home).then(() => { quitDone = true })
      await vi.waitFor(() => expect(quitDone).toBe(true), { timeout: 10_000 })
      await quit
      await expect(connecting).rejects.toThrow()
      expect(existsSync(getMmsRuntimePath(home))).toBe(false)

      // The service reads the stop (fenced by its token) while still starting, ends there, and gives the home back.
      await vi.waitFor(() => expect(logs.join('')).toContain('Shutting down MMS (stop-request)'), { timeout: 5_000 })
      releaseCreation()
      await service
      expect(serviceStart).not.toHaveBeenCalled()
      expect(resolveOwnerStatus(home).owned).toBe(false)

      // With the service gone, a window's request does not start a new one.
      await expect(gui.runWithSender(fakeWindow(51), () => gui.request('threads.list'))).rejects.toThrow()
      await expect(gui.start()).rejects.toThrow('stopped')
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      releaseCreation()
      cleanup.abort()
      const state = await service
      await state.mms?.stop().catch(() => undefined)
      await gui.stop()
    }
  }, 60_000)

  it('right after this run started the service: the stop waits for it to take the home, then reaches it', async () => {
    const home = newHome()
    const controller = { spawnedServiceRunning: true, stopForQuit: vi.fn(async () => undefined) }
    const quitting = stopServiceForQuit(controller, home, { waitForOwnerMs: 10_000 })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(readStopRequest(home)).toBeNull()
    const lease = acquireMmsOwnerLease(home, { kind: 'daemon' })
    try {
      await quitting
      expect(readStopRequest(home)?.token).toBe(lease.owner.token)
      expect(controller.stopForQuit).toHaveBeenCalledTimes(1)
    } finally {
      lease.release()
    }
  })
})
