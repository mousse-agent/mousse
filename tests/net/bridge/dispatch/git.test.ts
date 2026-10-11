import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, remoteGit } from '../../../../src/mms/bridge/dispatch/git'
import { authenticatedRemote } from './http-fixture'

const roots: string[] = []
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0)) await cleanup()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'dispatch-git-'))
  roots.push(root)
  const repo = join(root, 'repo')
  await mkdir(repo)
  await git(repo, ['init', '--template='])
  await writeFile(join(repo, 'base.txt'), 'base\n')
  await git(repo, ['add', '.'])
  await git(repo, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@localhost',
    'commit',
    '-m',
    'base'
  ])
  return { root, repo, base: await git(repo, ['rev-parse', 'HEAD']) }
}

it('uses a global credential helper for authenticated smart-HTTP fetch and push with URL rewriting', async () => {
  const f = await repository()
  const serverRepo = join(f.root, 'remote.git')
  await git(f.root, ['clone', '--bare', f.repo, serverRepo])
  const http = await authenticatedRemote(f.root)
  cleanups.push(http.close)
  vi.stubEnv('HOME', f.root)
  vi.stubEnv('XDG_CONFIG_HOME', f.root)
  vi.stubEnv('GIT_CONFIG_GLOBAL', http.globalConfig)
  vi.stubEnv('GIT_CONFIG_SYSTEM', devNull)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '0')
  const client = join(f.root, 'client')
  await mkdir(client)
  await git(client, ['init', '--template='])
  await git(client, ['remote', 'add', 'origin', http.url])
  await expect(git(client, ['fetch', 'origin', f.base])).rejects.toThrow()
  await expect(stat(http.marker)).rejects.toMatchObject({ code: 'ENOENT' })
  const marker = join(f.root, 'remote-unsafe-program-ran')
  const program = join(f.root, 'remote-unsafe-program')
  await writeFile(program, `#!/bin/sh\nprintf unsafe > '${marker}'\n`, { mode: 0o700 })
  const hooks = join(client, '.git', 'hooks')
  await mkdir(hooks)
  await writeFile(join(hooks, 'pre-push'), await readFile(program), { mode: 0o700 })
  await git(client, ['config', 'core.hooksPath', hooks])
  await git(client, ['config', 'core.fsmonitor', program])
  const systemConfig = join(f.root, 'remote-system.gitconfig')
  await writeFile(systemConfig, '[dispatch]\nprobe = trusted-system\n')
  vi.stubEnv('GIT_CONFIG_SYSTEM', systemConfig)
  vi.stubEnv('GIT_DIR', join(f.root, 'nonexistent'))
  vi.stubEnv('GIT_WORK_TREE', join(f.root, 'nonexistent'))
  expect(await remoteGit(client, ['config', '--get', 'dispatch.probe'])).toBe('trusted-system')
  await remoteGit(client, ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', f.base])
  expect(await git(client, ['rev-parse', `${f.base}^{commit}`])).toBe(f.base)
  const fetchCalls = await readFile(http.marker, 'utf8')
  expect(fetchCalls.split('\n')).toContain('get')
  await git(client, ['remote', 'set-url', 'origin', http.rewrittenUrl])
  await http.clearMarker()
  await git(client, ['update-ref', 'refs/mousse/dispatch/fixture', f.base])
  await remoteGit(client, [
    'push',
    '--no-verify',
    'origin',
    'refs/mousse/dispatch/fixture:refs/heads/result'
  ])
  expect((await readFile(http.marker, 'utf8')).split('\n')).toContain('get')
  expect(await git(serverRepo, ['rev-parse', 'refs/heads/result'])).toBe(f.base)
  expect(http.counts().fetch).toBeGreaterThan(0)
  expect(http.counts().push).toBeGreaterThan(0)
  await expect(remoteGit(client, ['fetch', `ext::${program}`])).rejects.toThrow()
  await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(http.errors).toEqual([])
})

it('ignores global/system config and inherited repository overrides, hooks, fsmonitor and filters', async () => {
  const f = await repository()
  const marker = join(f.root, 'unsafe-program-ran')
  const program = join(f.root, 'unsafe-program')
  await writeFile(program, `#!/bin/sh\nprintf unsafe > '${marker}'\ncat\n`, { mode: 0o700 })
  const globalConfig = join(f.root, 'global.gitconfig')
  const systemConfig = join(f.root, 'system.gitconfig')
  await writeFile(
    globalConfig,
    `[dispatch]\nglobal = ignored\n[filter "probe"]\nclean = ${program}\nsmudge = ${program}\n`
  )
  await writeFile(systemConfig, '[dispatch]\nsystem = ignored\n')
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
  vi.stubEnv('GIT_CONFIG_SYSTEM', systemConfig)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '0')
  vi.stubEnv('GIT_DIR', join(f.root, 'nonexistent'))
  vi.stubEnv('GIT_WORK_TREE', join(f.root, 'nonexistent'))
  await expect(git(f.repo, ['config', '--get', 'dispatch.global'])).rejects.toThrow()
  await expect(git(f.repo, ['config', '--get', 'dispatch.system'])).rejects.toThrow()
  expect(await git(f.repo, ['rev-parse', 'HEAD'])).toBe(f.base)
  const hooks = join(f.repo, '.git', 'hooks')
  await mkdir(hooks)
  await writeFile(join(hooks, 'pre-commit'), await readFile(program), { mode: 0o700 })
  await writeFile(join(hooks, 'post-checkout'), await readFile(program), { mode: 0o700 })
  await git(f.repo, ['config', 'core.hooksPath', hooks])
  await git(f.repo, ['config', 'core.fsmonitor', program])
  await writeFile(join(f.repo, '.gitattributes'), '*.txt filter=probe\n')
  await writeFile(join(f.repo, 'base.txt'), 'changed\n')
  await git(f.repo, ['add', '.'])
  await git(f.repo, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@localhost',
    'commit',
    '-m',
    'changed'
  ])
  await git(f.repo, ['checkout', '--detach', f.base])
  expect(await readFile(join(f.repo, 'base.txt'), 'utf8')).toBe('base\n')
  await expect(git(f.repo, ['fetch', `ext::${program}`])).rejects.toThrow()
  await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
})
