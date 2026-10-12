/**
 * SPEC §16.4 continue after restart: `orchestrator.send` with `continuationOfRunId` records the
 * continued run, opens the turn with a system line, replays on a repeated `continue:<runId>`
 * request, and needs `acknowledgeUncertain` for an `uncertain` run.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PI, phase6Daemon, piAdapter, type Phase6Daemon } from './phase6Fixture'

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
})
