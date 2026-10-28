import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  RepositoryIdentities,
  sameFolder
} from '../../../../src/mms/bridge/remote/repositoryIdentity'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean()
})

function folder(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-identity-')))
  cleanups.push(() =>
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  )
  return path
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8'
  }).trim()
}
function repository(): string {
  const path = folder()
  git(path, 'init', '-q')
  git(path, 'commit', '-q', '--allow-empty', '-m', 'root')
  git(path, 'remote', 'add', 'origin', 'https://example.com/org/app.git')
  return path
}

it('gives a subfolder the identity of its repository', async () => {
  const top = repository()
  mkdirSync(join(top, 'packages', 'app'), { recursive: true })
  const identities = new RepositoryIdentities()
  const whole = await identities.of(top)
  const sub = await identities.of(join(top, 'packages', 'app'))
  expect(whole).toMatchObject({ root: top, remotes: ['example.com/org/app'] })
  expect(whole?.roots).toHaveLength(1)
  expect(sub).toEqual(whole)
})

it('gives a folder reached through a link the identity of the repository it leads to', async () => {
  const top = repository()
  const link = join(folder(), 'linked')
  try {
    symlinkSync(top, link, 'junction')
  } catch {
    // The machine cannot make links: there is nothing to check.
    return
  }
  const identities = new RepositoryIdentities()
  const direct = await identities.of(top)
  const linked = await identities.of(link)
  expect(direct).not.toBeNull()
  expect(linked).toEqual(direct)
})

it('has no identity for a folder that is not in a repository, or that is gone', async () => {
  const identities = new RepositoryIdentities()
  expect(await identities.of(folder())).toBeNull()
  expect(await identities.of(join(folder(), 'missing'))).toBeNull()
})

it('reads a repository once while its answer is fresh, however many folders and callers ask', async () => {
  const top = repository()
  mkdirSync(join(top, 'a'))
  mkdirSync(join(top, 'b'))
  let reads = 0
  const identities = new RepositoryIdentities({
    read: async () => {
      reads += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { roots: ['a'.repeat(40)], remotes: [] }
    }
  })
  const answers = await Promise.all([
    identities.of(top),
    identities.of(join(top, 'a')),
    identities.of(join(top, 'b')),
    identities.of(top)
  ])
  expect(reads).toBe(1)
  expect(new Set(answers.map((answer) => answer?.root)).size).toBe(1)
  await identities.of(join(top, 'a'))
  expect(reads).toBe(1)
})

it('reads one repository at a time, so a profile has one scan in flight', async () => {
  const first = repository()
  const second = repository()
  let running = 0
  let most = 0
  const identities = new RepositoryIdentities({
    read: async () => {
      running += 1
      most = Math.max(most, running)
      await new Promise((resolve) => setTimeout(resolve, 20))
      running -= 1
      return { roots: ['b'.repeat(40)], remotes: [] }
    }
  })
  await Promise.all([identities.of(first), identities.of(second)])
  expect(most).toBe(1)
})

it('gives up on a slow repository, tries again after a minute, and does not hold up the next one', async () => {
  const slow = repository()
  const quick = repository()
  let clock = 1_000
  const read = new Map<string, number>()
  const identities = new RepositoryIdentities({
    timing: { now: () => clock },
    budgetMs: 30,
    read: async (root) => {
      read.set(root, (read.get(root) ?? 0) + 1)
      if (root === slow) await new Promise((resolve) => setTimeout(resolve, 300))
      return { roots: ['c'.repeat(40)], remotes: [] }
    }
  })
  expect(await identities.of(slow)).toBeNull()
  expect(await identities.of(quick)).toMatchObject({ root: quick })
  // A repository that failed is not read again on every call.
  expect(await identities.of(slow)).toBeNull()
  expect(read.get(slow)).toBe(1)
  clock += 61_000
  await identities.of(slow)
  expect(read.get(slow)).toBe(2)
})

it('stops the Git calls of a slow repository when it gives up, and compares folders as Windows does', async () => {
  const slow = repository()
  let stopped = false
  const identities = new RepositoryIdentities({
    budgetMs: 30,
    read: (_root, signal) =>
      new Promise((resolve) => {
        signal?.addEventListener('abort', () => {
          stopped = true
          resolve({ roots: [], remotes: [] })
        })
      })
  })
  expect(await identities.of(slow)).toBeNull()
  expect(stopped).toBe(true)
  // Windows ignores case and takes either separator; other systems compare exactly.
  if (process.platform === 'win32') {
    expect(sameFolder(String.raw`C:\Work\App`, 'c:/work/app')).toBe(true)
    expect(await identities.isTop(slow.toUpperCase(), slow)).toBe(true)
  } else {
    expect(sameFolder('/work/App', '/work/app')).toBe(false)
    expect(sameFolder('/work/app', '/work/app')).toBe(true)
  }
  expect(sameFolder('/work/app', '/work/other')).toBe(false)
})
