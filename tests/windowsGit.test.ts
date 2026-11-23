import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ensureWindowsGit, withWindowsGitPath } from '../src/main/mms/windowsGit'
import type { WindowsGitSetup } from '../src/shared/windowsGit'
import { zipOf } from './harness/archiveFixtures'

const { probe, download } = vi.hoisted(() => ({ probe: vi.fn(), download: vi.fn() }))
vi.mock('node:child_process', async (original) => {
  const { promisify } = await import('node:util')
  return {
    ...await original<typeof import('node:child_process')>(),
    execFile: Object.assign(() => {}, { [promisify.custom]: probe })
  }
})
vi.mock('../src/mms/harness/agents/install', () => ({ downloadArtifact: download }))

const missing = Object.assign(new Error('Git was not found'), { code: 'ENOENT' })
const assetDigest = '4a92850b6e917da4fd010669b614b55dccf5b0ec333a534cc4be4700dfefdafd'
let home: string
let changes: WindowsGitSetup[]

function setup(overrides: Partial<Parameters<typeof ensureWindowsGit>[0]> = {}) {
  return ensureWindowsGit({
    homeDir: home,
    env: {},
    signal: new AbortController().signal,
    onSetup: (change) => changes.push(change),
    platform: 'win32',
    arch: 'x64',
    ...overrides
  })
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'mousse-win-git-'))
  changes = []
  probe.mockReset().mockImplementation(async (executable: string) => {
    if (!existsSync(executable)) throw missing
    return { stdout: 'git version 2.56.1.windows.1\n' }
  })
  download.mockReset().mockImplementation(async (_url: string, file: string) => {
    await writeFile(file, zipOf([{ name: 'cmd/git.exe', data: 'git fixture' }]))
    return { sha256: assetDigest }
  })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

it('does not download when system Git works or on other platforms', async () => {
  await expect(setup({ platform: 'linux' })).resolves.toBeUndefined()
  expect(probe).not.toHaveBeenCalled()
  probe.mockResolvedValueOnce({ stdout: 'git version 2.56.1.windows.1\n' })
  await expect(setup()).resolves.toBeUndefined()
  expect(download).not.toHaveBeenCalled()
  expect(changes).toEqual([])
})

it('stages an official download, publishes a complete Git and reuses it on the next start', async () => {
  const cmdDir = await setup()
  expect(cmdDir).toBeDefined()
  expect(download.mock.calls[0]?.[0]).toMatch(/^https:\/\/github\.com\/git-for-windows\/git\/releases\/download\//)
  expect(changes.map((change) => change?.phase)).toEqual(['downloading', 'installing'])
  await expect(readFile(join(cmdDir!, 'git.exe'), 'utf8')).resolves.toBe('git fixture')
  await expect(setup()).resolves.toBe(cmdDir)
  expect(download).toHaveBeenCalledTimes(1)
  expect(withWindowsGitPath({ Path: 'C:\\Windows' }, cmdDir)).toEqual({ Path: `${cmdDir};C:\\Windows` })
})

it.each([
  ['wrong checksum', 'official checksum'],
  ['network failure', 'Offline']
])('leaves no installed or staging files after %s and permits retry', async (failure, reason) => {
  if (failure === 'wrong checksum') download.mockResolvedValueOnce({ sha256: 'wrong' })
  else download.mockRejectedValueOnce(new Error('Offline'))
  await expect(setup()).rejects.toThrow(reason)
  await expect(readdir(join(home, 'prerequisites', 'git'))).resolves.toEqual([])
  expect(changes.map((change) => change?.phase)).toEqual(['downloading'])
  await expect(setup()).resolves.toBeDefined()
})
