import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  freeInstallFolder,
  installFolderStragglers,
  listInstallFolderProcesses,
  parseListing,
  runPowerShell,
  serviceHomeOf,
  type FreeInstallFolderOptions,
  type InstallFolderListing,
  type InstallFolderProcess
} from '../../src/main/updates/installFolder'

const DIR = 'C:\\Users\\u\\AppData\\Local\\Programs\\Mousse'
const exe = `${DIR}\\Mousse.exe`

const SELF: InstallFolderProcess = { pid: 100, parentPid: 1, path: exe, commandLine: `"${exe}"` }
const RENDERER: InstallFolderProcess = { pid: 101, parentPid: 100, path: exe, commandLine: `"${exe}" --type=renderer --app-path=x` }
const GPU: InstallFolderProcess = { pid: 102, parentPid: 100, path: exe, commandLine: `"${exe}" --type=gpu-process` }
const SERVICE: InstallFolderProcess = { pid: 200, parentPid: 100, path: exe, commandLine: `"${exe}" --cli service run --home C:\\Users\\u\\.mousse` }
const OTHER_SERVICE: InstallFolderProcess = { pid: 300, parentPid: 7, path: exe, commandLine: `"${exe}" --cli service run --home "C:\\Users\\u\\bridge home"` }
const THIRD_SERVICE: InstallFolderProcess = { pid: 310, parentPid: 7, path: exe, commandLine: `"${exe}" --cli service run --home C:\\Users\\Jörg\\.mousse-ü` }
const CLI: InstallFolderProcess = { pid: 400, parentPid: 8, path: `${DIR}\\mousse-cli.exe`, commandLine: 'mousse-cli mcp' }
const VOICE: InstallFolderProcess = { pid: 500, parentPid: 100, path: `${DIR}\\resources\\voice-engine\\mousse-voice.exe`, commandLine: 'mousse-voice.exe' }
const OTHER_GUI_RENDERER: InstallFolderProcess = { pid: 601, parentPid: 600, path: exe, commandLine: `"${exe}" --type=renderer` }
const FOREIGN: InstallFolderProcess = { pid: 700, parentPid: 9, path: `${DIR}\\Tools\\other.exe`, commandLine: 'other.exe' }

/**
 * A fake process table on the fake clock: `exitsAt` ends a process at that time, a kill ends it at once unless it
 * is unkillable.
 */
function table(initial: InstallFolderProcess[], extra: { exitsAt?: Record<number, number>; unkillable?: number[] } = {}) {
  const running = new Map(initial.map((process) => [process.pid, process]))
  const killed: number[] = []
  const stopped: Array<{ home: string; timeoutMs: number; at: number }> = []
  const listing = async (): Promise<InstallFolderListing | null> => {
    const time = Date.now()
    for (const [pid, at] of Object.entries(extra.exitsAt ?? {})) if (time >= at) running.delete(Number(pid))
    return { processes: [...running.values()], hidden: [] }
  }
  const options: FreeInstallFolderOptions = {
    selfPid: SELF.pid,
    list: listing,
    stopService: async (home, timeoutMs) => { stopped.push({ home, timeoutMs, at: Date.now() }) },
    kill: (pid) => {
      killed.push(pid)
      if (extra.unkillable?.includes(pid)) throw new Error('Access is denied')
      running.delete(pid)
    },
    serviceStopTimeoutMs: 30_000,
    graceMs: 5_000,
    killWaitMs: 10_000,
    intervalMs: 500
  }
  return { killed, stopped, options }
}

/** Runs `freeInstallFolder` on fake timers until it settles. */
async function settle(options: FreeInstallFolderOptions) {
  const run = freeInstallFolder(options)
  run.catch(() => undefined)
  await vi.advanceTimersByTimeAsync(120_000)
  return run
}

