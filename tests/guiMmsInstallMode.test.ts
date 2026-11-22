/**
 * While an update installs, the window client must never start or reconnect to the background service: a service
 * started then runs the old executable and keeps the installer from replacing it.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { GuiMmsController } from '../src/main/mms/GuiMmsController'
import * as daemonHost from '../src/cli/daemonHost'
import * as windowsGit from '../src/main/mms/windowsGit'
import * as nativeGit from '../src/main/mms/nativeGit'

function fakeWindow(id: number): WebContents {
  return Object.assign(new EventEmitter(), { id, isDestroyed: () => false }) as unknown as WebContents
}

interface Internals {
  spawnDaemon: () => Promise<unknown>
  connectOnce: () => Promise<unknown>
}

describe('GuiMmsController while an update installs', () => {
  const homes: string[] = []
  const newHome = (): string => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-gui-install-'))
    homes.push(home)
    return home
  }

  afterEach(() => {
    vi.restoreAllMocks()
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  it('waits for Git setup before starting the daemon and passes the new Git on its PATH', async () => {
    const home = newHome()
    const gui = new GuiMmsController({ homeDir: home })
    const cmdDir = join(home, 'git', 'cmd')
    let completeSetup!: (cmdDir: string) => void
    const installing = new Promise<string>((resolve) => { completeSetup = resolve })
    vi.spyOn(windowsGit, 'ensureWindowsGit').mockImplementation(({ onSetup }) => {
      onSetup({ phase: 'downloading' })
      return installing
    })
    vi.spyOn(daemonHost, 'resolveDaemonHostInvocation').mockReturnValue({
      command: process.execPath,
      argsPrefix: ['-e', 'console.log(process.env.PATH)', '--'],
      env: { PATH: 'original-path', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }
    })

    try {
      const start = gui.start()
      const failure = expect(start).rejects.toThrow('MMS daemon exited before readiness')
      expect(gui.gitPrerequisite?.phase).toBe('downloading')
      completeSetup(cmdDir)
      await failure
      expect(readFileSync(join(home, 'mms-startup.log'), 'utf8').trim()).toBe(`${cmdDir};original-path`)
      expect(gui.gitPrerequisite).toBeNull()
    } finally {
      completeSetup(cmdDir)
      await gui.stop()
    }
  })

  it.skipIf(process.platform === 'win32')('starts the service only after the native installer makes Git available', async () => {
    const home = newHome()
    const gui = new GuiMmsController({ homeDir: home })
    const gitDir = join(home, 'system-bin')
    const findGit = vi.spyOn(nativeGit, 'findNativeGit').mockResolvedValue(undefined)
    vi.spyOn(nativeGit, 'nativeGitInstaller').mockResolvedValue({
      platform: 'linux', command: '/usr/bin/pkexec', args: [], readyMessage: 'Confirm the package install.',
      failureMessage: 'The package install failed.'
    })
    const install = vi.spyOn(nativeGit, 'installNativeGit').mockRejectedValueOnce(new Error('Canceled'))
      .mockImplementationOnce(async () => {
        findGit.mockResolvedValue(gitDir)
        return true
      })
    vi.spyOn(daemonHost, 'resolveDaemonHostInvocation').mockReturnValue({
      command: process.execPath,
      argsPrefix: ['-e', 'console.log(process.env.PATH)', '--'],
      env: { PATH: '/original' }
    })

    try {
      await expect(gui.start()).rejects.toThrow('Git is required')
      expect(gui.gitPrerequisite).toMatchObject({ phase: 'required', canInstall: true })
      expect(install).not.toHaveBeenCalled()

      await expect(gui.installGit()).resolves.toBe(false)
      expect(gui.gitPrerequisite).toMatchObject({ phase: 'required', message: 'The package install failed.' })
      await expect(gui.installGit()).resolves.toBe(true)
      await expect(gui.start()).rejects.toThrow('MMS daemon exited before readiness')
      expect(readFileSync(join(home, 'mms-startup.log'), 'utf8').trim()).toBe(`${gitDir}:/original`)
      expect(gui.gitPrerequisite).toBeNull()
    } finally {
      await gui.stop()
    }
  })

  it('a window request after the service exited starts it again after a plain stop, but not in install mode', async () => {
    const gui = new GuiMmsController({ homeDir: newHome() })
    const internals = gui as unknown as Internals
    const spawn = vi.spyOn(internals, 'spawnDaemon').mockRejectedValue(new Error('spawned'))
    const window = fakeWindow(41)

    // What happened before: stop() re-arms the controller, so the next window request spawns the service.
    await gui.stop()
    await expect(gui.runWithSender(window, () => gui.request('threads.list'))).rejects.toThrow('spawned')
    expect(spawn).toHaveBeenCalledTimes(1)

    await gui.stopForInstall()
    expect(gui.installingUpdate).toBe(true)
    await expect(gui.runWithSender(window, () => gui.request('threads.list'))).rejects.toThrow('installing an update')
    await expect(gui.request('threads.list')).rejects.toThrow('installing an update')
    await expect(gui.start()).rejects.toThrow('installing an update')
    // Quitting for the installer stops the controller again; that must not re-arm it.
    await gui.stop()
    await expect(gui.runWithSender(window, () => gui.request('threads.list'))).rejects.toThrow('installing an update')
    expect(spawn).toHaveBeenCalledTimes(1)

    // The installer could not start: Mousse carries on and may start its service again.
    gui.resumeAfterInstall()
    await expect(gui.start()).rejects.toThrow('spawned')
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it("an update install that fails after the tray's Quit does not bring the service back", async () => {
    const gui = new GuiMmsController({ homeDir: newHome() })
    const spawn = vi.spyOn(gui as unknown as Internals, 'spawnDaemon').mockRejectedValue(new Error('spawned'))
    await gui.stopForQuit()
    // An install already under way stops the client for itself, its installer does not start, and it recovers.
    await gui.stopForInstall()
    gui.resumeAfterInstall()
    await expect(gui.start()).rejects.toThrow('stopped')
    await expect(gui.runWithSender(fakeWindow(43), () => gui.request('threads.list'))).rejects.toThrow('stopped')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('a connected window does not reconnect or start the service when it exits during the install', async () => {
    const home = newHome()
    const previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'daemon' })
    await mms.start()
    const ownerToken = mms.getOwnerLease()!.owner.token
    const server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    const endpoint = await server.start()
    mms.getOwnerLease()?.setEndpoint(endpoint)
    let serviceRunning = true
    const gui = new GuiMmsController({ homeDir: home, endpointOverride: endpoint, ownerTokenOverride: ownerToken, reconnectBaseMs: 5 })
    try {
      const internals = gui as unknown as Internals
      const spawn = vi.spyOn(internals, 'spawnDaemon').mockRejectedValue(new Error('spawned'))
      const window = fakeWindow(42)
      await gui.start()
      await gui.prepareWindow(window)
      const connect = vi.spyOn(internals, 'connectOnce')

      await gui.stopForInstall()
      // The service exits, as the installer hand-off asks it to.
      await server.stop()
      await mms.stop()
      serviceRunning = false
      await new Promise((resolve) => setTimeout(resolve, 100))

      await expect(gui.runWithSender(window, () => gui.request('threads.list'))).rejects.toThrow('installing an update')
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(connect).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
      expect(gui.connectionState).toBe('stopped')
    } finally {
      await gui.stop()
      if (serviceRunning) {
        await server.stop()
        await mms.stop()
      }
      if (previousHome === undefined) delete process.env.MOUSSE_HOME
      else process.env.MOUSSE_HOME = previousHome
    }
  })
})
