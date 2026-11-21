/**
 * Git processes start in a helper process (`src/mms/git/gitSpawn.ts`), not on the daemon's event loop, where Windows
 * held the loop for the whole process creation. What a command answers must not change: each row below runs the same
 * command started by the helper and started on the calling thread (`MOUSSE_GIT_SPAWN_WORKER=0`, as before) and
 * compares everything the caller sees.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import childProcess, { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { gitCancellationScope, runGitProcess, type GitProcess } from '../src/mms/git/runGitProcess'
import { DiskGate, diskGate, diskOf, execFileGit, inBackgroundGitLane, spawnGit, stopGitSpawnWorkers } from '../src/mms/git/gitSpawn'
import { gitFile } from '../src/mms/git/gitExecutable'
import { resolveRepositoryIdentityAsync } from '../src/mms/git/RepositoryIdentity'

let dir: string
let cwd: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mousse-git-spawn-'))
  cwd = join(dir, 'repo')
  execFileSync('git', ['init', '-q', cwd])
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' })
  git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test')
  writeFileSync(join(cwd, 'README'), 'hello\n'); writeFileSync(join(cwd, 'bytes.bin'), Buffer.from([0, 255, 13, 10, 128]))
  git('add', '.'); git('commit', '-qm', 'init')
  writeFileSync(join(dir, 'input.txt'), 'from a file\n')
})
afterAll(async () => {
  await stopGitSpawnWorkers()
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
})
afterEach(() => { delete process.env.MOUSSE_GIT_SPAWN_WORKER })

/** Calls of `child_process.spawn` on this thread that start Git, while `work` runs. */
async function spawnsHere<T>(work: () => Promise<T>): Promise<{ result: T; spawns: number }> {
  const original = childProcess.spawn
  let spawns = 0
  childProcess.spawn = ((file: string, ...rest: unknown[]) => {
    if (file === gitFile()) spawns += 1
    return (original as (...args: unknown[]) => unknown)(file, ...rest)
  }) as typeof childProcess.spawn
  syncBuiltinESMExports()
  try {
    return { result: await work(), spawns }
  } finally {
    childProcess.spawn = original
    syncBuiltinESMExports()
  }
}

async function both<T>(run: () => Promise<T>): Promise<{ worker: T; here: T }> {
  const worker = await run()
  process.env.MOUSSE_GIT_SPAWN_WORKER = '0'
  const here = await run()
  delete process.env.MOUSSE_GIT_SPAWN_WORKER
  return { worker, here }
}

const seen = (ran: GitProcess) => ({ status: ran.status, stdout: ran.stdoutBytes.toString('hex'), stderr: ran.stderr, error: ran.error?.code })

