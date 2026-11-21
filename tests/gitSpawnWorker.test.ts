/**
 * Git processes start in a helper process (`src/mms/git/gitSpawn.ts`), not on the daemon's event loop, where Windows
 * held the loop for the whole process creation. What a command answers must not change: each row below runs the same
 * command started by the helper and started on the calling thread (`MOUSSE_GIT_SPAWN_WORKER=0`, as before) and
 * compares everything the caller sees.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import childProcess, { execFile, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { gitCancellationScope, runGitProcess, type GitProcess } from '../src/mms/git/runGitProcess'
import { DiskGate, diskGate, diskOf, execFileGit, inBackgroundGitLane, spawnGit, stopGitSpawnWorkers } from '../src/mms/git/gitSpawn'
import { gitFile, gitProgramSettled } from '../src/mms/git/gitExecutable'
import { resolveRepositoryIdentity, resolveRepositoryIdentityAsync } from '../src/mms/git/RepositoryIdentity'
import { acquireRepositoryLease, RepositoryLeaseBusyError } from '../src/mms/git/RepositoryLease'
import { withGitMutationLocks } from '../src/mms/actions/GitOperationCoordinator'
import { GitService } from '../src/mms/git/GitService'
import { userAction } from '../src/mms/git/gitPolicy'
import { runGit } from '../src/mms/git/gitProcess'
import * as gitSpawn from '../src/mms/git/gitSpawn'
import { inTurnBoundary } from '../src/mms/diagnostics/turnBoundary'
import { requestDaemonShutdown } from '../src/cli/daemonShutdown'
import { crashChild } from './support/build'
import { startDaemon, until, type Daemon } from './support/daemon'

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
    if (process.platform === 'win32') {
      // The direct path uses CreateProcessW to put Git in its job. Its PID is known before spawnGit returns.
      const child = spawnGit(gitFile(), ['rev-parse', 'HEAD'], { cwd })
      expect(child.pid).toBeDefined()
      await new Promise((done) => child.once('close', done))
    } else expect(here.spawns).toBe(1)
    expect(here.result.stdout).toBe(onWorker.result.stdout)
  })

  it('keeps a final admission check next to the actual spawn', async () => {
    let allowed = false
    const command = () => runGitProcess(['rev-parse', 'HEAD'], { cwd, env: process.env, beforeStart: () => {
      if (!allowed) throw new Error('Admission refused')
    } })
    await expect(command()).rejects.toThrow('Admission refused')
    allowed = true
    expect((await command()).status).toBe(0)
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
    const utf8 = ['-c', 'alias.utf8=!printf "café"', 'utf8']
    const cases: [string[], { cwd: string; maxBuffer?: number }][] = [
      [['rev-parse', 'HEAD'], { cwd }],
      [['rev-parse', '--verify', 'no-such-ref'], { cwd }],
      [['cat-file', 'blob', 'HEAD:README'], { cwd, maxBuffer: 2 }]
    ]
    for (const [args, options] of cases) expect(await call(true, args, options)).toEqual(await call(false, args, options))
    const limited = { cwd, maxBuffer: 4 }
    const truncated = await call(true, utf8, limited)
    expect(truncated).toEqual(await call(false, utf8, limited))
    expect(truncated).toMatchObject({ stdout: 'café', code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
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
    if (process.platform === 'win32') expect(alive(child.pid!)).toBe(false)
    else try { process.kill(child.pid!) } catch { /* already gone */ }
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
    const timings: string[] = []
    const cancelled = inTurnBoundary({ threadId: 'spawn-accounting' }, () =>
      inBackgroundGitLane(() => scope.run(() => runGitProcess(['rev-parse', 'HEAD'], { cwd, env: process.env }))), (line) => timings.push(line))
    expect(diskGate.load(disk)).toEqual({ running: 1, waiting: 2, interactive: 1 })
    controller.abort()
    expect(await cancelled).toMatchObject({ status: null, error: { code: 'ABORT_ERR' } })
    expect(JSON.parse(timings[0]!.slice('[turn-boundary] '.length))).toMatchObject({ git: 0, gitMs: 0 })
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

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}

