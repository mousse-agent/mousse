import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getCliBuildOptions } from '../../scripts/build-cli.mjs'

/**
 * A daemon killed (SIGKILL, in a child process: `tests/support/runKillChild.ts`) while a thread's turn is cut off at
 * one point, with a message queued behind it, then started again on the same home. The cut-off turn ends
 * `interrupted` and the transcript says so; it never runs again and nothing reaches the provider twice; the queued
 * message runs once, after it; the thread is left idle.
 */
describe('restart recovery of a turn cut off by a killed daemon', () => {
  let bundle: string
  let root: string
  const homes: string[] = []

  beforeAll(async () => {
    const repo = resolve(__dirname, '..', '..')
    // Beside the checkout, so the child resolves its packages from node_modules.
    root = join(repo, 'out', 'test-builds', `restart-recovery-${process.pid}`)
    mkdirSync(root, { recursive: true })
    bundle = join(root, 'child.mjs')
    const options = getCliBuildOptions(repo)
    await build({ ...options, entryPoints: [join(repo, 'tests', 'support', 'runKillChild.ts')], outfile: bundle, sourcemap: false, logLevel: 'silent', plugins: [] })
  }, 180_000)

  afterAll(() => {
    for (const dir of [root, ...homes]) {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* the OS cleans up */ }
    }
  })

  const runChild = (args: string[]) => {
    const env: NodeJS.ProcessEnv = { ...process.env, MOUSSE_THREAD_DB_WORKER: 'inline' }
    for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key]
    return spawnSync(process.execPath, [bundle, ...args], { cwd: root, env, encoding: 'utf-8', timeout: 60_000 })
  }

  interface Result {
    timedOut: boolean
    transcript: string[]
    live: string[]
    runs: Array<{ clientRequestId: string | null; status: string; interruptedBy: string | null }>
    queue: number
    active: boolean
    nonTerminal: string[]
    restarted: string[]
    open: number
    note: Array<{ runIds: string[]; queuedRunIds?: string[] }>
  }

  const INTERRUPTED = 'system:Turn interrupted by a Mousse restart.'
  const SCENARIOS = ['starting', 'streaming', 'tool', 'steer', 'approval', 'question'] as const

  for (const scenario of SCENARIOS) {
    it(`killed while ${scenario}: the turn ends interrupted, never runs again, and the queued message runs once after it`, () => {
      // Outside any repository: the child's test project must never resolve to this checkout's git repository.
      const home = mkdtempSync(join(tmpdir(), `mousse-restart-${scenario}-`))
      homes.push(home)
      const killed = runChild(['first', home, scenario])
      expect(existsSync(join(home, 'error.txt')) ? readFileSync(join(home, 'error.txt'), 'utf-8') : '', killed.stderr).toBe('')
      expect(killed.status === 0).toBe(false)
      if (scenario !== 'starting') expect(existsSync(join(home, 'killed'))).toBe(true)

      const restarted = runChild(['restart', home])
      expect(existsSync(join(home, 'error.txt')) ? readFileSync(join(home, 'error.txt'), 'utf-8') : '', restarted.stderr).toBe('')
      expect(restarted.status).toBe(0)
      const result = JSON.parse(readFileSync(join(home, 'result.json'), 'utf-8')) as Result
      const prompts = readFileSync(join(home, 'prompts.log'), 'utf-8').trim().split('\n')
      expect(result.timedOut).toBe(false)

      // Nothing reaches the provider twice: the cut-off turn is not sent again, and the queued message runs once.
      expect(prompts).toEqual(scenario === 'starting' ? ['first:earlier', 'restart:next'] : ['first:earlier', 'first:cut', 'restart:next'])
      expect(result.restarted).toEqual([])
      // The cut-off run is interrupted by the restart, not left queued; the queued message's run completed.
      // A steered message's own run ended when it joined the turn; back in the queue, it runs as a new one.
      const queuedRun = scenario === 'steer' ? [['c-2', 'cancelled', 'user'], ['queue', 'completed', null]] : [['c-2', 'completed', null]]
      expect(result.runs.map(({ clientRequestId, status, interruptedBy }) => [clientRequestId?.startsWith('queue:') ? 'queue' : clientRequestId, status, interruptedBy]).sort()).toEqual([
        ['c-0', 'completed', null],
        ['c-1', 'interrupted', 'daemon_restart'],
        ...queuedRun
      ])
      expect(result.note).toEqual([expect.objectContaining({ runIds: [expect.any(String)] })])
      expect(result.note[0].queuedRunIds ?? []).toEqual([])
      // The transcript shows the message, that its turn was cut off by the restart, then the queued message and its reply.
      for (const transcript of [result.transcript, result.live]) {
        const at = transcript.indexOf('user:cut')
        expect(at).toBeGreaterThan(transcript.indexOf('assistant:reply to earlier'))
        expect(transcript.filter((row) => row === 'user:cut')).toHaveLength(1)
        expect(transcript.indexOf(INTERRUPTED)).toBeGreaterThan(at)
        expect(transcript.filter((row) => row === INTERRUPTED)).toHaveLength(1)
        expect(transcript.filter((row) => row === 'user:next')).toHaveLength(1)
        expect(transcript.indexOf('user:next')).toBeGreaterThan(transcript.indexOf(INTERRUPTED))
        expect(transcript.at(-1)).toBe('assistant:reply to next')
      }
      // No reply is left streaming and no tool row running.
      expect(result.open).toBe(0)
      // The thread is idle: nothing queued, active or left non-terminal.
      expect(result.queue).toBe(0)
      expect(result.active).toBe(false)
      expect(result.nonTerminal).toEqual([])
    }, 120_000)
  }
})
