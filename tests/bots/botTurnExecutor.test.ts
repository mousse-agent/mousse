/**
 * PR 6 §4 "Execution", "Forward guard" and "Ordinary sends to bot threads are refused": the
 * `turn.start` executor runs a bot payload only through the bot engine, refuses a payload kind it
 * does not know instead of casting it to a send, and every ordinary way into a bot thread (send,
 * queue, steer, the generic Continue) is refused with `bot_thread_read_only`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentRegistry } from '../../src/mms/agents/AgentRegistry'
import type { BotTurnDispatcher } from '../../src/mms/bots/activation/dispatcher'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectOutbox } from '../../src/mms/run/EffectOutbox'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { ToolInvocations } from '../../src/mms/run/ToolInvocations'
import type { BotTurnPayload, EffectRecord } from '../../src/mms/run/types'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'
import { PtyManager } from '../../src/mms/terminals/PtyManager'
import { WorktreeManager } from '../../src/mms/worktree/WorktreeManager'
import { getDefaultSettings } from '../../src/shared/settings'

let home: string
let db: ProfileDatabase
let engine: RunEngine
let outbox: EffectOutbox
let orch: OrchestratorService
let settled: Array<{ payload: BotTurnPayload; outcome: { text?: string } }>
let prepared: BotTurnPayload[]
let runTurn: ReturnType<typeof vi.fn>

const execute = (effect: EffectRecord) =>
  (orch as unknown as { executeTurnStartEffect(effect: EffectRecord, signal: AbortSignal): Promise<void> }).executeTurnStartEffect(effect, new AbortController().signal)

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mousse-bot-executor-'))
  db = new ProfileDatabase({ profileHome: home })
  const store = new RunStore(db)
  outbox = new EffectOutbox(store)
  engine = new RunEngine({ store, outbox, tools: new ToolInvocations(store), pid: 1 })
  orch = new OrchestratorService(new AgentRegistry(), new TaskQueue(), new WorktreeManager(home), new PtyManager(), { get: () => getDefaultSettings() } as never, {} as never)
  ;(orch as unknown as { runEngine: RunEngine }).runEngine = engine
  settled = []
  prepared = []
  runTurn = vi.fn(async () => ({ message: 'should not run', actions: [] }))
  ;(orch as unknown as { runTurnOnSession: unknown }).runTurnOnSession = runTurn
  const dispatcher: BotTurnDispatcher = {
    prepare: (payload) => {
      prepared.push(payload)
      return { refused: 'The bot\'s permissions were revoked or changed.', code: 'bot_grant_revoked' }
    },
    settle: (payload, outcome) => { settled.push({ payload, outcome }) },
    ownerOf: (threadId) => (threadId.startsWith('bot-') ? 'Site editor' : undefined)
  }
  orch.setBotDispatcher(dispatcher)
})

afterEach(() => {
  db.close()
  rmSync(home, { recursive: true, force: true })
})

const queuedBotRun = async (threadId = 'bot-thread') => {
  const sent = await engine.sendWithStart({ kind: 'send', threadId, clientRequestId: `${threadId}:d1`, source: 'bot' },
    (runId): BotTurnPayload => ({ kind: 'bot', runId, threadId, activationId: 'act-1', dispatchN: 1 }))
  if (sent.status !== 'accepted') throw new Error('rejected')
  return outbox.listForRun(sent.runId).find((effect) => effect.kind === 'turn.start')!
}

describe('the turn.start executor', () => {
  it('a bot payload whose grant no longer holds is refused: the run is cancelled and no turn starts', async () => {
    const effect = await queuedBotRun()
    await execute(effect)
    expect(prepared).toHaveLength(1)
    expect(runTurn).not.toHaveBeenCalled()
    expect(engine.getRun(effect.runId!)).toMatchObject({ status: 'cancelled', outcome: { error: 'bot_grant_revoked' } })
    expect(settled.map((entry) => entry.payload.runId)).toEqual([effect.runId])
  })

  it('without a bot engine, a bot payload is cancelled, never run as a send', async () => {
    orch.setBotDispatcher(null)
    const effect = await queuedBotRun()
    await execute(effect)
    expect(runTurn).not.toHaveBeenCalled()
    expect(engine.getRun(effect.runId!)).toMatchObject({ status: 'cancelled', outcome: { error: 'bots_unavailable' } })
  })

  it('a payload of an unknown kind is refused, not cast to a send', async () => {
    const sent = await engine.sendWithStart({ kind: 'send', threadId: 't', clientRequestId: 'future-1', source: 'gui' },
      (runId) => ({ kind: 'bot2', runId, threadId: 't', input: { content: 'run me', mode: 'agent' } }))
    if (sent.status !== 'accepted') throw new Error('rejected')
    await execute(outbox.listForRun(sent.runId).find((effect) => effect.kind === 'turn.start')!)
    expect(runTurn).not.toHaveBeenCalled()
    expect(engine.getRun(sent.runId)).toMatchObject({ status: 'cancelled', outcome: { error: 'unknown_turn_payload' } })
  })
})

describe('a prepared bot turn', () => {
  const prepare = (): BotTurnDispatcher['prepare'] => (payload) => ({
    activationId: payload.activationId,
    dispatchN: payload.dispatchN,
    prompt: 'Fix the footer',
    selection: { instanceId: 'pi:openrouter', model: 'some/model' },
    policy: { approvals: 'grants', approve: 'host', tools: { allow: ['read'] }, authority: { kind: 'bot', digest: 'd' } },
    authority: { time: { signal: new AbortController().signal } } as never,
    scratch: join(home, 'scratch'),
    skills: []
  })

  it('runs as a bot turn on the activation thread, and settles with the final message', async () => {
    orch.setBotDispatcher({ prepare: prepare(), settle: (payload, outcome) => { settled.push({ payload, outcome }) }, ownerOf: () => 'Site editor' })
    runTurn.mockImplementation(async () => ({ message: 'Footer fixed.', actions: [] }))
    const effect = await queuedBotRun()
    await execute(effect)
    expect(runTurn).toHaveBeenCalledTimes(1)
    const [, input, , , opts] = runTurn.mock.calls[0] as [unknown, { content: string }, boolean, boolean, { source: string; runId: string; bot: { prompt: string } }]
    expect(input).toMatchObject({ content: 'Fix the footer', mode: 'agent' })
    expect(opts).toMatchObject({ source: 'bot', runId: effect.runId, bot: { prompt: 'Fix the footer' } })
    expect(settled).toEqual([{ payload: expect.objectContaining({ runId: effect.runId }), outcome: { text: 'Footer fixed.' } }])
  })

  it('a thread that already has history fails with bot_state_invalid before anything is sent', async () => {
    orch.setBotDispatcher({ prepare: prepare(), settle: (payload, outcome) => { settled.push({ payload, outcome }) }, ownerOf: () => 'Site editor' })
    const effect = await queuedBotRun()
    const session = (orch as unknown as { getOrCreateSession(threadId: string): { messages: unknown[] } }).getOrCreateSession('bot-thread')
    session.messages.push({ role: 'user', content: 'ZEBRA-7731' })
    await execute(effect)
    expect(runTurn).not.toHaveBeenCalled()
    expect(engine.getRun(effect.runId!)).toMatchObject({ status: 'cancelled', outcome: { error: 'bot_state_invalid' } })
  })
})

describe('bot turn setup', () => {
  it('a prepare that throws cancels the run and settles it, so no activation stays running', async () => {
    orch.setBotDispatcher({ prepare: () => { throw new Error('malformed narrow') }, settle: (payload, outcome) => { settled.push({ payload, outcome }) }, ownerOf: () => 'Site editor' })
    const effect = await queuedBotRun()
    await execute(effect)
    expect(engine.getRun(effect.runId!)).toMatchObject({ status: 'cancelled', outcome: { error: 'bot_prepare_failed' } })
    expect(settled).toHaveLength(1)
    expect(runTurn).not.toHaveBeenCalled()
  })

  it('the bot’s role and instructions lead the turn preamble, and its app tools never ask a person', async () => {
    const internals = orch as unknown as {
      getOrCreateSession(threadId: string): unknown
      registerAppTurn(session: unknown, runId: string, mode: string, continuation: boolean, bot?: unknown): { turn: { approvals?: string; bot?: unknown } }
      completeAppTurn(turn: unknown, input: Record<string, unknown>): Promise<{ bot?: unknown; instructions(mcp: boolean): { turnPreamble: string } }>
      appToolTurns: { get(runId: string): { approvals?: string } | undefined }
    }
    const authority = { skills: new Set<string>(), time: { signal: new AbortController().signal } }
    const registered = internals.registerAppTurn(internals.getOrCreateSession('bot-thread'), 'run-bot', 'agent', false, { authority, skills: [] })
    const app = await internals.completeAppTurn(registered.turn, { promptRuntime: false, userContent: 'go', instanceId: 'pi:x', model: 'm', approvals: 'never', botInstructions: 'You are ZEBRA-REVIEWER.' })
    expect(app.bot).toBe(authority)
    expect(app.instructions(true).turnPreamble.startsWith('Your role and instructions:\nYou are ZEBRA-REVIEWER.')).toBe(true)
    expect(internals.appToolTurns.get('run-bot')?.approvals).toBe('never')
  })
})

describe('ordinary sends to bot threads', () => {
  const readOnly = { code: 'bot_thread_read_only', message: 'This thread belongs to the bot Site editor. Use the Bots tab to continue it.' }

  it('send, continue, queue and steer are refused with bot_thread_read_only', async () => {
    await expect(orch.send({ content: 'hello', mode: 'agent' }, false, { threadId: 'bot-thread' })).rejects.toMatchObject(readOnly)
    await expect(orch.send({ content: 'continue', mode: 'agent' }, false, { threadId: 'bot-thread', continuationOfRunId: 'run-1' })).rejects.toMatchObject(readOnly)
    expect(() => orch.enqueueForThread('bot-thread', { content: 'later', mode: 'agent' })).toThrow(expect.objectContaining(readOnly))
    expect(() => orch.steerActiveTurn('nudge', 'bot-thread')).toThrow(expect.objectContaining(readOnly))
    const effect = await queuedBotRun('bot-steer')
    await expect(orch.steerRun(effect.runId!, 'nudge', 'steer-1')).rejects.toMatchObject(readOnly)
    expect(runTurn).not.toHaveBeenCalled()
  })

  it('protocol steer without a run id, and Retry, are refused; nothing is steered into a bot turn', () => {
    expect(() => orch.steerThreadOrEnqueueExternal('bot-thread', 'nudge')).toThrow(expect.objectContaining(readOnly))
    expect(orch.steerThread('bot-thread', 'wake notice')).toBe(false)
    expect(() => orch.retryLastConnection('bot-thread')).toThrow(expect.objectContaining(readOnly))
    expect(runTurn).not.toHaveBeenCalled()
  })

  it('every turn start on a bot thread outside its dispatch is refused, and its run cancelled', async () => {
    const sent = await engine.dispatch({ kind: 'send', threadId: 'bot-thread', clientRequestId: 'plain-1', source: 'gui' })
    if (sent.status !== 'accepted') throw new Error('rejected')
    const real = (OrchestratorService.prototype as unknown as { runTurnOnSession: (...args: unknown[]) => Promise<unknown> }).runTurnOnSession
    const session = (orch as unknown as { getOrCreateSession(threadId: string): unknown }).getOrCreateSession('bot-thread')
    await expect(real.call(orch, session, { content: 'hello', mode: 'agent' }, false, true, { runId: sent.runId })).rejects.toMatchObject(readOnly)
    expect(engine.getRun(sent.runId)).toMatchObject({ status: 'cancelled', outcome: { error: 'bot_thread_read_only' } })
  })

  it('wake and integration effects on a bot thread are cancelled, never run as plain turns', async () => {
    for (const kind of ['wake', 'integration'] as const) {
      const sent = await engine.dispatch({ kind: 'send', threadId: 'bot-thread', clientRequestId: `${kind}-1`, source: kind === 'wake' ? 'wake' : 'integration' })
      if (sent.status !== 'accepted') throw new Error('rejected')
      const payload = kind === 'wake'
        ? { kind, threadId: 'bot-thread', runId: sent.runId, inboxIds: [] }
        : { kind, threadId: 'bot-thread', runId: sent.runId, delegationId: 'd-1' }
      const effect = outbox.enqueue({ threadId: 'bot-thread', runId: sent.runId, kind: 'turn.start', payload })
      await execute(effect)
      expect(engine.getRun(sent.runId), kind).toMatchObject({ status: 'cancelled', outcome: { error: 'bot_thread_read_only' } })
    }
    expect(runTurn).not.toHaveBeenCalled()
  })

  it('other threads are not affected', () => {
    expect(() => orch.steerActiveTurn('nudge', 'person-thread')).not.toThrow()
  })
})
