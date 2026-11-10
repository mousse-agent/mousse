/**
 * The repository lease between processes is an OS lock (`RepositoryLease`). Real child processes run the real lease
 * code, and an older Mousse is the lease of the builds before the OS lock (`fixtures/legacyRepositoryLease`):
 * - a killed holder lets go at once, and a live holder is never taken over however long it holds;
 * - acquirers that race never hold it together;
 * - a live holder of an older build is never taken over, and is named while it is waited for;
 * - an older build never takes over a holder of this build that keeps its lease file fresh;
 * - a lease file left unfinished by a holder of this build is removed at once; an older build's keeps its rule;
 * - the lock works on long Windows paths, and a lock file that cannot be opened is waited for, then named as busy.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir, uptime } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildSync } from 'esbuild'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { resolveRepositoryIdentity, type RepositoryIdentity } from '../src/mms/git/RepositoryIdentity'
import { acquireRepositoryLease, getRepositoryLeasePath, getRepositoryLockPath, REPOSITORY_LEASE_TIMING, RepositoryLeaseBusyError } from '../src/mms/git/RepositoryLease'
import { GIT_STOP_TIMING, gitStopProbe, runGitProcess } from '../src/mms/git/runGitProcess'
import { withGitMutationLocks } from '../src/mms/actions/GitOperationCoordinator'
import { sqliteFilePath } from '../src/mms/data/sqliteFilePath'
import { STORE_TRASH_RETRY, trashProjectStoreWhenFree, trashRemovedProjectStores } from '../src/mms/actions/SnapshotRefReleaseService'
import { snapshotTrashRoot } from '../src/mms/workspace/SnapshotWorkspace'

const dirs: string[] = []
const children: ChildProcess[] = []
let script: string

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-lease-os-')); dirs.push(dir)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q'); git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test')
  writeFileSync(join(dir, 'README'), 'x'); git('add', '.'); git('commit', '-qm', 'init')
  return dir
}

beforeAll(() => {
  const work = mkdtempSync(join(tmpdir(), 'mousse-lease-os-child-')); dirs.push(work)
  // `hold <repo> [heartbeatMs]`: takes the lease, says `held`, keeps it until killed.
  // `legacy-hold <repo>`: the same with an older build's lease.
  // `legacy-try <repo> <staleMs> <waitMs>`: an older build tries for the lease and says `took` or `busy`.
  // `race <repo> <log> <go>`: waits for `go`, takes the lease, records when it held it, and lets go.
  writeFileSync(join(work, 'child.ts'), [
    `import { appendFileSync, existsSync } from 'node:fs'`,
    `import { acquireRepositoryLease } from ${JSON.stringify(resolve('src/mms/git/RepositoryLease'))}`,
    `import { acquireRepositoryLease as acquireOlder } from ${JSON.stringify(resolve('tests/fixtures/legacyRepositoryLease'))}`,
    `import { resolveRepositoryIdentity } from ${JSON.stringify(resolve('src/mms/git/RepositoryIdentity'))}`,
    `const [mode, repo, a, b] = process.argv.slice(2)`,
    `const identity = resolveRepositoryIdentity(repo)`,
    `const sleeper = new Int32Array(new SharedArrayBuffer(4))`,
    `if (mode === 'hold') {`,
    `  await acquireRepositoryLease(identity, a ? { heartbeatMs: Number(a) } : {})`,
    `  console.log('held')`,
    `  setInterval(() => undefined, 60_000)`,
    `} else if (mode === 'legacy-hold') {`,
    `  await acquireOlder(identity)`,
    `  console.log('held')`,
    `  setInterval(() => undefined, 60_000)`,
    `} else if (mode === 'legacy-try') {`,
    `  const lease = await acquireOlder(identity, { staleAfterMs: Number(a), retryDelayMs: 5, signal: AbortSignal.timeout(Number(b)) }).catch(() => undefined)`,
    `  console.log(lease ? 'took' : 'busy')`,
    `  lease?.release()`,
    `  process.exit(0)`,
    `} else {`,
    `  console.log('ready')`,
    `  while (!existsSync(b)) Atomics.wait(sleeper, 0, 0, 1)`,
    `  const lease = await acquireRepositoryLease(identity, { retryDelayMs: 1 })`,
    `  appendFileSync(a, 'enter ' + process.pid + '\\n')`,
    `  Atomics.wait(sleeper, 0, 0, 60)`,
    `  appendFileSync(a, 'exit ' + process.pid + '\\n')`,
    `  lease.release()`,
    `}`
  ].join('\n'))
  script = join(work, 'child.mjs')
  buildSync({ entryPoints: [join(work, 'child.ts')], bundle: true, platform: 'node', format: 'esm', outfile: script, logLevel: 'silent', banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" } })
})

const leaseTiming = { ...REPOSITORY_LEASE_TIMING }
const stopTiming = { ...GIT_STOP_TIMING }
afterEach(async () => {
  Object.assign(REPOSITORY_LEASE_TIMING, leaseTiming)
  Object.assign(GIT_STOP_TIMING, stopTiming)
  delete gitStopProbe.alive
  vi.restoreAllMocks()
  // A killed holder lets go of its files only once it has exited (on Windows, its open handles hold the folder).
  await Promise.all(children.splice(0).map((made) => { made.kill('SIGKILL'); return exited(made) }))
  while (dirs.length > 1) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function child(args: string[]): ChildProcess {
  const made = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
  children.push(made)
  return made
}
const said = (made: ChildProcess): Promise<string> => new Promise((done) => made.stdout!.once('data', (data) => done(String(data).trim())))
function exited(made: ChildProcess): Promise<void> {
  return new Promise((done) => { if (made.exitCode !== null || made.signalCode !== null) done(); else made.once('exit', () => done()) })
}
const busy = (identity: RepositoryIdentity, opts: { staleAfterMs?: number; maxWaitMs?: number } = {}): Promise<RepositoryLeaseBusyError> =>
  acquireRepositoryLease(identity, { retryDelayMs: 5, maxWaitMs: 500, ...opts }).then(
    (lease) => { lease.release(); throw new Error('the lease was taken') },
    (error: unknown) => { expect(error).toBeInstanceOf(RepositoryLeaseBusyError); return error as RepositoryLeaseBusyError }
  )
const acquires = async (identity: RepositoryIdentity): Promise<number> => {
  const begun = Date.now()
  const lease = await acquireRepositoryLease(identity, { retryDelayMs: 5, maxWaitMs: 5_000 })
  expect(lease.release()).toBe(true)
  return Date.now() - begun
}

describe('the repository lease between processes', () => {
  it('lets go at once when its holder is killed', async () => {
    const root = repo(); const identity = resolveRepositoryIdentity(root)
    const holder = child(['hold', root])
    expect(await said(holder)).toBe('held')
    const error = await busy(identity, { maxWaitMs: 300 })
    expect(error.holder).toMatchObject({ pid: holder.pid, olderBuild: false })
    expect(error.message).toContain(`process ${holder.pid}`)
    holder.kill('SIGKILL'); await exited(holder)
    // Not after a stale window: the OS let go with the process, and the file it left names a holder of the OS lock.
    expect(await acquires(identity)).toBeLessThan(2_000)
  }, 30_000)

  it('never takes over a live holder, past any stale window and even with its lease file gone', async () => {
    const root = repo(); const identity = resolveRepositoryIdentity(root)
    const holder = child(['hold', root])
    expect(await said(holder)).toBe('held')
    await busy(identity, { staleAfterMs: 1, maxWaitMs: 1_000 })
    unlinkSync(getRepositoryLeasePath(identity))
    await busy(identity, { staleAfterMs: 1, maxWaitMs: 1_000 })
    holder.kill('SIGKILL'); await exited(holder)
    await acquires(identity)
  }, 30_000)

  it('keeps its lease file fresh while it holds, so an older Mousse never takes it over', async () => {
    const root = repo(); const identity = resolveRepositoryIdentity(root)
    const holder = child(['hold', root, '100'])
    expect(await said(holder)).toBe('held')
    const first = JSON.parse(readFileSync(getRepositoryLeasePath(identity), 'utf8')) as { heartbeatAt: string; osLock?: boolean }
    expect(first.osLock).toBe(true)
    await new Promise((done) => setTimeout(done, 600))
    const later = JSON.parse(readFileSync(getRepositoryLeasePath(identity), 'utf8')) as { heartbeatAt: string }
    expect(Date.parse(later.heartbeatAt)).toBeGreaterThan(Date.parse(first.heartbeatAt))
    // An older build with a 300 ms stale window tries for 1.5 s, many windows over.
    const older = child(['legacy-try', root, '300', '1500'])
    expect(await said(older)).toBe('busy')
  }, 30_000)

  it('never takes over a live holder of an older Mousse, however old its heartbeat, and names it', async () => {
    const root = repo(); const identity = resolveRepositoryIdentity(root)
    const older = child(['legacy-hold', root])
    expect(await said(older)).toBe('held')
    // Older builds never refresh their lease; by its heartbeat it would be stale at once.
    const error = await busy(identity, { staleAfterMs: 1, maxWaitMs: 1_000 })
    expect(error.holder).toMatchObject({ pid: older.pid, olderBuild: true })
    expect(error.message).toContain(`process ${older.pid}`)
    expect(error.message).toContain('older Mousse')
    // It may be a leftover of an older Mousse whose pid another program got: what clears it, and where the file is.
    expect(error.message).toContain('restart that Mousse')
    expect(error.message).toContain(getRepositoryLeasePath(identity))
    older.kill('SIGKILL'); await exited(older)
    expect(await acquires(identity)).toBeLessThan(2_000)
  }, 30_000)

  it('takes over at once a lease of an older Mousse whose process is gone, however fresh its heartbeat', async () => {
    const root = repo(); const identity = resolveRepositoryIdentity(root)
    const now = new Date().toISOString()
    writeFileSync(getRepositoryLeasePath(identity), JSON.stringify({ pid: 2147000000, processInstanceId: 'gone', token: 'gone', acquiredAt: now, heartbeatAt: now }))
    expect(await acquires(identity)).toBeLessThan(2_000)
  })

  it('removes at once a lease file a holder of this build left unfinished, and keeps the older rule for others', async () => {
    const root = repo(); const identity = resolveRepositoryIdentity(root); const path = getRepositoryLeasePath(identity)
    // Every build writes its whole record right after creating the file: one left empty or cut short for 5 s is abandoned.
    const old = new Date(Date.now() - 6_000)
    // Cut short while being written (no current build publishes this way; a file system without hard links does).
    writeFileSync(path, '{"osLock":true,"pid":')
    expect(await acquires(identity)).toBeLessThan(2_000)
    // A complete record a holder staged but never put in place is removed too.
    const staged = `${path}.publish-0123456789abcdef`
    writeFileSync(staged, '{"osLock":true}')
    await acquires(identity)
    expect(existsSync(staged)).toBe(false)
    // Empty, or an older build's unfinished record: its writer may still be writing it for a moment, so it waits.
    for (const text of ['', '{"pid":12']) {
      writeFileSync(path, text)
      await busy(identity, { maxWaitMs: 300 })
      utimesSync(path, old, old)
      await acquires(identity)
    }
  })

  it('never lets processes that race for it, over a lease left behind, hold it together', async () => {
    const root = repo(); const identity = resolveRepositoryIdentity(root); const path = getRepositoryLeasePath(identity)
    const work = mkdtempSync(join(tmpdir(), 'mousse-lease-race-')); dirs.push(work)
    const log = join(work, 'holds.log'); const go = join(work, 'go')
    for (let round = 0; round < 8; round += 1) {
      rmSync(go, { force: true }); rmSync(log, { force: true })
      // What a stopped process left: half a record, or the record of a process that is gone.
      writeFileSync(path, round % 2 === 0 ? '{"pid":' : JSON.stringify({ pid: 2147000000, processInstanceId: 'gone', token: `gone-${round}`, acquiredAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString() }))
      const old = new Date(Date.now() - 120_000); utimesSync(path, old, old)
      const racers = Array.from({ length: 4 }, () => child(['race', root, log, go]))
      await Promise.all(racers.map(said))
      writeFileSync(go, '')
      await Promise.all(racers.map(exited))
      const lines = readFileSync(log, 'utf8').trim().split('\n')
      expect(lines).toHaveLength(8)
      for (let index = 0; index < lines.length; index += 2) {
        expect(lines[index]!.startsWith('enter ')).toBe(true)
        expect(lines[index + 1]).toBe(lines[index]!.replace('enter', 'exit'))
      }
      expect(existsSync(path)).toBe(false)
    }
  }, 120_000)
})

describe('the repository lock file', () => {
  /** A repository identity whose metadata folder is `metadataDir` (as a hidden store's is). */
  const identityAt = (metadataDir: string): RepositoryIdentity => {
    mkdirSync(metadataDir, { recursive: true })
    return { commonDir: metadataDir, key: metadataDir, worktreePath: metadataDir, metadataDir, capability: { allowed: true } } as RepositoryIdentity
  }

  it('works where its path is longer than Windows paths normally may be', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mousse-lease-long-')); dirs.push(base)
    const identity = identityAt(join(base, ...Array.from({ length: 6 }, (_, index) => `${'deep-folder-name-'.repeat(3)}${index}`), 'mousse'))
    expect(getRepositoryLockPath(identity).length).toBeGreaterThan(300)
    const lease = await acquireRepositoryLease(identity, { maxWaitMs: 5_000 })
    expect(existsSync(getRepositoryLockPath(identity))).toBe(true)
    // While it is held, a second caller here waits, and is told this process holds it.
    const error = await busy(identity, { maxWaitMs: 200 })
    expect(error.holder?.pid).toBe(process.pid)
    expect(lease.release()).toBe(true)
    await acquires(identity)
  })

  it('waits while the lock file cannot be opened, ends busy with what failed, and goes on once it can', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mousse-lease-cantopen-')); dirs.push(base)
    const identity = identityAt(join(base, 'mousse'))
    // A folder where the lock file belongs: SQLite cannot open it (SQLITE_CANTOPEN).
    mkdirSync(getRepositoryLockPath(identity))
    const error = await busy(identity, { maxWaitMs: 300 })
    expect(error.message).toContain('could not be used')
    expect(((error.cause as { errcode?: number }).errcode ?? 0) & 0xff).toBe(14)
    const waiting = acquireRepositoryLease(identity, { retryDelayMs: 5, maxWaitMs: 5_000 })
    await new Promise((done) => setTimeout(done, 100))
    rmdirSync(getRepositoryLockPath(identity))
    expect((await waiting).release()).toBe(true)
  })

  it('moves a removed project\'s store to the trash once nothing has its lock file open', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-lease-trash-')); dirs.push(home)
    const metadata = join(home, 'project-data', 'project-1', 'snapshots.git', 'mousse')
    mkdirSync(metadata, { recursive: true })
    writeFileSync(join(metadata, 'project-removed'), '')
    // Another process waiting for the store's lock has the lock file open.
    const waiter = new DatabaseSync(sqliteFilePath(join(metadata, 'repository-mutation.lock')), { timeout: 0 })
    waiter.exec('BEGIN EXCLUSIVE')
    const retry = { ...STORE_TRASH_RETRY }
    Object.assign(STORE_TRASH_RETRY, { attempts: 6, firstDelayMs: 50 })
    try {
      expect(() => trashProjectStoreWhenFree('project-1', home)).not.toThrow()
      waiter.exec('ROLLBACK'); waiter.close()
      const until = Date.now() + 5_000
      while (existsSync(join(home, 'project-data', 'project-1')) && Date.now() < until) await new Promise((done) => setTimeout(done, 20))
      expect(existsSync(join(home, 'project-data', 'project-1'))).toBe(false)
      expect(readdirSync(snapshotTrashRoot(home)).some((name) => name.startsWith('project-project-1-'))).toBe(true)
    } finally {
      Object.assign(STORE_TRASH_RETRY, retry)
      try { waiter.close() } catch { /* closed */ }
    }
  })
})

