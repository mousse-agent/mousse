import { describe, expect, it, vi } from 'vitest'
import {
  freeInstallFolder,
  installFolderStragglers,
  serviceHomeOf,
  type InstallFolderProcess
} from '../../src/main/updates/installFolder'

const DIR = 'C:\\Users\\u\\AppData\\Local\\Programs\\Mousse'
const exe = `${DIR}\\Mousse.exe`

const SELF: InstallFolderProcess = { pid: 100, parentPid: 1, path: exe, commandLine: `"${exe}"` }
const RENDERER: InstallFolderProcess = { pid: 101, parentPid: 100, path: exe, commandLine: `"${exe}" --type=renderer --app-path=x` }
const GPU: InstallFolderProcess = { pid: 102, parentPid: 100, path: exe, commandLine: `"${exe}" --type=gpu-process` }
const SERVICE: InstallFolderProcess = { pid: 200, parentPid: 100, path: exe, commandLine: `"${exe}" --cli service run --home C:\\Users\\u\\.mousse` }
const OTHER_SERVICE: InstallFolderProcess = { pid: 300, parentPid: 7, path: exe, commandLine: `"${exe}" --cli service run --home "C:\\Users\\u\\bridge home"` }
const CLI: InstallFolderProcess = { pid: 400, parentPid: 8, path: `${DIR}\\mousse-cli.exe`, commandLine: 'mousse-cli mcp' }
const VOICE: InstallFolderProcess = { pid: 500, parentPid: 100, path: `${DIR}\\resources\\voice-engine\\mousse-voice.exe`, commandLine: 'mousse-voice.exe' }
const OTHER_GUI_RENDERER: InstallFolderProcess = { pid: 601, parentPid: 600, path: exe, commandLine: `"${exe}" --type=renderer` }

/** A fake process table: `list` reports what still runs, at the fake clock's time. */
function table(initial: InstallFolderProcess[], exitsAt: Record<number, number> = {}) {
  let clock = 0
  const running = new Map(initial.map((process) => [process.pid, process]))
  const killed: number[] = []
  const stopped: string[] = []
  return {
    killed,
    stopped,
    options: {
      selfPid: SELF.pid,
      list: async () => {
        for (const [pid, at] of Object.entries(exitsAt)) if (clock >= at) running.delete(Number(pid))
        return [...running.values()]
      },
      stopService: async (home: string) => { stopped.push(home) },
      kill: (pid: number) => {
        killed.push(pid)
        running.delete(pid)
      },
      now: () => clock,
      sleep: async (ms: number) => { clock += ms },
      timeoutMs: 10_000,
      graceMs: 3_000,
      intervalMs: 500
    }
  }
}

describe('install folder hand-off', () => {
  it('keeps this process and its own Chromium helpers; everything else running from the folder is a straggler', () => {
    const stragglers = installFolderStragglers([SELF, RENDERER, GPU, SERVICE, OTHER_SERVICE, CLI, VOICE, OTHER_GUI_RENDERER], SELF.pid)
    expect(stragglers.map((process) => process.pid)).toEqual([200, 300, 400, 500, 601])
  })

  it('reads the home of a background service from its command line', () => {
    expect(serviceHomeOf(SERVICE.commandLine)).toBe('C:\\Users\\u\\.mousse')
    expect(serviceHomeOf(OTHER_SERVICE.commandLine)).toBe('C:\\Users\\u\\bridge home')
    expect(serviceHomeOf(`"${exe}" --cli --home=/tmp/h service run`)).toBe('/tmp/h')
    expect(serviceHomeOf(`"${exe}" --cli service status --home C:\\h`)).toBeUndefined()
    expect(serviceHomeOf(CLI.commandLine)).toBeUndefined()
  })

  it('returns at once when only this process and its helpers run', async () => {
    const fake = table([SELF, RENDERER, GPU])
    await expect(freeInstallFolder(fake.options)).resolves.toEqual({ checked: true, killed: [] })
    expect(fake.stopped).toEqual([])
  })

  it('asks other services to stop and waits for stragglers that exit on their own', async () => {
    const fake = table([SELF, RENDERER, OTHER_SERVICE, CLI], { 300: 1_000, 400: 2_000 })
    await expect(freeInstallFolder(fake.options)).resolves.toEqual({ checked: true, killed: [] })
    expect(fake.stopped).toEqual(['C:\\Users\\u\\bridge home'])
    expect(fake.killed).toEqual([])
  })

  it('kills what is still running after the grace period, then lets the install go ahead', async () => {
    const fake = table([SELF, SERVICE, VOICE])
    await expect(freeInstallFolder(fake.options)).resolves.toEqual({ checked: true, killed: [200, 500] })
    expect(fake.stopped).toEqual(['C:\\Users\\u\\.mousse'])
  })

  it('refuses to go ahead while a process from the install folder keeps running', async () => {
    const fake = table([SELF, SERVICE])
    fake.options.kill = vi.fn(() => { throw new Error('Access is denied') })
    await expect(freeInstallFolder(fake.options)).rejects.toThrow(/still running from the install folder \(200\)/)
  })

  it('does not check where the platform cannot list processes', async () => {
    const kill = vi.fn()
    await expect(freeInstallFolder({ selfPid: 1, list: async () => null, stopService: async () => undefined, kill })).resolves.toEqual({ checked: false, killed: [] })
    expect(kill).not.toHaveBeenCalled()
  })
})
