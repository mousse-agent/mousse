import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KEEP_COPY_LIMITS } from '../src/mms/actions/keptCopies'
import { acquireRepositoryLease } from '../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentityAsync } from '../src/mms/git/RepositoryIdentity'
import { StorageCleanupService } from '../src/mms/lifecycle/StorageCleanupService'
import { WorktreeManager } from '../src/mms/worktree/WorktreeManager'
import { cleanupRecordFor, cleanupRecordsFolder, tryLockCleanup, type CleanupRecord } from '../src/mms/worktree/verifiedCleanup'
import { utimesSync, openSync, writeSync, closeSync } from 'node:fs'
import { ownedHome } from './support/fixtureGit'

const roots: string[] = []
const owned: Array<() => void> = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const undo of owned.splice(0)) undo()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const restored = (cwd: string, ref: string, path: string): Buffer => execFileSync('git', ['cat-file', 'blob', `${ref}:${path}`], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
const registered = (cwd: string, path: string): boolean => git(cwd, 'worktree', 'list', '--porcelain').split('\n').includes(`worktree ${path}`)
const preservedRefs = (cwd: string): string[] => git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/mousse/preserved/').split('\n').filter(Boolean)
const blobOf = (bytes: Buffer): string => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
const digestOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const deletingIn = (folder: string): string[] => readdirSync(folder).filter((name) => /^\.deleting-[a-f0-9]{16}$/.test(name))

function setup() {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null')
  vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null')
  vi.stubEnv('MOUSSE_GIT_POLICY', 'refuse')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-cleanup-proof-')))
  roots.push(root)
  const cwd = join(root, 'repo'), home = join(root, 'home'), owner = join(root, 'owner')
  mkdirSync(cwd); mkdirSync(home); mkdirSync(owner)
  owned.push(ownedHome(home))
  git(cwd, 'init', '-q', '-b', 'main'); git(cwd, 'config', 'user.name', 'Audit'); git(cwd, 'config', 'user.email', 'audit@example.invalid')
  git(cwd, 'config', 'commit.gpgsign', 'false'); git(cwd, 'config', 'core.hooksPath', '/dev/null')
  writeFileSync(join(cwd, 'base.txt'), 'base\n'); writeFileSync(join(cwd, '.gitignore'), 'ignored/\n')
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base')
  return { root, cwd, home, owner, manager: new WorktreeManager(cwd, home) }
}

/** Starts a cleanup and ends it at its first removal, as a process ending there would: the folder is renamed and recorded. */
async function crashed(f: ReturnType<typeof setup>, agent: string, options: { deleteIgnored?: boolean; prepare?: (worktree: string) => void } = {}) {
  const info = await f.manager.createWorktree(agent, f.cwd, undefined, undefined, { safeCheckout: true })
  mkdirSync(join(info.path, 'ignored')); writeFileSync(join(info.path, 'ignored', 'out.bin'), 'agent output\n')
  options.prepare?.(info.path)
  const result = await f.manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner: f.owner, ...(options.deleteIgnored ? { deleteIgnored: true } : {}) }, beforeRemove: () => { throw new Error('The process ended') } })
  expect(result).toMatchObject({ success: false, error: 'The process ended' })
  const deleting = join(dirname(info.path), deletingIn(dirname(info.path))[0]!)
  const record = (await cleanupRecordFor(f.home, deleting))!
  return { info, deleting, record, recordPath: join(cleanupRecordsFolder(f.home), `${record.id}.json`) }
}

