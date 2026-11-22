/**
 * The tray's Quit ends Mousse at once and stops its background service, also while that service is still starting:
 * windows close first (an editor with unsaved edits keeps Mousse open), then the tray icon goes, the window client
 * stops connecting and never starts a service again, and the stop reaches the service that holds the home and the
 * one this run started. Nothing waits for the service to become ready or to finish stopping.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

const trays = vi.hoisted(() => [] as Array<{ destroyed: boolean; menu: { template: Array<{ label?: string; click?: () => void }> } | null }>)
vi.mock('electron', () => {
  class Tray {
    destroyed = false
    menu: { template: Array<{ label?: string; click?: () => void }> } | null = null
    constructor() { trays.push(this) }
    setToolTip(): void {}
    setContextMenu(menu: { template: Array<{ label?: string; click?: () => void }> }): void { this.menu = menu }
    on(): void {}
    destroy(): void { this.destroyed = true }
  }
  return { Tray, Menu: { buildFromTemplate: (template: unknown) => ({ template }) } }
})

import { MousseMainService } from '../src/mms/MousseMainService'
import { GuiMmsController } from '../src/main/mms/GuiMmsController'
import { stopServiceForQuit } from '../src/main/mms/stopServiceForQuit'
import { createServiceTray } from '../src/main/serviceTray'
import { createTrayQuit, type QuitWindow } from '../src/main/trayQuit'
import { runDaemonForeground } from '../src/cli/commands/service'
import { getMmsRuntimePath, readStopRequest } from '../src/cli/mmsRuntime'
import { acquireMmsOwnerLease, createOwnerToken, readOwnerRecord, resolveOwnerStatus } from '../src/mms/ownership/MmsOwnerLease'

function senderWindow(id: number): WebContents {
  return Object.assign(new EventEmitter(), { id, isDestroyed: () => false }) as unknown as WebContents
}

/** A window that closes, or keeps itself open the way an editor with unsaved edits does (its `beforeunload`). */
function appWindow(opts: { unsavedEdits?: boolean } = {}): QuitWindow & { closed: boolean; shown: number } {
  const webContents = new EventEmitter()
  const window = Object.assign(new EventEmitter(), {
    closed: false,
    shown: 0,
    webContents,
    isDestroyed: () => window.closed,
    show: () => { window.shown += 1 },
    focus: () => undefined,
    close: () => {
      setTimeout(() => {
        if (opts.unsavedEdits) {
          webContents.emit('will-prevent-unload')
          return
        }
        window.closed = true
        window.emit('closed')
      }, 5)
    }
  })
  return window as unknown as QuitWindow & { closed: boolean; shown: number }
}

/** The tray as main makes it, with its Quit wired the way main wires it. Returns the Quit menu item's click. */
function trayWithQuit(windows: QuitWindow[], quit: () => void): { click: () => void; tray: (typeof trays)[number] } {
  let quitting = false
  let created: { destroy(): void } | null = null
  created = createServiceTray('icon.png', {
    open: () => undefined,
    quitAndStop: createTrayQuit({
      windows: () => windows,
      isQuitting: () => quitting,
      destroyTray: () => created?.destroy(),
      quit: () => {
        quitting = true
        quit()
      }
    })
  })
  const tray = trays.at(-1)!
  const item = tray.menu!.template.find((entry) => entry.label === 'Quit Mousse and stop background work')!
  return { click: () => item.click!(), tray }
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
    trays.splice(0)
    delete process.env.MOUSSE_HOME
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  it('while the service is starting: window and tray go at once, the service stops without starting, and none starts again', async () => {
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

      const window = appWindow()
      let quitDone = false
      let quit: Promise<void> | undefined
      const { click, tray } = trayWithQuit([window], () => {
        quit = stopServiceForQuit(gui, home).then(() => { quitDone = true })
      })
      click()
      // Gone while the service is still being created. Before, the client's disconnect waited for that start
      // until the 30-second readiness wait ran out.
      await vi.waitFor(() => expect(quitDone).toBe(true), { timeout: 10_000 })
      await quit
      expect(window.closed).toBe(true)
      expect(tray.destroyed).toBe(true)
      await expect(connecting).rejects.toThrow()
      expect(existsSync(getMmsRuntimePath(home))).toBe(false)

      // The service reads the stop (fenced by its token) while still starting, ends there, and gives the home back.
      await vi.waitFor(() => expect(logs.join('')).toContain('Shutting down MMS (stop-request)'), { timeout: 5_000 })
      releaseCreation()
      await service
      expect(serviceStart).not.toHaveBeenCalled()
      expect(resolveOwnerStatus(home).owned).toBe(false)

      // With the service gone, a window's request does not start a new one.
      await expect(gui.runWithSender(senderWindow(51), () => gui.request('threads.list'))).rejects.toThrow()
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

  it('a window with unsaved edits keeps Mousse open: the tray stays, the service is not stopped, the window comes forward', async () => {
    const kept = appWindow({ unsavedEdits: true })
    const other = appWindow()
    const quit = vi.fn()
    const { click, tray } = trayWithQuit([other, kept], quit)
    click()
    await vi.waitFor(() => expect(kept.shown).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(quit).not.toHaveBeenCalled()
    expect(tray.destroyed).toBe(false)
    expect(kept.closed).toBe(false)
  })

  it('an update install waiting on the Quit hears its outcome only once the windows have decided', async () => {
    const quitAndStop = (windows: QuitWindow[]) => createTrayQuit({ windows: () => windows, isQuitting: () => false, destroyTray: () => undefined, quit: () => undefined })
    // Nothing asked: the install goes ahead.
    await expect(quitAndStop([appWindow()]).decided()).resolves.toBe(false)
    // A window's beforeunload is still running: the answer waits for it.
    const vetoed = quitAndStop([appWindow({ unsavedEdits: true })])
    vetoed()
    await expect(vetoed.decided()).resolves.toBe(false)
    const closing = quitAndStop([appWindow()])
    closing()
    expect(closing.closing).toBe(true)
    await expect(closing.decided()).resolves.toBe(true)
    await expect(closing.decided()).resolves.toBe(true)
  })

  it('the service this run started gets the stop before it takes the home; one started by anything else is left alone', async () => {
    const home = newHome()
    process.env.MOUSSE_HOME = home
    // The window client chose the token of the service it just started; that service has not taken the home yet.
    const spawnedToken = createOwnerToken()
    const controller = { spawnedServiceToken: spawnedToken, stopForQuit: vi.fn(async () => undefined) }
    await stopServiceForQuit(controller, home)

    // Meanwhile `service start` brought up another service, which takes the home first.
    const other = acquireMmsOwnerLease(home, { kind: 'daemon' })
    try {
      expect(readStopRequest(home, other.owner.token)).toBeNull()
      // The service this run started reads its stop and never takes the home.
      const logs: string[] = []
      const state = await runDaemonForeground({ homeDir: home, ownerToken: spawnedToken, skipSignals: true, onLog: (msg) => logs.push(msg) })
      expect(state.shuttingDown).toBe(true)
      expect(logs.join('')).toContain('Shutting down MMS (stop-request)')
      expect(readOwnerRecord(home)?.token).toBe(other.owner.token)
      expect(readStopRequest(home, spawnedToken)).toBeNull()
    } finally {
      other.release()
    }
  }, 30_000)
})
