import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KEEP_COPY_LIMITS, keptCopyRestoreCommand } from '../src/mms/actions/keptCopies'
import { expirePreservedFiles, threadPreservedIndex } from '../src/mms/actions/preservedFiles'
import { UndoRetentionService } from '../src/mms/actions/UndoRetentionService'
import { DEFAULT_UNDO_RETENTION_POLICY } from '../src/shared/undoRetention'
import { WorktreeManager } from '../src/mms/worktree/WorktreeManager'
import { ownedHome } from './support/fixtureGit'

const roots: string[] = []
const owned: Array<() => void> = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const undo of owned.splice(0)) undo()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const preservedRefs = (cwd: string): string[] => git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/mousse/preserved/').split('\n').filter(Boolean)
/** The bytes a kept file gives back: `git cat-file blob <ref>:<path>`, the restore command, read as bytes. */
const keptBytes = (cwd: string, ref: string, path: string): Buffer => execFileSync('git', ['cat-file', 'blob', `${ref}:${path}`], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
const exists = (cwd: string, sha: string): boolean => { try { git(cwd, 'cat-file', '-e', sha); return true } catch { return false } }

/** A repository and an installation home of Mousse's, as the audit reproduction set them up. */
function setup() {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null')
  vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null')
  vi.stubEnv('MOUSSE_GIT_POLICY', 'refuse')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-cleanup-keep-')))
  roots.push(root)
  const cwd = join(root, 'repo'), home = join(root, 'home'), owner = join(root, 'owner')
  mkdirSync(cwd); mkdirSync(home); mkdirSync(owner)
  owned.push(ownedHome(home))
  git(cwd, 'init', '-q', '-b', 'main'); git(cwd, 'config', 'user.name', 'Audit'); git(cwd, 'config', 'user.email', 'audit@example.invalid')
  git(cwd, 'config', 'commit.gpgsign', 'false'); git(cwd, 'config', 'core.hooksPath', '/dev/null')
  writeFileSync(join(cwd, 'base.txt'), 'base\n'); writeFileSync(join(cwd, '.gitignore'), 'ignored/\n')
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base')
  return { cwd, home, owner, manager: new WorktreeManager(cwd, home) }
}

/** Writes the working version of `path` back from the copy with the command a result names, in the repository's main folder, and reads its bytes. */
function restore(cwd: string, ref: string, path: string): Buffer {
  mkdirSync(dirname(join(cwd, path)), { recursive: true })
  execFileSync('sh', ['-c', keptCopyRestoreCommand(ref).replaceAll('<path>', `'${path}'`)], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  return readFileSync(join(cwd, path))
}

describe('agent worktree cleanup keeps ignored files first', () => {
  it('keeps the ignored bytes cleanup used to lose, then removes the worktree (the audit reproduction, inverted)', async () => {
    const { cwd, owner, manager } = setup()
    const info = await manager.createWorktree('audit-agent-123', cwd, git(cwd, 'rev-parse', 'HEAD'))
    const outputs = { 'ignored/result.bin': Buffer.concat([randomBytes(2048), Buffer.from('\r\n\0unique ignored dispatch bytes a045cb40\n')]), 'ignored/logs/run.log': Buffer.from('line one\r\nline two\n') }
    for (const [path, bytes] of Object.entries(outputs)) { mkdirSync(dirname(join(info.path, path)), { recursive: true }); writeFileSync(join(info.path, path), bytes) }

    const result = await manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner } })

    expect(result).toMatchObject({ success: true, copy: { files: 2 } })
    expect(existsSync(info.path)).toBe(false)
    expect(threadPreservedIndex(owner).owns(result.copy!.ref)).toBe(true)
    for (const [path, bytes] of Object.entries(outputs)) expect(restore(cwd, result.copy!.ref, path).equals(bytes)).toBe(true)
  })

  it('tells each step to the caller before it happens: the keep, then the delete with the finished copy and where the folder goes', async () => {
    const { cwd, owner, manager } = setup()
    const info = await manager.createWorktree('audit-agent-456', cwd)
    mkdirSync(join(info.path, 'ignored')); writeFileSync(join(info.path, 'ignored', 'out.bin'), randomBytes(64))
    const steps: Array<{ phase: string; present: boolean; ref?: string; admin?: string; path?: string }> = []
    const result = await manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner, record: (step) => steps.push({ phase: step.phase, present: existsSync(info.path), ...('ref' in step ? { ref: step.ref } : {}), ...('admin' in step ? { admin: step.admin.ref, path: step.path } : {}) }) } })
    expect(steps).toEqual([{ phase: 'keeping', present: true }, { phase: 'deleting', present: true, ref: result.copy!.ref, admin: result.admin!.ref, path: expect.stringMatching(/\/\.deleting-[a-f0-9]{16}$/) }])
    expect(dirname(steps[1]!.path!)).toBe(dirname(info.path))
    expect(existsSync(steps[1]!.path!)).toBe(false)
    expect(preservedRefs(cwd).sort()).toEqual([result.copy!.ref, result.admin!.ref].sort())
  })

  it('removes a worktree with no ignored files after keeping only Git\'s own data of it', async () => {
    const { cwd, owner, manager } = setup()
    const info = await manager.createWorktree('audit-agent-789', cwd)
    const steps: string[] = []
    const result = await manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner, record: (step) => steps.push(step.phase) } })
    expect(result).toEqual({ success: true, admin: { ref: expect.any(String), sha: expect.any(String), windowMs: DEFAULT_UNDO_RETENTION_POLICY.windowMs } })
    expect(existsSync(info.path)).toBe(false)
    expect(steps).toEqual(['keeping', 'deleting'])
    expect(preservedRefs(cwd)).toEqual([result.admin!.ref])
    // Every commit the worktree named is held by a branch, so the kept commit is a root commit with no parents.
    expect(git(cwd, 'rev-list', '--parents', '-n1', result.admin!.ref)).toBe(result.admin!.sha)
  })

  it('over the copy limit, keeps the worktree and every ignored file, and says how many there are', async () => {
    const { cwd, owner, manager } = setup()
    const info = await manager.createWorktree('audit-agent-cap', cwd)
    const big = randomBytes(4096)
    mkdirSync(join(info.path, 'ignored')); writeFileSync(join(info.path, 'ignored', 'big.bin'), big); writeFileSync(join(info.path, 'ignored', 'small.txt'), 'small\n')
    const limit = KEEP_COPY_LIMITS.bytes
    KEEP_COPY_LIMITS.bytes = 1024
    try {
      const result = await manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner } })
      expect(result).toMatchObject({ success: false, kept: { ignoredFiles: 2, code: 'keep_copy_too_large', reason: expect.stringMatching(/^Kept, 2 ignored files: .*ignored\/big\.bin/) } })
    } finally {
      KEEP_COPY_LIMITS.bytes = limit
    }
    expect(readFileSync(join(info.path, 'ignored', 'big.bin')).equals(big)).toBe(true)
    expect(readFileSync(join(info.path, 'ignored', 'small.txt'), 'utf8')).toBe('small\n')
    expect(git(cwd, 'worktree', 'list', '--porcelain')).toContain(info.path)
    expect(preservedRefs(cwd)).toEqual([])
  })

  it('with nothing to own a copy, keeps a worktree that has no ignored files, for Git\'s own data of it', async () => {
    const { cwd, manager } = setup()
    const info = await manager.createWorktree('audit-agent-none-clean', cwd)
    const result = await manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true })
    expect(result).toMatchObject({ success: false, kept: { ignoredFiles: 0, code: 'no_owner', reason: expect.stringMatching(/^Kept: nothing owns a copy of Git's own data/) } })
    expect(existsSync(info.path)).toBe(true)
    expect(git(cwd, 'worktree', 'list', '--porcelain')).toContain(info.path)
    expect(preservedRefs(cwd)).toEqual([])
  })

  it('with nothing to own a copy, keeps a worktree that has ignored files', async () => {
    const { cwd, manager } = setup()
    const info = await manager.createWorktree('audit-agent-none', cwd)
    mkdirSync(join(info.path, 'ignored')); writeFileSync(join(info.path, 'ignored', 'out.txt'), 'only copy\n')
    const result = await manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true })
    expect(result).toMatchObject({ success: false, kept: { ignoredFiles: 1, code: 'no_owner' } })
    expect(readFileSync(join(info.path, 'ignored', 'out.txt'), 'utf8')).toBe('only copy\n')
    expect(preservedRefs(cwd)).toEqual([])
  })

  it('keeps a worktree with untracked files as it is, naming them, and keeps no copy', async () => {
    const { cwd, owner, manager } = setup()
    const info = await manager.createWorktree('audit-agent-dirty', cwd)
    writeFileSync(join(info.path, 'draft.txt'), 'untracked\n')
    mkdirSync(join(info.path, 'ignored')); writeFileSync(join(info.path, 'ignored', 'out.txt'), 'ignored\n')
    const result = await manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner } })
    expect(result).toMatchObject({ success: false, kept: { code: 'uncommitted_changes', uncommitted: 'draft.txt' } })
    expect(readFileSync(join(info.path, 'draft.txt'), 'utf8')).toBe('untracked\n')
    expect(readFileSync(join(info.path, 'ignored', 'out.txt'), 'utf8')).toBe('ignored\n')
    expect(preservedRefs(cwd)).toEqual([])
  })
})

