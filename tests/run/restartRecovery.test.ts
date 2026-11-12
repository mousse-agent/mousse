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
  // `steer-held-device`: a steer with no queue item of its own (a device's limited steer) held for a running tool; it
  // is saved as a `steering` row bound to the run, so the restart returns it once (docs/design/steer-and-interruptions.md §2.8).
  const SCENARIOS = ['starting', 'accepted', 'streaming', 'tool', 'uncertain', 'steer', 'steer-taken', 'steer-held', 'steer-held-device', 'approval', 'question'] as const
  /** What the provider was sent in the first process: `cut` reached it unless the turn died before its start. */
  const sentFirst = (scenario: string): string[] => (scenario === 'starting' || scenario === 'accepted' ? ['first:earlier'] : ['first:earlier', 'first:cut'])

  for (const scenario of SCENARIOS) {
    const taken = scenario === 'steer-taken'
    it(`killed while ${scenario}: the turn ends ${scenario === 'uncertain' ? 'uncertain' : 'interrupted'}, never runs again, and ${taken ? 'the steer the provider took does not run again' : 'the queued message runs once after it'}`, () => {
      // Outside any repository: the child's test project must never resolve to this checkout's git repository.
      const home = mkdtempSync(join(tmpdir(), `mousse-restart-${scenario}-`))
      homes.push(home)
      // A home inside a repository would put the child's branches in it: refuse to run there (set TMP elsewhere).
      expect(spawnSync('git', ['-C', home, 'rev-parse', '--git-dir'], { encoding: 'utf-8' }).status, `${home} is inside a git repository`).not.toBe(0)
      const killed = runChild(['first', home, scenario])
      expect(existsSync(join(home, 'error.txt')) ? readFileSync(join(home, 'error.txt'), 'utf-8') : '', killed.stderr).toBe('')
      expect(killed.status === 0).toBe(false)
      if (!['starting', 'accepted', 'steer-taken'].includes(scenario)) expect(existsSync(join(home, 'killed'))).toBe(true)

      const restarted = runChild(['restart', home])
      expect(existsSync(join(home, 'error.txt')) ? readFileSync(join(home, 'error.txt'), 'utf-8') : '', restarted.stderr).toBe('')
      expect(restarted.status).toBe(0)
      const result = JSON.parse(readFileSync(join(home, 'result.json'), 'utf-8')) as Result
      const prompts = readFileSync(join(home, 'prompts.log'), 'utf-8').trim().split('\n')
      expect(result.timedOut).toBe(false)

      // Nothing reaches the provider twice: the cut-off turn is not sent again, and the queued message runs once
      // (a steer the provider took runs no more).
      expect(prompts).toEqual([...sentFirst(scenario), ...(taken ? [] : ['restart:next'])])
      expect(result.restarted).toEqual([])
      // The cut-off run ends by the restart, not left queued; the queued message's run completed.
      // A steered message's own run ended when it joined the turn; back in the queue, it runs as a new one.
      const cutOff = scenario === 'uncertain' ? ['c-1', 'uncertain', null] : ['c-1', 'interrupted', 'daemon_restart']
      const queuedRun = scenario === 'steer' || scenario === 'steer-held' ? [['c-2', 'cancelled', 'user'], ['queue', 'completed', null]]
        : scenario === 'steer-held-device' ? [['queue', 'completed', null]]
        : taken ? [['c-2', 'cancelled', 'user']] : [['c-2', 'completed', null]]
      // A steer held for a running tool was never drained before the kill (docs/design/steer-and-interruptions.md §2.8).
      if (scenario === 'steer-held' || scenario === 'steer-held-device') expect(existsSync(join(home, 'cuts.log'))).toBe(false)
      expect(result.runs.map(({ clientRequestId, status, interruptedBy }) => [clientRequestId?.startsWith('queue:') ? 'queue' : clientRequestId, status, interruptedBy]).sort()).toEqual([
        ['c-0', 'completed', null],
        cutOff,
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
        if (taken) {
          // The steer the model took stays where it entered the turn, and nothing runs after the cut.
          expect(transcript.indexOf('user:next')).toBeGreaterThan(at)
          expect(transcript.at(-1)).toBe(INTERRUPTED)
        } else {
          expect(transcript.indexOf('user:next')).toBeGreaterThan(transcript.indexOf(INTERRUPTED))
          expect(transcript.at(-1)).toBe('assistant:reply to next')
        }
      }
      // No reply is left streaming and no tool row running.
      expect(result.open).toBe(0)
      // The thread is idle: nothing queued, active or left non-terminal.
      expect(result.queue).toBe(0)
      expect(result.active).toBe(false)
      expect(result.nonTerminal).toEqual([])
    }, 120_000)
  }

  // Acceptance per token (docs/design/steer-and-interruptions.md §2.6): accepting `next` must not acknowledge `later`,
  // which was drained separately and is still unread when the daemon dies. Killed after the acceptance, and inside it
  // (its text and id saved, its queue row not yet dropped).
  for (const scenario of ['steer-two-drains', 'steer-two-drains-ack'] as const) {
    const insideAck = scenario === 'steer-two-drains-ack'
    it(`killed with two steers drained and only the first accepted${insideAck ? ', inside its acceptance' : ''}: the first stays read, the second runs once after the restart`, () => {
      const home = mkdtempSync(join(tmpdir(), `mousse-restart-${scenario}-`))
      homes.push(home)
      expect(spawnSync('git', ['-C', home, 'rev-parse', '--git-dir'], { encoding: 'utf-8' }).status, `${home} is inside a git repository`).not.toBe(0)
      const killed = runChild(['first', home, scenario])
      expect(existsSync(join(home, 'error.txt')) ? readFileSync(join(home, 'error.txt'), 'utf-8') : '', killed.stderr).toBe('')
      expect(killed.status === 0).toBe(false)
      if (insideAck) {
        // Only `next` was saved as accepted and was being acknowledged; both rows were still `steering` on disk.
        const atKill = JSON.parse(readFileSync(join(home, 'at-kill.json'), 'utf-8')) as { next: string; later: string; acknowledging: string[]; accepted: string[]; steering: string[] }
        expect(atKill.acknowledging).toEqual([atKill.next])
        expect(atKill.accepted).toEqual([atKill.next])
        expect([...atKill.steering].sort()).toEqual([atKill.next, atKill.later].sort())
      }

      const restarted = runChild(['restart', home])
      expect(existsSync(join(home, 'error.txt')) ? readFileSync(join(home, 'error.txt'), 'utf-8') : '', restarted.stderr).toBe('')
      expect(restarted.status).toBe(0)
      const result = JSON.parse(readFileSync(join(home, 'result.json'), 'utf-8')) as Result
      const prompts = readFileSync(join(home, 'prompts.log'), 'utf-8').trim().split('\n')
      expect(result.timedOut).toBe(false)

      // `next` was read and is not sent again; `later` was not, and runs once, as its own turn.
      expect(prompts).toEqual(['first:earlier', 'first:cut', 'restart:later'])
      for (const transcript of [result.transcript, result.live]) {
        const at = transcript.indexOf('user:cut')
        expect(transcript.filter((row) => row === 'user:next')).toHaveLength(1)
        expect(transcript.indexOf('user:next')).toBeGreaterThan(at)
        expect(transcript.filter((row) => row === INTERRUPTED)).toHaveLength(1)
        expect(transcript.filter((row) => row === 'user:later')).toHaveLength(1)
        expect(transcript.indexOf('user:later')).toBeGreaterThan(transcript.indexOf(INTERRUPTED))
        expect(transcript.at(-1)).toBe('assistant:reply to later')
      }
      expect(result.open).toBe(0)
      expect(result.queue).toBe(0)
      expect(result.active).toBe(false)
      expect(result.nonTerminal).toEqual([])
    }, 120_000)
  }
})