describe('install folder hand-off', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps this process and its own Chromium helpers; everything else running from the folder is a straggler', () => {
    const stragglers = installFolderStragglers([SELF, RENDERER, GPU, SERVICE, OTHER_SERVICE, CLI, VOICE, OTHER_GUI_RENDERER], SELF.pid)
    expect(stragglers.map((process) => process.pid)).toEqual([200, 300, 400, 500, 601])
  })

  it('reads the home of a background service from its command line, non-ASCII paths included', () => {
    expect(serviceHomeOf(SERVICE.commandLine)).toBe('C:\\Users\\u\\.mousse')
    expect(serviceHomeOf(OTHER_SERVICE.commandLine)).toBe('C:\\Users\\u\\bridge home')
    expect(serviceHomeOf(THIRD_SERVICE.commandLine)).toBe('C:\\Users\\Jörg\\.mousse-ü')
    expect(serviceHomeOf(`"${exe}" --cli --home=/tmp/h service run`)).toBe('/tmp/h')
    expect(serviceHomeOf(`"${exe}" --cli service status --home C:\\h`)).toBeUndefined()
    expect(serviceHomeOf(CLI.commandLine)).toBeUndefined()
  })

  it('returns at once when only this process and its helpers run', async () => {
    vi.useFakeTimers()
    const fake = table([SELF, RENDERER, GPU])
    await expect(settle(fake.options)).resolves.toEqual({ checked: true, killed: [] })
    expect(fake.stopped).toEqual([])
  })

  it('asks other services to stop and waits for stragglers that exit on their own', async () => {
    vi.useFakeTimers({ now: 0 })
    const fake = table([SELF, RENDERER, OTHER_SERVICE, THIRD_SERVICE, CLI], { exitsAt: { 300: 1_000, 310: 1_000, 400: 2_000 } })
    await expect(settle(fake.options)).resolves.toEqual({ checked: true, killed: [] })
    expect(fake.stopped.map((stop) => stop.home)).toEqual(['C:\\Users\\u\\bridge home', 'C:\\Users\\Jörg\\.mousse-ü'])
    expect(fake.killed).toEqual([])
  })

  it('stops slow services of other homes at once, each with the full stop time, and starts the grace period after them', async () => {
    vi.useFakeTimers({ now: 0 })
    const fake = table([SELF, OTHER_SERVICE, THIRD_SERVICE], { exitsAt: { 300: 25_000, 310: 27_000 } })
    // Each takes 25 s to report back: one after the other they would take 50 s.
    fake.options.stopService = async (home, timeoutMs) => {
      fake.stopped.push({ home, timeoutMs, at: Date.now() })
      await new Promise((resolve) => setTimeout(resolve, 25_000))
    }
    await expect(settle(fake.options)).resolves.toEqual({ checked: true, killed: [] })
    expect(fake.stopped.map((stop) => [stop.at, stop.timeoutMs])).toEqual([[0, 30_000], [0, 30_000]])
  })

  it('ends a service that never reports back instead of refusing after interrupting it', async () => {
    vi.useFakeTimers({ now: 0 })
    const fake = table([SELF, OTHER_SERVICE])
    fake.options.stopService = async (_home, timeoutMs) => {
      await new Promise((resolve) => setTimeout(resolve, timeoutMs))
      throw new Error('timed out')
    }
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(settle(fake.options)).resolves.toEqual({ checked: true, killed: [300] })
  })

  it('kills what is still running after the grace period, then lets the install go ahead', async () => {
    vi.useFakeTimers({ now: 0 })
    const fake = table([SELF, SERVICE, VOICE])
    await expect(settle(fake.options)).resolves.toEqual({ checked: true, killed: [200, 500] })
    expect(fake.stopped.map((stop) => stop.home)).toEqual(['C:\\Users\\u\\.mousse'])
  })

  it('refuses to go ahead while a Mousse process cannot be ended', async () => {
    vi.useFakeTimers({ now: 0 })
    const fake = table([SELF, SERVICE], { unkillable: [200] })
    await expect(settle(fake.options)).rejects.toThrow(/still running from the install folder \(Mousse\.exe 200\)/)
  })

  it('refuses, without stopping or killing anything, while another program runs from the install folder', async () => {
    vi.useFakeTimers({ now: 0 })
    const fake = table([SELF, OTHER_SERVICE, FOREIGN])
    await expect(settle(fake.options)).rejects.toThrow(/Other programs are running from the Mousse install folder \(other\.exe 700\)/)
    expect(fake.stopped).toEqual([])
    expect(fake.killed).toEqual([])
  })

  it('never counts a failed listing as a free folder: it retries, and refuses when it cannot confirm', async () => {
    vi.useFakeTimers({ now: 0 })
    // The process exits right away, but no listing after the first one works.
    const failing = table([SELF, CLI], { exitsAt: { 400: 1 } })
    const realList = failing.options.list
    let first = true
    failing.options.list = async () => {
      if (!first) return null
      first = false
      return realList()
    }
    await expect(settle(failing.options)).rejects.toThrow('could not confirm that its install folder is free')

    // Listings that fail for a while, then work again, confirm it.
    vi.setSystemTime(0)
    const flaky = table([SELF, CLI], { exitsAt: { 400: 1 } })
    let calls = 0
    const list = flaky.options.list
    flaky.options.list = async () => (calls++ >= 1 && calls <= 4 ? null : list())
    await expect(settle(flaky.options)).resolves.toEqual({ checked: true, killed: [] })
    expect(calls).toBeGreaterThan(4)
  })

  it('says when Mousse processes may hold the folder but their path cannot be seen', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await freeInstallFolder({
      selfPid: SELF.pid,
      list: async () => ({ processes: [SELF], hidden: [{ pid: 900, name: 'Mousse.exe' }] }),
      stopService: async () => undefined,
      kill: () => undefined
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Mousse.exe 900'))
  })

  it('does not check where the platform cannot list processes', async () => {
    const kill = vi.fn()
    await expect(freeInstallFolder({ selfPid: 1, list: async () => null, stopService: async () => undefined, kill })).resolves.toEqual({ checked: false, killed: [] })
    expect(kill).not.toHaveBeenCalled()
    await expect(listInstallFolderProcesses('/opt/Mousse', 'linux')).resolves.toBeNull()
  })
})