function gitTree(label: string, exitRoot: boolean, indexLock?: string) {
  const script = join(dir, label + '.cjs')
  const marker = join(dir, label + '.pids')
  writeFileSync(script, [
    "const fs = require('node:fs'); const { spawn } = require('node:child_process')",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: ['ignore', 1, 2], windowsHide: true })",
    "child.once('spawn', () => {",
    ...(indexLock ? ['fs.writeFileSync(' + JSON.stringify(indexLock) + ', "")'] : []),
    'fs.writeFileSync(' + JSON.stringify(marker + '.tmp') + ', JSON.stringify([process.pid, child.pid]))',
    'fs.renameSync(' + JSON.stringify(marker + '.tmp') + ', ' + JSON.stringify(marker) + ')',
    exitRoot ? 'child.unref()' : 'setTimeout(() => {}, 60000)',
    '})'
  ].join('\n'))
  return {
    script,
    args: ['-c', 'alias.job-tree=!node "' + script.replace(/\\/g, '/') + '"', 'job-tree'],
    pids: async (): Promise<number[]> => {
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 10_000 })
      return JSON.parse(readFileSync(marker, 'utf8')) as number[]
    }
  }
}

function captureHelpers(onSpawn?: (worker: ChildProcess) => void) {
  const original = childProcess.spawn
  const helpers: ChildProcess[] = []
  childProcess.spawn = ((file: string, ...rest: unknown[]) => {
    const child = (original as (...args: unknown[]) => ChildProcess)(file, ...rest)
    if (file === process.execPath && (rest[1] as { serialization?: string })?.serialization === 'advanced') {
      helpers.push(child)
      onSpawn?.(child)
    }
    return child
  }) as typeof original
  syncBuiltinESMExports()
  return { helpers, restore() { childProcess.spawn = original; syncBuiltinESMExports() } }
}

// Cleanup also works against a broken implementation which leaks detached processes.
function killSurvivors(pids: number[]): void {
  for (const pid of pids) if (alive(pid)) try { process.kill(pid, 'SIGKILL') } catch { /* exited */ }
}

