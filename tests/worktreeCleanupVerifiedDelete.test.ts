import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { threadPreservedIndex } from '../src/mms/actions/preservedFiles'
import { WorktreeManager, type WorktreeInfo } from '../src/mms/worktree/WorktreeManager'
import { cleanupRecordFor, cleanupRecordsFolder } from '../src/mms/worktree/verifiedCleanup'
import { ownedHome } from './support/fixtureGit'

const roots: string[] = []
const owned: Array<() => void> = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const undo of owned.splice(0)) undo()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
/** The bytes a copy gives back for `path`: `git cat-file blob <ref>:<path>`, the restore command, read as bytes. */
const restored = (cwd: string, ref: string, path: string): Buffer => execFileSync('git', ['cat-file', 'blob', `${ref}:${path}`], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
const registered = (cwd: string, path: string): boolean => git(cwd, 'worktree', 'list', '--porcelain').split('\n').includes(`worktree ${path}`)
/** Folders and records of cleanups under way beside the worktree. */
const deletingIn = (folder: string): string[] => readdirSync(folder).filter((name) => name.startsWith('.deleting-'))

function setup() {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null')
  vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null')
  vi.stubEnv('MOUSSE_GIT_POLICY', 'refuse')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-cleanup-verified-')))
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

/** The worktree is gone from disk and from Git, with its administration folder, and no cleanup is left under way. */
function expectUnregistered(cwd: string, info: WorktreeInfo, admin: string, home: string): void {
  expect(existsSync(info.path)).toBe(false)
  expect(registered(cwd, info.path)).toBe(false)
  expect(existsSync(admin)).toBe(false)
  expect(deletingIn(dirname(info.path))).toEqual([])
  expect(existsSync(cleanupRecordsFolder(home)) ? readdirSync(cleanupRecordsFolder(home)).filter((name) => name.endsWith('.json')) : []).toEqual([])
}

describe('agent worktree cleanup deletes against a proof', () => {
  it('keeps a save that lands after the copy was made, and the delete goes on (the audit reproduction N3, inverted)', async () => {
    const { cwd, home, owner, manager } = setup()
    const info = await manager.createWorktree('audit-cleanup-late', cwd, git(cwd, 'rev-parse', 'HEAD'))
    const admin = git(info.path, 'rev-parse', '--absolute-git-dir')
    const first = Buffer.from('first copy\n'), rewritten = Buffer.from('FIRST COPY\n'), late = Buffer.from('late ignored bytes ba9b28c3\n')
    mkdirSync(join(info.path, 'ignored')); writeFileSync(join(info.path, 'ignored', 'first.bin'), first)

    const result = await manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner, record: (step) => {
      // Right before the folder moves: a new file, and a file the copy already holds saved again with as many bytes.
      if (step.phase === 'deleting') { writeFileSync(join(info.path, 'ignored', 'late.bin'), late); writeFileSync(join(info.path, 'ignored', 'first.bin'), rewritten) }
    } } })

    expect(result.success).toBe(true)
    expectUnregistered(cwd, info, admin, home)
    expect(restored(cwd, result.copy!.ref, 'ignored/first.bin').equals(first)).toBe(true)
    expect(result.late).toHaveLength(1)
    expect(restored(cwd, result.late![0]!.ref, 'ignored/late.bin').equals(late)).toBe(true)
    expect(restored(cwd, result.late![0]!.ref, 'ignored/first.bin').equals(rewritten)).toBe(true)
    expect(threadPreservedIndex(owner).owns(result.late![0]!.ref)).toBe(true)
  })

  it('keeps a tracked file whose CRLF bytes Git would write back as LF under core.autocrlf=input', async () => {
    const { cwd, home, owner, manager } = setup()
    git(cwd, 'config', 'core.autocrlf', 'input')
    writeFileSync(join(cwd, 'notes.txt'), 'line one\nline two\n'); git(cwd, 'add', 'notes.txt'); git(cwd, 'commit', '-qm', 'notes')
    const info = await manager.createWorktree('audit-cleanup-crlf', cwd)
    const admin = git(info.path, 'rev-parse', '--absolute-git-dir')
    const crlf = Buffer.from('line one\r\nline two\r\n')
    // Saved with CRLF and staged, as an agent's own `git add` would: the staged blob is HEAD's, and the index records
    // the CRLF file's size, so Git finds the worktree clean.
    writeFileSync(join(info.path, 'notes.txt'), crlf); git(info.path, 'add', 'notes.txt')
    expect(git(info.path, 'status', '--porcelain')).toBe('')

    const result = await manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner } })

    expect(result).toMatchObject({ success: true, copy: { files: 1 } })
    expectUnregistered(cwd, info, admin, home)
    expect(restored(cwd, result.copy!.ref, 'notes.txt').equals(crlf)).toBe(true)
  })

  it('a cleanup a process left part way is finished against its proof, keeping a save made into what was left', async () => {
    const { cwd, home, owner, manager } = setup()
    const info = await manager.createWorktree('audit-cleanup-crash', cwd)
    const admin = git(info.path, 'rev-parse', '--absolute-git-dir')
    const output = Buffer.from('agent output 7c41\n'), saved = Buffer.from('saved after the process ended 5d1e\n')
    mkdirSync(join(info.path, 'ignored')); writeFileSync(join(info.path, 'ignored', 'out.bin'), output)
    let removals = 0
    const crashed = await manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner }, beforeRemove: () => { if (++removals === 2) throw new Error('The process ended') } })
    expect(crashed).toMatchObject({ success: false, error: 'The process ended' })

    // The folder waits at its `.deleting-` name with its proof beside it; the worktree is still registered.
    // The record is in Mousse's own folder, never beside the worktree.
    expect(deletingIn(dirname(info.path))).toHaveLength(1)
    const deleting = join(dirname(info.path), deletingIn(dirname(info.path))[0]!)
    expect(existsSync(join(deleting, 'ignored', 'out.bin'))).toBe(false)
    expect(registered(cwd, info.path)).toBe(true)
    expect(manager.isValidatedAgentWorktreePath(deleting)).toBe(true)
    const record = (await cleanupRecordFor(home, deleting))!
    expect(record.proof.map((entry) => entry.path)).toContain('ignored/out.bin')
    writeFileSync(join(deleting, 'ignored', 'after.bin'), saved)

    // As Storage finishes it: by the recorded name.
    const resumed = await manager.cleanupValidatedAgentWorktree({ path: deleting, branch: info.branch, repositoryRoot: cwd }, { safeCheckout: true })

    expect(resumed.success).toBe(true)
    expectUnregistered(cwd, info, admin, home)
    expect(existsSync(deleting)).toBe(false)
    expect(restored(cwd, resumed.copy!.ref, 'ignored/out.bin').equals(output)).toBe(true)
    expect(restored(cwd, resumed.late![0]!.ref, 'ignored/after.bin').equals(saved)).toBe(true)
  })

  it('a dispatch\'s start check finishes it by the worktree\'s own path', async () => {
    const { cwd, home, owner, manager } = setup()
    const info = await manager.createWorktree('audit-cleanup-start', cwd)
    const admin = git(info.path, 'rev-parse', '--absolute-git-dir')
    const output = Buffer.from('dispatch output 9a02\n')
    mkdirSync(join(info.path, 'ignored')); writeFileSync(join(info.path, 'ignored', 'out.bin'), output)
    let removals = 0
    await manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner }, beforeRemove: () => { if (++removals === 3) throw new Error('The process ended') } })
    const resumed = await manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner } })
    expect(resumed.success).toBe(true)
    expectUnregistered(cwd, info, admin, home)
    expect(restored(cwd, resumed.copy!.ref, 'ignored/out.bin').equals(output)).toBe(true)
  })

  it('stops after three rounds of writes and keeps what is left as a working worktree; every write is on disk or in a copy', async () => {
    const { cwd, home, owner, manager } = setup()
    const info = await manager.createWorktree('audit-cleanup-rounds', cwd)
    const writes = new Map<string, Buffer>()
    // A writer that saves a new file each time an entry in the renamed folder is about to go.
    const beforeRemove = (path: string): void => {
      const root = /^(.*\/\.deleting-[a-f0-9]{16})/.exec(path)![1]!
      if (path === root || basename(path) === '.git') return
      const name = `late-${writes.size + 1}.txt`, bytes = Buffer.from(`write ${writes.size + 1} ${Math.random()}\n`)
      writeFileSync(join(root, name), bytes); writes.set(name, bytes)
    }

    const result = await manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner }, beforeRemove })

    expect(result).toMatchObject({ success: false, kept: { code: 'cleanup_stopped', reason: expect.stringMatching(/Cleanup stopped: files in it kept changing while it was being deleted, 3 times/), path: expect.stringMatching(/\/\.deleting-[a-f0-9]{16}$/) } })
    expect(result.error).not.toMatch(/trash/)
    const left = result.kept!.path!
    expect(existsSync(left)).toBe(true)
    // What is left is still a worktree Git knows.
    expect(git(left, 'rev-parse', '--is-inside-work-tree')).toBe('true')
    expect(registered(cwd, info.path)).toBe(true)
    const record = (await cleanupRecordFor(home, left))!
    expect(record.stopped?.reason).toMatch(/kept changing/)
    expect(writes.size).toBeGreaterThan(2)
    for (const [name, bytes] of writes) {
      const onDisk = existsSync(join(left, name)) && readFileSync(join(left, name)).equals(bytes)
      const inCopy = record.late.some((copy) => { try { return restored(cwd, copy.ref, name).equals(bytes) } catch { return false } })
      expect(onDisk || inCopy, name).toBe(true)
    }
  })
})
