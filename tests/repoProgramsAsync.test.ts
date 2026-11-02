/**
 * The check before each of Mousse's Git commands (`repoPrograms`) and the repository identity have an
 * async path. It gives the same answers as the synchronous one, the central Git check still runs first,
 * and a folder whose Git does not answer no longer holds the daemon: other folders, and timers, go on.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decideGitCommand, decideGitCommandAsync, GitPolicyError, registerOwnedGitRoot } from '../src/mms/git/gitPolicy'
import { grepWorkspace } from '../src/mms/files/WorkspaceGrep'
import { checkRepoPrograms, clearRepoProgramCache, guardedSimpleGit, repoProgramProbes, repoProgramSettings, repoProgramSettingsAsync, RepoProgramError, withoutRepoPrograms, withoutRepoProgramsAsync } from '../src/mms/git/repoPrograms'
import { clearRepositoryIdentityCache, resolveRepositoryIdentity, resolveRepositoryIdentityAsync, RepositoryIdentityError } from '../src/mms/git/RepositoryIdentity'
import { folderAccess } from '../src/mms/files/folderAccess'
import { MousseMainService } from '../src/mms/MousseMainService'
import { dispatchMethod } from '../src/mms/protocol/handlers'

const previousPath = process.env.PATH
const previousGlobal = process.env.GIT_CONFIG_GLOBAL
const previousPolicy = process.env.MOUSSE_GIT_POLICY
let root: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

function repo(name: string, commit = true): string {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q')
  if (commit) {
    writeFileSync(join(path, 'a.txt'), 'a\n')
    git(path, 'add', 'a.txt')
    git(path, 'commit', '-q', '-m', 'first')
  }
  return path
}

let slowGits = 0

/**
 * Puts a `git` first on PATH that is the real Git, except in a folder whose path contains `hang`: there a
 * command whose arguments contain `match` answers `seconds` late. With `stale`, Git answers as things were
 * when it started (it runs first, then waits), and only the first such command is slow. Returns the file that
 * appears once a slow command has started.
 */
