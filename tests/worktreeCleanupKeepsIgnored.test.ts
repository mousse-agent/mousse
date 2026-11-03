import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KEEP_COPY_LIMITS, keptCopyRestoreCommand } from '../src/mms/actions/keptCopies'
import { threadPreservedIndex } from '../src/mms/actions/preservedFiles'
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

  it('tells each step to the caller before it happens: the keep, then the removal with the finished copy', async () => {
    const { cwd, owner, manager } = setup()
    const info = await manager.createWorktree('audit-agent-456', cwd)
    mkdirSync(join(info.path, 'ignored')); writeFileSync(join(info.path, 'ignored', 'out.bin'), randomBytes(64))
    const steps: Array<{ phase: string; present: boolean; ref?: string }> = []
    const result = await manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner, record: (step) => steps.push({ phase: step.phase, present: existsSync(info.path), ...('ref' in step ? { ref: step.ref } : {}) }) } })
    expect(steps).toEqual([{ phase: 'keeping', present: true }, { phase: 'removing', present: true, ref: result.copy!.ref }])
    expect(preservedRefs(cwd)).toEqual([result.copy!.ref])
  })

  it('removes a worktree with no ignored files as before, keeping nothing', async () => {
    const { cwd, owner, manager } = setup()
    const info = await manager.createWorktree('audit-agent-789', cwd)
    const steps: string[] = []
    const result = await manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner, record: (step) => steps.push(step.phase) } })
    expect(result).toEqual({ success: true })
    expect(existsSync(info.path)).toBe(false)
    expect(steps).toEqual([])
    expect(preservedRefs(cwd)).toEqual([])
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

  it('with nothing to own a copy, keeps a worktree that has ignored files', async () => {
    const { cwd, manager } = setup()
    const info = await manager.createWorktree('audit-agent-none', cwd)
    mkdirSync(join(info.path, 'ignored')); writeFileSync(join(info.path, 'ignored', 'out.txt'), 'only copy\n')
    const result = await manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true })
    expect(result).toMatchObject({ success: false, kept: { ignoredFiles: 1, code: 'no_owner' } })
    expect(readFileSync(join(info.path, 'ignored', 'out.txt'), 'utf8')).toBe('only copy\n')
    expect(preservedRefs(cwd)).toEqual([])
  })

  it('leaves a worktree with untracked files to Git, which refuses it, and keeps no copy', async () => {
    const { cwd, owner, manager } = setup()
    const info = await manager.createWorktree('audit-agent-dirty', cwd)
    writeFileSync(join(info.path, 'draft.txt'), 'untracked\n')
    mkdirSync(join(info.path, 'ignored')); writeFileSync(join(info.path, 'ignored', 'out.txt'), 'ignored\n')
    const result = await manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner } })
    expect(result.success).toBe(false)
    expect(readFileSync(join(info.path, 'draft.txt'), 'utf8')).toBe('untracked\n')
    expect(readFileSync(join(info.path, 'ignored', 'out.txt'), 'utf8')).toBe('ignored\n')
    expect(preservedRefs(cwd)).toEqual([])
  })
})
