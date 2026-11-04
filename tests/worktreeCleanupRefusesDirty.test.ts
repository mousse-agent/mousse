import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { keptCopyRestoreCommand } from '../src/mms/actions/keptCopies'
import { WorktreeManager } from '../src/mms/worktree/WorktreeManager'
import { installGitRemoveGuard, type GitRemoveGuard } from './fixtures/gitRemoveGuard'
import { ownedHome } from './support/fixtureGit'

const roots: string[] = []
const undo: Array<() => void> = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const step of undo.splice(0).reverse()) step()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const preservedRefs = (cwd: string): string[] => git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/mousse/preserved/').split('\n').filter(Boolean)

/** Writes `path` back from a kept copy with its restore command, run in the repository's top folder, and reads its bytes. */
function restored(repo: string, ref: string, path: string): Buffer {
  rmSync(join(repo, path), { force: true })
  mkdirSync(dirname(join(repo, path)), { recursive: true })
  execFileSync('sh', ['-c', keptCopyRestoreCommand(ref, path, 'posix')], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
  return readFileSync(join(repo, path))
}

function setup() {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null')
  vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null')
  vi.stubEnv('MOUSSE_GIT_POLICY', 'refuse')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-cleanup-dirty-')))
  roots.push(root)
  const cwd = join(root, 'repo'), home = join(root, 'home'), owner = join(root, 'owner')
  mkdirSync(cwd); mkdirSync(home); mkdirSync(owner)
  undo.push(ownedHome(home))
  git(cwd, 'init', '-q', '-b', 'main'); git(cwd, 'config', 'user.name', 'Audit'); git(cwd, 'config', 'user.email', 'audit@example.invalid')
  git(cwd, 'config', 'commit.gpgsign', 'false'); git(cwd, 'config', 'core.hooksPath', '/dev/null')
  writeFileSync(join(cwd, 'base.txt'), 'base\n'); writeFileSync(join(cwd, '.gitignore'), 'ignored/\n')
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base')
  return { root, cwd, owner, manager: new WorktreeManager(cwd, home) }
}

function guard(beforeRemove?: string): GitRemoveGuard {
  const installed = installGitRemoveGuard(beforeRemove ? { beforeRemove } : {})
  undo.push(() => installed.restore())
  return installed
}

describe('cleanup of a worktree with uncommitted changes', () => {
  // `safeCheckout` is how a dispatch's and Storage's cleanups call it; without it, how an agent's cleanup does.
  it.each([true, false])('keeps it as it is with no Git removal run, then once clean removes it through the verified delete, and both copies give back their exact bytes (the audit reproduction R3-A, inverted; safeCheckout %s)', async (safeCheckout) => {
    const { cwd, owner, manager } = setup()
    const info = await manager.createWorktree(`audit-dirty-${safeCheckout}`, cwd)
    mkdirSync(join(info.path, 'ignored'))
    const output = Buffer.from('sole ignored output f144a973\r\n\0\xff', 'latin1')
    writeFileSync(join(info.path, 'ignored', 'result.bin'), output)
    writeFileSync(join(info.path, 'base.txt'), 'temporarily dirty\n')
    git(cwd, 'config', 'extensions.worktreeConfig', 'true')
    git(info.path, 'config', '--worktree', 'audit.note', 'admin-only-dirty-bypass')
    const admin = git(info.path, 'rev-parse', '--absolute-git-dir')
    const config = readFileSync(join(admin, 'config.worktree'))
    // As in the reproduction: base.txt becomes clean again the moment a removal starts, which Git would then accept.
    const launcher = guard(`printf 'base\\n' > '${info.path}/base.txt'`)

    const refused = await manager.cleanupValidatedAgentWorktree(info, { safeCheckout, keepIgnored: { owner } })

    const reason = 'Kept: it has uncommitted changes (base.txt). Nothing in it was changed.'
    expect(refused).toEqual({ success: false, error: reason, kept: { ignoredFiles: 0, code: 'uncommitted_changes', reason, uncommitted: 'base.txt' } })
    expect(launcher.removes()).toEqual([])
    expect(readFileSync(join(info.path, 'base.txt'), 'utf8')).toBe('temporarily dirty\n')
    expect(readFileSync(join(info.path, 'ignored', 'result.bin')).equals(output)).toBe(true)
    expect(readFileSync(join(admin, 'config.worktree')).equals(config)).toBe(true)
    expect(preservedRefs(cwd)).toEqual([])

    // Clean now: the next cleanup keeps the ignored output and Git's own data, then deletes against the proof.
    git(info.path, 'checkout', '--', 'base.txt')
    const removed = await manager.cleanupValidatedAgentWorktree(info, { safeCheckout, keepIgnored: { owner } })

    expect(removed.success).toBe(true)
    expect(existsSync(info.path)).toBe(false)
    expect(existsSync(admin)).toBe(false)
    launcher.assertNoRemoveOfExisting()
    expect(launcher.removes().map((call) => call.path)).toEqual([info.path])
    expect(restored(cwd, removed.copy!.ref, 'ignored/result.bin').equals(output)).toBe(true)
    expect(restored(cwd, removed.admin!.ref, 'config.worktree').equals(config)).toBe(true)
  })

  it('names untracked files too, the first three, then how many more', async () => {
    const { cwd, owner, manager } = setup()
    const info = await manager.createWorktree('audit-dirty-many', cwd)
    writeFileSync(join(info.path, 'base.txt'), 'changed\n')
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) writeFileSync(join(info.path, name), `${name}\n`)
    const launcher = guard()

    const result = await manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner } })

    expect(result).toMatchObject({ success: false, kept: { code: 'uncommitted_changes', uncommitted: 'base.txt, a.txt, b.txt and 2 more', reason: 'Kept: it has uncommitted changes (base.txt, a.txt, b.txt and 2 more). Nothing in it was changed.' } })
    expect(launcher.removes()).toEqual([])
    expect(readFileSync(join(info.path, 'd.txt'), 'utf8')).toBe('d.txt\n')
  })

  it('names a worktree that only has an untracked file', async () => {
    const { cwd, owner, manager } = setup()
    const info = await manager.createWorktree('audit-dirty-untracked', cwd)
    writeFileSync(join(info.path, 'draft.txt'), 'untracked\n')
    const launcher = guard()

    const result = await manager.cleanupValidatedAgentWorktree(info, { keepIgnored: { owner } })

    expect(result).toMatchObject({ success: false, error: 'Kept: it has uncommitted changes (draft.txt). Nothing in it was changed.', kept: { code: 'uncommitted_changes' } })
    expect(launcher.removes()).toEqual([])
    expect(readFileSync(join(info.path, 'draft.txt'), 'utf8')).toBe('untracked\n')
  })
})

describe('the guard launcher', () => {
  it('fails a test when git worktree remove runs on a folder that still exists, and leaves the folder there', () => {
    const { root, cwd } = setup()
    const path = join(root, 'plain')
    git(cwd, 'worktree', 'add', '-q', path)
    const launcher = guard()
    expect(() => git(cwd, 'worktree', 'remove', '--force', path)).toThrow()
    expect(existsSync(join(path, 'base.txt'))).toBe(true)
    expect(launcher.removes()).toEqual([expect.objectContaining({ path, existed: true })])
    expect(() => launcher.assertNoRemoveOfExisting()).toThrow(path)
  })
})
