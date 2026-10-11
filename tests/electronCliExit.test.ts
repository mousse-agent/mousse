import { afterEach, expect, it, vi } from 'vitest'
const { exit, runCliMain } = vi.hoisted(() => ({ exit: vi.fn(), runCliMain: vi.fn() }))
vi.mock('electron', () => ({ app: { exit } }))
vi.mock('../src/cli/runCliMain', () => ({ runCliMain }))
const originalExitCode = process.exitCode
const originalArgv = process.argv
const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
afterEach(() => {
  process.exitCode = originalExitCode; process.argv = originalArgv
  exit.mockReset(); runCliMain.mockReset(); stderr.mockClear(); vi.resetModules()
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
