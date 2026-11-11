/**
 * The steer hold on Claude Code (docs/design/steer-and-interruptions.md §2.4): a real orchestrator, run engine, Claude
 * adapter and provider service against a fake Claude Code process. A person's steer is not pushed while a `tool_use`
 * of the turn is open, from its `content_block_start` to its `tool_result`; it is pushed right after. Only foreground
 * subagents are moved to the background, each by its id, never with the call that has no id (it also moves a running
 * command, #874). Send now pushes the steer and then stops the command: by its task once Claude Code named one,
 * otherwise with an interrupt, because an immediate message waits for a running command (spike S1).
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { ClaudeSubscriptionAdapter } from '../../src/mms/harness/drivers/claudeCode/adapter'
import { FakeClaudeCli, SESSION, textDelta, toolResult, toolStart } from './fakeClaudeCli'
import { CLAUDE, phase6Daemon, waitFor } from './phase6Fixture'

vi.setConfig({ testTimeout: 60_000 })

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const taskStarted = (callId: string, taskId: string) => ({ type: 'system', subtype: 'task_started', session_id: SESSION, task_id: taskId, tool_use_id: callId, description: 'run it' })

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
    const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
      launchConfig: () => ({ binaryPath: binary }),
      query: cli.query,
      runAuth: vi.fn(async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
    })
    stops.push(async () => service.stop())
    const d = phase6Daemon(home, [new ClaudeSubscriptionAdapter(() => service)])
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
    return { d, cli, claude, thread, prompt, runId, first, steer, held, pushed }
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

  it('moves only foreground subagents, each by its id, then checks again: a command that starts during the move keeps the steer waiting', async () => {
    const w = await running()
    w.claude.emit(toolStart('agent-1', 'Agent', w.prompt))
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
    // Never the call with no id.
    expect(w.claude.backgroundCalls.every((id) => id === 'agent-1')).toBe(true)
  })

  it.each([['answers false', false], ['throws (background tasks are off)', 'throw']] as const)(
    'a subagent that cannot be moved (the move %s) is reported and waited for, without moving again', async (_name, answer) => {
      const w = await running()
      w.claude.backgroundAnswer = answer
      w.claude.emit(toolStart('agent-1', 'Agent', w.prompt))
      await later(30)
      await w.steer('after the subagent')
      await waitFor(() => w.held() !== undefined, 'held for the subagent')
      expect(w.held()?.waitsFor).toBe('Agent')
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
    const held = w.held()!
    expect(await w.d.orch.steerNow({ threadId: w.thread.id, runId: held.runId!, holdGeneration: held.holdGeneration, itemIds: held.itemIds, clientRequestId: 'now-1' })).toMatchObject({ status: 'accepted' })
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
    const held = w.held()!
    await w.d.orch.steerNow({ threadId: w.thread.id, runId: held.runId!, holdGeneration: held.holdGeneration, itemIds: held.itemIds, clientRequestId: 'now-1' })
    await waitFor(() => w.claude.stoppedTasks.length === 1, 'task stopped')
    expect(w.claude.stoppedTasks).toEqual(['task-9'])
    expect(w.claude.inputs).toHaveLength(2)
    expect(w.claude.interrupts).toBe(0)
  })
})
