/**
 * Start at login (Phase 1b design §10): the startup entry runs `mousse-cli service run`, and with no window open that
 * daemon starts the networking of each profile whose switch is on, once it has said it is ready. Nothing of the
 * networking runs before readiness. The helper's start is observed, not run.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runDaemonForeground } from '../../src/cli/commands/service'
import { getMmsRuntimePath } from '../../src/cli/mmsRuntime'
import { NetEngineService } from '../../src/mms/netEngine/NetEngineService'

const homes: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.MOUSSE_HOME
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
})

describe('the daemon a startup entry runs', () => {
  it.each([
    ['on', true],
    ['off', false]
  ])("with the profile's networking %s, starts it after ready: %s", async (_name, on) => {
    const home = mkdtempSync(join(tmpdir(), 'service-run-net-'))
    homes.push(home)
    process.env.MOUSSE_HOME = home
    // The profile's saved switch.
    vi.spyOn(NetEngineService.prototype, 'settings').mockReturnValue({ enabled: on, profile: 'default' })
    // Whether the daemon had published its readiness when each networking start began.
    const readyAtStart: boolean[] = []
    vi.spyOn(NetEngineService.prototype, 'startHelper').mockImplementation(async () => {
      readyAtStart.push(existsSync(getMmsRuntimePath(home)))
    })
    const stop = new AbortController()
    const service = runDaemonForeground({
      homeDir: home,
      skipSignals: true,
      stopSignal: stop.signal,
      onLog: () => undefined
    })
    try {
      await vi.waitFor(() => expect(existsSync(getMmsRuntimePath(home))).toBe(true), { timeout: 30_000 })
      if (on) await vi.waitFor(() => expect(readyAtStart).toEqual([true]), { timeout: 10_000 })
      else {
        await new Promise((resolve) => setTimeout(resolve, 500))
        expect(readyAtStart).toEqual([])
      }
    } finally {
      stop.abort()
      await service
    }
  }, 60_000)
})