describe('Git started by the helper', () => {
  it('starts no Git process on the calling thread; with the helper off, it does (the control)', async () => {
    const onWorker = await spawnsHere(() => runGitProcess(['rev-parse', 'HEAD'], { cwd, env: process.env }))
    expect(onWorker.result.status).toBe(0)
    expect(onWorker.spawns).toBe(0)
    // An `execFile`-shaped caller (the repository's identity) too.
    const identity = await spawnsHere(() => resolveRepositoryIdentityAsync(cwd))
    expect(identity.result.key).toMatch(/^[a-f0-9]+$/)
    expect(identity.spawns).toBe(0)

    process.env.MOUSSE_GIT_SPAWN_WORKER = '0'
    const here = await spawnsHere(() => runGitProcess(['rev-parse', 'HEAD'], { cwd, env: process.env }))
    expect(here.spawns).toBe(1)
    expect(here.result.stdout).toBe(onWorker.result.stdout)
  })

  it('keeps a final admission check next to the actual spawn', async () => {
    let allowed = false
    const command = () => runGitProcess(['rev-parse', 'HEAD'], { cwd, env: process.env, beforeStart: () => {
      if (!allowed) throw new Error('Admission refused')
    } })
    await expect(command()).rejects.toThrow('Admission refused')
    allowed = true
    expect(await spawnsHere(command)).toMatchObject({ spawns: 1, result: { status: 0 } })
  })

  it('routes results back to the async context for each concurrent operation', async () => {
    const context = new AsyncLocalStorage<string>()
    const names = ['first', 'second']
    const replies = await Promise.all(names.map((name) => context.run(name, () => new Promise((resolve, reject) => {
      execFileGit(gitFile(), ['rev-parse', 'HEAD'], { cwd }, (error, stdout) => {
        if (error) reject(error)
        else resolve({ name: context.getStore(), head: stdout.trim() })
      })
    }))))
    expect(replies).toEqual(names.map((name) => ({ name, head: expect.stringMatching(/^[a-f0-9]+$/) })))
  })

  it('times out a Git process that is waiting for input', async () => {
    const error = await new Promise((resolve) => {
      execFileGit(gitFile(), ['cat-file', '--batch'], { cwd, timeout: 100 }, (failure) => resolve(failure))
    })
    expect(error).toMatchObject({ killed: true })
  })

  // Every way a `runGitProcess` caller can see a command end.
  const rows: [string, () => Promise<GitProcess>][] = [
    ['output', () => runGitProcess(['log', '-1', '--format=%s%n%H'], { cwd, env: process.env })],
    ['binary output', () => runGitProcess(['cat-file', 'blob', 'HEAD:bytes.bin'], { cwd, env: process.env })],
    ['a failure with its message', () => runGitProcess(['rev-parse', '--verify', 'no-such-ref'], { cwd, env: process.env })],
    ['input', () => runGitProcess(['hash-object', '--stdin'], { cwd, env: process.env, input: 'some input\n' })],
    ['input from a file', () => runGitProcess(['hash-object', '--stdin'], { cwd, env: process.env, inputFile: join(dir, 'input.txt') })],
    ['input from a missing file', () => runGitProcess(['hash-object', '--stdin'], { cwd, env: process.env, inputFile: join(dir, 'missing.txt') })],
    ['output past its limit', () => runGitProcess(['cat-file', 'blob', 'HEAD:README'], { cwd, env: process.env, maxBuffer: 2 })],
    ['a folder that is not there', () => runGitProcess(['status'], { cwd: join(dir, 'missing'), env: process.env })],
    ['the environment given', () => runGitProcess(['var', 'GIT_AUTHOR_IDENT'], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'Given Name', GIT_AUTHOR_EMAIL: 'given@example.test', GIT_AUTHOR_DATE: '1700000000 +0000' } })]
  ]
  it.each(rows)('answers the same: %s', async (_name, run) => {
    const { worker, here } = await both(run)
    // Output past its limit kills Git, which may already have exited with its status by then (more often when the kill
    // comes from the helper): the error and the output are the answer, the status is a race either way.
    const shown = (ran: GitProcess) => ran.error?.code === 'ENOBUFS' ? { ...seen(ran), status: undefined } : seen(ran)
    expect(shown(worker)).toEqual(shown(here))
  })

  it('answers `execFile` callers as `execFile` does', async () => {
    const call = (useWorker: boolean, args: string[], options: { cwd: string; maxBuffer?: number }) => new Promise<Record<string, unknown>>((settle) => {
      const done = (error: (Error & { code?: unknown; killed?: boolean; signal?: unknown; cmd?: string }) | null, stdout: string, stderr: string) =>
        settle({ stdout, stderr, message: error?.message, code: error?.code, killed: error?.killed, signal: error?.signal, cmd: error?.cmd })
      const options_ = { ...options, encoding: 'utf8' as const, windowsHide: true }
      if (useWorker) execFileGit(gitFile(), args, options_, done)
      else execFile(gitFile(), args, options_, done)
    })
    const cases: [string[], { cwd: string; maxBuffer?: number }][] = [
      [['rev-parse', 'HEAD'], { cwd }],
      [['rev-parse', '--verify', 'no-such-ref'], { cwd }],
      [['cat-file', 'blob', 'HEAD:README'], { cwd, maxBuffer: 2 }]
    ]
    for (const [args, options] of cases) expect(await call(true, args, options)).toEqual(await call(false, args, options))
    // A folder that is not there: the start's own error.
    const missing = { cwd: join(dir, 'missing') }
    const [worker, here] = [await call(true, ['status'], missing), await call(false, ['status'], missing)]
    expect(worker.code).toBe(here.code)
  })

  it('answers a caller whose process was running when the helper stopped, and starts a new helper for the next', async () => {
    const child = spawnGit(gitFile(), ['cat-file', '--batch'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    await new Promise((started) => child.once('spawn', started))
    const ended = new Promise<{ error?: string; closed: boolean }>((settle) => {
      let error: string | undefined
      child.on('error', (failure: NodeJS.ErrnoException) => { error = failure.code })
      child.on('close', () => settle({ error, closed: true }))
    })
    await stopGitSpawnWorkers()
    expect(await ended).toEqual({ error: 'EGITWORKER', closed: true })
    // Its input closed with the helper, so it ends on its own; the next command starts a new helper.
    try { process.kill(child.pid!) } catch { /* already gone */ }
    expect((await runGitProcess(['rev-parse', 'HEAD'], { cwd, env: process.env })).status).toBe(0)
  })

  it("never holds the daemon's own processes open: a short one ends while a lane keeps starting long-running Git", async () => {
    // On Windows a process started on one thread inherits the pipes another thread is creating at that moment, and holds
    // them open: started from a worker thread, 45 of 60 of these never ended while the long-running Git lived.
    const long: ReturnType<typeof spawnGit>[] = []
    let starting = true
    const starter = (async () => {
      while (starting) {
        if (long.length >= 12) break
        long.push(inBackgroundGitLane(() => spawnGit(gitFile(), ['cat-file', '--batch'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })))
        await new Promise((tick) => setTimeout(tick, 5))
      }
    })()
    let stuck = 0
    for (let i = 0; i < 30; i++) {
      stuck += await new Promise<number>((settle) => {
        const child = childProcess.spawn(gitFile(), ['rev-parse', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        child.stdout.resume(); child.stderr.resume()
        const timer = setTimeout(() => settle(1), 5_000)
        child.on('close', () => { clearTimeout(timer); settle(0) })
      })
    }
    starting = false
    await starter
    for (const child of long) child.stdin.end()
    await Promise.all(long.map((child) => new Promise((gone) => { if (child.exitCode !== null) gone(undefined); else child.once('close', gone) })))
    expect(stuck).toBe(0)
  }, 120_000)
})

describe('background Git on a disk where interactive Git runs', () => {
  // Each row: the steps, then which background commands have started.
  type Step = ['interactive' | 'interactiveEnds' | 'backgroundEnds', string] | ['background', string, string] | ['cancel', string]
  const rows: [string, Step[], string[]][] = [
    ['nothing interactive: background is not limited', [['background', 'A', 'b1'], ['background', 'A', 'b2'], ['background', 'A', 'b3']], ['b1', 'b2', 'b3']],
    ['interactive on the disk: one background at a time', [['interactive', 'A'], ['background', 'A', 'b1'], ['background', 'A', 'b2']], ['b1']],
    ['interactive on another disk: no limit here', [['interactive', 'B'], ['background', 'A', 'b1'], ['background', 'A', 'b2']], ['b1', 'b2']],
    ['already two running when interactive starts: they go on, the next waits', [['background', 'A', 'b1'], ['background', 'A', 'b2'], ['interactive', 'A'], ['background', 'A', 'b3'], ['backgroundEnds', 'A'], ['backgroundEnds', 'A']], ['b1', 'b2', 'b3']],
    ['the waiting one starts when the running one ends', [['interactive', 'A'], ['background', 'A', 'b1'], ['background', 'A', 'b2'], ['backgroundEnds', 'A']], ['b1', 'b2']],
    ['all waiting start once interactive ends', [['interactive', 'A'], ['background', 'A', 'b1'], ['background', 'A', 'b2'], ['background', 'A', 'b3'], ['interactiveEnds', 'A']], ['b1', 'b2', 'b3']],
    ['a cancelled one never starts', [['interactive', 'A'], ['background', 'A', 'b1'], ['background', 'A', 'b2'], ['cancel', 'b2'], ['backgroundEnds', 'A']], ['b1']]
  ]
  it.each(rows)('%s', (_name, steps, started) => {
    const gate = new DiskGate()
    const seen: string[] = []
    const cancels = new Map<string, () => boolean>()
    for (const step of steps) {
      if (step[0] === 'interactive') gate.interactiveStarted(step[1])
      else if (step[0] === 'interactiveEnds') gate.interactiveEnded(step[1])
      else if (step[0] === 'backgroundEnds') gate.backgroundEnded(step[1])
      else if (step[0] === 'cancel') cancels.get(step[1])!()
      else { const name = step[2]; cancels.set(name, gate.background(step[1], () => seen.push(name))) }
    }
    expect(seen).toEqual(started)
  })

  it('keeps counting active commands when two drive letters are found to share a disk', () => {
    const aliases = new Map<string, string>()
    const gate = new DiskGate((volume) => aliases.get(volume) ?? volume)
    gate.interactiveStarted('A')
    gate.background('B', () => undefined)
    aliases.set('A', 'disk')
    aliases.set('B', 'disk')
    let launched = false
    gate.background('B', () => { launched = true })
    expect(launched).toBe(false)
    gate.interactiveEnded('A')
    expect(launched).toBe(true)
  })

  it('holds a background command while an interactive one runs on its disk, and starts it when that ends', async () => {
    const disk = diskOf(cwd)
    // An interactive command that runs until its input closes, and a background one that does too.
    const interactive = spawnGit(gitFile(), ['cat-file', '--batch'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    const holder = inBackgroundGitLane(() => spawnGit(gitFile(), ['cat-file', '--batch'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] }))
    const waiting = inBackgroundGitLane(() => runGitProcess(['hash-object', '--stdin'], { cwd, env: process.env, input: 'held input\n', timeout: 60_000 }))
    const controller = new AbortController()
    const scope = gitCancellationScope(controller.signal)
    const cancelled = inBackgroundGitLane(() => scope.run(() => runGitProcess(['rev-parse', 'HEAD'], { cwd, env: process.env })))
    expect(diskGate.load(disk)).toEqual({ running: 1, waiting: 2, interactive: 1 })
    controller.abort()
    expect(await cancelled).toMatchObject({ status: null, error: { code: 'ABORT_ERR' } })
    expect(scope.survivorsGone()).toBeUndefined()
    expect(diskGate.load(disk)).toEqual({ running: 1, waiting: 1, interactive: 1 })
    // The interactive command ends: the waiting one starts, with the input it was given while it waited.
    interactive.stdin.end()
    const ran = await waiting
    expect(ran.status).toBe(0)
    expect(ran.stdout.trim()).toBe(execFileSync('git', ['hash-object', '--stdin'], { cwd, input: 'held input\n', encoding: 'utf8' }).trim())
    holder.stdin.end()
    await new Promise((settle) => holder.once('close', settle))
    expect(diskGate.load(disk)).toEqual({ running: 0, waiting: 0, interactive: 0 })
  })
})