describe.skipIf(process.platform !== 'win32')('Windows Git job ownership', () => {
  it.each(['graceful shutdown', 'forced exit'])('reaps both Git helpers and detached trees on daemon %s', async (mode) => {
    const trees = [gitTree(mode + '-interactive', false), gitTree(mode + '-background', false)]
    const entry = await crashChild('tests/fixtures/windowsGitShutdownDaemon.ts', {
      format: 'esm', packages: 'external', banner: {
        js: 'import { createRequire as fixtureRequire } from "node:module"; const require = fixtureRequire(import.meta.url); const __dirname = import.meta.dirname; const __filename = import.meta.filename;'
      }
    })
    let daemon: Daemon | undefined
    let descendants: number[] = []
    try {
      daemon = await startDaemon({
        entry, home: join(dir, mode), args: ['service', 'run', cwd, ...trees.map((tree) => tree.script)],
        onStart: (started) => { daemon = started }
      })
      descendants = (await Promise.all(trees.map((tree) => tree.pids().catch((error: unknown) => {
        throw new Error(daemon!.output, { cause: error })
      })))).flat()
      const byLabel = (label: string) => [...daemon!.output.matchAll(new RegExp('Git ' + label + ' PID (\\d+)', 'g'))].map((match) => Number(match[1]))
      expect(byLabel('helper')).toHaveLength(2)
      expect(byLabel('root')).toHaveLength(2)
      const observed = [...descendants, ...byLabel('helper'), ...byLabel('root')]
      expect(observed.every(alive)).toBe(true)
      if (mode === 'graceful shutdown') {
        requestDaemonShutdown(daemon.home, daemon.owner!.token, 'test-windows-git-shutdown', { shared: true })
        await until(() => daemon!.done, Boolean, 12_000, daemon.output)
        expect(daemon.child.exitCode, daemon.output).toBe(0)
      } else {
        await daemon.kill()
        // Closing the daemon's handles in the kernel starts asynchronous job termination.
        await vi.waitFor(() => expect(observed.filter(alive)).toEqual([]), { timeout: 5_000 })
      }
      expect(observed.filter(alive)).toEqual([])
    } finally {
      await daemon?.kill()
      killSurvivors(descendants)
    }
  }, 60_000)

  it('keeps the repository leased until the process tree of a crashed helper is dead', async () => {
    await gitProgramSettled()
    await stopGitSpawnWorkers()
    const tracked = captureHelpers()
    const tree = gitTree('helper-crash', false)
    const identity = resolveRepositoryIdentity(cwd)
    const hook = join(cwd, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\nexec node "' + tree.script.replace(/\\/g, '/') + '"\n')
    const owner = join(dir, 'mutation-owner')
    mkdirSync(owner)
    let pids: number[] = []
    const running = withGitMutationLocks(owner, cwd, 'test-helper-crash', () => {
      return runGitProcess(['commit', '--allow-empty', '--no-gpg-sign', '-m', 'should not commit'], { cwd, env: process.env })
    })
    try {
      pids = await tree.pids()
      expect(pids.every(alive)).toBe(true)
      await expect(acquireRepositoryLease(identity, { retryDelayMs: 10, maxWaitMs: 200 })).rejects.toBeInstanceOf(RepositoryLeaseBusyError)
      expect(tracked.helpers).toHaveLength(1)
      const handoff = acquireRepositoryLease(identity, { retryDelayMs: 5, maxWaitMs: 10_000 }).then((lease) => {
        try { return pids.filter(alive) } finally { lease.release() }
      })
      tracked.helpers[0]!.kill('SIGKILL')
      expect((await running).error?.code).toBe('EGITWORKER')
      expect(pids.filter(alive)).toEqual([])
      expect(await handoff).toEqual([])
      expect((await runGitProcess(['rev-parse', 'HEAD'], { cwd, env: process.env })).status).toBe(0)
    } finally {
      tracked.restore()
      killSurvivors(pids)
      rmSync(hook, { force: true })
      await running.catch(() => undefined)
    }
  }, 30_000)

  it.each(['abort', 'timeout', 'runGit abort'] as const)('waits after the Git root exits on %s', async (mode) => {
    const index = join(dir, 'private-' + mode)
    const lock = index + '.lock'
    const tree = gitTree('root-exited-' + mode, true, mode === 'runGit abort' ? undefined : lock)
    const controller = new AbortController()
    let root: number | undefined
    let rootExited = false
    const realSpawn = gitSpawn.spawnGit
    const observe = vi.spyOn(gitSpawn, 'spawnGit').mockImplementation((file, args, options) => {
      const child = realSpawn(file, args, options)
      if (args.includes('job-tree')) {
        child.once('spawn', () => { root = child.pid })
        child.once('exit', () => { rootExited = true })
      }
      return child
    })
    const running = mode === 'runGit abort'
      ? runGit(cwd, tree.args, { signal: controller.signal })
      : gitCancellationScope(controller.signal).run(() => runGitProcess(tree.args, {
        cwd, env: { ...process.env, GIT_INDEX_FILE: index }, ...(mode === 'timeout' ? { timeout: 4_000 } : {})
      }))
    let descendants: number[] = []
    try {
      descendants = await tree.pids()
      await vi.waitFor(() => expect(rootExited).toBe(true))
      expect(root).toBeDefined()
      expect(alive(root!)).toBe(false)
      const detached = descendants.at(-1)!
      expect(alive(detached)).toBe(true)
      if (mode !== 'timeout') controller.abort()
      const result = await running
      expect(result).toMatchObject(mode === 'runGit abort' ? { cancelled: true, exited: true } : { error: { code: mode === 'timeout' ? 'ETIMEDOUT' : 'ABORT_ERR' } })
      expect(alive(detached)).toBe(false)
      expect(existsSync(lock)).toBe(false)
    } finally {
      observe.mockRestore()
      killSurvivors(descendants)
      controller.abort()
      await running.catch(() => undefined)
    }
  }, 20_000)

  it('refuses a Git panel mutation when its identity helper dies with another owner holding the lease', async () => {
    await gitProgramSettled()
    await stopGitSpawnWorkers()
    const identity = resolveRepositoryIdentity(cwd)
    const held = await acquireRepositoryLease(identity)
    let crashed = false
    const tracked = captureHelpers((worker) => {
      const send = worker.send.bind(worker)
      worker.send = ((message: { args?: string[] }, ...rest: unknown[]) => {
        if (!crashed && message.args?.includes('--is-bare-repository') && message.args.includes('--is-inside-work-tree')) {
          crashed = true
          worker.kill('SIGKILL')
        }
        return (send as (...args: unknown[]) => boolean)(message, ...rest)
      }) as typeof worker.send
    })
    const filename = 'identity-lease.txt'
    writeFileSync(join(cwd, filename), 'leave this unstaged\n')
    const stage = () => new GitService().stage(cwd, userAction('button', 'Stage test file'), [filename])
    const staged = () => execFileSync('git', ['diff', '--cached', '--name-only'], { cwd, encoding: 'utf8' }).trim()
    try {
      await expect(stage()).rejects.toMatchObject({ code: 'EGITWORKER' })
      expect(crashed).toBe(true)
      expect(staged()).toBe('')
    } finally {
      tracked.restore()
      held.release()
    }
    try {
      await stage()
      expect(staged()).toBe(filename)
    } finally {
      execFileSync('git', ['reset', '-q', 'HEAD', '--', filename], { cwd })
      rmSync(join(cwd, filename), { force: true })
    }
  }, 30_000)
})
