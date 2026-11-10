import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { buildSync } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'
import { acquireRepositoryLease, getRepositoryLeasePath, RepositoryLeaseAbortedError, RepositoryLeaseBusyError } from '../src/mms/git/RepositoryLease'

const dirs: string[] = []
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-repo-')); dirs.push(dir)
  execFileSync('git', ['init', '-q'], { cwd: dir }); execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: dir }); execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  writeFileSync(join(dir, 'README'), 'x'); execFileSync('git', ['add', '.'], { cwd: dir }); execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })
  return dir
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

describe('RepositoryIdentity', () => {
  it('uses git common-dir so linked worktrees share one identity', () => {
    const root = repo(); const linked = `${root}-linked`; dirs.push(linked)
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'linked', linked], { cwd: root })
    expect(resolveRepositoryIdentity(root).commonDir).toBe(resolveRepositoryIdentity(linked).commonDir)
    expect(resolveRepositoryIdentity(root).key).toBe(resolveRepositoryIdentity(linked).key)
  })
  it('refuses mutation capability for bare and unborn repositories', () => {
    const bare = mkdtempSync(join(tmpdir(), 'mousse-bare-')); dirs.push(bare); execFileSync('git', ['init', '--bare', '-q'], { cwd: bare })
    expect(resolveRepositoryIdentity(bare).capability).toEqual({ allowed: false, reason: 'bare-repository' })
    const unborn = mkdtempSync(join(tmpdir(), 'mousse-unborn-')); dirs.push(unborn); execFileSync('git', ['init', '-q'], { cwd: unborn })
    expect(resolveRepositoryIdentity(unborn).capability).toEqual({ allowed: false, reason: 'unborn-head' })
  })
})

describe('RepositoryLease', () => {
  it('serializes contenders fairly and keeps independent repositories independent', async () => {
    const a = resolveRepositoryIdentity(repo()); const b = resolveRepositoryIdentity(repo())
    const first = await acquireRepositoryLease(a); const second = acquireRepositoryLease(a, { retryDelayMs: 2 }); const other = await acquireRepositoryLease(b)
    let acquired = false; void second.then(() => { acquired = true })
    await new Promise(resolve => setTimeout(resolve, 15)); expect(acquired).toBe(false)
    expect(other.release()).toBe(true); expect(first.release()).toBe(true)
    expect((await second).release()).toBe(true)
  })
  it('aborts a queued contender and safely recovers dead stale ownership', async () => {
    const identity = resolveRepositoryIdentity(repo()); const first = await acquireRepositoryLease(identity)
    const controller = new AbortController(); const waiting = acquireRepositoryLease(identity, { signal: controller.signal, retryDelayMs: 2 }); controller.abort()
    await expect(waiting).rejects.toBeInstanceOf(RepositoryLeaseAbortedError); expect(first.release()).toBe(true)
    writeFileSync(getRepositoryLeasePath(identity), JSON.stringify({ pid: 2147000000, processInstanceId: 'dead', token: 'dead', acquiredAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString() }))
    const recovered = await acquireRepositoryLease(identity); expect(existsSync(getRepositoryLeasePath(identity))).toBe(true); recovered.release()
  })
  it('lets the next caller in this process go when the lease file was removed or taken over while held', async () => {
    const identity = resolveRepositoryIdentity(repo()); const path = getRepositoryLeasePath(identity)
    const first = await acquireRepositoryLease(identity)
    const waiting = acquireRepositoryLease(identity, { retryDelayMs: 2, maxWaitMs: 5_000 })
    // Something removed the file while it was held (another process reclaimed it as stale, then let it go).
    unlinkSync(path)
    expect(first.release()).toBe(false)
    const second = await waiting
    // Another process took the file over while it was held; its owner is gone by the time anyone looks again.
    const third = acquireRepositoryLease(identity, { retryDelayMs: 2, maxWaitMs: 5_000 })
    writeFileSync(path, JSON.stringify({ pid: 2147000000, processInstanceId: 'other', token: 'other', acquiredAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString() }))
    expect(second.release()).toBe(false)
    expect((await third).release()).toBe(true)
  })
  it('takes over a lease file left unreadable for longer than the stale window', async () => {
    const identity = resolveRepositoryIdentity(repo()); const path = getRepositoryLeasePath(identity)
    writeFileSync(path, '{"pid":')
    await expect(acquireRepositoryLease(identity, { retryDelayMs: 2, maxWaitMs: 100 })).rejects.toBeInstanceOf(RepositoryLeaseBusyError)
    const old = new Date(Date.now() - 60_000); utimesSync(path, old, old)
    const lease = await acquireRepositoryLease(identity, { retryDelayMs: 2, maxWaitMs: 5_000 })
    expect(lease.release()).toBe(true)
  })
  it('ends a wait that runs past maxWaitMs as busy, and an aborted wait as aborted', async () => {
    const identity = resolveRepositoryIdentity(repo()); const first = await acquireRepositoryLease(identity)
    await expect(acquireRepositoryLease(identity, { maxWaitMs: 50 })).rejects.toBeInstanceOf(RepositoryLeaseBusyError)
    const controller = new AbortController(); const aborted = acquireRepositoryLease(identity, { maxWaitMs: 5_000, signal: controller.signal }); controller.abort()
    await expect(aborted).rejects.toBeInstanceOf(RepositoryLeaseAbortedError)
    expect(first.release()).toBe(true)
    expect((await acquireRepositoryLease(identity, { maxWaitMs: 5_000 })).release()).toBe(true)
  })
})

