/**
 * The steer hold on Claude Code (docs/design/steer-and-interruptions.md §2.4): a real orchestrator, run engine, Claude
 * adapter and provider service against a fake Claude Code process. A person's steer is not pushed while a `tool_use`
 * of the turn is open, from its `content_block_start` to its `tool_result`; it is pushed right after. Only foreground
 * subagents that Claude Code runs as a task are moved to the background, each by its id, never with the call that has
 * no id (it also moves a running command, #874). Send now pushes the steer and then stops the command: by its task
 * once Claude Code named one, otherwise with an interrupt, because an immediate message waits for a running command
 * (spike S1). With no command left to stop, the push alone is the cut.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeSubscriptionProviderService } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { ClaudeSubscriptionAdapter } from '../../src/mms/harness/drivers/claudeCode/adapter'
import { FakeClaudeCli, lifecycle, messageStart, resultFrame, SESSION, taskStarted, textDelta, toolResult, toolStart, toolUse, type FakeClaudeProcess } from './fakeClaudeCli'
import { CLAUDE, phase6Daemon, waitFor } from './phase6Fixture'
import { readDurableQueue } from '../../src/mms/queue/durableQueue'

vi.setConfig({ testTimeout: 60_000 })

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** What Claude Code sends when an interrupt ends a running command: the call's error result, then the aborted turn's result. */
const interruptedCommand = (process: FakeClaudeProcess, callId: string, prompt: string): void => {
  process.emit(
    {
      type: 'user',
      session_id: SESSION,
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: '[Request interrupted by user for tool use]', is_error: true }] }
    },
    resultFrame({ uuids: [prompt], terminalReason: 'aborted_tools', error: 'interrupted', queued: 1 })
  )
}

/** The queued steer `id` runs as the turn's next request, and the model answers it. */
const answerSteer = (process: FakeClaudeProcess, id: string, text: string): void => {
  process.emit(lifecycle(id, 'started'), messageStart(id), textDelta(text, id), resultFrame({ uuids: [id], text }))
}

