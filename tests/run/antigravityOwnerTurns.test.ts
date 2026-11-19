/**
 * Antigravity's personal sign-in through a real `OrchestratorService`, Run Engine and effect worker:
 * the owner's proof is recorded on the run when the send arrives, kept across a restart, and read
 * by the gateway on every attempt. Sends without it, agents' messages, automatic continues and a
 * Resume now nobody pressed from a window start no turn.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usageLimitError } from '../../src/mms/orchestrator/providerErrors'
import type { RunRecord } from '../../src/mms/run/types'
import { PI_TEST_CAPABILITIES } from '../support/piStub'
import { ScriptedAdapter, phase6Daemon, piAdapter, waitFor, type Phase6Daemon } from './phase6Fixture'

vi.setConfig({ testTimeout: 30_000 })

const AGY = { llmProvider: 'antigravity', model: 'gemini-test' }
const GUI = { via: 'gui' as const }

describe('Antigravity runs only turns its owner drives', () => {
  let previousHome: string | undefined
  const homes: string[] = []
  const daemons: Phase6Daemon[] = []

  afterEach(async () => {
    for (const daemon of daemons.splice(0).reverse()) await daemon.stop().catch(() => undefined)
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  const newHome = (): string => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-owner-turns-'))
    previousHome ??= process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    homes.push(home)
    return home
  }

  const boot = (home: string, adapters: ScriptedAdapter[], pid = 1, resumeAfterUsageLimit = false): Phase6Daemon => {
    const daemon = phase6Daemon(home, adapters, { pid, runs: { resumeAfterUsageLimit } })
    daemons.push(daemon)
    return daemon
  }

  const agy = () => new ScriptedAdapter('antigravity', PI_TEST_CAPABILITIES, (input) => `reply: ${input.prompt}`)
  const runsOf = (d: Phase6Daemon, threadId: string): RunRecord[] => [...d.engine.listRuns(threadId)].sort((a, b) => a.ordinal - b.ordinal)
  const settled = (d: Phase6Daemon, threadId: string) => runsOf(d, threadId).every((run) => ['completed', 'failed', 'cancelled', 'interrupted', 'uncertain'].includes(run.status))
  const thread = (d: Phase6Daemon) => {
    const created = d.store.createThread('Owner only')
    d.orch.setThreadModelOverride(created.id, AGY)
    return created
  }
  const REFUSED = /^\[not_eligible\] .*runs only messages you send yourself from a Mousse window/

  it('runs the owner’s message, keeps its proof across a restart, and refuses a send labelled as a window without one', async () => {
    const home = newHome()
    const adapter = agy()
    const first = boot(home, [adapter])
    const chat = thread(first)
    const owner = await first.orch.send('From the window', false, { threadId: chat.id, clientRequestId: 'owner', source: 'gui', ownerProof: GUI })
    expect(first.engine.getRun(owner.runId!)).toMatchObject({ status: 'completed', ownerProof: GUI })
    const plain = await first.orch.send('Labelled as a window, without proof', false, { threadId: chat.id, clientRequestId: 'plain', source: 'gui' })
    await waitFor(() => settled(first, chat.id), 'the refused run to settle')
    const refused = first.engine.getRun(plain.runId!)!
    expect(refused.status).toBe('failed')
    expect(refused.ownerProof).toBeUndefined()
    expect(refused.outcome?.error).toMatch(REFUSED)
    expect(adapter.turns.map((turn) => turn.prompt)).toEqual(['From the window'])

    await first.crash()
    const second = boot(home, [adapter], 2)
    expect(second.engine.getRun(owner.runId!)!.ownerProof).toEqual(GUI)
  })

  it('a message the owner queued behind a running turn keeps its proof and runs', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const adapter = new ScriptedAdapter('antigravity', PI_TEST_CAPABILITIES, async (input) => {
      if (input.prompt === 'First') await gate
      return `reply: ${input.prompt}`
    })
    const d = boot(newHome(), [adapter])
    const chat = thread(d)
    const first = d.orch.send('First', false, { threadId: chat.id, clientRequestId: 'q1', source: 'gui', ownerProof: GUI })
    await waitFor(() => adapter.turns.length === 1, 'the first turn to start')
    const second = d.orch.send('Queued', false, { threadId: chat.id, clientRequestId: 'q2', source: 'gui', ownerProof: GUI })
    await waitFor(() => runsOf(d, chat.id).length === 2, 'the queued run')
    release()
    await Promise.all([first, second])
    await waitFor(() => settled(d, chat.id), 'both runs to finish')
    expect(runsOf(d, chat.id).map((run) => [run.status, run.ownerProof])).toEqual([['completed', GUI], ['completed', GUI]])
    expect(adapter.turns.map((turn) => turn.prompt)).toEqual(['First', 'Queued'])
  })

  it('an agent’s message during the owner’s turn is not read into it, and does not run on its own', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const drained: Array<string | undefined> = []
    class Steered extends ScriptedAdapter {
      override async startTurn(...args: Parameters<ScriptedAdapter['startTurn']>) {
        const [input, , control] = args
        if (input.prompt === 'First') {
          await gate
          drained.push(control.drainSteer())
        }
        return super.startTurn(...args)
      }
    }
    const adapter = new Steered('antigravity', PI_TEST_CAPABILITIES, (input) => `reply: ${input.prompt}`)
    const d = boot(newHome(), [adapter])
    const chat = thread(d)
    const first = d.orch.send('First', false, { threadId: chat.id, clientRequestId: 's1', source: 'gui', ownerProof: GUI })
    await waitFor(() => runsOf(d, chat.id).length === 1 && runsOf(d, chat.id)[0]!.status === 'running', 'the owner’s turn to start')
    expect(d.orch.steerThread(chat.id, 'From an agent', undefined, undefined, { kind: 'agent', threadId: 'other', runId: 'run:other:1' }, 'ask')).toBe(true)
    release()
    await first
    await waitFor(() => settled(d, chat.id) && runsOf(d, chat.id).length === 2, 'the agent’s message to settle')
    expect(drained).toEqual([undefined])
    expect(adapter.turns.map((turn) => turn.prompt)).toEqual(['First'])
    expect(runsOf(d, chat.id)[1]).toMatchObject({ status: 'failed' })
    expect(runsOf(d, chat.id)[1]!.ownerProof).toBeUndefined()
  })

  it('never takes a proof for an agent’s message', async () => {
    const adapter = agy()
    const d = boot(newHome(), [adapter])
    const chat = thread(d)
    await (d.orch as any).sendToThreadAsAgent(chat.id, { content: 'From an agent', mode: 'agent' }, {
      clientRequestId: 'agent', ownerProof: GUI, actor: { kind: 'agent', threadId: 'other', runId: 'run:other:1', toolCallId: 'call-1' }
    })
    await waitFor(() => runsOf(d, chat.id).length === 1 && settled(d, chat.id), 'the agent’s run to settle')
    const [run] = runsOf(d, chat.id)
    expect(run!.ownerProof).toBeUndefined()
    expect(run!.status).toBe('failed')
    expect(adapter.turns).toEqual([])
  })

  describe('a paused turn', () => {
    const pausedChat = async (d: Phase6Daemon, adapter: ScriptedAdapter) => {
      const chat = thread(d)
      adapter.failNext = usageLimitError({ provider: 'antigravity', resetsAt: new Date(Date.now() + 60_000).toISOString(), estimated: false, limitKind: 'five_hour' })
      const sent = await d.orch.send('Do the work', false, { threadId: chat.id, clientRequestId: 'first', source: 'gui', ownerProof: GUI })
      expect(d.engine.getRun(sent.runId!)!.status).toBe('paused')
      return { chat, runId: sent.runId! }
    }

    it('continues when the owner presses Resume now in a window', async () => {
      const adapter = agy()
      const d = boot(newHome(), [adapter])
      const { chat, runId } = await pausedChat(d, adapter)
      await d.orch.resumePausedRun(runId, GUI)
      await waitFor(() => runsOf(d, chat.id).length === 2 && settled(d, chat.id), 'the continuation to finish')
      expect(runsOf(d, chat.id)[1]).toMatchObject({ source: 'resume_now', status: 'completed', ownerProof: GUI, outcome: { continuationOf: runId } })
      expect(adapter.turns).toHaveLength(2)
    })

    it('does not continue on a Resume now from anything but a window', async () => {
      const adapter = agy()
      const d = boot(newHome(), [adapter])
      const { chat, runId } = await pausedChat(d, adapter)
      await d.orch.resumePausedRun(runId)
      await waitFor(() => runsOf(d, chat.id).length === 2 && settled(d, chat.id), 'the continuation to settle')
      const continuation = runsOf(d, chat.id)[1]!
      expect(continuation.ownerProof).toBeUndefined()
      expect(continuation.outcome?.error).toMatch(REFUSED)
      expect(adapter.turns).toHaveLength(1)
    })
  })

  it('leaves other providers as they were: a send without a proof runs', async () => {
    const pi = piAdapter((input) => `reply: ${input.prompt}`)
    const d = boot(newHome(), [pi])
    const chat = d.store.createThread('Pi')
    d.orch.setThreadModelOverride(chat.id, { llmProvider: 'openai', model: 'gpt-replay' })
    const sent = await d.orch.send('Hello', false, { threadId: chat.id, clientRequestId: 'pi' })
    expect(d.engine.getRun(sent.runId!)).toMatchObject({ status: 'completed' })
    expect(pi.turns).toHaveLength(1)
  })
})