describe('RepositoryLease heartbeat', () => {
  it('never leaves the lease empty or cut short for a reader in another process while it is refreshed', async () => {
    const root = repo()
    const work = mkdtempSync(join(tmpdir(), 'mousse-lease-child-')); dirs.push(work)
    // The real lease code, run in a process of its own that refreshes the lease as fast as it can.
    writeFileSync(join(work, 'child.ts'), `import { acquireRepositoryLease } from ${JSON.stringify(resolve('src/mms/git/RepositoryLease'))}\nimport { resolveRepositoryIdentity } from ${JSON.stringify(resolve('src/mms/git/RepositoryIdentity'))}\nconst lease = await acquireRepositoryLease(resolveRepositoryIdentity(process.argv[2]))\nconsole.log(lease.path)\nconst until = Date.now() + 2000\nwhile (Date.now() < until) lease.heartbeat()\nlease.release()\n`)
    buildSync({ entryPoints: [join(work, 'child.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(work, 'child.mjs'), logLevel: 'silent', banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" } })
    const child = spawn(process.execPath, [join(work, 'child.mjs'), root], { stdio: ['ignore', 'pipe', 'inherit'] })
    const path = await new Promise<string>((done) => child.stdout.once('data', (data) => done(String(data).trim())))
    let running = true
    child.on('exit', () => { running = false })
    let reads = 0, unreadable = 0
    while (running) {
      const batch = await Promise.all(Array.from({ length: 16 }, () => readFile(path, 'utf8').then((text) => { JSON.parse(text); return 0 }).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? 0 : 1)))
      reads += batch.length; unreadable += batch.reduce((sum: number, value) => sum + value, 0)
    }
    expect(reads).toBeGreaterThan(1_000)
    expect(unreadable).toBe(0)
  }, 30_000)
})

describe('RepositoryLease reclaim across processes', () => {
  it('never lets two processes that reclaim the same stale lease at once hold it together', async () => {
    const root = repo()
    const identity = resolveRepositoryIdentity(root); const leasePath = getRepositoryLeasePath(identity)
    const work = mkdtempSync(join(tmpdir(), 'mousse-lease-race-')); dirs.push(work)
    const log = join(work, 'holds.log'); const go = join(work, 'go')
    // The real lease code in processes of their own: each waits for `go`, then takes the lease, records when it held it, and lets go.
    writeFileSync(join(work, 'child.ts'), [
      `import { appendFileSync, existsSync } from 'node:fs'`,
      `import { acquireRepositoryLease } from ${JSON.stringify(resolve('src/mms/git/RepositoryLease'))}`,
      `import { resolveRepositoryIdentity } from ${JSON.stringify(resolve('src/mms/git/RepositoryIdentity'))}`,
      `const [repo, log, go] = process.argv.slice(2)`,
      `const identity = resolveRepositoryIdentity(repo)`,
      `console.log('ready')`,
      `const sleeper = new Int32Array(new SharedArrayBuffer(4))`,
      `while (!existsSync(go)) Atomics.wait(sleeper, 0, 0, 1)`,
      `const lease = await acquireRepositoryLease(identity, { retryDelayMs: 1 })`,
      `appendFileSync(log, 'enter ' + process.pid + '\\n')`,
      `Atomics.wait(sleeper, 0, 0, 60)`,
      `appendFileSync(log, 'exit ' + process.pid + '\\n')`,
      `lease.release()`
    ].join('\n'))
    buildSync({ entryPoints: [join(work, 'child.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(work, 'child.mjs'), logLevel: 'silent', banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" } })
    for (let round = 0; round < 8; round += 1) {
      rmSync(go, { force: true }); rmSync(log, { force: true })
      // What a stopped process left: half a record (it stopped while writing it), or the record of a process that is gone.
      writeFileSync(leasePath, round % 2 === 0 ? '{"pid":' : JSON.stringify({ pid: 2147000000, processInstanceId: 'gone', token: `gone-${round}`, acquiredAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString() }))
      const old = new Date(Date.now() - 120_000); utimesSync(leasePath, old, old)
      const children = Array.from({ length: 4 }, () => spawn(process.execPath, [join(work, 'child.mjs'), root, log, go], { stdio: ['ignore', 'pipe', 'inherit'] }))
      await Promise.all(children.map((child) => new Promise<void>((done) => child.stdout.once('data', () => done()))))
      writeFileSync(go, '')
      await Promise.all(children.map((child) => new Promise<void>((done) => child.on('exit', () => done()))))
      const lines = readFileSync(log, 'utf8').trim().split('\n')
      expect(lines).toHaveLength(8)
      // One holder at a time: every enter is followed by the same process's exit.
      for (let index = 0; index < lines.length; index += 2) {
        expect(lines[index]!.startsWith('enter ')).toBe(true)
        expect(lines[index + 1]).toBe(lines[index]!.replace('enter', 'exit'))
      }
      expect(existsSync(leasePath)).toBe(false)
    }
  }, 120_000)
})