describe('the record of a cleanup under way', () => {
  it('is kept in Mousse\'s own folder, not beside the worktree', async () => {
    const f = setup()
    const { info, record } = await crashed(f, 'proof-where')
    expect(readdirSync(dirname(info.path)).filter((name) => name.endsWith('.json'))).toEqual([])
    expect(existsSync(join(cleanupRecordsFolder(f.home), `${record.id}.json`))).toBe(true)
  })

  it('a record that lists a file no copy holds deletes nothing more, and the file stays', async () => {
    const f = setup()
    const { info, deleting, recordPath } = await crashed(f, 'proof-tamper')
    const bytes = Buffer.from('not captured anywhere unique tamper 3299\n')
    writeFileSync(join(deleting, 'secret.bin'), bytes)
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as CleanupRecord
    record.proof.push({ path: 'secret.bin', kind: 'file', digest: digestOf(bytes), bytes: bytes.length, mode: lstatSync(join(deleting, 'secret.bin')).mode, blob: blobOf(bytes) })
    writeFileSync(recordPath, JSON.stringify(record))

    const result = await f.manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner: f.owner } })

    expect(result).toMatchObject({ success: false, kept: { code: 'cleanup_stopped', reason: expect.stringMatching(/secret\.bin, which no kept copy, commit or confirmed delete holds/) } })
    expect(readFileSync(join(deleting, 'secret.bin')).equals(bytes)).toBe(true)
    expect(readFileSync(join(deleting, 'base.txt'), 'utf8')).toBe('base\n')
  })

  it('a record forged for another `.deleting-` folder, beside it or in Mousse\'s folder, deletes nothing in it', async () => {
    const f = setup()
    const { info, record } = await crashed(f, 'proof-forged')
    const other = join(dirname(info.path), '.deleting-0123456789abcdef'), bytes = Buffer.from('unrelated unique 82910\n')
    mkdirSync(other); writeFileSync(join(other, 'personal.bin'), bytes)
    const entries = [{ path: '', kind: 'directory' as const, digest: '', bytes: 0, mode: lstatSync(other).mode }, { path: 'personal.bin', kind: 'file' as const, digest: digestOf(bytes), bytes: bytes.length, mode: lstatSync(join(other, 'personal.bin')).mode, blob: blobOf(bytes) }]
    // Beside the folder, as an earlier version kept it: not a record cleanup reads.
    writeFileSync(`${other}.json`, JSON.stringify({ ...record, deletingPath: other, proof: entries }))
    expect(await f.manager.cleanupValidatedAgentWorktree({ path: other, branch: info.branch, repositoryRoot: f.cwd }, { safeCheckout: true })).toMatchObject({ success: false })
    // In Mousse's own folder: it names a folder that is not the one cleanup renamed.
    const forged: CleanupRecord = { ...record, id: '0123456789abcdef', deletingPath: other, realPath: other, proof: entries }
    writeFileSync(join(cleanupRecordsFolder(f.home), '0123456789abcdef.json'), JSON.stringify(forged))
    const result = await f.manager.cleanupValidatedAgentWorktree({ path: other, branch: info.branch, repositoryRoot: f.cwd }, { safeCheckout: true })
    expect(result).toMatchObject({ success: false, kept: { reason: expect.stringMatching(/no longer the folder it renamed/) } })
    expect(readFileSync(join(other, 'personal.bin')).equals(bytes)).toBe(true)
  })

  it('a renamed folder swapped for a link gets no .git written through it, and nothing in its target goes', async () => {
    const f = setup()
    const { info, deleting } = await crashed(f, 'proof-link')
    const outside = join(f.root, 'outside'), bytes = Buffer.from('outside the worktree\n')
    mkdirSync(outside); writeFileSync(join(outside, 'mine.txt'), bytes)
    renameSync(deleting, `${deleting}-moved`); symlinkSync(outside, deleting)
    const result = await f.manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner: f.owner } })
    expect(result.success).toBe(false)
    expect(existsSync(join(outside, '.git'))).toBe(false)
    expect(readFileSync(join(outside, 'mine.txt')).equals(bytes)).toBe(true)
  })

  it('another run that has the cleanup is left to finish it, and nothing changes', async () => {
    const f = setup()
    const { info, deleting, record, recordPath } = await crashed(f, 'proof-busy')
    const before = readFileSync(recordPath, 'utf8')
    const release = tryLockCleanup(f.home, record.id)!
    try {
      const busy = await f.manager.cleanupValidatedAgentWorktree({ path: deleting, branch: info.branch, repositoryRoot: f.cwd }, { safeCheckout: true })
      expect(busy).toMatchObject({ success: false, kept: { code: 'cleanup_running' } })
      expect(readFileSync(recordPath, 'utf8')).toBe(before)
      expect(existsSync(join(deleting, 'ignored', 'out.bin'))).toBe(true)
    } finally { release() }
    expect(await f.manager.cleanupValidatedAgentWorktree({ path: deleting, branch: info.branch, repositoryRoot: f.cwd }, { safeCheckout: true })).toMatchObject({ success: true })
    expect(existsSync(deleting)).toBe(false)
  })
})