describe("agent worktree cleanup keeps Git's own data of the worktree", () => {
  /** Moves the owner's retention clock to `at` in steps the clock check accepts. */
  async function advance(owner: string, top: string, from: number, at: number): Promise<void> {
    for (let now = from; now < at; now = Math.min(at, now + 6 * 24 * 60 * 60 * 1000)) await new UndoRetentionService(owner, () => now).sweep(top)
    await new UndoRetentionService(owner, () => at).sweep(top)
  }

  it('keeps per-worktree settings, HEAD history and the commit only that history named, until the copy expires (the audit reproduction N4, inverted)', async () => {
    const { cwd, owner, manager } = setup()
    const start = Date.now()
    await new UndoRetentionService(owner, () => start).sweep(cwd)
    const info = await manager.createWorktree('audit-cleanup-admin', cwd, git(cwd, 'rev-parse', 'HEAD'))
    git(cwd, 'config', 'extensions.worktreeConfig', 'true')
    git(info.path, 'config', '--worktree', 'audit.note', 'sole admin setting 3c91dd')
    const admin = git(info.path, 'rev-parse', '--absolute-git-dir'), config = readFileSync(join(admin, 'config.worktree'))
    // A commit made on a detached HEAD and then left: only the worktree's HEAD history names it.
    const original = git(info.path, 'rev-parse', 'HEAD'); git(info.path, 'checkout', '-q', '--detach')
    writeFileSync(join(info.path, 'base.txt'), 'abandoned user commit contents\n'); git(info.path, 'commit', '-qam', 'abandoned')
    const abandoned = git(info.path, 'rev-parse', 'HEAD'); git(info.path, 'reset', '-q', '--hard', original)
    const reflog = readFileSync(join(admin, 'logs', 'HEAD'))
    expect(reflog.toString()).toContain(abandoned)

    const result = await manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner } })

    expect(result.success).toBe(true); expect(existsSync(admin)).toBe(false); expect(existsSync(info.path)).toBe(false)
    const ref = result.admin!.ref
    expect(threadPreservedIndex(owner).owns(ref)).toBe(true)
    expect(keptBytes(cwd, ref, 'config.worktree').equals(config)).toBe(true)
    expect(keptBytes(cwd, ref, 'logs/HEAD').equals(reflog)).toBe(true)
    expect(git(cwd, 'rev-parse', `${ref}^@`).split('\n')).toEqual([abandoned])

    // Inside the window nothing expires, and Git's garbage collection keeps the abandoned commit.
    const inside = start + DEFAULT_UNDO_RETENTION_POLICY.windowMs - 60 * 60 * 1000
    await advance(owner, cwd, start, inside)
    expect((await expirePreservedFiles(owner, cwd, { now: () => inside })).expiredRefs).toEqual([])
    git(cwd, 'reflog', 'expire', '--expire=now', '--all'); git(cwd, 'gc', '-q', '--prune=now')
    expect(git(cwd, 'cat-file', '-t', abandoned)).toBe('commit')
    expect(keptBytes(cwd, ref, 'logs/HEAD').equals(reflog)).toBe(true)

    // After it, the copy goes, and the pin with it.
    const after = start + DEFAULT_UNDO_RETENTION_POLICY.windowMs + 60 * 60 * 1000
    await advance(owner, cwd, inside, after)
    expect((await expirePreservedFiles(owner, cwd, { now: () => after })).expiredRefs).toEqual([ref])
    expect(preservedRefs(cwd)).toEqual([])
    git(cwd, 'reflog', 'expire', '--expire=now', '--all'); git(cwd, 'gc', '-q', '--prune=now')
    expect(exists(cwd, abandoned)).toBe(false)
  })

  it('keeps the commit a worktree\'s branch alone held, since the branch may go after it', async () => {
    const { cwd, owner, manager } = setup()
    const info = await manager.createWorktree('audit-cleanup-branch', cwd)
    writeFileSync(join(info.path, 'base.txt'), 'agent work\n'); git(info.path, 'commit', '-qam', 'agent work')
    const work = git(info.path, 'rev-parse', 'HEAD')
    const result = await manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner }, deleteBranch: false })
    expect(result.success).toBe(true)
    expect(git(cwd, 'rev-parse', `${result.admin!.ref}^@`).split('\n')).toEqual([work])
    git(cwd, 'branch', '-D', info.branch); git(cwd, 'reflog', 'expire', '--expire=now', '--all'); git(cwd, 'gc', '-q', '--prune=now')
    expect(git(cwd, 'cat-file', '-t', work)).toBe('commit')
  })

  it('a confirmed delete from Storage removes the ignored files with the worktree and still keeps Git\'s own data of it', async () => {
    const { cwd, owner, manager } = setup()
    const info = await manager.createWorktree('audit-cleanup-confirmed', cwd)
    git(cwd, 'config', 'extensions.worktreeConfig', 'true')
    git(info.path, 'config', '--worktree', 'audit.note', 'confirmed delete setting')
    const config = readFileSync(join(git(info.path, 'rev-parse', '--absolute-git-dir'), 'config.worktree'))
    mkdirSync(join(info.path, 'ignored')); writeFileSync(join(info.path, 'ignored', 'out.bin'), randomBytes(64))
    const steps: string[] = []
    const result = await manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner, deleteIgnored: true, record: (step) => steps.push(`${step.phase}:${step.files}`) } })
    expect(result.success).toBe(true); expect(result.copy).toBeUndefined()
    expect(existsSync(info.path)).toBe(false)
    expect(steps).toEqual(['keeping:0', 'deleting:0'])
    expect(preservedRefs(cwd)).toEqual([result.admin!.ref])
    expect(keptBytes(cwd, result.admin!.ref, 'config.worktree').equals(config)).toBe(true)
  })
})
