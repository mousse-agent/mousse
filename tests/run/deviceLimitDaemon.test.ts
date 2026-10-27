/**
 * A person at another of the user's computers runs turns at no more than the limit this computer gave
 * that device (`net_node_policy.max_permission_mode`), however the thread is set: when the turn runs
 * at once, when it waits in the queue, and when its text has to wait behind a running turn.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PI, phase6Daemon, piAdapter, waitFor, type Phase6Daemon } from './phase6Fixture'

let home: string | undefined
let before: string | undefined
let daemon: Phase6Daemon | undefined
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mousse-device-limit-'))
  before = process.env.MOUSSE_HOME
  process.env.MOUSSE_HOME = home
})
afterEach(async () => {
  await daemon?.shutdown().catch(() => undefined)
  daemon = undefined
  if (before === undefined) delete process.env.MOUSSE_HOME
  else process.env.MOUSSE_HOME = before
  if (home) rmSync(home, { recursive: true, force: true })
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

describe('turns from another computer', () => {
  it('run at the device limit, while the same thread run by its owner keeps its own mode', async () => {
    const gate = deferred()
    daemon = phase6Daemon(home!, [piAdapter(async (input) => (input.prompt === 'first' ? (await gate.promise, 'one') : 'done'))])
    const thread = daemon.store.createThread('Limits')
    daemon.orch.setThreadModelOverride(thread.id, PI)
    daemon.orch.setThreadPermissionMode(thread.id, 'full')
    const modeOf = (runId: string) => daemon!.engine.bindingForRun(runId)?.policy.permissionMode

    // The owner's own message holds the thread while it runs, at the thread's mode.
    const first = await daemon.orch.send('first', false, { threadId: thread.id, source: 'gui', awaitMode: 'ack' })
    await waitFor(() => modeOf(first.runId!) !== undefined, 'the first turn to bind')
    expect(modeOf(first.runId!)).toBe('full')

    // A message from a device limited to Auto-accept edits queues, carrying the limit with it.
    const queued = await daemon.orch.send('second', false, { threadId: thread.id, source: 'gui', permissionMode: 'accept_edits', sentFrom: { node: 'nod_laptop' } })
    expect(queued.queued).toBe(true)
    expect(daemon.orch.listQueue(thread.id).find((item) => item.id === queued.queueItem!.id)).toMatchObject({ permissionMode: 'accept_edits' })
    // Recorded for the owner: the thread and the run say which computer sent it.
    expect(daemon.store.getThread(thread.id)!.sentFrom).toEqual({ node: 'nod_laptop' })
    const events = daemon.engine.store.db.statement("SELECT run_id, payload FROM thread_events WHERE type = 'run.sent_from'").all() as Array<{ run_id: string; payload: string }>
    expect(events.map((event) => [event.run_id, JSON.parse(event.payload)])).toEqual([[queued.runId, { node: 'nod_laptop' }]])

    gate.resolve()
    await waitFor(() => daemon!.engine.listRuns(thread.id).length === 2 && daemon!.engine.listRuns(thread.id).every((run) => run.status === 'completed'), 'both turns to finish')
    // The drained message ran at its limit, not at the thread's Full access.
    expect(modeOf(queued.runId!)).toBe('accept_edits')
    expect(modeOf(first.runId!)).toBe('full')
  })

  /** A thread at Full access whose first turn is held, so the test decides what the turn reads. */
  async function holdingThread() {
    const gate = deferred()
    daemon = phase6Daemon(home!, [piAdapter(async (input) => (input.prompt === 'first' ? (await gate.promise, 'one') : 'done'))])
    const thread = daemon.store.createThread('Steered')
    daemon.orch.setThreadModelOverride(thread.id, PI)
    daemon.orch.setThreadPermissionMode(thread.id, 'full')
    const modeOf = (runId: string) => daemon!.engine.bindingForRun(runId)?.policy.permissionMode
    const first = await daemon.orch.send('first', false, { threadId: thread.id, source: 'gui', awaitMode: 'ack' })
    await waitFor(() => modeOf(first.runId!) !== undefined, 'the first turn to bind')
    const followUps = () => daemon!.engine.listRuns(thread.id).filter((run) => run.runId !== first.runId)
    return { gate, thread, first, modeOf, followUps }
  }

  it('runs a steer the turn never reads at the device limit, not at the thread’s Full access', async () => {
    const { gate, thread, followUps, modeOf } = await holdingThread()
    expect(daemon!.orch.steerThreadOrEnqueueExternal(thread.id, 'device text', { source: 'gui', permissionMode: 'ask' })).toMatchObject({ steered: true })
    gate.resolve()
    await waitFor(() => followUps().some((run) => run.status === 'completed'), 'the follow-up turn to finish')
    const [followUp] = followUps()
    expect(followUp.source).toBe('steer-followup')
    expect(modeOf(followUp.runId)).toBe('ask')
  })

  it('does the same for a steer that names the running run', async () => {
    const { gate, thread, first, followUps, modeOf } = await holdingThread()
    expect(await daemon!.orch.steerRun(first.runId!, 'device text', 'steer-1', thread.id, undefined, undefined, 'accept_edits')).toMatchObject({ status: 'accepted' })
    // The steer effect is delivered by the worker; give it a moment to reach the turn before the turn ends.
    await new Promise((resolve) => setTimeout(resolve, 300))
    gate.resolve()
    await waitFor(() => followUps().some((run) => run.status === 'completed'), 'the follow-up turn to finish')
    expect(modeOf(followUps()[0].runId)).toBe('accept_edits')
  })

  it('does the same for a steer that arrives after its run ended', async () => {
    const { gate, thread, first, followUps, modeOf } = await holdingThread()
    gate.resolve()
    await waitFor(() => daemon!.engine.getRun(first.runId!)?.status === 'completed', 'the first turn to finish')
    // What the steer effect does for a run that is already over: the text waits as a turn of its own.
    ;(daemon!.orch as unknown as { executeTurnSteerEffect(effect: unknown): void }).executeTurnSteerEffect({
      effectId: 'effect-late',
      payload: { runId: first.runId, threadId: thread.id, text: 'late device text', deviceLimit: 'ask' }
    })
    await waitFor(() => followUps().some((run) => run.status === 'completed'), 'the late turn to finish')
    expect(modeOf(followUps()[0].runId)).toBe('ask')
  })

  it('leaves a message the owner queued no looser than the limit once a device edits it', async () => {
    const { gate, thread, followUps, modeOf } = await holdingThread()
    const queued = await daemon!.orch.send('owner text', false, { threadId: thread.id, source: 'gui' })
    expect(queued.queueItem!.permissionMode).toBeUndefined()
    const edited = daemon!.orch.editQueuedItem(thread.id, queued.queueItem!.id, { content: 'device text' }, { permissionMode: 'accept_edits', sentFrom: { node: 'nod_laptop' } })
    expect(edited).toMatchObject({ content: 'device text', permissionMode: 'accept_edits', sentFrom: { node: 'nod_laptop' } })
    // An owner’s own edit changes nothing about the limit.
    const own = await daemon!.orch.send('own', false, { threadId: thread.id, source: 'gui' })
    expect(daemon!.orch.editQueuedItem(thread.id, own.queueItem!.id, { content: 'own, edited' }).permissionMode).toBeUndefined()
    gate.resolve()
    await waitFor(() => followUps().length === 2 && followUps().every((run) => run.status === 'completed'), 'both queued turns to finish')
    expect(modeOf(queued.runId!)).toBe('accept_edits')
    expect(modeOf(own.runId!)).toBe('full')
  })

  it('retries a failed request under the limit it was sent with', async () => {
    daemon = phase6Daemon(home!, [piAdapter(() => 'ok')])
    const thread = daemon.store.createThread('Retry')
    const session = daemon.orch.getOrCreateSession(thread.id)
    session.failedConnectionRequest = { content: 'retry me' }
    session.failedConnectionLimit = 'ask'
    const run = vi.spyOn(daemon.orch as unknown as { runTurnOnSession(...args: unknown[]): Promise<unknown> }, 'runTurnOnSession').mockResolvedValue({ message: '', actions: [] })
    expect(daemon.orch.retryLastConnection(thread.id)).toBe(true)
    expect(run).toHaveBeenCalledWith(session, { content: 'retry me' }, true, true, { permissionMode: 'ask' })
    expect(session.failedConnectionLimit).toBeNull()
  })

  it('cannot loosen the thread: a device allowed Full access still runs in a stricter thread mode', async () => {
    daemon = phase6Daemon(home!, [piAdapter(() => 'ok')])
    const thread = daemon.store.createThread('Strict')
    daemon.orch.setThreadModelOverride(thread.id, PI)
    daemon.orch.setThreadPermissionMode(thread.id, 'ask')
    const sent = await daemon.orch.send('hello', false, { threadId: thread.id, source: 'gui', permissionMode: 'full' })
    await waitFor(() => daemon!.engine.bindingForRun(sent.runId!) !== undefined, 'the turn to bind')
    expect(daemon.engine.bindingForRun(sent.runId!)?.policy.permissionMode).toBe('ask')
  })

  it('sets the mode of a thread only up to the limit, and accepts a steer option that carries the limit', async () => {
    daemon = phase6Daemon(home!, [piAdapter(() => 'ok')])
    const thread = daemon.store.createThread('Steer')
    daemon.orch.setThreadModelOverride(thread.id, PI)
    // Nothing runs and no turn is paused, so there is nothing to join or hold: the steer is not kept.
    expect(daemon.orch.steerThreadOrEnqueueExternal(thread.id, 'also', { source: 'gui', permissionMode: 'ask' })).toEqual({ steered: false, queued: false })
    // The mode of a thread is set only up to the device's limit.
    expect(() => daemon!.orch.setThreadPermissionMode(thread.id, 'full', { node: 'nod_laptop', maxPermissionMode: 'accept_edits' })).toThrow(expect.objectContaining({ code: 'permission_mode_above_ceiling' }))
    expect(daemon.orch.setThreadPermissionMode(thread.id, 'accept_edits', { node: 'nod_laptop', maxPermissionMode: 'accept_edits' }).permissionMode).toBe('accept_edits')
    expect(daemon.orch.setThreadPermissionMode(thread.id, 'ask', { node: 'nod_laptop', maxPermissionMode: 'ask' }).permissionMode).toBe('ask')
  })
})