describe('a person\'s steer on Claude Code waits for a running tool', () => {
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

  /** A thread whose first turn runs and stays open; the fake answers nothing on its own. */
  const running = async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-claude-hold-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, 'claude-config'))
    stops.push(async () => vi.unstubAllEnvs())
    const binary = join(home, 'claude')
    writeFileSync(binary, 'fixture')
    chmodSync(binary, 0o755)
    mkdirSync(join(home, 'providers', 'claude-subscription'), { recursive: true })
    writeFileSync(join(home, 'providers', 'claude-subscription', 'settings.json'), JSON.stringify({ loginPolicy: 'cli', binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] }))
    const cli = new FakeClaudeCli()
    cli.reply = undefined
    let service!: ClaudeSubscriptionProviderService
    const d = phase6Daemon(home, [new ClaudeSubscriptionAdapter(() => service)])
    // One question service for the daemon and Claude, as in the app: a steer answers what Mousse itself asks too.
    service = new ClaudeSubscriptionProviderService(home, d.questions, {
      launchConfig: () => ({ binaryPath: binary }),
      query: cli.query,
      runAuth: vi.fn(async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
    })
    stops.push(async () => service.stop())
    stops.push(d.stop)
    const thread = d.store.createThread('Hold')
    d.orch.setThreadModelOverride(thread.id, CLAUDE)
    let sends = 0
    const send = (text: string) => d.orch.send(text, false, { threadId: thread.id, clientRequestId: `send-${++sends}` })
    const first = send('first')
    first.catch(() => undefined)
    await waitFor(() => cli.processes.length === 1 && cli.last.inputs.length === 1, 'the first turn to reach Claude Code')
    const claude = cli.last
    const prompt = claude.uuid(0)
    const runId = d.engine.getActiveRun(thread.id)!.runId
    const steer = async (text: string): Promise<string> => {
      const queued = await send(text)
      expect(d.orch.promoteQueueItem(thread.id, queued.queueItem!.id)).toEqual({ ok: true })
      return queued.queueItem!.id
    }
    const held = () => d.orch.getTurnState(thread.id).heldSteer
    /** The steers pushed to Claude Code, by their text. */
    const pushed = () => claude.inputs.slice(1).map((_, index) => claude.text(index + 1))
    /** Every Send now outcome windows were told, in order. */
    const outcomes: Array<{ requestId: string; outcome: string }> = []
    d.orch.on('steer-now', (event: { threadId: string; requestId: string; outcome: string }) => {
      if (event.threadId === thread.id) outcomes.push({ requestId: event.requestId, outcome: event.outcome })
    })
    /** How many times `text` is a user message of the model's context. */
    const inContext = (text: string) => d.orch.getNativeContext(thread.id).messages.filter((message) => message.role === 'user' && JSON.stringify(message).includes(text)).length
    const sendNow = (clientRequestId: string, hold = held()!) =>
      d.orch.steerNow({ threadId: thread.id, runId: hold.runId ?? runId, holdGeneration: hold.holdGeneration, itemIds: hold.itemIds, clientRequestId })
    return { d, cli, claude, thread, prompt, runId, first, steer, held, pushed, outcomes, inContext, sendNow }
  }

  it('no push while a tool_use is open, from its content_block_start to its tool_result; then one push, as an immediate message', async () => {
    const w = await running()
    w.claude.emit(toolStart('bash-1', 'Bash', w.prompt))
    await later(30)
    await w.steer('use pnpm')
    await waitFor(() => w.held() !== undefined, 'held')
    expect(w.held()).toMatchObject({ waitsFor: 'Bash', tools: 1, runId: w.runId })
    await later(350)
    expect(w.claude.inputs).toHaveLength(1)
    w.claude.emit(toolResult('bash-1'))
    await waitFor(() => w.claude.inputs.length === 2, 'the steer pushed after the result')
    expect(w.claude.inputs[1]).toMatchObject({ priority: 'now' })
    expect(w.pushed()).toEqual([expect.stringContaining('use pnpm')])
    expect(w.claude.backgroundCalls).toEqual([])
    expect(w.claude.interrupts).toBe(0)
    expect(w.held()).toBeUndefined()
    await later(250)
    expect(w.claude.inputs).toHaveLength(2)
  })

  it('a steer while the model writes and no tool is open is pushed at once', async () => {
    const w = await running()
    w.claude.emit(textDelta('thinking out loud', w.prompt))
    await w.steer('listen')
    await waitFor(() => w.claude.inputs.length === 2, 'pushed')
    expect(w.pushed()).toEqual([expect.stringContaining('listen')])
    expect(w.held()).toBeUndefined()
  })

  it('moves only foreground subagents Claude Code runs as a task, each by its id, then checks again: a command that starts during the move keeps the steer waiting', async () => {
    const w = await running()
    w.claude.emit(toolStart('agent-1', 'Agent', w.prompt), taskStarted('agent-1', 'task-agent'))
    await later(30)
    let open!: () => void
    w.claude.backgroundGate = new Promise<void>((resolve) => { open = resolve })
    await w.steer('after the move')
    await waitFor(() => w.claude.backgroundCalls.length === 1, 'the subagent moving')
    expect(w.claude.backgroundCalls).toEqual(['agent-1'])
    // A command starts while the move is awaited.
    w.claude.emit(toolStart('bash-1', 'Bash', w.prompt))
    await later(30)
    open()
    await waitFor(() => w.held() !== undefined, 'held again for the command')
    expect(w.held()?.waitsFor).toBe('Bash')
    await later(300)
    expect(w.claude.inputs).toHaveLength(1)
    w.claude.backgroundGate = undefined
    w.claude.emit(toolResult('bash-1'))
    await waitFor(() => w.claude.inputs.length === 2, 'pushed after the command')
    expect(w.pushed()).toEqual([expect.stringContaining('after the move')])
    // Never the call with no id, and the subagent moved once is not moved again.
    expect(w.claude.backgroundCalls).toEqual(['agent-1'])
  })

  it('a subagent moved once is not moved again for the next steer', async () => {
    const w = await running()
    w.claude.emit(toolStart('agent-1', 'Agent', w.prompt), taskStarted('agent-1', 'task-agent'), textDelta('working', w.prompt))
    await later(30)
    await w.steer('first steer')
    await waitFor(() => w.claude.inputs.length === 2, 'the first steer pushed')
    await w.steer('second steer')
    await waitFor(() => w.claude.inputs.length === 3, 'the second steer pushed')
    expect(w.claude.backgroundCalls).toEqual(['agent-1'])
  })

  it('a subagent Claude Code has not started a task for yet (its prompt still streams) is not moved and does not hold: the steer is pushed at once', async () => {
    const w = await running()
    w.claude.emit(toolStart('agent-1', 'Agent', w.prompt))
    await later(30)
    await w.steer('before the subagent starts')
    await waitFor(() => w.claude.inputs.length === 2, 'pushed')
    expect(w.pushed()).toEqual([expect.stringContaining('before the subagent starts')])
    expect(w.claude.backgroundCalls).toEqual([])
    const row = w.d.orch.getOrCreateSession(w.thread.id).messages.find((message) => message.activity?.callId === 'agent-1')
    expect(row?.activity?.notMovable).toBeUndefined()
    expect(w.held()).toBeUndefined()
  })

  it.each([['answers false', false], ['throws (background tasks are off)', 'throw']] as const)(
    'a subagent task that cannot be moved (the move %s) is reported and waited for, without moving again', async (_name, answer) => {
      const w = await running()
      w.claude.backgroundAnswer = answer
      w.claude.emit(toolStart('agent-1', 'Agent', w.prompt), taskStarted('agent-1', 'task-agent'))
      await later(30)
      await w.steer('after the subagent')
      await waitFor(() => w.held() !== undefined, 'held for the subagent')
      // The progress line's word for it ("Running subagent…").
      expect(w.held()?.waitsFor).toBe('subagent')
      const row = w.d.orch.getOrCreateSession(w.thread.id).messages.find((message) => message.activity?.callId === 'agent-1')
      expect(row?.activity?.notMovable).toBe(true)
      await later(350)
      expect(w.claude.backgroundCalls).toEqual(['agent-1'])
      expect(w.claude.inputs).toHaveLength(1)
      w.claude.emit(toolResult('agent-1'))
      await waitFor(() => w.claude.inputs.length === 2, 'pushed once the subagent ended')
      expect(w.pushed()).toEqual([expect.stringContaining('after the subagent')])
    })

  it('Send now before Claude Code names the command\'s task: the steer is pushed, then the turn is interrupted', async () => {
    const w = await running()
    w.claude.emit(toolStart('bash-1', 'Bash', w.prompt))
    await later(30)
    await w.steer('now please')
    await waitFor(() => w.held() !== undefined, 'held')
    expect(await w.sendNow('now-1')).toMatchObject({ status: 'accepted' })
    await waitFor(() => w.claude.interrupts === 1, 'interrupted')
    // Pushed first, so the interrupt leaves it queued and it runs once.
    expect(w.claude.inputs).toHaveLength(2)
    expect(w.claude.inputs[1]).toMatchObject({ priority: 'now' })
    expect(w.claude.interruptOptions).toEqual([undefined])
    expect(w.claude.stoppedTasks).toEqual([])
    expect(w.claude.backgroundCalls).toEqual([])
  })

  it('Send now once Claude Code named the command\'s task: the steer is pushed, then that task is stopped, with no interrupt', async () => {
    const w = await running()
    w.claude.emit(toolStart('bash-1', 'Bash', w.prompt), taskStarted('bash-1', 'task-9'))
    await later(30)
    await w.steer('stop it')
    await waitFor(() => w.held() !== undefined, 'held')
    await w.sendNow('now-1')
    await waitFor(() => w.claude.stoppedTasks.length === 1, 'task stopped')
    expect(w.claude.stoppedTasks).toEqual(['task-9'])
    expect(w.claude.inputs).toHaveLength(2)
    expect(w.claude.interrupts).toBe(0)
  })

  it('Send now through to the end: the interrupt\'s aborted result does not end the run, the model answers the steer, and it is accepted once', async () => {
    const w = await running()
    w.claude.emit(toolStart('bash-1', 'Bash', w.prompt), toolUse('bash-1', 'Bash', { command: 'sleep 30' }))
    await later(30)
    const itemId = await w.steer('use pnpm instead')
    await waitFor(() => w.held() !== undefined, 'held')
    w.claude.onInterrupt = (process) => {
      setTimeout(() => {
        interruptedCommand(process, 'bash-1', w.prompt)
        answerSteer(process, process.uuid(1), 'switching to pnpm')
      }, 0)
    }
    expect(await w.sendNow('now-1')).toMatchObject({ status: 'accepted' })
    await w.first
    expect(w.claude.interrupts).toBe(1)
    expect(w.inContext('use pnpm instead')).toBe(1)
    // Accepted: its row left the queue, and no follow-up turn carries it.
    expect(w.d.orch.listQueue(w.thread.id).map((item) => item.id)).not.toContain(itemId)
    expect(w.d.orch.listQueue(w.thread.id)).toEqual([])
    expect(w.outcomes).toEqual([{ requestId: 'now-1', outcome: 'applied' }])
    // The audit record of the person's Send now (§2.9).
    expect(w.d.engine.listEvents(w.thread.id).filter((event) => event.type === 'person.action').map((event) => event.payload)).toEqual([
      expect.objectContaining({ action: 'steered_run', now: true, requestId: 'now-1' })
    ])
    // Nothing runs it again.
    await later(300)
    expect(w.claude.inputs).toHaveLength(2)
    expect(w.d.engine.getActiveRun(w.thread.id)).toBeNull()
  })

  it('Send now, then Stop before Claude Code reads the steer: the steer comes back once as a queued message and nothing runs it', async () => {
    const w = await running()
    w.claude.emit(toolStart('bash-1', 'Bash', w.prompt), toolUse('bash-1', 'Bash', { command: 'sleep 30' }))
    await later(30)
    const itemId = await w.steer('then stop')
    await waitFor(() => w.held() !== undefined, 'held')
    await w.sendNow('now-1')
    await waitFor(() => w.claude.interrupts === 1, 'Send now\'s interrupt')
    expect(w.claude.inputs).toHaveLength(2)
    await w.d.orch.stopThread(w.thread.id, 'user')
    await w.first.catch(() => undefined)
    await waitFor(() => w.d.engine.getActiveRun(w.thread.id) === null, 'the run to end')
    await later(200)
    expect(w.d.orch.listQueue(w.thread.id).map((item) => [item.id, item.state])).toEqual([[itemId, 'pending']])
    expect(w.inContext('then stop')).toBe(0)
    expect(w.claude.ranAfterInterrupt).toEqual([])
    expect(w.claude.inputs).toHaveLength(2)
  })

  it('Send now as the command ends on its own: the push alone is the cut, with no interrupt (it would also stop background work)', async () => {
    const w = await running()
    w.claude.emit(toolStart('bash-1', 'Bash', w.prompt), toolUse('bash-1', 'Bash', { command: 'npm test' }))
    await later(30)
    await w.steer('racing the end')
    await waitFor(() => w.held() !== undefined, 'held')
    const click = w.sendNow('now-1')
    // The command's result lands in the same moment as the click, before the next poll.
    w.claude.emit(toolResult('bash-1'))
    expect(await click).toMatchObject({ status: 'accepted' })
    await waitFor(() => w.claude.inputs.length === 2, 'pushed')
    await later(250)
    expect(w.pushed()).toEqual([expect.stringContaining('racing the end')])
    expect(w.claude.interrupts).toBe(0)
    expect(w.claude.stoppedTasks).toEqual([])
  })

  it('a click replayed with the same request id forces nothing more and is reported once', async () => {
    const w = await running()
    w.claude.emit(toolStart('bash-1', 'Bash', w.prompt), toolUse('bash-1', 'Bash', { command: 'sleep 30' }))
    await later(30)
    await w.steer('first')
    await waitFor(() => w.held() !== undefined, 'held')
    const shown = w.held()!
    await w.sendNow('now-1', shown)
    await waitFor(() => w.claude.interrupts === 1, 'Send now\'s interrupt')
    expect(await w.sendNow('now-1', shown)).toMatchObject({ replayed: true })
    // A new hold in the same turn: a second command, and a second steer held for it.
    w.claude.emit(toolStart('bash-2', 'Bash', w.prompt), toolUse('bash-2', 'Bash', { command: 'sleep 30' }))
    await later(30)
    await w.steer('second')
    await waitFor(() => w.held() !== undefined && w.held()!.holdGeneration !== shown.holdGeneration, 'held again')
    await later(250)
    expect(w.outcomes).toEqual([{ requestId: 'now-1', outcome: 'applied' }])
    expect(w.claude.interrupts).toBe(1)
  })

  it.each([
    ['ask_user', 'mcp__mousse__ask_user', { questions: [{ question: 'Which?' }] }],
    ['an approval of a relayed tool', 'mcp__mousse-relay__github__create_issue', { title: 'x' }]
  ] as const)('a question Mousse asks for %s does not hold the steer: the steer answers it', async (_name, toolName, input) => {
    const w = await running()
    w.claude.emit(toolStart('mcp-1', toolName, w.prompt), toolUse('mcp-1', toolName, input))
    await later(30)
    const answer = w.d.questions.requestAnswers([{ id: 'q', prompt: 'Which one?', options: [{ id: 'a', label: 'A' }] }], w.thread.id)
    answer.catch(() => undefined)
    await waitFor(() => w.d.questions.listPendingForThread(w.thread.id).length === 1, 'the question pending')
    // The Steer button's path (`orchestrator.steer`): the steer joins the running turn.
    expect(w.d.orch.steerThreadOrEnqueueExternal(w.thread.id, 'do B instead')).toMatchObject({ steered: true })
    await waitFor(() => w.claude.inputs.length === 2, 'pushed at once')
    expect(w.pushed()).toEqual([expect.stringContaining('do B instead')])
    expect(w.held()).toBeUndefined()
    // The steer answered the question as the person.
    await waitFor(() => w.d.questions.listPendingForThread(w.thread.id).length === 0, 'the question answered')
  })

  it('with no question pending, Mousse\'s ask_user call holds like any tool', async () => {
    const w = await running()
    w.claude.emit(toolStart('mcp-1', 'mcp__mousse__ask_user', w.prompt), toolUse('mcp-1', 'mcp__mousse__ask_user', {}))
    await later(30)
    await w.steer('waits')
    await waitFor(() => w.held() !== undefined, 'held: no question is pending yet')
    expect(w.held()?.waitsFor).toBe('Ask User')
  })

  it.each([
    ['the next root message starts', (process: FakeClaudeProcess, steerId: string) => process.emit(messageStart(steerId))],
    ['an aborted result comes', (process: FakeClaudeProcess, steerId: string) => process.emit(resultFrame({ uuids: [steerId], terminalReason: 'aborted_streaming', queued: 1 }))]
  ] as const)('a call announced just after a cut\'s push, and dropped before it ran, does not hold later steers once %s', async (_name, end) => {
    const w = await running()
    w.claude.emit(textDelta('writing', w.prompt))
    await w.steer('first steer')
    await waitFor(() => w.claude.inputs.length === 2, 'the cut pushed')
    const steerId = w.claude.uuid(1)
    // A tool_use already on its way when the push landed: announced, its input never completes, no result follows.
    w.claude.emit(toolStart('bash-late', 'Bash', w.prompt))
    await later(30)
    end(w.claude, steerId)
    await later(30)
    const row = w.d.orch.getOrCreateSession(w.thread.id).messages.find((message) => message.activity?.callId === 'bash-late')
    expect(row?.activity?.status).toBe('interrupted')
    await w.steer('second steer')
    await waitFor(() => w.claude.inputs.length === 3, 'the second steer pushed, not held')
    expect(w.held()).toBeUndefined()
  })

  it('a call whose whole message arrived is not closed when the next message starts: it runs, and holds', async () => {
    const w = await running()
    w.claude.emit(toolStart('bash-1', 'Bash', w.prompt), toolUse('bash-1', 'Bash', { command: 'sleep 5' }), messageStart(w.prompt))
    await later(30)
    await w.steer('waits for it')
    await waitFor(() => w.held() !== undefined, 'held')
    expect(w.held()?.waitsFor).toBe('Bash')
  })

  it('an agent\'s steer held for a tool shows no wait line and no Send now, and a click on its hold is stale and stops nothing', async () => {
    const w = await running()
    w.claude.emit(toolStart('bash-1', 'Bash', w.prompt), toolUse('bash-1', 'Bash', { command: 'sleep 30' }))
    await later(30)
    const origin = { kind: 'agent' as const, threadId: 'other-thread', runId: 'other-run' }
    expect(w.d.orch.steerThread(w.thread.id, 'from another agent', undefined, undefined, origin, 'ask')).toBe(true)
    await later(350)
    // Held (nothing pushed while the command runs), but not shown.
    expect(w.claude.inputs).toHaveLength(1)
    expect(w.held()).toBeUndefined()
    expect(await w.sendNow('now-agent', { waitsFor: 'Bash', tools: 1, since: '', holdGeneration: 1, itemIds: [], runId: w.runId })).toMatchObject({ status: 'accepted' })
    await waitFor(() => w.outcomes.length === 1, 'the click settled')
    expect(w.outcomes).toEqual([{ requestId: 'now-agent', outcome: 'stale' }])
    await later(250)
    expect(w.claude.interrupts).toBe(0)
    expect(w.claude.inputs).toHaveLength(1)
  })

  it('a person\'s steer with no queue item (a device with a permission limit) is saved as a queue row bound to the run while it is held, and Send now forces it', async () => {
    const w = await running()
    w.claude.emit(toolStart('bash-1', 'Bash', w.prompt), toolUse('bash-1', 'Bash', { command: 'sleep 30' }))
    await later(30)
    // A device with a limit steers through the same entry a window does (`orchestrator.steer`).
    expect(w.d.orch.steerThreadOrEnqueueExternal(w.thread.id, 'limited device steer', { permissionMode: 'ask' })).toMatchObject({ steered: true })
    await waitFor(() => w.held() !== undefined, 'held')
    // It was saved as a queue row bound to the run, `steering` from the start, with the device's limit: a crash while
    // it waits for the tool returns it once (`restartRecovery`, `steer-held-device`).
    const rows = readDurableQueue(w.d.store, w.thread.id)
    expect(rows).toEqual([expect.objectContaining({ content: 'limited device steer', state: 'steering', steerRunId: w.runId, permissionMode: 'ask' })])
    expect(w.held()).toMatchObject({ itemIds: [rows[0]!.id], waitsFor: 'Bash' })
    await w.sendNow('now-1')
    await waitFor(() => w.claude.interrupts === 1, 'interrupted')
    expect(w.pushed()).toEqual([expect.stringContaining('limited device steer')])
    expect(w.outcomes).toEqual([{ requestId: 'now-1', outcome: 'applied' }])
  })

  it('a run-bound steer (`orchestrator.steer` with its run) is saved as a queue row bound to the run while it is held', async () => {
    const w = await running()
    w.claude.emit(toolStart('bash-1', 'Bash', w.prompt), toolUse('bash-1', 'Bash', { command: 'sleep 30' }))
    await later(30)
    expect(await w.d.orch.steerRun(w.runId, 'run-bound steer', 'steer-1', w.thread.id)).toMatchObject({ status: 'accepted' })
    await waitFor(() => w.held() !== undefined, 'held')
    const rows = readDurableQueue(w.d.store, w.thread.id)
    expect(rows).toEqual([expect.objectContaining({ content: 'run-bound steer', state: 'steering', steerRunId: w.runId })])
    expect(w.held()?.itemIds).toEqual([rows[0]!.id])
    w.claude.emit(toolResult('bash-1'))
    await waitFor(() => w.claude.inputs.length === 2, 'pushed after the command')
    expect(w.pushed()).toEqual([expect.stringContaining('run-bound steer')])
  })

  it.each([
    ['before the model wrote anything: the steer is handed back and runs once more', false, 2],
    ['after the model began its answer: the steer is read, once', true, 1]
  ] as const)('Send now whose interrupt lands after Claude Code took the steer for its next request, aborted %s; the run ends at that aborted result, never stuck', async (_name, answered, sentTimes) => {
    const w = await running()
    w.claude.emit(toolStart('bash-1', 'Bash', w.prompt), toolUse('bash-1', 'Bash', { command: 'npm test' }))
    await later(30)
    await w.steer('use pnpm')
    await waitFor(() => w.held() !== undefined, 'held')
    w.claude.onInterrupt = (process) => {
      // The command had just ended and Claude Code had taken the steer for its next request: the interrupt aborts that
      // request, so the model never answers the steer and no result of its own follows.
      setTimeout(() => {
        process.emit(toolResult('bash-1'), lifecycle(process.uuid(1), 'started'), ...(answered ? [messageStart()] : []), resultFrame({ uuids: [w.prompt], terminalReason: 'aborted_streaming', error: 'interrupted' }))
      }, 0)
    }
    // What runs after: answered at once.
    w.claude.onInput = (message, process) => {
      if (message.priority !== 'now') process.answer(String(message.uuid), 'ok')
    }
    await w.sendNow('now-1')
    await waitFor(() => w.claude.interrupts === 1, 'Send now\'s interrupt')
    await waitFor(() => w.d.engine.getActiveRun(w.thread.id) === null && w.d.orch.listQueue(w.thread.id).length === 0 && !w.d.orch.isActiveTurnRunning(w.thread.id), 'the run ended and nothing waits').catch((error) => {
      throw new Error(`${(error as Error).message}: ${JSON.stringify({ active: w.d.engine.getActiveRun(w.thread.id)?.status, queue: w.d.orch.listQueue(w.thread.id).map((item) => [item.content, item.state]), running: w.d.orch.isActiveTurnRunning(w.thread.id), inputs: w.cli.processes.map((p) => p.inputs.map((_, i) => p.text(i).slice(0, 40))), phase: w.d.orch.getTurnState(w.thread.id).phase })}`)
    })
    await w.first.catch(() => undefined)
    await later(300)
    // Pushed once; handed back and run once more as a turn of its own when the model never wrote, read once when it did.
    expect(cliInputsWith(w.cli, 'use pnpm')).toBe(sentTimes)
    expect(w.inContext('use pnpm')).toBe(1)
    expect(w.claude.interrupts).toBe(1)
  })

  it('Send now with two tasks whose stop fails interrupts the turn once', async () => {
    const w = await running()
    w.claude.stopTaskFails = true
    w.claude.emit(
      toolStart('bash-1', 'Bash', w.prompt), toolUse('bash-1', 'Bash', { command: 'sleep 30' }), taskStarted('bash-1', 'task-1'),
      toolStart('bash-2', 'Bash', w.prompt), toolUse('bash-2', 'Bash', { command: 'sleep 30' }), taskStarted('bash-2', 'task-2')
    )
    await later(30)
    await w.steer('stop both')
    await waitFor(() => w.held()?.tools === 2, 'held for both')
    await w.sendNow('now-1')
    await waitFor(() => w.claude.stoppedTasks.length === 2, 'both stops tried')
    await later(250)
    expect(w.claude.interrupts).toBe(1)
  })

  it.each(['WebFetch', 'WebSearch'])('Send now during %s pushes the steer with no interrupt: the push alone ends it (S1), and background work keeps running', async (tool) => {
    const w = await running()
    w.claude.emit(toolStart('web-1', tool, w.prompt), toolUse('web-1', tool, tool === 'WebFetch' ? { url: 'https://example.com' } : { query: 'steer hold' }))
    await later(30)
    await w.steer('skip the page')
    await waitFor(() => w.held() !== undefined, 'held')
    await w.sendNow('now-1')
    await waitFor(() => w.claude.inputs.length === 2, 'pushed')
    await later(250)
    expect(w.pushed()).toEqual([expect.stringContaining('skip the page')])
    expect(w.claude.interrupts).toBe(0)
    expect(w.claude.stoppedTasks).toEqual([])
  })
})

/** How many messages sent to Claude Code, in every process, carry `text`. */
function cliInputsWith(cli: FakeClaudeCli, text: string): number {
  return cli.processes.reduce((count, process) => count + process.inputs.filter((_, index) => process.text(index).includes(text)).length, 0)
}
