/**
 * Owner check `phase1a.path-switch`: a multi-minute call and a terminal survive a path switch with no gap in
 * output. Both helpers run on a manual clock moved to the moment the caller's path is due for renewal; the
 * helper opens a renewed path (`path.reopen`), the app moves its subscriptions there and new calls with them,
 * keeps the old path for the call still running on it (here only `MOUSSE_NET_ENGINE_PATH_DRAIN_MS`, so the call is
 * cut off), then says `path.reopened` and the old path closes with `PATH_REPLACED`. The cut-off call is collected
 * on the new path; the terminal reads on without a reset.
 *
 * It needs the real helper (`MOUSSE_NET_HELPER`, a debug build: the manual clock is debug-only); without it, a
 * check run fails with `no_helper` and a plain test run skips it. Its control
 * (`MOUSSE_NET_ENGINE_CONTROL=abort-on-path-replaced`) aborts the handlers still running on the old path when it
 * closes, and fails it with `false_outcome`. `scripts/net-engine-check.mjs phase1a.path-switch` runs it and prints
 * the marker.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PROJECT_SHELL_AGENT_ID } from '../../../src/shared/types'
import type { EngineHelper } from '../../../src/mms/netEngine/helper/connections'
import {
  codeOf,
  eventually,
  pairProfiles,
  REAL_HELPER,
  step,
  terminalOutput,
  type Pair
} from './harness'

process.env.MOUSSE_HELPER_MANUAL_CLOCK = '1'
// The old path is kept this long for the call still running on it: shorter than the call, so the call is cut off
// and asked for again on the new path.
process.env.MOUSSE_NET_ENGINE_PATH_DRAIN_MS ??= '3000'
/** How long the owner's push runs. */
const CALL_MS = Number(process.env.MOUSSE_NET_ENGINE_CHECK_CALL_MS || 150_000)
const SKEW_SECS = Number(process.env.MOUSSE_NET_CLOCK_SKEW_SECS || 600)
const LEAD_SECS = Number(process.env.MOUSSE_NET_RENEW_LEAD_SECS || 1_800)

/** The helper's `conn.up` of each connection it holds up. */
const upsOf = (engine: EngineHelper) =>
  (engine as unknown as { ups: Map<number, Record<string, unknown>> }).ups

describe.runIf(REAL_HELPER)('phase1a.path-switch', () => {
  let pair: Pair
  let threadId: string, projectId: string, ptyId: string
  const callerEvents: Array<Record<string, unknown>> = []
  beforeAll(async () => {
    pair = await pairProfiles()
    pair.callerComputer.engine.onEvent((event) => callerEvents.push(event))
    await pair.ownerLocal('bridge.policy', { node: pair.callerOnOwner, terminal: true })
    const node = pair.ownerOnCaller
    const project = await pair.dispatch('projects.open', { node, path: pair.folder() })
    projectId = (project.project ?? project).id
    const created = await pair.dispatch('threads.create', { node, name: 'Switch', projectId })
    threadId = (created.thread ?? created).id
    await pair.dispatch('thread.snapshot', { threadId })
  }, 120_000)
  afterAll(() => pair?.close(), 120_000)

  const attached = () =>
    pair.caller.bridge.router.terminals
      .state()
      .some((term) => term.ptyId === ptyId && term.attached)

  it(
    'keeps a multi-minute call and a terminal through a path switch, with no gap in output',
    async () => {
      const before = pair.shells.length
      const created = await step(undefined, () =>
        pair.dispatch('pty.create', { threadId, agentId: `${PROJECT_SHELL_AGENT_ID}:tab-switch` })
      )
      ptyId = created.ptyId
      const shell = pair.shells[before]!
      await step(undefined, () => eventually(() => expect(attached()).toBe(true), 20_000))

      // The terminal prints a numbered line every 50 ms through the switch; the window must see each once, in order.
      let line = 0
      const printer = setInterval(() => shell.pty.say(`line ${++line}\r\n`), 50)
      // A reset of the terminal's stream (detached, or read again from a snapshot) is a gap, even if filled later.
      let detached = 0
      const watch = setInterval(() => {
        if (!attached()) detached += 1
      }, 20)

      // The owner's push runs for minutes, and counts how often it ran.
      let runs = 0
      const push = vi.spyOn(pair.owner.gitService, 'push').mockImplementation((async () => {
        runs += 1
        await new Promise((resolve) => setTimeout(resolve, CALL_MS))
      }) as never)
      try {
        const node = pair.ownerOnCaller
        const client = () =>
          pair.caller.netEngine.client(node) as unknown as { connection: { id: string } }
        const oldConn = Number(client().connection.id)
        const call = pair.dispatch('git.push', { projectId }).then(
          () => 'done',
          (error: unknown) => `failed ${codeOf(error) ?? String(error)}`
        )
        await step(undefined, () => eventually(() => expect(runs).toBe(1), 30_000))

        // Both clocks go to the moment the caller's path is due for renewal.
        const up = upsOf(pair.callerComputer.engine).get(oldConn)
        expect(up?.dir).toBe('out')
        const deadline = Number(up!.deadline)
        const now = Number((await pair.callerComputer.engine.request('test.clock', {})).now)
        const advance = deadline - SKEW_SECS - LEAD_SECS - now
        for (const computer of [pair.callerComputer, pair.ownerComputer])
          await computer.engine.request('test.clock', { advance_secs: advance })

        // The renewed path is in use, and the old one closed as replaced once the app said so.
        await step('not_switched', () =>
          eventually(() => {
            const reopen = callerEvents.find(
              (event) => event.ev === 'path.reopen' && event.from === oldConn
            )
            expect(reopen).toBeDefined()
            expect(Number(client().connection.id)).toBe(Number(reopen!.conn))
            expect(
              callerEvents.some(
                (event) =>
                  event.ev === 'conn.down' &&
                  event.conn === oldConn &&
                  event.reason === 'path_replaced'
              )
            ).toBe(true)
          }, 60_000)
        )

        // The call cut off with the old path is collected on the new one: it ran once and its result is the real one.
        const outcome = await step(undefined, () => call)
        await step('false_outcome', () => {
          expect(outcome).toBe('done')
          expect(runs).toBe(1)
        })
      } finally {
        push.mockRestore()
        clearInterval(printer)
        clearInterval(watch)
      }

      const last = line
      await step('gap', () =>
        eventually(() => {
          const shown = terminalOutput(pair.events, ptyId)
            .split('\r\n')
            .filter((text) => text.startsWith('line '))
          expect(shown).toEqual(Array.from({ length: last }, (_, index) => `line ${index + 1}`))
        }, 30_000)
      )
      await step('gap', () => expect(detached).toBe(0))
      // Calls go on over the new path.
      await step('not_switched', () =>
        pair.dispatch('pty.write', { threadId, ptyId, data: 'after\r' })
      )
      expect(shell.pty.written.join('')).toContain('after')
    },
    CALL_MS + 240_000
  )
})

describe.runIf(!REAL_HELPER && !!process.env.MOUSSE_NET_ENGINE_CHECK_OUT)(
  'phase1a.path-switch',
  () => {
    it('needs the real helper', async () => {
      await step('no_helper', () => {
        throw new Error(
          'phase1a.path-switch runs only with MOUSSE_NET_HELPER (a debug helper build)'
        )
      })
    })
  }
)