describe('PowerShell process listing', () => {
  it('reads the listing, one process or several, with or without a byte order mark', () => {
    const one = JSON.stringify({ processes: { pid: 5, parentPid: 1, path: 'C:\\Jörg\\Mousse.exe', commandLine: 'service run --home C:\\Jörg\\.mousse' }, hidden: [] })
    expect(parseListing(`\uFEFF${one}\r\n`)).toEqual({
      processes: [{ pid: 5, parentPid: 1, path: 'C:\\Jörg\\Mousse.exe', commandLine: 'service run --home C:\\Jörg\\.mousse' }],
      hidden: []
    })
    const several = JSON.stringify({
      processes: [{ pid: 5, parentPid: 1, path: 'a', commandLine: null }, { pid: 'x' }],
      hidden: { pid: 9, name: 'Mousse.exe' }
    })
    expect(parseListing(several)).toEqual({ processes: [{ pid: 5, parentPid: 1, path: 'a', commandLine: '' }], hidden: [{ pid: 9, name: 'Mousse.exe' }] })
    expect(parseListing('{"processes":[],"hidden":[]}')).toEqual({ processes: [], hidden: [] })
  })

  it('rejects output that is not the listing, so it never reads as an empty folder', () => {
    expect(() => parseListing('')).toThrow()
    expect(() => parseListing('[]')).toThrow()
    expect(() => parseListing('Get-CimInstance : Access denied')).toThrow()
  })

  it.skipIf(process.platform !== 'win32')('PowerShell writes non-ASCII text as UTF-8', async () => {
    const text = 'C:\\Users\\Jörg Ünïcødé\\.mousse — 日本'
    const out = await runPowerShell('Write-Output $env:MOUSSE_TEST_TEXT', { MOUSSE_TEST_TEXT: text })
    expect(out.trim()).toBe(text)
  }, 30_000)

  it.skipIf(process.platform !== 'win32')('lists a running service with a non-ASCII home, intact', async () => {
    const home = 'C:\\Users\\Jörg Ünï\\.mousse'
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', '--', '--cli', 'service', 'run', '--home', home], { stdio: 'ignore', windowsHide: true })
    try {
      await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject) })
      const listing = await listInstallFolderProcesses(dirname(process.execPath))
      const found = listing?.processes.find((process) => process.pid === child.pid)
      expect(found).toBeDefined()
      expect(serviceHomeOf(found!.commandLine)).toBe(home)
    } finally {
      child.kill()
    }
  }, 30_000)
})