describe('what cleanup keeps', () => {
  it.each(['--assume-unchanged', '--skip-worktree'])('keeps an edit to a tracked file hidden by %s', async (flag) => {
    const f = setup()
    const info = await f.manager.createWorktree(`proof-hidden-${flag.slice(2)}`, f.cwd)
    git(info.path, 'update-index', flag, 'base.txt')
    const bytes = Buffer.from('sole hidden tracked bytes 80e2\n'); writeFileSync(join(info.path, 'base.txt'), bytes)
    expect(git(info.path, 'status', '--porcelain')).toBe('')
    const result = await f.manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner: f.owner } })
    expect(result).toMatchObject({ success: true, copy: { files: 1 } })
    expect(restored(f.cwd, result.copy!.ref, 'base.txt').equals(bytes)).toBe(true)
  })

  it('makes no copy for a tracked link that is HEAD\'s', async () => {
    const f = setup()
    symlinkSync('base.txt', join(f.cwd, 'alias')); git(f.cwd, 'add', 'alias'); git(f.cwd, 'commit', '-qm', 'link')
    const info = await f.manager.createWorktree('proof-link-held', f.cwd)
    const result = await f.manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner: f.owner } })
    expect(result.success).toBe(true)
    expect(result.copy).toBeUndefined()
    expect(preservedRefs(f.cwd)).toEqual([result.admin!.ref])
  })

  it('removes an agent\'s worktree whose files a filter driver wrote, as Git LFS does, comparing them with what the driver writes', async () => {
    const f = setup()
    const config = join(f.root, 'gitconfig')
    const clean = join(f.root, 'clean.sh'), smudge = join(f.root, 'smudge.sh')
    writeFileSync(clean, '#!/bin/sh\ncat >/dev/null\nprintf "pointer\\n"\n', { mode: 0o755 })
    writeFileSync(smudge, '#!/bin/sh\ncat >/dev/null\nprintf "real media bytes\\n"\n', { mode: 0o755 })
    writeFileSync(config, `[filter "media"]\n\tclean = ${clean}\n\tsmudge = ${smudge}\n\trequired = true\n`)
    vi.stubEnv('GIT_CONFIG_GLOBAL', config)
    writeFileSync(join(f.cwd, '.gitattributes'), 'media.dat filter=media\n'); writeFileSync(join(f.cwd, 'media.dat'), 'real media bytes\n')
    git(f.cwd, 'add', '.'); git(f.cwd, 'commit', '-qm', 'media')
    expect(git(f.cwd, 'cat-file', 'blob', 'HEAD:media.dat')).toBe('pointer')
    // An agent's worktree: checked out with its drivers.
    const info = await f.manager.createWorktree('proof-media', f.cwd)
    expect(readFileSync(join(info.path, 'media.dat'), 'utf8')).toBe('real media bytes\n')
    const result = await f.manager.cleanupValidatedAgentWorktree(info, { keepIgnored: { owner: f.owner } })
    expect(result).toMatchObject({ success: true })
    expect(result.copy).toBeUndefined()
    expect(existsSync(info.path)).toBe(false)
  })
})

describe('the repository during the delete', () => {
  it('is free once the folder is renamed: another action gets its lock while the worktree is still being deleted', async () => {
    const f = setup()
    const info = await f.manager.createWorktree('proof-lock', f.cwd)
    mkdirSync(join(info.path, 'ignored')); for (let index = 0; index < 20; index++) writeFileSync(join(info.path, 'ignored', `f${index}.bin`), `output ${index}\n`)
    const identity = await resolveRepositoryIdentityAsync(f.cwd, { requireMutationCapability: true })
    let asked: Promise<void> | undefined
    let stillRegistered: boolean | undefined
    const result = await f.manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner: f.owner }, beforeRemove: () => {
      asked ??= acquireRepositoryLease(identity).then((lease) => { stillRegistered = registered(f.cwd, info.path); lease.release() })
    } })
    await asked
    expect(result.success).toBe(true)
    // Git still registered the worktree when the other action held the lock: it got the lock before the cleanup finished.
    expect(stillRegistered).toBe(true)
  })
})