describe('the repository lease, round 2', () => {
  const identityAt = (metadataDir: string): RepositoryIdentity => {
    mkdirSync(metadataDir, { recursive: true })
    return { commonDir: metadataDir, key: metadataDir, worktreePath: metadataDir, metadataDir, capability: { allowed: true } } as RepositoryIdentity
  }
  const olderLease = (pid: number, acquiredAt: Date, heartbeatAt = acquiredAt): string => JSON.stringify({ pid, processInstanceId: 'older', token: `older-${pid}`, acquiredAt: acquiredAt.toISOString(), heartbeatAt: heartbeatAt.toISOString() })
  const ago = (ms: number): Date => new Date(Date.now() - ms)

  it("takes over an older Mousse's lease whose pid another program got since it was taken", async () => {
    const root = repo(); const identity = resolveRepositoryIdentity(root)
    // A program that started after the lease was taken, now holding the pid the lease names.
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); children.push(other)
    writeFileSync(getRepositoryLeasePath(identity), olderLease(other.pid!, new Date(Date.now() - 60 * 60_000)))
    // The program's start is looked up without blocking; the lease goes once it is known.
    expect(await acquires(identity)).toBeLessThan(5_000)
  }, 30_000)

  it("takes over at once an older Mousse's lease taken before the computer last started", async () => {
    const root = repo(); const identity = resolveRepositoryIdentity(root)
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); children.push(other)
    // Refreshed a minute ago: past older builds' 30 s, well inside the 6 h ceiling, so only the boot rule decides.
    writeFileSync(getRepositoryLeasePath(identity), olderLease(other.pid!, ago(uptime() * 1000 + 24 * 60 * 60_000), ago(60_000)))
    expect(await acquires(identity)).toBeLessThan(2_000)
  }, 30_000)

  it("keeps a recently refreshed older Mousse's lease that only a clock step makes look reused or older than the boot", async () => {
    const root = repo(); const identity = resolveRepositoryIdentity(root); const path = getRepositoryLeasePath(identity)
    // Its process started after the lease's `acquiredAt` (as after the clock stepped back), and the lease reads as
    // taken before the boot (as after a step forward); its heartbeat is 5 s old, as a live holder's is.
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); children.push(other)
    writeFileSync(path, olderLease(other.pid!, ago(60 * 60_000), ago(5_000)))
    await busy(identity, { maxWaitMs: 3_000 })
    writeFileSync(path, olderLease(other.pid!, ago(uptime() * 1000 + 60 * 60_000), ago(5_000)))
    await busy(identity, { maxWaitMs: 1_000 })
    // Once it is not refreshed for more than 30 s, the rules apply.
    writeFileSync(path, olderLease(other.pid!, ago(60 * 60_000), ago(31_000)))
    expect(await acquires(identity)).toBeLessThan(5_000)
  }, 30_000)

  it("takes over an older Mousse's lease not refreshed for over six hours, and keeps a younger one of a live process", async () => {
    const root = repo(); const identity = resolveRepositoryIdentity(root); const path = getRepositoryLeasePath(identity)
    // A live process that was already running when the lease was taken, so only the heartbeat's age can decide.
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); children.push(other)
    await new Promise((done) => setTimeout(done, 2_500))
    const lease = (heartbeatAgeMs: number) => {
      const acquiredAt = new Date().toISOString()
      return JSON.stringify({ pid: other.pid, processInstanceId: 'older', token: 'older', acquiredAt, heartbeatAt: new Date(Date.now() - heartbeatAgeMs).toISOString() })
    }
    writeFileSync(path, lease(5 * 60 * 60_000))
    await busy(identity, { maxWaitMs: 3_000 })
    writeFileSync(path, lease(7 * 60 * 60_000))
    expect(await acquires(identity)).toBeLessThan(2_000)
  }, 30_000)

  it('ends a wait with no limit of its own once the lock file stays unusable, and a later wait never reports that cause', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mousse-lease-cap-')); dirs.push(base)
    const identity = identityAt(join(base, 'mousse'))
    REPOSITORY_LEASE_TIMING.unavailableLimitMs = 300
    mkdirSync(getRepositoryLockPath(identity))
    const begun = Date.now()
    const error = await acquireRepositoryLease(identity, { retryDelayMs: 5 }).then(() => undefined, (failure: unknown) => failure)
    expect(error).toBeInstanceOf(RepositoryLeaseBusyError)
    expect(((error as Error).cause as { errcode?: number }).errcode! & 0xff).toBe(14)
    expect(Date.now() - begun).toBeLessThan(3_000)
    rmdirSync(getRepositoryLockPath(identity))
    // Held here now: a wait that ends behind it names this process, and nothing of the earlier failure.
    const lease = await acquireRepositoryLease(identity, { maxWaitMs: 5_000 })
    const later = await busy(identity, { maxWaitMs: 200 })
    expect(later.cause).toBeUndefined()
    expect(later.message).not.toContain('could not be used')
    lease.release()
  })

  it('publishes the lease whole where the file system has no hard links, and keeps no journal file while it holds', async () => {
    const root = repo(); const identity = resolveRepositoryIdentity(root)
    REPOSITORY_LEASE_TIMING.noHardLinks = true
    const lease = await acquireRepositoryLease(identity, { maxWaitMs: 5_000 })
    expect(JSON.parse(readFileSync(getRepositoryLeasePath(identity), 'utf8'))).toMatchObject({ osLock: true, token: lease.owner.token })
    expect(readdirSync(identity.metadataDir).filter((name) => name.includes('.publish-') || name.endsWith('-journal'))).toEqual([])
    expect(lease.release()).toBe(true)
  })

  it('stays held while a stopped Git command is still running: fresh for older builds, and says what to do', async () => {
    const root = repo(); const identity = resolveRepositoryIdentity(root)
    const threadDirectory = mkdtempSync(join(tmpdir(), 'mousse-lease-retained-')); dirs.push(threadDirectory)
    Object.assign(REPOSITORY_LEASE_TIMING, { heartbeatMs: 100 })
    Object.assign(GIT_STOP_TIMING, { exitWaitMs: 200, slowPollMs: 50, survivorLimitMs: 300 })
    let lingering = true
    gitStopProbe.alive = () => lingering
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 500)
    const ran = await withGitMutationLocks(threadDirectory, root, 'test', () => runGitProcess(['-c', 'alias.slow=!sleep 30', 'slow'], { cwd: root, env: process.env }), undefined, undefined, controller.signal)
    expect(ran.error?.code).toBe('ABORT_ERR')
    const first = JSON.parse(readFileSync(getRepositoryLeasePath(identity), 'utf8')) as { heartbeatAt: string; stoppedGitPids?: number[] }
    expect(first.stoppedGitPids?.length).toBeGreaterThan(0)
    // Past the survivor limit the lease is still refreshed, and an older build never takes it.
    await new Promise((done) => setTimeout(done, 700))
    expect(logged).toHaveBeenCalled()
    const later = JSON.parse(readFileSync(getRepositoryLeasePath(identity), 'utf8')) as { heartbeatAt: string }
    expect(Date.parse(later.heartbeatAt)).toBeGreaterThan(Date.parse(first.heartbeatAt))
    const older = child(['legacy-try', root, '300', '1500'])
    expect(await said(older)).toBe('busy')
    const error = await busy(identity, { maxWaitMs: 300 })
    expect(error.message).toContain(`A stopped git command is still running (pid ${first.stoppedGitPids![0]}`)
    expect(error.message).toContain('Close it or restart Mousse.')
    lingering = false
    await acquires(identity)
  }, 30_000)

  it.skipIf(process.platform === 'win32')('never holds a lock on a lock file that another took the place of while it waited', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mousse-lease-inode-')); dirs.push(base)
    const identity = identityAt(join(base, 'mousse'))
    const first = await acquireRepositoryLease(identity, { maxWaitMs: 5_000 })
    const waiting = acquireRepositoryLease(identity, { retryDelayMs: 5, maxWaitMs: 3_000 })
    await new Promise((done) => setTimeout(done, 100))
    // The file is replaced, and the new one is locked by someone else.
    unlinkSync(getRepositoryLockPath(identity))
    const other = new DatabaseSync(getRepositoryLockPath(identity), { timeout: 0 })
    other.exec('BEGIN EXCLUSIVE')
    first.release()
    await expect(waiting).rejects.toBeInstanceOf(RepositoryLeaseBusyError)
    other.exec('ROLLBACK'); other.close()
  })

  it('moves the stores of removed projects that no thread uses to the trash when storage cleanup runs', () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-lease-sweep-')); dirs.push(home)
    const metadata = join(home, 'project-data', 'project-2', 'snapshots.git', 'mousse')
    mkdirSync(metadata, { recursive: true })
    writeFileSync(join(metadata, 'project-removed'), '')
    mkdirSync(join(home, 'project-data', 'project-3', 'snapshots.git', 'mousse'), { recursive: true })
    expect(trashRemovedProjectStores(home)).toBe(1)
    expect(existsSync(join(home, 'project-data', 'project-2'))).toBe(false)
    expect(existsSync(join(home, 'project-data', 'project-3'))).toBe(true)
  })
})
