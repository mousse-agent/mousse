import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/cli/cliLaunch', () => ({
  isElectronMainProcess: () => true,
  resolvePackagedCliLauncher: () => null,
  resolveCliInvocation: () => ({ command: 'electron', argsPrefix: ['app', '--cli'], env: { MOUSSE_ELECTRON_USER_DATA: '/vault' } })
}))
import { resolveDaemonHostInvocation } from '../src/cli/daemonHost'

afterEach(() => vi.restoreAllMocks())
describe('credential-capable daemon host', () => {
  it('keeps Electron main mode even when the Node native addon probe succeeds', () => {
    const host = resolveDaemonHostInvocation(undefined, { preferRunAsNode: true, nodePtyOk: true })
    expect(host.mode).toBe('electron-dual-mode')
    expect(host.argsPrefix).toEqual(['app', '--cli'])
    expect(host.env.MOUSSE_ELECTRON_USER_DATA).toBe('/vault')
    expect(host.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })
})