function slowGit(match: string, seconds: number, options: { stale?: boolean } = {}): string {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const started = join(root, `slow-git-${slowGits += 1}`)
  const slow = options.stale
    ? `if [ ! -e "${started}" ]; then : > "${started}"; "${real}" "$@" > "${started}.out"; code=$?; sleep ${seconds}; cat "${started}.out"; exit $code; fi`
    : `: > "${started}"; sleep ${seconds}`
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase "$(pwd -P)" in *hang*) case "$*" in *${match}*) ${slow};; esac;; esac\nexec "${real}" "$@"\n`)
  chmodSync(join(bin, 'git'), 0o755)
  process.env.PATH = `${bin}${delimiter}${previousPath}`
  return started
}

/** Lists the config: the second command of the check before a Git command. */
const hangingGit = (seconds: number): string => slowGit('--show-scope', seconds)

/** Whether `promise` is still pending after a few turns of the event loop. */
async function pending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  void promise.then(() => { settled = true }, () => { settled = true })
  for (let turn = 0; turn < 5 && !settled; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  return !settled
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-repo-async-')))
  const global = join(root, 'global.gitconfig')
  writeFileSync(global, '[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = global
  clearRepoProgramCache()
  clearRepositoryIdentityCache()
  folderAccess.reset()
})
afterEach(() => {
  process.env.PATH = previousPath
  if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = previousGlobal
  if (previousPolicy === undefined) delete process.env.MOUSSE_GIT_POLICY
  else process.env.MOUSSE_GIT_POLICY = previousPolicy
  clearRepoProgramCache()
  folderAccess.reset()
  rmSync(root, { recursive: true, force: true })
})

describe('the async check before a Git command', () => {
  it('gives the same settings and arguments as the synchronous check', async () => {
    const path = repo('plain')
    // Programs the repository names for itself: a filter, a diff driver and a hook by name.
    git(path, 'config', 'filter.secret.clean', 'secret-clean')
    git(path, 'config', 'diff.tool.command', 'tool-diff')
    git(path, 'config', 'hook.lint.command', 'lint')
    const outside = join(root, 'not-a-repository')
    mkdirSync(outside)
    for (const cwd of [path, outside]) {
      for (const args of [['status'], ['add', '-A'], ['config', '--get', 'user.name'], ['update-ref', 'refs/mousse/x', 'HEAD']]) {
        expect(await withoutRepoProgramsAsync(cwd, args)).toEqual(withoutRepoPrograms(cwd, args))
      }
      expect(await repoProgramSettingsAsync(cwd, { write: true })).toEqual(repoProgramSettings(cwd, { write: true }))
      expect(await repoProgramSettingsAsync(cwd, { userAction: true })).toEqual(repoProgramSettings(cwd, { userAction: true }))
    }
    expect(withoutRepoPrograms(path, ['status']).join(' ')).toContain('filter.secret.clean=')
  })

  it('shares the cache with the synchronous check and sees a config written since', async () => {
    const path = repo('cached')
    const before = await repoProgramSettingsAsync(path)
    const probes = repoProgramProbes()
    expect(repoProgramSettings(path)).toEqual(before)
    expect(await repoProgramSettingsAsync(path)).toEqual(before)
    expect(repoProgramProbes()).toBe(probes)
    git(path, 'config', 'core.sshCommand', 'planted-ssh')
    expect(await repoProgramSettingsAsync(path)).toContain('core.sshcommand=ssh')
    expect(repoProgramProbes()).toBe(probes + 1)
  })

  it('refuses the same way: a program it cannot turn off, and the central Git check', async () => {
    const path = repo('refused')
    git(path, 'config', 'core.gitProxy', 'planted-proxy')
    expect(() => withoutRepoPrograms(path, ['status'])).toThrow(RepoProgramError)
    await expect(withoutRepoProgramsAsync(path, ['status'])).rejects.toThrow(RepoProgramError)
    await expect(checkRepoPrograms(path)).rejects.toThrow(/core\.gitproxy/)
    // simple-git's methods reject with it too.
    await expect(guardedSimpleGit(path).raw(['status'])).rejects.toThrow(RepoProgramError)

    process.env.MOUSSE_GIT_POLICY = 'refuse'
    const other = repo('policy')
    // A change to a branch that is not Mousse's, without the user asking: the central check refuses it before anything runs.
    expect(() => withoutRepoPrograms(other, ['update-ref', 'refs/heads/main', 'HEAD'])).toThrow(GitPolicyError)
    await expect(withoutRepoProgramsAsync(other, ['update-ref', 'refs/heads/main', 'HEAD'])).rejects.toThrow(GitPolicyError)
  })

  it.skipIf(process.platform === 'win32')('a `git init` while the check looks for the repository is not cached as "not a repository"', async () => {
    const path = join(root, 'hang-init')
    mkdirSync(path)
    const started = slowGit('--show-toplevel', 1, { stale: true })
    const reading = repoProgramSettingsAsync(path)
    await vi.waitFor(() => expect(statSync(started).isFile()).toBe(true))
    // While Git is still answering "not a repository": the folder becomes one, with a program in its config.
    git(path, 'init', '-q')
    git(path, 'config', 'core.sshCommand', 'planted-ssh')
    expect(await reading).toContain('core.sshcommand=ssh')
    expect(await repoProgramSettingsAsync(path)).toContain('core.sshcommand=ssh')
    expect(repoProgramSettings(path)).toContain('core.sshcommand=ssh')
  })

  it.skipIf(process.platform === 'win32')('a config written while it is listed is not cached as the old answer', async () => {
    const path = repo('hang-config')
    const started = slowGit('--show-scope', 1, { stale: true })
    const reading = repoProgramSettingsAsync(path)
    await vi.waitFor(() => expect(statSync(started).isFile()).toBe(true))
    git(path, 'config', 'core.sshCommand', 'planted-ssh')
    expect(await reading).toContain('core.sshcommand=ssh')
    expect(await repoProgramSettingsAsync(path)).toContain('core.sshcommand=ssh')
  })

  it.skipIf(process.platform === 'win32')('a slow read in the central Git check holds nothing else', async () => {
    const owned = repo('hang-owned')
    const undo = registerOwnedGitRoot(owned)
    try {
      git(owned, 'checkout', '-q', '-b', 'mousse/thread')
      const other = repo('other-owned')
      // A commit in an owned worktree: the check asks Git which branch HEAD is on.
      slowGit('symbolic-ref', 2)
      const begun = Date.now()
      const waiting = withoutRepoProgramsAsync(owned, ['commit', '-m', 'x'])
      expect(await pending(waiting)).toBe(true)
      expect(await withoutRepoProgramsAsync(other, ['status'])).toEqual(withoutRepoPrograms(other, ['status']))
      expect(await pending(waiting)).toBe(true)
      expect(Date.now() - begun).toBeLessThan(1500)
      await expect(waiting).resolves.toContain('commit')
    } finally {
      undo()
    }
  })

  it.skipIf(process.platform === 'win32')('a search cancelled, or out of time, during the check ends at once', async () => {
    const path = repo('hang-search')
    hangingGit(3)
    const controller = new AbortController()
    const begun = Date.now()
    const cancelled = grepWorkspace(path, 'a', { signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    expect(Date.now() - begun).toBeLessThan(1500)
    clearRepoProgramCache()
    const late = Date.now()
    await expect(grepWorkspace(path, 'a', { timeoutMs: 200 })).resolves.toMatchObject({ timedOut: true, matches: [] })
    expect(Date.now() - late).toBeLessThan(1500)
  })

  it.skipIf(process.platform === 'win32')('waits for a folder whose Git does not answer without holding anything else', async () => {
    const stuck = repo('hang-repo')
    const other = repo('other-repo')
    hangingGit(2)
    const started = Date.now()
    const waiting = withoutRepoProgramsAsync(stuck, ['status'])
    // Timers still fire, and another folder's check finishes, while the first one waits on Git.
    expect(await pending(waiting)).toBe(true)
    expect(await withoutRepoProgramsAsync(other, ['status'])).toEqual(withoutRepoPrograms(other, ['status']))
    expect(await pending(waiting)).toBe(true)
    expect(Date.now() - started).toBeLessThan(1500)
    // Once Git answers, the waiting check gives the usual arguments.
    const argv = await waiting
    expect(argv.at(-1)).toBe('status')
  })

  it('waits for the folder check first, so nothing reads a volume that is not answering', async () => {
    const path = repo('external')
    let answer!: () => void
    const prompt = new Promise<void>((resolve) => { answer = resolve })
    folderAccess.reset({ keyOf: (folder) => folder.startsWith(path) ? 'external' : 'internal', probe: async (folder) => { if (folder.startsWith(path)) await prompt } })
    const probes = repoProgramProbes()
    const waiting = withoutRepoProgramsAsync(path, ['status'])
    const simple = guardedSimpleGit(path).raw(['status', '--porcelain'])
    const identity = resolveRepositoryIdentityAsync(path)
    expect(await pending(Promise.race([waiting, simple, identity]))).toBe(true)
    expect(repoProgramProbes()).toBe(probes)
    answer()
    await expect(waiting).resolves.toContain('status')
    await expect(simple).resolves.toBe('')
    await expect(identity).resolves.toMatchObject({ capability: { allowed: true } })
  })

  it('makes the same decisions in the central Git check, reading without blocking', async () => {
    const owned = repo('owned')
    const undo = registerOwnedGitRoot(owned)
    try {
      git(owned, 'checkout', '-q', '-b', 'mousse/thread')
      git(owned, 'symbolic-ref', 'refs/mousse/points-at-main', 'refs/heads/main')
      const plain = repo('plain-check')
      const requests = [
        { cwd: owned, args: ['commit', '-m', 'x'] },
        { cwd: owned, args: ['update-ref', 'refs/mousse/points-at-main', 'HEAD'] },
        { cwd: owned, args: ['update-ref', 'refs/mousse/own', 'HEAD'] },
        { cwd: owned, args: ['sparse-checkout', 'set', 'a'] },
        { cwd: owned, args: ['read-tree', 'HEAD'], env: { GIT_INDEX_FILE: join(owned, '.git', 'mousse-x.index') } },
        { cwd: plain, args: ['commit', '-m', 'x'] },
        { cwd: plain, args: ['status'] },
        { cwd: join(plain, '.git'), args: ['update-ref', 'refs/heads/main', 'HEAD'] }
      ]
      for (const request of requests) expect(await decideGitCommandAsync(request)).toEqual(decideGitCommand(request))
    } finally {
      undo()
    }
  })
})

describe('resolveRepositoryIdentityAsync', () => {
  it('gives the identity the synchronous call gives', async () => {
    const path = repo('identity')
    const unborn = repo('unborn', false)
    const plainFolder = join(root, 'plain-folder')
    mkdirSync(plainFolder)
    const home = join(root, 'metadata-home')
    for (const cwd of [path, unborn, plainFolder]) {
      const sync = resolveRepositoryIdentity(cwd, { metadataHome: home })
      clearRepositoryIdentityCache()
      const async = await resolveRepositoryIdentityAsync(cwd, { metadataHome: home })
      expect({ ...async, movedFrom: undefined }).toEqual({ ...sync, movedFrom: undefined })
    }
    expect((await resolveRepositoryIdentityAsync(path)).capability).toEqual({ allowed: true })
    await expect(resolveRepositoryIdentityAsync(unborn, { requireMutationCapability: true })).rejects.toThrow(RepositoryIdentityError)
    await expect(resolveRepositoryIdentityAsync(plainFolder, { requireMutationCapability: true })).rejects.toMatchObject({ capability: { reason: 'not-a-repository' } })
  })

  it('reuses the metadata folder it chose, and chooses again once that folder is gone', async () => {
    const path = repo('reuse')
    const first = await resolveRepositoryIdentityAsync(path)
    const hint = join(first.metadataDir, 'repository-location.json')
    const written = readFileSync(hint, 'utf8')
    const changed = statSync(hint).mtimeMs
    await new Promise((resolve) => setTimeout(resolve, 20))
    const again = await resolveRepositoryIdentityAsync(path)
    expect(again.metadataDir).toBe(first.metadataDir)
    expect(readFileSync(hint, 'utf8')).toBe(written)
    expect(statSync(hint).mtimeMs).toBe(changed)
    rmSync(first.metadataDir, { recursive: true, force: true })
    const recreated = await resolveRepositoryIdentityAsync(path)
    expect(recreated.metadataDir).toBe(first.metadataDir)
    expect(statSync(hint).isFile()).toBe(true)
  })

  it('is always current about a repository that gets its first commit', async () => {
    const path = repo('first-commit', false)
    expect((await resolveRepositoryIdentityAsync(path)).capability).toMatchObject({ reason: 'unborn-head' })
    writeFileSync(join(path, 'a.txt'), 'a\n')
    git(path, 'add', 'a.txt')
    git(path, 'commit', '-q', '-m', 'first')
    expect((await resolveRepositoryIdentityAsync(path)).capability).toEqual({ allowed: true })
  })

  it('gives the same key as the synchronous call for a name Unicode can spell two ways', async () => {
    // Stored decomposed, opened by either spelling (macOS finds both).
    repo('Cafe\u0301')
    for (const name of ['Cafe\u0301', 'Caf\u00e9']) {
      const path = join(root, name)
      if (process.platform !== 'darwin' && name === 'Caf\u00e9') continue
      const sync = resolveRepositoryIdentity(path)
      const async = await resolveRepositoryIdentityAsync(path)
      expect(async.key).toBe(sync.key)
      expect(async.commonDir).toBe(sync.commonDir)
      expect(async.worktreePath).toBe(sync.worktreePath)
    }
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('names the same metadata folder as the synchronous call after the repository stops being writable', async () => {
    const path = repo('writable')
    const home = join(root, 'fallback-home')
    const first = await resolveRepositoryIdentityAsync(path, { metadataHome: home })
    expect(first.metadataDir).toBe(join(first.commonDir, 'mousse'))
    chmodSync(first.metadataDir, 0o555)
    try {
      // Both keep the folder they chose, so both name the same lease file.
      expect(resolveRepositoryIdentity(path, { metadataHome: home }).metadataDir).toBe(first.metadataDir)
      expect((await resolveRepositoryIdentityAsync(path, { metadataHome: home })).metadataDir).toBe(first.metadataDir)
    } finally {
      chmodSync(first.metadataDir, 0o755)
    }
  })

  it.skipIf(process.platform === 'win32')('resolves another repository while one folder waits on Git', async () => {
    const stuck = repo('hang-identity')
    const other = repo('other-identity')
    hangingGit(2)
    const waiting = resolveRepositoryIdentityAsync(stuck)
    expect(await pending(waiting)).toBe(true)
    expect((await resolveRepositoryIdentityAsync(other)).capability).toEqual({ allowed: true })
    expect(await pending(waiting)).toBe(true)
    await expect(waiting).resolves.toMatchObject({ capability: { allowed: true } })
  })
})

describe.skipIf(process.platform === 'win32')('requests while a folder waits on Git', () => {
  let home: string
  let mms: MousseMainService

  beforeEach(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-repo-async-mms-')))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
  })
  afterEach(async () => {
    process.env.PATH = previousPath
    await mms.stop()
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  it("git.status for another project and thread metadata answer while one project's Git hangs", async () => {
    const ctx = { mms, globalSequence: () => 0 }
    const stuck = (await dispatchMethod(ctx, 'projects.open', { path: repo('hang-project') }) as { project: { id: string } }).project
    const other = (await dispatchMethod(ctx, 'projects.open', { path: repo('other-project') }) as { project: { id: string } }).project
    const thread = (await dispatchMethod(ctx, 'threads.create', { name: 'Elsewhere', projectId: other.id }) as { thread: { id: string } }).thread
    // From now on, reading the stuck project's Git config takes 3 seconds; before, it held the whole daemon that long.
    hangingGit(3)
    clearRepoProgramCache()
    const started = Date.now()
    const waiting = dispatchMethod(ctx, 'git.status', { projectId: stuck.id })
    expect(await pending(waiting)).toBe(true)
    await expect(dispatchMethod(ctx, 'git.status', { projectId: other.id })).resolves.toMatchObject({ status: { isRepo: true } })
    await expect(dispatchMethod(ctx, 'threads.get', { threadId: thread.id })).resolves.toBeDefined()
    expect(Date.now() - started).toBeLessThan(2000)
    expect(await pending(waiting)).toBe(true)
    // Once Git answers, the waiting request finishes as usual.
    await expect(waiting).resolves.toMatchObject({ status: { isRepo: true } })
  }, 20_000)
})