describe('what Storage says of a cleanup that stopped', () => {
  it('names the file only in the folder when its copy could not be kept, instead of saying every file is copied', async () => {
    const f = setup()
    const info = await f.manager.createWorktree('proof-storage', f.cwd)
    const bytes = Buffer.from('late bytes are only on disk not copied\n')
    const limit = KEEP_COPY_LIMITS.bytes
    KEEP_COPY_LIMITS.bytes = 8
    let left = ''
    try {
      let wrote = false
      const result = await f.manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner: f.owner }, beforeRemove: (path) => {
        if (wrote) return
        wrote = true
        writeFileSync(join(/^(.*\/\.deleting-[a-f0-9]{16})/.exec(path)![1]!, 'late.bin'), bytes)
      } })
      expect(result).toMatchObject({ success: false, kept: { code: 'cleanup_stopped', reason: expect.stringMatching(/1 file written into it is only in .*\(late\.bin\)/) } })
      left = result.kept!.path!
    } finally { KEEP_COPY_LIMITS.bytes = limit }
    expect(readFileSync(join(left, 'late.bin')).equals(bytes)).toBe(true)
    expect(() => git(f.cwd, 'cat-file', '-e', blobOf(bytes))).toThrow()
    const storage = Object.create(StorageCleanupService.prototype) as StorageCleanupService
    Object.assign(storage, { deps: { installationHome: f.home } })
    const reason = await (storage as unknown as { dispatchWorktreeReason(kept: { path: string }): Promise<string> }).dispatchWorktreeReason({ path: left })
    expect(reason).not.toMatch(/every file it held is kept/)
    expect(reason).toMatch(/1 file written into it since, which is only in the folder \(late\.bin\)/)
  })
})

