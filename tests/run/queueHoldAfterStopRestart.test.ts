/**
 * Issue #917: after a Stop, what waits in the thread's queue waits for the person (Send now), and a restart keeps it
 * waiting. Startup recovery drains only a queue no Stop held, as the running app drains one after a turn that ends
 * on its own. A real orchestrator, run engine and effect worker over a scripted provider, restarted on the same home.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TurnInput } from '../../src/mms/harness/adapter'
import { PI, phase6Daemon, piAdapter, waitFor, type Phase6Daemon, type ScriptedAdapter } from './phase6Fixture'

vi.setConfig({ testTimeout: 60_000 })

/**
 * Replies at once, except to `holds`, whose turn runs until it is stopped or `releases` ends it. With `slowStop` a
 * stopped turn still ends only when `releases` ends it, as a provider that is slow to let go.
 */
const script = (holds: ReadonlySet<string>, releases = new Map<string, () => void>(), slowStop = false) => (input: TurnInput): Promise<string> | string =>
  holds.has(input.prompt)
    ? new Promise<string>((resolve) => {
      releases.set(input.prompt, () => resolve(`reply to ${input.prompt}`))
      if (slowStop) return
      if (input.signal.aborted) resolve('')
      else input.signal.addEventListener('abort', () => resolve(''), { once: true })
    })
    : `reply to ${input.prompt}`

