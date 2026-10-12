/**
 * SPEC §16.4 continue after restart: `orchestrator.send` with `continuationOfRunId` records the
 * continued run, opens the turn with a system line, replays on a repeated `continue:<runId>`
 * request, and needs `acknowledgeUncertain` for an `uncertain` run.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Reconciler } from '../../src/mms/run/Reconciler'
import { PI, phase6Daemon, piAdapter, waitFor, type Phase6Daemon } from './phase6Fixture'

describe('continue after restart (SPEC §16.4)', () => {
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

  const setupHome = () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-continue-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    return home
  }

  it('continues an interrupted run once; a double click replays the same run', async () => {
    const dir = setupHome()
    const pi = piAdapter((input) => `continuing: ${input.prompt}`)
    const first = phase6Daemon(dir, [pi], { pid: 1 })
    const thread = first.store.createThread('Restart')
    first.orch.setThreadModelOverride(thread.id, PI)
    // A turn is running when the daemon dies.
    const sent = await first.engine.dispatch({ kind: 'send', threadId: thread.id, clientRequestId: 'before-crash', source: 'gui' })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    first.engine.markStarting(sent.runId)
    first.engine.markRunning(sent.runId)
    await first.crash()

    const second = phase6Daemon(dir, [pi], { pid: 2 })
    daemons.push(second)
    expect(second.boot.interrupted).toEqual([sent.runId])
    const send = () => second.orch.send('Continue where you left off.', false, {
      threadId: thread.id,
      clientRequestId: `continue:${sent.runId}`,
      continuationOfRunId: sent.runId
    })
    const response = await send()
    expect(response.message).toBe('continuing: Continue where you left off.')
    const continued = second.engine.getRun(response.runId!)!
    expect(continued).toMatchObject({ ordinal: 2, status: 'completed', clientRequestId: `continue:${sent.runId}`, outcome: { continuationOf: sent.runId } })
    expect(second.orch.getMessages(thread.id).some((message) => message.role === 'system' && message.content === 'Continuing run 1 after a restart.')).toBe(true)

    const replay = await send()
    expect(replay).toMatchObject({ runId: continued.runId, replayed: true })
    expect(second.engine.listRuns(thread.id)).toHaveLength(2)
    expect(pi.turns).toHaveLength(1)
  })

  it('an uncertain run needs acknowledgeUncertain in the same send; the refusal is not stored', async () => {
    const pi = piAdapter((input) => `ok: ${input.prompt}`)
    const d = phase6Daemon(setupHome(), [pi])
    daemons.push(d)
    const thread = d.store.createThread('Uncertain')
    d.orch.setThreadModelOverride(thread.id, PI)
    const sent = await d.engine.dispatch({ kind: 'send', threadId: thread.id, clientRequestId: 'cut-off', source: 'gui' })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    d.engine.markStarting(sent.runId)
    d.engine.markRunning(sent.runId)
    d.engine.markTerminal(sent.runId, 'uncertain', { uncertainReason: 'non_idempotent_tool_in_flight' })

    const options = { threadId: thread.id, clientRequestId: `continue:${sent.runId}`, continuationOfRunId: sent.runId }
    await expect(d.orch.send('Continue where you left off.', false, options)).rejects.toMatchObject({ code: 'uncertain_not_acknowledged' })
    expect(d.engine.listRuns(thread.id)).toHaveLength(1)
    expect(d.engine.store.getReceipt(`continue:${sent.runId}`)).toBeNull()

    const acknowledged = await d.orch.send('Continue where you left off.', false, { ...options, acknowledgeUncertain: true })
    expect(d.engine.getRun(acknowledged.runId!)).toMatchObject({ status: 'completed', outcome: { continuationOf: sent.runId } })

    // A continuation must name an ended run of the same thread.
    const other = d.store.createThread('Other')
    await expect(d.orch.send('Continue', false, { threadId: other.id, clientRequestId: 'x-1', continuationOfRunId: sent.runId }))
      .rejects.toMatchObject({ code: 'continuation_not_found' })
  })

  it('a profile stop during a turn records a restart, not a Stop, and the next boot notes it', async () => {
    const dir = setupHome()
    let started = false
    // Runs until its signal aborts, like a provider stream cut off by the shutdown.
    const gated = piAdapter((input) => new Promise<string>((_resolve, reject) => {
      started = true
      input.signal.addEventListener('abort', () => reject(input.signal.reason as Error), { once: true })
    }))
    const first = phase6Daemon(dir, [gated], { pid: 1 })
    const thread = first.store.createThread('Shutdown')
    first.orch.setThreadModelOverride(thread.id, PI)
    const sent = await first.orch.send('Work slowly', false, { threadId: thread.id, clientRequestId: 'gated-1', awaitMode: 'ack' })
    await waitFor(() => started, 'the gated turn')
    await first.shutdown()

    const pi = piAdapter((input) => `after: ${input.prompt}`)
    const second = phase6Daemon(dir, [pi], { pid: 2 })
    daemons.push(second)
    expect(second.boot.interrupted).toEqual([])
    expect(second.engine.getRun(sent.runId!)).toMatchObject({ status: 'interrupted', outcome: { interruptedBy: 'daemon_restart' } })
    const systemOf = (d: Phase6Daemon) => d.orch.getMessages(thread.id).filter((message) => message.role === 'system').map((message) => message.content)
    expect(systemOf(first)).toContain('Turn interrupted by a Mousse restart.')
    expect(systemOf(first)).not.toContain('Turn stopped.')
    const notes = second.engine.listEvents(thread.id).filter((event) => event.type === 'restart.note')
    expect(notes.map((event) => event.payload)).toEqual([{ epoch: 2, runIds: [sent.runId], uncertainRunIds: [], cutOffTools: [] }])
    // The next turn opens with the note, once.
    await second.orch.send('Next', false, { threadId: thread.id, clientRequestId: 'next-1' })
    expect(systemOf(second)).toContain('The Mousse daemon restarted during the previous turn. Interrupted: 1 run(s).')
  })

  it('a queued send whose turn.start died with the daemon runs after the restart (rule 5)', async () => {
    const dir = setupHome()
    const first = phase6Daemon(dir, [piAdapter(() => 'unused')], { pid: 1 })
    const thread = first.store.createThread('Stranded')
    first.orch.setThreadModelOverride(thread.id, PI)
    // The worker is gone before it claims the send's turn.start; then the daemon crashes.
    await first.worker.stop()
    const sent = await first.engine.dispatch({ kind: 'send', threadId: thread.id, clientRequestId: 'stranded-1', source: 'gui' })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    const input = { content: 'Pick this up', mode: 'agent' }
    first.engine.outbox.enqueue({
      threadId: thread.id,
      runId: sent.runId,
      kind: 'turn.start',
      payload: { runId: sent.runId, threadId: thread.id, input, reuseLastUser: false, displayUserMessage: true, source: 'gui' }
    })
    await first.crash()

    const pi = piAdapter((turn) => `picked up: ${turn.prompt}`)
    const second = phase6Daemon(dir, [pi], { pid: 2 })
    daemons.push(second)
    expect(second.boot.strandedQueued).toEqual([sent.runId])
    const reconciler = new Reconciler({ store: second.engine.store, outbox: second.engine.outbox, tools: second.engine.tools })
    expect(reconciler.runOnce().queuedStarts).toEqual([sent.runId])
    await waitFor(() => second.engine.getRun(sent.runId)!.status === 'completed', 'the restarted run')
    expect(pi.turns.map((turn) => turn.prompt)).toEqual(['Pick this up'])
    const system = second.orch.getMessages(thread.id).filter((message) => message.role === 'system').map((message) => message.content)
    expect(system).toContain('The Mousse daemon restarted before this turn started. Queued before the restart: 1 run(s).')
  })
})
