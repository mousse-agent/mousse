/**
 * Owner check `phase1a.once-or-unknown`: a call whose reply is dropped after the owner did the work, with the
 * caller's helper killed at that moment and a new one started. The work happens once, or the window is told the
 * outcome is unknown; it never happens twice.
 *
 * - Terminal input (numbered, not in the ledger): the caller sends the same number again; the owner applies it once.
 * - A durable call (`orchestrator.send`): the caller asks for the result of the same request id before anything else.
 * - A durable call still running when the link goes: asked again, the owner holds the answer until it finishes.
 *
 * Its control (`MOUSSE_NET_ENGINE_CONTROL=no-host-dedupe`) applies a repeated input number again and fails it with
 * `duplicate_effect`. `scripts/net-engine-check.mjs phase1a.once-or-unknown` runs it and prints the marker.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PROJECT_SHELL_AGENT_ID } from '../../../src/shared/types'
import type { Crossed } from '../fakeHelper'
import { codeOf, eventually, pairProfiles, step, type Pair } from './harness'

describe('phase1a.once-or-unknown', () => {
  let pair: Pair
  let threadId: string
  beforeAll(async () => {
    pair = await pairProfiles()
    await pair.ownerLocal('bridge.policy', { node: pair.callerOnOwner, terminal: true })
    const node = pair.ownerOnCaller
    const project = await pair.dispatch('projects.open', { node, path: pair.folder() })
    const created = await pair.dispatch('threads.create', { node, name: 'Once', projectId: (project.project ?? project).id })
    threadId = (created.thread ?? created).id
  }, 120_000)
  afterAll(() => pair?.close())

  /**
   * Drops the owner's answer to the next `method` call and kills the caller's helper as it does. Resolves once
   * both happened.
   */
  function dropNextAnswer(method: string): Promise<void> {
    return new Promise<void>((resolve) => {
      pair.fabric.network.tap = (row: Crossed) => {
        if (row.from !== pair.ownerComputer.endpoint || row.method !== method || row.header.t !== 'result') return
        pair.fabric.network.tap = undefined
        pair.callerComputer.helper.kill()
        resolve()
        return 'drop'
      }
    })
  }

  /** A new helper for the caller, connected again. */
  async function helperBack(): Promise<void> {
    await pair.fabric.restartHelper(pair.callerComputer)
    await pair.fabric.connect(pair.callerComputer, pair.ownerOnCaller)
  }

  /** The window's answer: what it got, or that the outcome is unknown (also a pass). */
  async function answered(call: Promise<unknown>): Promise<'done' | 'unknown'> {
    try {
      await call
      return 'done'
    } catch (error) {
      if (codeOf(error) === 'outcome_uncertain') return 'unknown'
      throw error
    }
  }

  const count = (text: string, part: string) => text.split(part).length - 1

  it('applies terminal input once when its reply is lost with the helper', async () => {
    const before = pair.shells.length
    const created = await step(undefined, () =>
      pair.dispatch('pty.create', { threadId, agentId: `${PROJECT_SHELL_AGENT_ID}:tab-once` })
    )
    const shell = pair.shells[before]!
    await step(undefined, () => pair.dispatch('pty.write', { threadId, ptyId: created.ptyId, data: 'first-input\r' }))
    const dropped = dropNextAnswer('routed.pty.write')
    const call = pair.dispatch('pty.write', { threadId, ptyId: created.ptyId, data: 'second-input\r' })
    await dropped
    await helperBack()
    await step(undefined, () => answered(call))
    await step('duplicate_effect', async () => {
      // A repeated number applied again shows up here; give it the time a resend takes.
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(count(shell.pty.written.join(''), 'second-input')).toBe(1)
    })
    expect(count(shell.pty.written.join(''), 'first-input')).toBe(1)
  }, 90_000)

  it('runs a durable call once when its reply is lost with the helper', async () => {
    const send = vi.spyOn(pair.owner.orchestrator, 'send').mockResolvedValue({ accepted: true } as never)
    try {
      const dropped = dropNextAnswer('routed.orchestrator.send')
      const call = pair.dispatch('orchestrator.send', { threadId, content: 'once please', requestId: 'once-1' })
      await dropped
      const from = pair.fabric.network.crossed.length
      await helperBack()
      const outcome = await step(undefined, () => answered(call))
      // Its result was asked for by the same request id, before any repeat of the call.
      const asked = pair.fabric.network.crossed
        .slice(from)
        .filter((row) => row.from === pair.callerComputer.endpoint && row.label === 'mousse.rpc')
        .map((row) => (row.header.t === 'call' ? `call ${String(row.header.method)}` : String(row.header.t)))
        .filter((line) => line === 'result.get' || line === 'call routed.orchestrator.send')
      expect(asked[0]).toBe('result.get')
      // Done means it ran exactly once; unknown means at most once.
      await step('duplicate_effect', () => expect(send.mock.calls.length).toBeLessThanOrEqual(1))
      if (outcome === 'done') expect(send).toHaveBeenCalledTimes(1)
    } finally {
      send.mockRestore()
    }
  }, 90_000)

  it('waits for a durable call still running when the link went, and runs it once', async () => {
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      vi.spyOn(pair.owner.orchestrator, 'send').mockImplementation((() => {
        resolve()
        return new Promise((done) => (release = () => done({ accepted: true })))
      }) as never)
    })
    const send = vi.mocked(pair.owner.orchestrator.send)
    try {
      const call = pair.dispatch('orchestrator.send', { threadId, content: 'slow one', requestId: 'once-2' })
      await started
      pair.callerComputer.helper.kill()
      await helperBack()
      // The caller asks for the result again (result.get) while the owner's handler still runs.
      await eventually(() =>
        expect(
          pair.fabric.network.crossed.some(
            (row) => row.from === pair.callerComputer.endpoint && row.header.t === 'result.get'
          )
        ).toBe(true)
      )
      release()
      expect(await step(undefined, () => answered(call))).toBe('done')
      await step('duplicate_effect', () => expect(send).toHaveBeenCalledTimes(1))
    } finally {
      send.mockRestore()
    }
  }, 90_000)
})
