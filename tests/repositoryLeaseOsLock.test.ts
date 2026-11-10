/**
 * The repository lease between processes is an OS lock (`RepositoryLease`): real child processes run the real lease
 * code. A killed holder lets go at once, a live holder is never taken over however long it holds, acquirers that race
 * never hold it together, and a lease file of a Mousse without the OS lock is honoured while it is fresh.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildSync } from 'esbuild'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'
import { acquireRepositoryLease, getRepositoryLeasePath, RepositoryLeaseBusyError, REPOSITORY_LEASE_HEARTBEAT_MS } from '../src/mms/git/RepositoryLease'

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
  // `hold <repo>`: takes the lease, says `held`, and keeps it until killed. `race <repo> <log> <go>`: waits for `go`,
  // takes the lease, records when it held it, and lets go.
  writeFileSync(join(work, 'child.ts'), [
    `import { appendFileSync, existsSync } from 'node:fs'`,
    `import { acquireRepositoryLease } from ${JSON.stringify(resolve('src/mms/git/RepositoryLease'))}`,
    `import { resolveRepositoryIdentity } from ${JSON.stringify(resolve('src/mms/git/RepositoryIdentity'))}`,
    `const [mode, repo, log, go] = process.argv.slice(2)`,
    `const identity = resolveRepositoryIdentity(repo)`,
    `const sleeper = new Int32Array(new SharedArrayBuffer(4))`,
    `if (mode === 'hold') {`,
    `  await acquireRepositoryLease(identity)`,
    `  console.log('held')`,
    `  setInterval(() => undefined, 60_000)`,
    `} else {`,
    `  console.log('ready')`,
    `  while (!existsSync(go)) Atomics.wait(sleeper, 0, 0, 1)`,
    `  const lease = await acquireRepositoryLease(identity, { retryDelayMs: 1 })`,
    `  appendFileSync(log, 'enter ' + process.pid + '\\n')`,
    `  Atomics.wait(sleeper, 0, 0, 60)`,
    `  appendFileSync(log, 'exit ' + process.pid + '\\n')`,
    `  lease.release()`,
    `}`
  ].join('\n'))
  script = join(work, 'child.mjs')
  buildSync({ entryPoints: [join(work, 'child.ts')], bundle: true, platform: 'node', format: 'esm', outfile: script, logLevel: 'silent', banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" } })
})

afterEach(async () => {
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
const exited = (made: ChildProcess): Promise<void> => new Promise((done) => { if (made.exitCode !== null || made.signalCode !== null) done(); else made.once('exit', () => done()) })

describe('the repository lease between processes', () => {
  it('lets go at once when its holder is killed', async () => {
    const root = repo(); const identity = resolveRepositoryIdentity(root)
    const holder = child(['hold', root])
    expect(await said(holder)).toBe('held')
    await expect(acquireRepositoryLease(identity, { retryDelayMs: 5, maxWaitMs: 300 })).rejects.toBeInstanceOf(RepositoryLeaseBusyError)
    holder.kill('SIGKILL'); await exited(holder)
    const begun = Date.now()
    const lease = await acquireRepositoryLease(identity, { retryDelayMs: 5, maxWaitMs: 5_000 })
    // Not after a stale window: the OS let go with the process, and the file it left names a holder of the OS lock.
    expect(Date.now() - begun).toBeLessThan(2_000)
    expect(lease.release()).toBe(true)
  }, 30_000)

  it('never takes over a live holder, past any stale window and even with its lease file gone', async () => {
    const root = repo(); const identity = resolveRepositoryIdentity(root)
    const holder = child(['hold', root])
    expect(await said(holder)).toBe('held')
    // By the file alone this holder would be stale at once.
    await expect(acquireRepositoryLease(identity, { retryDelayMs: 5, staleAfterMs: 1, maxWaitMs: 1_000 })).rejects.toBeInstanceOf(RepositoryLeaseBusyError)
    unlinkSync(getRepositoryLeasePath(identity))
    await expect(acquireRepositoryLease(identity, { retryDelayMs: 5, staleAfterMs: 1, maxWaitMs: 1_000 })).rejects.toBeInstanceOf(RepositoryLeaseBusyError)
    holder.kill('SIGKILL'); await exited(holder)
    expect((await acquireRepositoryLease(identity, { retryDelayMs: 5, maxWaitMs: 5_000 })).release()).toBe(true)
  }, 30_000)

  it('keeps its lease file fresh for a Mousse without the OS lock while it holds', async () => {
    const root = repo(); const identity = resolveRepositoryIdentity(root)
    const holder = child(['hold', root])
    expect(await said(holder)).toBe('held')
    const first = JSON.parse(readFileSync(getRepositoryLeasePath(identity), 'utf8')) as { heartbeatAt: string; osLock?: boolean }
    expect(first.osLock).toBe(true)
    await new Promise((done) => setTimeout(done, REPOSITORY_LEASE_HEARTBEAT_MS + 1_500))
    const later = JSON.parse(readFileSync(getRepositoryLeasePath(identity), 'utf8')) as { heartbeatAt: string }
    expect(Date.parse(later.heartbeatAt)).toBeGreaterThan(Date.parse(first.heartbeatAt))
  }, 30_000)

  it('waits while a fresh lease of a Mousse without the OS lock is there, and takes over a stale one', async () => {
    const root = repo(); const identity = resolveRepositoryIdentity(root); const path = getRepositoryLeasePath(identity)
    // A live process stands for the older Mousse that holds the repository.
    const older = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); children.push(older)
    const lease = (heartbeatAt: string) => JSON.stringify({ pid: older.pid, processInstanceId: 'older', token: 'older', acquiredAt: heartbeatAt, heartbeatAt })
    writeFileSync(path, lease(new Date().toISOString()))
    await expect(acquireRepositoryLease(identity, { retryDelayMs: 5, maxWaitMs: 500 })).rejects.toBeInstanceOf(RepositoryLeaseBusyError)
    writeFileSync(path, lease(new Date(Date.now() - 120_000).toISOString()))
    expect((await acquireRepositoryLease(identity, { retryDelayMs: 5, maxWaitMs: 5_000 })).release()).toBe(true)
  }, 30_000)

  it('takes over a lease file left unreadable for longer than the stale window', async () => {
    const root = repo(); const identity = resolveRepositoryIdentity(root); const path = getRepositoryLeasePath(identity)
    writeFileSync(path, '{"pid":')
    await expect(acquireRepositoryLease(identity, { retryDelayMs: 2, maxWaitMs: 100 })).rejects.toBeInstanceOf(RepositoryLeaseBusyError)
    const old = new Date(Date.now() - 60_000); utimesSync(path, old, old)
    expect((await acquireRepositoryLease(identity, { retryDelayMs: 2, maxWaitMs: 5_000 })).release()).toBe(true)
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