/** What `lstat` says of a file, as a proof records it. */
const signatureOf = (path: string): string => { const stat = lstatSync(path, { bigint: true }); return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') }

describe('a resume trusts what is on disk, not the record alone', () => {
  it('a record that pairs new bytes on disk with the blob of the old ones refuses, names the file, and the new bytes stay', async () => {
    const f = setup()
    const { info, deleting, recordPath } = await crashed(f, 'proof-old-blob')
    const edited = Buffer.from('new bytes no copy holds 51c2\n')
    writeFileSync(join(deleting, 'ignored', 'out.bin'), edited)
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as CleanupRecord
    const entry = record.proof.find((item) => item.path === 'ignored/out.bin')!
    // The digest and signature of the new bytes, with the id of the old ones, which the copy holds.
    Object.assign(entry, { digest: digestOf(edited), bytes: edited.length, signature: signatureOf(join(deleting, 'ignored', 'out.bin')), coarse: false })
    writeFileSync(recordPath, JSON.stringify(record))
    const result = await f.manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner: f.owner } })
    expect(result).toMatchObject({ success: false, kept: { code: 'cleanup_stopped', reason: expect.stringMatching(/ignored\/out\.bin, which no kept copy, commit or confirmed delete holds/) } })
    expect(readFileSync(join(deleting, 'ignored', 'out.bin')).equals(edited)).toBe(true)
    expect(() => git(f.cwd, 'cat-file', '-e', blobOf(edited))).toThrow()
  })

  it('a record that adds a file Git does not ignore as a confirmed delete with no digest refuses, names it, and the file stays', async () => {
    const f = setup()
    const { info, deleting, recordPath } = await crashed(f, 'proof-not-ignored', { deleteIgnored: true })
    const bytes = Buffer.from('not ignored, never confirmed 7a1d\n')
    writeFileSync(join(deleting, 'notes.md'), bytes)
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as CleanupRecord
    expect(record.deleteIgnored).toBe(true)
    record.proof.push({ path: 'notes.md', kind: 'file', digest: '', bytes: bytes.length, mode: lstatSync(join(deleting, 'notes.md')).mode, signature: signatureOf(join(deleting, 'notes.md')), coarse: false, confirmed: true })
    writeFileSync(recordPath, JSON.stringify(record))
    const result = await f.manager.cleanupValidatedAgentWorktree({ path: deleting, branch: info.branch, repositoryRoot: f.cwd }, { safeCheckout: true })
    expect(result).toMatchObject({ success: false, kept: { code: 'cleanup_stopped', reason: expect.stringMatching(/notes\.md, which no kept copy, commit or confirmed delete holds/) } })
    expect(readFileSync(join(deleting, 'notes.md')).equals(bytes)).toBe(true)
  })

  it('a save after a crash into a file the proof lists is kept as a late copy, and the cleanup finishes', async () => {
    const f = setup()
    const { info, deleting } = await crashed(f, 'proof-saved-after')
    const saved = Buffer.from('saved into a listed file after the crash e09b\n')
    writeFileSync(join(deleting, 'ignored', 'out.bin'), saved)
    const result = await f.manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner: f.owner } })
    expect(result.success).toBe(true)
    expect(existsSync(deleting)).toBe(false)
    expect(restored(f.cwd, result.copy!.ref, 'ignored/out.bin').toString()).toBe('agent output\n')
    expect(result.late!.some((copy) => restored(f.cwd, copy.ref, 'ignored/out.bin').equals(saved))).toBe(true)
  })

  it('a confirmed delete of ignored files, a link among them, resumes and finishes', async () => {
    const f = setup()
    const { info, deleting } = await crashed(f, 'proof-confirmed-link', { deleteIgnored: true, prepare: (worktree) => symlinkSync('out.bin', join(worktree, 'ignored', 'alias')) })
    expect(lstatSync(join(deleting, 'ignored', 'alias')).isSymbolicLink()).toBe(true)
    const result = await f.manager.cleanupValidatedAgentWorktree({ path: deleting, branch: info.branch, repositoryRoot: f.cwd }, { safeCheckout: true })
    expect(result).toMatchObject({ success: true })
    expect(existsSync(deleting)).toBe(false)
    expect(registered(f.cwd, info.path)).toBe(false)
  })

  it('a dispatch\'s recovery runs no filter driver, even after a .gitattributes written into what was left names one', async () => {
    const f = setup()
    const marker = join(f.root, 'driver-ran'), driver = join(f.root, 'driver.sh'), config = join(f.root, 'gitconfig')
    writeFileSync(driver, `#!/bin/sh\nprintf ran >> '${marker}'\ncat\n`, { mode: 0o755 })
    writeFileSync(config, `[filter "probe"]\n\tclean = ${driver}\n\tsmudge = ${driver}\n\trequired = true\n`)
    vi.stubEnv('GIT_CONFIG_GLOBAL', config)
    // Under core.autocrlf=true a dispatch's checkout writes CRLF: the file is held by Git's form, which a resume reads.
    writeFileSync(join(f.cwd, 'notes.txt'), 'line one\nline two\n'); git(f.cwd, 'add', 'notes.txt'); git(f.cwd, 'commit', '-qm', 'notes')
    git(f.cwd, 'config', 'core.autocrlf', 'true')
    const { info, deleting, record } = await crashed(f, 'proof-recovery-driver')
    expect(readFileSync(join(deleting, 'notes.txt'), 'utf8')).toBe('line one\r\nline two\r\n')
    expect(record.heldByForm).toContain('notes.txt')
    const attributes = Buffer.from('* filter=probe\n')
    writeFileSync(join(deleting, '.gitattributes'), attributes)
    const result = await f.manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner: f.owner } })
    expect(existsSync(marker)).toBe(false)
    expect(result.success).toBe(true)
    expect(existsSync(deleting)).toBe(false)
    expect(result.late!.some((copy) => restored(f.cwd, copy.ref, '.gitattributes').equals(attributes))).toBe(true)
    expect(existsSync(marker)).toBe(false)
  })

  it('a same-size edit with its times put back, right before the rename, is kept in a copy', async () => {
    const f = setup()
    const info = await f.manager.createWorktree('proof-times-back', f.cwd)
    mkdirSync(join(info.path, 'ignored')); writeFileSync(join(info.path, 'ignored', 'one.bin'), 'one 1f\n')
    for (const path of ['base.txt', 'ignored/one.bin']) utimesSync(join(info.path, path), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    const edits = { 'base.txt': Buffer.from('BASE\n'), 'ignored/one.bin': Buffer.from('one 9z\n') }
    const result = await f.manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner: f.owner, record: (step) => {
      if (step.phase !== 'deleting') return
      for (const [path, bytes] of Object.entries(edits)) {
        const target = join(info.path, path), before = lstatSync(target, { bigint: true })
        const fd = openSync(target, 'r+'); writeSync(fd, bytes, 0, bytes.length, 0); closeSync(fd)
        utimesSync(target, Number(before.atimeNs) / 1e9, Number(before.mtimeNs) / 1e9)
      }
    } } })
    expect(result.success).toBe(true)
    const copies = [result.copy?.ref, ...(result.late ?? []).map((copy) => copy.ref)].filter((ref): ref is string => Boolean(ref))
    for (const [path, bytes] of Object.entries(edits)) expect(copies.some((ref) => { try { return restored(f.cwd, ref, path).equals(bytes) } catch { return false } }), path).toBe(true)
  })
})
