/**
 * Issue #142: a subagent that was stopped and is then continued resumes its native Claude session
 * instead of starting cold. A real orchestrator, run engine and adapter over the real provider
 * service, with only the SDK's `query` replaced.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { ClaudeSubscriptionAdapter } from '../../src/mms/harness/drivers/claudeCode/adapter'
import { FakeClaudeCli, resultFrame, roster, textDelta } from './fakeClaudeCli'
import { CLAUDE, phase6Daemon, waitFor } from './phase6Fixture'

describe('stopping a Claude turn and continuing the thread (issue #142)', () => {
  let home: string | undefined
  let previousHome: string | undefined
  const stops: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop().catch(() => undefined)
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  const result = { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'vendor-session' }
  const started = { type: 'stream_event', session_id: 'vendor-session', parent_tool_use_id: null, event: { type: 'message_start' } }

  /** Turn 1 completes, turn 2 is stopped once the SDK has a session (or before, with `sessionFirst` false), turn 3 follows. */
  const stoppedThenContinued = async (sessionFirst: boolean) => {
    home = mkdtempSync(join(tmpdir(), 'mousse-warm-resume-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const binary = join(home, 'claude')
    writeFileSync(binary, 'fixture')
    chmodSync(binary, 0o755)
    mkdirSync(join(home, 'providers', 'claude-subscription'), { recursive: true })
    writeFileSync(join(home, 'providers', 'claude-subscription', 'settings.json'), JSON.stringify({ loginPolicy: 'cli', binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] }))
    const inputs: Array<{ options: Options; prompt: unknown }> = []
    let reachedSecondTurn = false
    const query = (input: { options: Options; prompt: unknown }): Query => {
      inputs.push(input)
      if (inputs.length !== 2) return Object.assign((async function* () { yield result })(), { close: vi.fn(), interrupt: vi.fn(async () => {}) }) as unknown as Query
      // The second turn waits until it is stopped; stopping closes the query, which lets it end.
      let open!: () => void
      const gate = new Promise<void>((resolve) => { open = resolve })
      const events = (async function* () {
        if (sessionFirst) yield started
        reachedSecondTurn = true
        await gate
        yield started
      })()
      return Object.assign(events, { close: vi.fn(() => open()), interrupt: vi.fn(async () => {}) }) as unknown as Query
    }
    const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
      launchConfig: () => ({ binaryPath: binary }),
      live: false,
      query,
      runAuth: vi.fn(async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
    })
    stops.push(async () => service.stop())
    const d = phase6Daemon(home, [new ClaudeSubscriptionAdapter(() => service)])
    stops.push(d.stop)
    const thread = d.store.createThread('Subagent')
    d.orch.setThreadModelOverride(thread.id, CLAUDE)

    await d.orch.send('one', false, { threadId: thread.id, clientRequestId: 'turn-1' })
    const second = d.orch.send('two', false, { threadId: thread.id, clientRequestId: 'turn-2' })
    second.catch(() => undefined)
    await waitFor(() => reachedSecondTurn, 'the second turn to start')
    const run = d.engine.listRuns(thread.id)[0]
    await d.orch.abortRun(run.runId, 'stop-2', thread.id)
    await second
    await waitFor(() => d.engine.getRun(run.runId)?.status === 'interrupted', 'the second run to end')
    await d.orch.send('three', false, { threadId: thread.id, clientRequestId: 'turn-3' })
    return { inputs, d, thread }
  }

  it('resumes the same native session on the turn after a stop', async () => {
    const { inputs } = await stoppedThenContinued(true)
    expect(inputs).toHaveLength(3)
    expect(inputs[1].options.resume).toBe('vendor-session')
    expect(inputs[2].options.resume).toBe('vendor-session')
  }, 30_000)

  it('starts the next turn fresh when the stop came before the SDK had a session', async () => {
    const { inputs } = await stoppedThenContinued(false)
    expect(inputs).toHaveLength(3)
    expect(inputs[1].options.resume).toBe('vendor-session')
    expect(inputs[2].options.resume).toBeUndefined()
  }, 30_000)

  /** The same thread on a live query: turn 1 completes, turn 2 hangs after its first frame and is ended with `end`, turn 3 follows. */
  const liveStoppedThenContinued = async (end: 'stop' | 'preempt') => {
    home = mkdtempSync(join(tmpdir(), 'mousse-warm-resume-live-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const binary = join(home, 'claude')
    writeFileSync(binary, 'fixture')
    chmodSync(binary, 0o755)
    mkdirSync(join(home, 'providers', 'claude-subscription'), { recursive: true })
    writeFileSync(join(home, 'providers', 'claude-subscription', 'settings.json'), JSON.stringify({ loginPolicy: 'cli', binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] }))
    const cli = new FakeClaudeCli()
    cli.reply = (message, claude) => {
      const text = claude.text(claude.inputs.length - 1)
      if (text.includes('two')) claude.emit(textDelta('partial', String(message.uuid)))
      else claude.answer(String(message.uuid), `answer ${claude.inputs.length}`)
    }
    const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
      launchConfig: () => ({ binaryPath: binary }),
      query: cli.query,
      runAuth: vi.fn(async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
    })
    stops.push(async () => service.stop())
    const d = phase6Daemon(home, [new ClaudeSubscriptionAdapter(() => service)])
    stops.push(d.stop)
    const thread = d.store.createThread('Subagent')
    d.orch.setThreadModelOverride(thread.id, CLAUDE)

    await d.orch.send('one', false, { threadId: thread.id, clientRequestId: 'turn-1' })
    const second = d.orch.send('two', false, { threadId: thread.id, clientRequestId: 'turn-2' })
    second.catch(() => undefined)
    await waitFor(() => cli.last.inputs.length === 2, 'the second turn to be read')
    await new Promise((resolve) => setTimeout(resolve, 50))
    const run = d.engine.listRuns(thread.id)[0]
    if (end === 'stop') await d.orch.abortRun(run.runId, 'stop-2', thread.id)
    else d.orch.abortActiveTurn(thread.id)
    await second
    await waitFor(() => d.engine.getRun(run.runId)?.status === 'interrupted', 'the second run to end')
    cli.reply = (message, claude) => {
      // What the interrupted turn leaves behind: its abort result, then the answer to the new prompt.
      if (end === 'preempt') claude.emit(resultFrame({ uuids: [claude.uuid(1)], terminalReason: 'aborted_streaming' }))
      claude.answer(String(message.uuid), 'answer to three')
    }
    await d.orch.send('three', false, { threadId: thread.id, clientRequestId: 'turn-3' })
    return { cli, d, thread }
  }

  /** One finished turn that left a background shell running. */
  const threadWithHelper = async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-live-stop-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const binary = join(home, 'claude')
    writeFileSync(binary, 'fixture')
    chmodSync(binary, 0o755)
    mkdirSync(join(home, 'providers', 'claude-subscription'), { recursive: true })
    writeFileSync(join(home, 'providers', 'claude-subscription', 'settings.json'), JSON.stringify({ loginPolicy: 'cli', binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] }))
    const cli = new FakeClaudeCli()
    cli.reply = (message, claude) => {
      claude.emit(roster({ id: 'bash-1' }))
      claude.answer(String(message.uuid), 'started')
    }
    const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
      launchConfig: () => ({ binaryPath: binary }),
      query: cli.query,
      runAuth: vi.fn(async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
    })
    stops.push(async () => service.stop())
    const d = phase6Daemon(home, [new ClaudeSubscriptionAdapter(() => service)])
    stops.push(d.stop)
    const thread = d.store.createThread('Subagent')
    d.orch.setThreadModelOverride(thread.id, CLAUDE)
    await d.orch.send('one', false, { threadId: thread.id, clientRequestId: 'turn-1' })
    expect(service.hasBackgroundWork(thread.id)).toBe(true)
    return { cli, d, thread, service }
  }

  it('Stop by run id reaches the process even when that run already ended', async () => {
    const { cli, d, thread, service } = await threadWithHelper()
    const run = d.engine.listRuns(thread.id)[0]
    expect(d.engine.getRun(run.runId)?.status).toBe('completed')
    const result = await d.orch.abortRun(run.runId, 'stop-after-end', thread.id)
    expect(result.status).toBe('ignored')
    expect(cli.last.closed).toBe(true)
    expect(service.hasBackgroundWork(thread.id)).toBe(false)
  }, 30_000)

  it('Stop aimed at an old run leaves the process a newer run is using', async () => {
    const { cli, d, thread, service } = await threadWithHelper()
    const [older] = d.engine.listRuns(thread.id)
    cli.reply = undefined
    const second = d.orch.send('two', false, { threadId: thread.id, clientRequestId: 'turn-2' })
    second.catch(() => undefined)
    await waitFor(() => cli.last.inputs.length === 2, 'the second run to start')
    const result = await d.orch.abortRun(older.runId, 'stale-stop', thread.id)
    expect(result.status).toBe('ignored')
    expect(cli.last.closed).toBe(false)
    expect(service.hasBackgroundWork(thread.id)).toBe(true)
    cli.last.answer(cli.last.uuid(1), 'second done')
    await second
  }, 30_000)

  it('after a failed turn, a plain resend continues on the same process', async () => {
    const { cli, d, thread } = await threadWithHelper()
    cli.reply = (message, claude) => claude.emit(resultFrame({ uuids: [String(message.uuid)], error: 'rate limit' }))
    await d.orch.send('two', false, { threadId: thread.id, clientRequestId: 'turn-2' }).catch(() => undefined)
    await waitFor(() => d.engine.listRuns(thread.id).some((run) => run.status === 'failed'), 'the second run to fail')
    cli.reply = (message, claude) => claude.answer(String(message.uuid), 'back again')
    await d.orch.send('three', false, { threadId: thread.id, clientRequestId: 'turn-3' })
    expect(cli.processes).toHaveLength(1)
    expect(d.engine.listRuns(thread.id).filter((run) => run.status === 'completed')).toHaveLength(2)
    expect(cli.last.text(2)).not.toContain('Previous conversation')
  }, 30_000)

  it('a steer Claude could not take goes back to the queue with its rows held, unread', async () => {
    const { cli, d, thread } = await threadWithHelper()
    cli.reply = undefined
    const second = d.orch.send('two', false, { threadId: thread.id, clientRequestId: 'turn-2' })
    second.catch(() => undefined)
    await waitFor(() => cli.last.inputs.length === 2, 'the second run to start')
    const claude = cli.last
    claude.emit(textDelta('working', claude.uuid(1)))
    const run = d.engine.listRuns(thread.id).find((candidate) => candidate.status === 'running')!
    const row = d.engine.inbox.append({ threadId: thread.id, kind: 'reconcile_notice', payload: { text: 'A helper finished.' } })
    const effect = d.engine.outbox.enqueue({ threadId: thread.id, runId: run.runId, kind: 'turn.steer', availableAt: new Date(Date.now() + 3_600_000).toISOString(), payload: { runId: run.runId, threadId: thread.id, text: 'notice', inboxIds: [row.inboxId] } })
    d.engine.inbox.markDelivered([row.inboxId], effect.effectId)
    let open!: () => void
    claude.backgroundGate = new Promise<void>((resolve) => { open = resolve })
    expect(d.orch.steerThread(thread.id, 'notice for the model', undefined, { inboxIds: [row.inboxId], effectId: effect.effectId })).toBe(true)
    // The service drains the steer, marking its rows read, then waits for foreground work to move.
    await waitFor(() => claude.backgrounded === 1, 'the steer to be drained')
    expect(d.engine.inbox.get(row.inboxId)!.payload).toMatchObject({ steerTakenBy: effect.effectId })
    // The turn's result lands first: the steer cannot be pushed.
    claude.emit(resultFrame({ uuids: [claude.uuid(1)], text: 'working' }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    open()
    await second
    // Its rows were held again, then ran as the next turn, which carries them.
    await waitFor(() => claude.inputs.length === 3, 'the steer to run as the next turn')
    // (a steer that carries rows is rebuilt from them when it runs)
    expect(claude.text(2)).toContain('A helper finished.')
    expect(d.engine.inbox.get(row.inboxId)!.payload).not.toMatchObject({ steerTakenBy: effect.effectId })
    expect(d.engine.inbox.get(row.inboxId)).toMatchObject({ status: 'delivered' })
  }, 30_000)

  it('two steers in flight when the result lands are each handed back with their own rows', async () => {
    const { cli, d, thread } = await threadWithHelper()
    cli.reply = undefined
    const second = d.orch.send('two', false, { threadId: thread.id, clientRequestId: 'turn-2' })
    second.catch(() => undefined)
    await waitFor(() => cli.last.inputs.length === 2, 'the second run to start')
    const claude = cli.last
    claude.emit(textDelta('working', claude.uuid(1)))
    const run = d.engine.listRuns(thread.id).find((candidate) => candidate.status === 'running')!
    const carry = (label: string) => {
      const row = d.engine.inbox.append({ threadId: thread.id, kind: 'reconcile_notice', payload: { text: `Helper ${label} finished.` } })
      const effect = d.engine.outbox.enqueue({ threadId: thread.id, runId: run.runId, kind: 'turn.steer', availableAt: new Date(Date.now() + 3_600_000).toISOString(), payload: { runId: run.runId, threadId: thread.id, text: label, inboxIds: [row.inboxId] } })
      d.engine.inbox.markDelivered([row.inboxId], effect.effectId)
      return { row, effect }
    }
    const taken = (item: { row: { inboxId: string }; effect: { effectId: string } }) =>
      (d.engine.inbox.get(item.row.inboxId)!.payload as { steerTakenBy?: string }).steerTakenBy === item.effect.effectId
    let open!: () => void
    claude.backgroundGate = new Promise<void>((resolve) => { open = resolve })
    const a = carry('A')
    expect(d.orch.steerThread(thread.id, 'steer A', undefined, { inboxIds: [a.row.inboxId], effectId: a.effect.effectId })).toBe(true)
    await waitFor(() => claude.backgrounded === 1, 'the first steer to be drained')
    const b = carry('B')
    expect(d.orch.steerThread(thread.id, 'steer B', undefined, { inboxIds: [b.row.inboxId], effectId: b.effect.effectId })).toBe(true)
    await waitFor(() => claude.backgrounded === 2, 'the second steer to be drained')
    expect([taken(a), taken(b)]).toEqual([true, true])
    claude.emit(resultFrame({ uuids: [claude.uuid(1)], text: 'working' }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    open()
    await second
    // Each drain gave back its own rows: neither stays marked as read.
    expect([taken(a), taken(b)]).toEqual([false, false])
    await waitFor(() => claude.inputs.length === 3, 'the first returned steer to run as the next turn')
    expect(claude.text(2)).toContain('Helper A finished.')
  }, 30_000)

  it('a returned steer restores external text and the owned steer whole, never by cutting one out of the other', async () => {
    const { cli, d, thread } = await threadWithHelper()
    cli.reply = undefined
    const session = d.orch.getOrCreateSession(thread.id)
    let external: string | undefined
    const turn = (d.orch as any).runTurnOnSession(session, { content: 'two', mode: 'agent' }, false, true, {
      externalDrainSteer: () => {
        const text = external
        external = undefined
        return text
      }
    }) as Promise<unknown>
    turn.catch(() => undefined)
    await waitFor(() => cli.last.inputs.length === 2, 'the second turn to start')
    const claude = cli.last
    claude.emit(textDelta('working', claude.uuid(1)))
    let open!: () => void
    claude.backgroundGate = new Promise<void>((resolve) => { open = resolve })
    // One drain takes both: the external text "please inspect" and the owned steer "inspect".
    external = 'please inspect'
    expect(d.orch.steerThread(thread.id, 'inspect')).toBe(true)
    await waitFor(() => claude.backgrounded === 1, 'the steer to be drained')
    claude.emit(resultFrame({ uuids: [claude.uuid(1)], text: 'working' }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    open()
    await turn
    await waitFor(() => claude.inputs.length === 3, 'the returned steer to run as the next turn')
    // (the message content is JSON text here, so a newline shows as a backslash and an n)
    expect(claude.text(2)).toContain('please inspect\\ninspect')
    expect(claude.text(2)).not.toContain('please \\n')
  }, 30_000)

  it('a refused model change leaves the process usable: the next plain message runs on it', async () => {
    const { cli, d, thread } = await threadWithHelper()
    d.orch.setThreadModelOverride(thread.id, { llmProvider: 'claude-subscription', model: 'opus' })
    await d.orch.send('two', false, { threadId: thread.id, clientRequestId: 'turn-2' }).catch(() => undefined)
    await waitFor(() => d.engine.listRuns(thread.id).some((run) => run.status === 'failed'), 'the refused run to fail')
    expect(cli.processes).toHaveLength(1)
    // The user goes back to the model the process runs, and sends a plain message.
    d.orch.setThreadModelOverride(thread.id, CLAUDE)
    cli.reply = (message, claude) => claude.answer(String(message.uuid), 'back on sonnet')
    await d.orch.send('three', false, { threadId: thread.id, clientRequestId: 'turn-3' })
    expect(cli.processes).toHaveLength(1)
    expect(cli.last.closed).toBe(false)
    expect(d.engine.listRuns(thread.id).filter((run) => run.status === 'completed')).toHaveLength(2)
    // The refused message was never sent to Claude, and nothing was replayed.
    expect(cli.last.inputs).toHaveLength(2)
    expect(cli.last.text(1)).not.toContain('Previous conversation')
  }, 30_000)

  it('replaying an old Stop does not close the process, and the helper, that a newer run started', async () => {
    const { cli, d, thread, service } = await threadWithHelper()
    // Stop A: the thread's first process (with its helper) ends.
    const first = await d.orch.stopThread(thread.id, 'user', { clientRequestId: 'stop-a' })
    expect(first.ok).toBe(true)
    expect(cli.processes[0].closed).toBe(true)
    // Run B starts a new process with a helper of its own.
    await d.orch.send('b', false, { threadId: thread.id, clientRequestId: 'turn-b' })
    expect(cli.processes).toHaveLength(2)
    expect(service.hasBackgroundWork(thread.id)).toBe(true)
    // A's Stop is retried (same clientRequestId): the result is the first one, and B's process is left alone.
    const replay = await d.orch.stopThread(thread.id, 'user', { clientRequestId: 'stop-a' })
    expect(replay.replayed).toBe(true)
    expect(replay.threads).toEqual(first.threads)
    expect(cli.processes[1].closed).toBe(false)
    expect(service.hasBackgroundWork(thread.id)).toBe(true)
    // The same for a Stop by run id that was ignored (the run had ended) and is replayed.
    const [older] = d.engine.listRuns(thread.id).slice(-1)
    const stale = await d.orch.abortRun(older.runId, 'stop-old-run', thread.id)
    expect(stale.status).toBe('ignored')
    expect(cli.processes[1].closed).toBe(true)
    await d.orch.send('c', false, { threadId: thread.id, clientRequestId: 'turn-c' })
    expect(cli.processes).toHaveLength(3)
    const staleReplay = await d.orch.abortRun(older.runId, 'stop-old-run', thread.id)
    expect(staleReplay.status).toBe('ignored')
    expect(cli.processes[2].closed).toBe(false)
    await d.orch.stopThread(thread.id, 'user', { clientRequestId: 'stop-c' })
    expect(cli.processes[2].closed).toBe(true)
    await d.orch.send('b2', false, { threadId: thread.id, clientRequestId: 'turn-b2' })
    expect(cli.processes).toHaveLength(4)
    // A Stop that is new does end it.
    await d.orch.stopThread(thread.id, 'user', { clientRequestId: 'stop-b' })
    expect(cli.processes[3].closed).toBe(true)
  }, 30_000)

  it('deleting the thread or switching its provider ends the process and its helpers', async () => {
    const deleted = await threadWithHelper()
    deleted.d.orch.markThreadDeleted(deleted.thread.id)
    await waitFor(() => deleted.cli.last.closed, 'the process to close after the thread was deleted')
    expect(deleted.service.hasBackgroundWork(deleted.thread.id)).toBe(false)
    await stops.pop()?.()
    await stops.pop()?.()

    const switched = await threadWithHelper()
    switched.d.orch.setThreadModelOverride(switched.thread.id, { llmProvider: 'openai', model: 'gpt-replay' })
    await waitFor(() => switched.cli.last.closed, 'the process to close after the provider was switched')
    expect(switched.service.hasBackgroundWork(switched.thread.id)).toBe(false)
  }, 30_000)

  it('on a live query, Stop closes the process and the next turn resumes the same native session', async () => {
    const { cli } = await liveStoppedThenContinued('stop')
    expect(cli.processes).toHaveLength(2)
    expect(cli.processes[0].closed).toBe(true)
    expect(cli.processes[1].options.resume).toBe('vendor-session')
    // The stopped request reaches Claude once: the resumed session already holds it.
    expect(cli.processes[1].inputs).toHaveLength(1)
    expect(cli.processes[1].text(0)).not.toContain('Previous conversation')
  }, 30_000)

  it('on a live query, a preempted turn leaves the process open and the next turn is pushed into it', async () => {
    const { cli } = await liveStoppedThenContinued('preempt')
    expect(cli.processes).toHaveLength(1)
    expect(cli.processes[0].closed).toBe(false)
    expect(cli.processes[0].interrupts).toBe(1)
    expect(cli.processes[0].inputs).toHaveLength(3)
  }, 30_000)
})
