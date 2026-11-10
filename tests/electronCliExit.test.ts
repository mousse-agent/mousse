import { afterEach, expect, it, vi } from 'vitest'
const { exit, runCliMain, order, switches } = vi.hoisted(() => ({ exit: vi.fn(), runCliMain: vi.fn(), order: [] as string[], switches: new Map<string, string>() }))
vi.mock('electron', () => ({
  app: {
    exit,
    disableHardwareAcceleration: () => { order.push('disableHardwareAcceleration') },
    commandLine: {
      getSwitchValue: (name: string) => switches.get(name) ?? '',
      appendSwitch: (name: string, value = '') => { order.push(`switch:${name}`); switches.set(name, value) }
    }
  }
}))
vi.mock('../src/cli/runCliMain', () => ({ runCliMain }))
const originalExitCode = process.exitCode
const originalArgv = process.argv
const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
afterEach(() => {
  process.exitCode = originalExitCode; process.argv = originalArgv
  exit.mockReset(); runCliMain.mockReset(); stderr.mockClear(); vi.resetModules()
  order.length = 0; switches.clear()
})
it('starts no GPU or network service process, set before the CLI runs', async () => {
  runCliMain.mockImplementation(async () => { order.push('runCliMain') })
  await import('../src/main/cli')
  await vi.waitFor(() => expect(exit).toHaveBeenCalled())
  expect(order).toEqual(['disableHardwareAcceleration', 'switch:in-process-gpu', 'switch:enable-features', 'runCliMain'])
  expect(switches.get('enable-features')).toBe('NetworkServiceInProcess2')
})
it.each([undefined, 2, 130])('preserves a completed command exit status %s at the actual Electron CLI entry', async code => {
  process.argv = ['owned-electron-cli', '--json', 'net', 'status']
  runCliMain.mockImplementation(async () => { process.exitCode = code })
  await import('../src/main/cli')
  await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(code ?? 0))
  expect(runCliMain).toHaveBeenCalledExactlyOnceWith(process.argv.slice(1))
  expect(stderr).not.toHaveBeenCalled()
})
it('exits nonzero when the CLI entry rejects before completing a command', async () => {
  process.exitCode = undefined
  runCliMain.mockRejectedValue(new Error('owned CLI failure'))
  await import('../src/main/cli')
  await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(1))
  expect(stderr).toHaveBeenCalledWith('owned CLI failure\n')
})