describe('a queue held after a Stop stays held across a restart (#917)', () => {
  let home: string | undefined
  let previousHome: string | undefined
  const daemons: Phase6Daemon[] = []

  afterEach(async () => {
    for (const daemon of daemons.splice(0).reverse()) await daemon.stop().catch(() => undefined)
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  const setup = (holds: string[] = ['first'], opts?: { slowStop?: boolean }) => {
    home = mkdtempSync(join(tmpdir(), 'mousse-hold-stop-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const releases = new Map<string, () => void>()
    const adapter = piAdapter(script(new Set(holds), releases, opts?.slowStop))
    const d = phase6Daemon(home, [adapter], { pid: 1 })
    daemons.push(d)
    const thread = d.store.createThread('Held')
    d.orch.setThreadModelOverride(thread.id, PI)
    let sends = 0
    const send = (text: string) => d.orch.send(text, false, { threadId: thread.id, clientRequestId: `send-${++sends}` })
    const release = (prompt: string) => releases.get(prompt)?.()
    return { dir: home, adapter, d, thread, send, release }
  }

  const prompts = (adapter: ScriptedAdapter) => adapter.turns.map((turn) => turn.prompt)
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300))

  /** Starts the daemon again on the same home and runs startup recovery, both ways the profile can. */
  const restart = async (dir: string, crashed: Phase6Daemon) => {
    await crashed.crash()
    daemons.splice(daemons.indexOf(crashed), 1)
    const adapter = piAdapter(script(new Set()))
    const d = phase6Daemon(dir, [adapter], { pid: 2, orchestratorBoot: true })
    daemons.push(d)
    d.orch.scheduleStartupQueueRecovery()
    d.orch.recoverAndDrainPendingQueues()
    await settle()
    return { d, adapter }
  }

  const idle = (d: Phase6Daemon, threadId: string, label: string) =>
    waitFor(() => !d.orch.isActiveTurnRunning(threadId) && d.store.loadMessageQueue(threadId).length === 0 && d.engine.getActiveRun(threadId) === null, label)

  /** A running first turn with A and B queued behind it. */
  const queuedBehindTurn = async (w: ReturnType<typeof setup>) => {
    const first = w.send('first')
    await waitFor(() => prompts(w.adapter).includes('first'), 'the first turn')
    const a = await w.send('A')
    const b = await w.send('B')
    expect([a.queued, b.queued]).toEqual([true, true])
    return { first, a: a.queueItem!, b: b.queueItem! }
  }

  const stop = async (w: ReturnType<typeof setup>, first: Promise<unknown>) => {
    await w.d.orch.stopThread(w.thread.id, 'user')
    await first.catch(() => undefined)
    await waitFor(() => !w.d.orch.isActiveTurnRunning(w.thread.id), 'the stopped turn to end')
    await settle()
  }

  it('messages left queued after a Stop do not run after a restart; Send now runs them once, in order', async () => {
    const w = setup()
    const { first, a } = await queuedBehindTurn(w)
    await stop(w, first)
    // The running app holds them.
    expect(prompts(w.adapter)).toEqual(['first'])

    const { d, adapter } = await restart(w.dir, w.d)
    // So does the restarted one: the hold was saved on the items.
    expect(prompts(adapter)).toEqual([])
    expect(d.store.loadMessageQueue(w.thread.id).map((item) => [item.content, item.heldAfterStop])).toEqual([['A', true], ['B', true]])

    expect(d.orch.promoteQueueItem(w.thread.id, a.id)).toEqual({ ok: true })
    await idle(d, w.thread.id, 'the queue to drain')
    await settle()
    expect(prompts(adapter)).toEqual(['A', 'B'])
  })

  it('a message sent now that the Stop handed back stays queued across a restart, and runs once when sent', async () => {
    const w = setup()
    const { first, b } = await queuedBehindTurn(w)
    // Send now on B while the turn runs: the turn never reads it, and the Stop hands it back first in the queue.
    expect(w.d.orch.promoteQueueItem(w.thread.id, b.id)).toEqual({ ok: true })
    await stop(w, first)
    expect(prompts(w.adapter)).toEqual(['first'])
    expect(w.d.orch.listQueue(w.thread.id).map((item) => [item.content, item.state])).toEqual([['B', 'pending'], ['A', 'pending']])

    const { d, adapter } = await restart(w.dir, w.d)
    expect(prompts(adapter)).toEqual([])
    expect(d.orch.promoteQueueItem(w.thread.id, b.id)).toEqual({ ok: true })
    await idle(d, w.thread.id, 'the queue to drain')
    await settle()
    expect(prompts(adapter)).toEqual(['B', 'A'])
  })

  it('Send now while the stopped turn still ends lets the queue go on, and saves that for a restart in that window', async () => {
    const w = setup(['first'], { slowStop: true })
    const { first, b } = await queuedBehindTurn(w)
    await w.d.orch.stopThread(w.thread.id, 'user')
    // The provider has not let go: the stopped turn is still ending when the person sends B now.
    expect(w.d.orch.isActiveTurnRunning(w.thread.id)).toBe(true)
    expect(w.d.orch.promoteQueueItem(w.thread.id, b.id)).toEqual({ ok: true })
    // The saved queue, which startup recovery reads, holds nothing for the person any more.
    expect(w.d.store.loadMessageQueue(w.thread.id).map((item) => [item.content, item.heldAfterStop])).toEqual([['B', undefined], ['A', undefined]])

    w.release('first')
    await first.catch(() => undefined)
    await idle(w.d, w.thread.id, 'the queue to drain')
    expect(prompts(w.adapter)).toEqual(['first', 'B', 'A'])
  })

  it('a new message after the Stop lets the queue go on, as in the running app, and a restart keeps that', async () => {
    const w = setup(['first', 'D'])
    const { first } = await queuedBehindTurn(w)
    await stop(w, first)
    // The person writes again; the restart comes while that turn runs.
    void w.send('D').catch(() => undefined)
    await waitFor(() => prompts(w.adapter).includes('D'), 'the new turn')
    await waitFor(() => w.d.store.loadMessageQueue(w.thread.id).every((item) => !item.heldAfterStop), 'the hold to lift')

    const { d, adapter } = await restart(w.dir, w.d)
    await idle(d, w.thread.id, 'the queue to drain')
    expect(prompts(adapter)).toEqual(['A', 'B'])
  })

  it('a workflow command after the Stop lets the queue go on, as any turn does', async () => {
    const w = setup()
    const { first } = await queuedBehindTurn(w)
    await stop(w, first)
    const workflowRun = {
      invocationId: 'invocation-1', profileId: 'profile', threadId: w.thread.id, definitionId: 'definition',
      revisionId: 'revision', runId: 'workflow-run-1', title: 'Fixture', state: 'running' as const
    }
    // While the workflow's turn runs, the saved queue (what a restart in that window reads) holds nothing any more.
    let heldDuringTurn: Array<true | undefined> | undefined
    w.d.orch.setWorkflowChatExecutor({
      prepare: async () => { throw new Error('not used') },
      execute: async () => {
        heldDuringTurn = w.d.store.loadMessageQueue(w.thread.id).map((item) => item.heldAfterStop)
        return workflowRun
      },
      observe: async () => { throw new Error('not used') },
      abandon: () => undefined
    })
    await w.d.orch.send({ content: '/fixture', workflowInvocationId: workflowRun.invocationId }, false, { threadId: w.thread.id, clientRequestId: 'workflow' })
    expect(heldDuringTurn).toEqual([undefined, undefined])
    await idle(w.d, w.thread.id, 'the queue to drain')
    expect(prompts(w.adapter)).toEqual(['first', 'A', 'B'])
  })

  it('in the running app, a turn that ends on its own runs what was queued behind it', async () => {
    const w = setup()
    const { first } = await queuedBehindTurn(w)
    w.release('first')
    await first
    await idle(w.d, w.thread.id, 'the queue to drain')
    expect(prompts(w.adapter)).toEqual(['first', 'A', 'B'])
  })

  it('so after a restart that cut the turn off, with no Stop, what was queued behind it runs, once, in order', async () => {
    const w = setup()
    await queuedBehindTurn(w)
    expect(w.d.store.loadMessageQueue(w.thread.id).some((item) => item.heldAfterStop)).toBe(false)
    const { d, adapter } = await restart(w.dir, w.d)
    await idle(d, w.thread.id, 'the queue to drain')
    await settle()
    expect(prompts(adapter)).toEqual(['A', 'B'])
  })
})
