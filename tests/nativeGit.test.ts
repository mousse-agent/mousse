import { afterEach, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({
  exists: new Set<string>(),
  launch: vi.fn()
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  access: vi.fn(async (file: string) => {
    if (!host.exists.has(file)) throw new Error('Executable is missing')
  }),
  realpath: vi.fn(async (file: string) => file)
}))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  return { ...actual, execFile: Object.assign(() => {}, { [promisify.custom]: host.launch }) }
})

import { nativeGitEnvironment, installNativeGit, nativeGitInstaller } from '../src/main/mms/nativeGit'

const signal = new AbortController().signal
afterEach(() => {
  host.exists.clear()
  host.launch.mockReset()
})

it.skipIf(process.platform === 'win32')('skips the Apple Git stub until Command Line Tools are selected', async () => {
  host.exists.add('/usr/bin/git')
  host.launch.mockRejectedValueOnce(new Error('No developer tools selected'))
  await expect(nativeGitEnvironment('darwin', { PATH: '/usr/bin' }, signal)).resolves.toBeUndefined()
  expect(host.launch.mock.calls.map(([file]) => file)).toEqual(['/usr/bin/xcode-select'])

  host.launch.mockResolvedValueOnce({ stdout: '/Library/Developer/CommandLineTools' })
    .mockResolvedValueOnce({ stdout: 'git version 2.50.1 (Apple Git-155)' })
  await expect(nativeGitEnvironment('darwin', { PATH: '/usr/bin' }, signal)).resolves.toEqual({ PATH: '/usr/bin' })
})

it.skipIf(process.platform === 'win32')('finds Homebrew Git outside the PATH of a Finder launch', async () => {
  host.exists.add('/opt/homebrew/bin/git')
  host.launch.mockResolvedValue({ stdout: 'git version 2.56.1' })
  await expect(nativeGitEnvironment('darwin', { PATH: '/usr/bin' }, signal)).resolves.toEqual({ PATH: '/opt/homebrew/bin:/usr/bin' })
  expect(host.launch.mock.calls.map(([file]) => file)).toEqual(['/opt/homebrew/bin/git'])
})

it('uses the system installer and never elevates a package manager from the user PATH', async () => {
  host.exists.add('/usr/bin/apt-get')
  await expect(nativeGitInstaller('linux')).resolves.toBeUndefined()
  host.exists.add('/usr/bin/pkexec')
  const installer = await nativeGitInstaller('linux')
  expect(installer).toBeDefined()
  host.launch.mockReturnValue(Object.assign(Promise.resolve({ stdout: '' }), { child: {} }))
  await expect(installNativeGit(installer!, signal)).resolves.toBe(true)
  expect(host.launch).toHaveBeenCalledWith('/usr/bin/pkexec', [
    '--disable-internal-agent', '/usr/bin/apt-get', '-y', 'install', 'git'
  ], expect.objectContaining({ cwd: '/', signal }))
})

it('opens the macOS installer and reports that the system install is still pending', async () => {
  const installer = await nativeGitInstaller('darwin')
  host.launch.mockReturnValue(Object.assign(Promise.resolve({ stdout: '' }), { child: {} }))
  await expect(installNativeGit(installer!, signal)).resolves.toBe(false)
  expect(host.launch).toHaveBeenCalledWith('/usr/bin/xcode-select', ['--install'], expect.objectContaining({ signal }))
})
