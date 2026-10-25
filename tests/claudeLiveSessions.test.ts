/**
 * Issue #142: a Claude thread runs on a live query, so the helpers it started outlive a turn. These
 * tests drive the provider service against `FakeClaudeCli`, a peer that reads the prompt stream and
 * writes the frames a real Claude Code process would.
 */
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import {
  ClaudeSubscriptionProviderService,
  type ClaudeLiveHost,
  type ClaudeSubscriptionChatInput
} from '../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
import { LiveSession, type LiveTimings } from '../src/mms/providers/claudeSubscription/liveSession'
import { FakeClaudeCli, notification, resultFrame, roster, SESSION, textDelta, toolResult, toolStart } from './run/fakeClaudeCli'

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const homes: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function fixture(timings: Partial<LiveTimings> = {}, cli = new FakeClaudeCli()) {
  const home = mkdtempSync(join(tmpdir(), 'claude-live-test-'))
  homes.push(home)
  const binary = join(home, 'claude')
  writeFileSync(binary, 'fixture')
  chmodSync(binary, 0o755)
  mkdirSync(join(home, 'providers', 'claude-subscription'), { recursive: true })
  writeFileSync(join(home, 'providers', 'claude-subscription', 'settings.json'), JSON.stringify({ loginPolicy: 'cli', binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] }))
  const questions = new UserQuestionService()
  const service = new ClaudeSubscriptionProviderService(home, questions, {
    query: cli.query,
    live: { noticeDelayMs: 10, ...timings },
    runAuth: vi.fn(async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
  })
  const host = { backgroundWork: vi.fn<(threadId: string, active: boolean) => void>(), continuationStarted: vi.fn<NonNullable<ClaudeLiveHost['continuationStarted']>>(), notice: vi.fn<NonNullable<ClaudeLiveHost['notice']>>() }
  service.setLiveHost(host)
  const chat = (extra: Partial<ClaudeSubscriptionChatInput> = {}) =>
    service.chat({ threadId: 'thread', cwd: home, model: 'sonnet', prompt: 'hello', onText: vi.fn(), ...extra })
  /** One finished turn, committed the way the adapter commits it. */
  const turn = async (extra: Partial<ClaudeSubscriptionChatInput> = {}, history = '') => {
    const text = await chat({ history, ...extra })
    service.commitConversation(extra.threadId ?? 'thread', history)
    return text
  }
  return { home, service, cli, host, questions, chat, turn }
}

/** A turn whose prompt the process reads but never answers on its own. */
const silent = (cli: FakeClaudeCli) => {
  cli.reply = undefined
}
const inputs = (cli: FakeClaudeCli, count: number) => vi.waitFor(() => expect(cli.last.inputs.length).toBeGreaterThanOrEqual(count))

describe('a live Claude query', () => {
  it('serves three turns and a question preemption from one process, never resuming while it is live', async () => {
    const { cli, chat, turn, service, home } = fixture()
    for (const n of [1, 2, 3]) expect(await turn({ prompt: `turn ${n}` })).toBe(`reply to ${n}`)
    expect(cli.processes).toHaveLength(1)
    const process = cli.last
    expect(process.options.resume).toBeUndefined()
    expect(process.inputs.every((message) => message.uuid)).toBe(true)
    expect(process.inputEnded).toBe(false)

    // Question preemption: the turn is aborted, the process stays.
    process.onInput = null
    const preempt = new AbortController()
    const onText = vi.fn()
    const fourth = chat({ prompt: 'long', signal: preempt.signal, onText, history: '' })
    await inputs(cli, 4)
    process.emit(textDelta('working', process.uuid(3)))
    await vi.waitFor(() => expect(onText).toHaveBeenCalled())
    preempt.abort()
    await expect(fourth).rejects.toThrow()
    expect(process.interrupts).toBe(1)
    expect(process.closed).toBe(false)
    // The adapter fingerprints the stopped turn, so the next turn may reuse the process.
    service.commitInterrupted('thread', '')

    // The next turn runs on the same process; the result the interrupt produced is not its own.
    process.onInput = (message, self) => {
      if (message.priority === 'now') return
      self.emit(resultFrame({ uuids: [process.uuid(3)], terminalReason: 'aborted_streaming' }))
      self.answer(String(message.uuid), 'fifth answer')
    }
    expect(await chat({ prompt: 'fifth', history: '' })).toBe('fifth answer')
    expect(cli.processes).toHaveLength(1)
    expect(process.closed).toBe(false)
    void home
  })

  it('a turn aborted before Claude started its prompt cancels the queued prompt and keeps the process', async () => {
    const { cli, chat } = fixture()
    silent(cli)
    const abort = new AbortController()
    const turn = chat({ signal: abort.signal })
    await inputs(cli, 1)
    const process = cli.last
    abort.abort()
    await expect(turn).rejects.toThrow()
    // The interrupt asks Claude to drop what it has queued; the process is not closed for it.
    // A plain interrupt first; its receipt names the prompt as still queued, so it is cancelled by id.
    await vi.waitFor(() => expect(process.interruptOptions).toEqual([undefined, { cancelQueued: true }]))
    expect(process.closed).toBe(false)
    expect(process.queued).toEqual([])
    cli.reply = (message, self) => self.answer(String(message.uuid), 'next')
    expect(await chat({ history: '' })).toBe('next')
  })

  it.each([true, false])('question preemption during startup keeps a running helper alive (receipts %s)', async (receipts) => {
    const f = fixture()
    f.cli.reply = (message, process) => {
      process.emit(roster({ id: 'bash-1' }))
      process.answer(String(message.uuid), 'started')
    }
    await f.turn()
    const process = f.cli.last
    process.receipts = receipts
    f.cli.reply = undefined
    const abort = new AbortController()
    const second = f.chat({ signal: abort.signal, history: '' })
    await inputs(f.cli, 2)
    // The prompt is queued and Claude has not echoed it yet: this is the startup window.
    abort.abort()
    await expect(second).rejects.toThrow()
    await vi.waitFor(() => expect(process.interrupts).toBe(receipts ? 2 : 1))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(process.closed).toBe(false)
    expect(f.service.hasBackgroundWork('thread')).toBe(true)
  })

  it('closes the process for an aborted, never-started prompt only when Claude cannot cancel it and no helper is running', async () => {
    const { cli, chat, turn } = fixture()
    await turn()
    cli.last.receipts = false
    silent(cli)
    const abort = new AbortController()
    const second = chat({ signal: abort.signal, history: '' })
    await inputs(cli, 2)
    abort.abort()
    await expect(second).rejects.toThrow()
    await vi.waitFor(() => expect(cli.last.closed).toBe(true))
    cli.reply = (message, process) => process.answer(String(message.uuid), 'fresh')
    expect(await chat({ history: '' })).toBe('fresh')
    expect(cli.processes).toHaveLength(2)
  })

  it('keeps the Mousse credential on the live query, and a different credential needs a new process', async () => {
    const { cli, turn } = fixture()
    const mcp = (token: string) => ({ mcp: { url: 'http://127.0.0.1:9/mcp', token } })
    await turn(mcp('t1'))
    await turn(mcp('t1'))
    expect(cli.processes).toHaveLength(1)
    expect(JSON.stringify(cli.last.options.mcpServers)).toContain('t1')
    await turn(mcp('t2'))
    expect(cli.processes).toHaveLength(2)
    expect(JSON.stringify(cli.last.options.mcpServers)).toContain('t2')
  })

  it('applies new integrations when the process restarts: now when it is idle, later when background work keeps it', async () => {
    const f = fixture()
    const withServer = (name: string) => ({
      integrations: { mcpServers: { [name]: { type: 'stdio' as const, command: 'srv' } }, proxiedServers: {}, env: {}, warnings: [], toolRules: {} }
    })
    await f.turn(withServer('one'))
    await f.turn(withServer('two'))
    expect(f.cli.processes).toHaveLength(2)
    f.cli.reply = (message, process) => {
      process.emit(roster({ id: 'bash-1' }))
      process.answer(String(message.uuid), 'started')
    }
    await f.turn(withServer('two'))
    f.cli.reply = (message, process) => process.answer(String(message.uuid), 'again')
    // Background work is pending: the integrations change waits for the process to end.
    expect(await f.turn(withServer('three'))).toBe('again')
    expect(f.cli.processes).toHaveLength(2)
  })

  it('moves a steer into the live query as an immediate message and never interrupts, so helpers keep running', async () => {
    const { cli, service, chat, host } = fixture()
    silent(cli)
    const drainSteer = vi.fn<() => string | undefined>().mockReturnValueOnce('also do X').mockReturnValue(undefined)
    const onSteer = vi.fn()
    let ended = false
    const turn = chat({ drainSteer, onSteer }).finally(() => { ended = true })
    await inputs(cli, 1)
    const process = cli.last
    const first = process.uuid(0)
    process.emit(roster({ id: 'bash-1' }), textDelta('working', first))
    await inputs(cli, 2)
    expect(onSteer).toHaveBeenCalledExactlyOnceWith('also do X')
    expect(process.inputs[1]).toMatchObject({ priority: 'now' })
    expect(process.text(1)).toContain('also do X')
    expect(process.backgrounded).toBe(1)
    expect(process.interrupts).toBe(0)
    // The interrupt the steer causes ends no run; the run ends at the steer turn's own result.
    process.emit(resultFrame({ uuids: [first], terminalReason: 'aborted_streaming', queued: 1 }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(ended).toBe(false)
    const steerUuid = process.uuid(1)
    process.emit(textDelta('after steer', steerUuid), resultFrame({ uuids: [steerUuid], text: 'after steer' }))
    expect(await turn).toBe('working\n\nafter steer')
    expect(service.hasBackgroundWork('thread')).toBe(true)
    expect(host.backgroundWork).toHaveBeenCalledExactlyOnceWith('thread', true)
  })

  it('a steered run whose result already arrived is not steered: the text stays with the orchestrator', async () => {
    const hooks = { backgroundWork: vi.fn(), continuationStarted: vi.fn(), ended: vi.fn() }
    const session = new LiveSession('thread', hooks)
    const process = new FakeClaudeCli()
    session.attach(process.query({ prompt: session.queue, options: {} as never }))
    const run = session.beginRun(() => undefined)
    session.push(run, { type: 'user', message: { role: 'user', content: 'go' }, parent_tool_use_id: null, session_id: '' })
    await vi.waitFor(() => expect(process.last.inputs).toHaveLength(1))
    // (the default fake answers and ends the run)
    await run.done
    expect(await session.steer(run, 'too late')).toBe(false)
    expect(process.last.inputs).toHaveLength(1)
    session.close()
  })

  it('switches the permission mode for each turn: plan, then bypass on the same process', async () => {
    const { cli, turn } = fixture()
    await turn({ mode: 'plan' })
    const process = cli.last
    expect(process.options.permissionMode).toBe('plan')
    // A live query that may switch to bypass later is created with the flag even in plan mode.
    expect(process.options.allowDangerouslySkipPermissions).toBe(true)
    const hook = (name: string) => process.options.hooks!.PreToolUse![0].hooks[0](
      { hook_event_name: 'PreToolUse', tool_use_id: 't', tool_name: name, tool_input: {} } as never, 't', { signal: new AbortController().signal }
    )
    expect(await hook('Read')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask' } })
    await turn({ mode: 'default' })
    expect(cli.processes).toHaveLength(1)
    expect(process.permissionModes).toEqual(['bypassPermissions'])
    // The hook reads the turn that is running, not the one that created the query.
    expect(await hook('Read')).toEqual({})
  })

  it('keeps the read-only policy of a child on a live query', async () => {
    const { cli, turn } = fixture()
    await turn({ child: { readOnly: true } })
    const process = cli.last
    expect(process.options.permissionMode).toBe('default')
    expect(process.options.allowDangerouslySkipPermissions).toBeUndefined()
    const decision = await process.options.canUseTool!('Bash', { command: 'rm x' }, { signal: new AbortController().signal } as never)
    expect(decision).toMatchObject({ behavior: 'deny', message: expect.stringContaining('read-only') })
  })
})

describe('background work', () => {
  /** A turn that started a shell and finished; the shell is still running. */
  const withHelper = async (f: ReturnType<typeof fixture>, id = 'bash-1') => {
    f.cli.reply = (message, process) => {
      process.emit(roster({ id }))
      process.answer(String(message.uuid), 'started it')
    }
    expect(await f.turn()).toBe('started it')
    f.cli.reply = undefined
  }

  it('a helper outlives the turn, and the result reaches the parent through a continuation turn', async () => {
    const f = fixture()
    const events: string[] = []
    f.host.continuationStarted.mockImplementation((threadId, info) => {
      events.push(`wake ${info.taskIds.join(',')}`)
      void f.service.chat({ threadId, cwd: f.home, model: 'sonnet', prompt: '', continuation: true, onText: () => undefined }).then((text) => {
        events.push(`continuation ${text}`)
        f.service.commitConversation(threadId, '')
      })
    })
    await withHelper(f)
    expect(f.service.hasBackgroundWork('thread')).toBe(true)
    const process = f.cli.last
    // The helper finished long after the turn; Claude starts a turn of its own to read the report.
    process.emit(notification('bash-1'), textDelta('The build passed.'), resultFrame({ text: 'The build passed.', origin: 'task-notification' }))
    await vi.waitFor(() => expect(events).toContain('continuation The build passed.'))
    expect(events[0]).toBe('wake bash-1')
    expect(f.cli.processes).toHaveLength(1)
    // The notification is consumed and committed with the continuation run.
    await vi.waitFor(() => expect(f.service.hasBackgroundWork('thread')).toBe(false))
    expect(f.host.backgroundWork.mock.calls).toEqual([['thread', true], ['thread', false]])
  })

  it('an empty roster before the notification does not end the obligation', async () => {
    const f = fixture()
    await withHelper(f)
    f.cli.last.emit(roster())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(f.service.hasBackgroundWork('thread')).toBe(true)
    expect(f.host.backgroundWork).toHaveBeenCalledTimes(1)
  })

  it('a helper that finishes during the turn is consumed there and discharged when the turn commits, with no continuation', async () => {
    const f = fixture()
    f.cli.reply = (message, process) => {
      process.emit(roster({ id: 'agent-1', type: 'local_agent' }), notification('agent-1'))
      process.answer(String(message.uuid), 'agent said hi')
    }
    const text = await f.chat()
    expect(text).toBe('agent said hi')
    // Still owed until the turn commits.
    expect(f.service.hasBackgroundWork('thread')).toBe(true)
    f.service.commitConversation('thread', '')
    expect(f.service.hasBackgroundWork('thread')).toBe(false)
    expect(f.host.continuationStarted).not.toHaveBeenCalled()
    expect(f.host.backgroundWork.mock.calls).toEqual([['thread', true], ['thread', false]])
  })

  it('a notification for a task the process never listed wakes nothing and keeps nothing busy', async () => {
    const f = fixture()
    await f.turn()
    f.cli.last.emit(notification('mystery'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(f.host.continuationStarted).not.toHaveBeenCalled()
    expect(f.service.hasBackgroundWork('thread')).toBe(false)
    // Ambient tasks are not activity.
    f.cli.last.emit(roster({ id: 'watcher', ambient: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(f.service.hasBackgroundWork('thread')).toBe(false)
  })

  it('a wake that folds in a pending prompt settles that prompt once and opens no continuation', async () => {
    const f = fixture()
    await withHelper(f)
    const process = f.cli.last
    const pending = f.chat({ prompt: 'U', history: '' })
    await inputs(f.cli, 2)
    const uuid = process.uuid(1)
    // The task finishes while U waits; Claude folds U into its own turn and echoes it on one result.
    process.emit(notification('bash-1'), textDelta('folded answer', uuid), resultFrame({ uuids: [uuid], text: 'folded answer', origin: 'task-notification' }))
    expect(await pending).toBe('folded answer')
    expect(f.host.continuationStarted).not.toHaveBeenCalled()
    expect(f.service.hasBackgroundWork('thread')).toBe(true)
    f.service.commitConversation('thread', '')
    expect(f.service.hasBackgroundWork('thread')).toBe(false)
  })

  it('a prompt pushed while a wake turn is in flight gets its own text; the wake turn is a continuation of its own', async () => {
    const f = fixture()
    await withHelper(f)
    const process = f.cli.last
    process.emit(notification('bash-1'), textDelta('wake text'))
    await vi.waitFor(() => expect(f.host.continuationStarted).toHaveBeenCalledTimes(1))
    const mine = f.chat({ prompt: 'mine', history: '' })
    await inputs(f.cli, 2)
    // The wake turn ends first (no echo of ours), then Claude answers the pushed prompt.
    process.emit(resultFrame({ text: 'wake text', origin: 'task-notification' }))
    process.answer(process.uuid(1), 'my text')
    expect(await mine).toBe('my text')
    const continuation = await f.service.chat({ threadId: 'thread', cwd: f.home, model: 'sonnet', prompt: '', continuation: true, onText: () => undefined })
    expect(continuation).toBe('wake text')
  })

  it('a wake with no model turn ends its continuation at the empty notification result', async () => {
    const f = fixture()
    await withHelper(f)
    f.cli.last.emit(notification('bash-1'), resultFrame({ text: '', origin: 'task-notification', numTurns: 0 }))
    await vi.waitFor(() => expect(f.host.continuationStarted).toHaveBeenCalledTimes(1))
    const onText = vi.fn()
    // The host's run arrives after the continuation is already over and still gets it.
    const text = await f.service.chat({ threadId: 'thread', cwd: f.home, model: 'sonnet', prompt: '', continuation: true, onText })
    expect(text).toBe('')
    f.service.commitConversation('thread', '')
    expect(f.service.hasBackgroundWork('thread')).toBe(false)
  })

  it('a notification result with no turn of its own ends no Mousse run', async () => {
    const f = fixture()
    await withHelper(f)
    const process = f.cli.last
    const pending = f.chat({ prompt: 'U', history: '' })
    await inputs(f.cli, 2)
    process.emit(notification('bash-1'), resultFrame({ text: '', origin: 'task-notification', numTurns: 0 }))
    let done = false
    void pending.then(() => { done = true })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(done).toBe(false)
    process.answer(process.uuid(1), 'U answered')
    expect(await pending).toBe('U answered')
  })

  it('a wake whose turn never starts ends after the deadline with a note', async () => {
    vi.useFakeTimers()
    const f = fixture({ wakeDeadlineMs: 120_000 })
    await withHelper(f)
    f.cli.last.emit(notification('bash-1'))
    await vi.waitFor(() => expect(f.host.continuationStarted).toHaveBeenCalledTimes(1))
    const continuation = f.service.chat({ threadId: 'thread', cwd: f.home, model: 'sonnet', prompt: '', continuation: true, onText: () => undefined })
    await vi.advanceTimersByTimeAsync(120_001)
    expect(await continuation).toContain('did not respond')
  })

  it('attributes the tool calls of a continuation to the continuation run and checks them with its policy', async () => {
    const f = fixture()
    await withHelper(f)
    const process = f.cli.last
    const tools: string[] = []
    // Frames of the wake turn arrive before its run exists, and more after.
    process.emit(notification('bash-1'), toolStart('wake-tool', 'Read'))
    await vi.waitFor(() => expect(f.host.continuationStarted).toHaveBeenCalledTimes(1))
    const continuation = f.service.chat({
      threadId: 'thread', cwd: f.home, model: 'sonnet', prompt: '', continuation: true, onText: () => undefined,
      integrations: { mcpServers: {}, proxiedServers: {}, env: {}, warnings: [], toolRules: { mcp__srv__: { denied: ['danger'] } } },
      onTool: (event) => tools.push(`${event.phase}:${event.callId}`)
    })
    process.emit(toolResult('wake-tool'), resultFrame({ text: 'read it', origin: 'task-notification' }))
    expect(await continuation).toBe('read it')
    expect(tools).toEqual(['start:wake-tool', 'complete:wake-tool'])
    // The query's hook now follows the continuation's own rules.
    const denied = await process.options.hooks!.PreToolUse![0].hooks[0](
      { hook_event_name: 'PreToolUse', tool_use_id: 'x', tool_name: 'mcp__srv__danger', tool_input: {} } as never, 'x', { signal: new AbortController().signal }
    )
    expect(denied).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  })

  it('without a host a wake is stopped the moment it starts, so no hidden turn runs, and nothing it would have read is discharged', async () => {
    const f = fixture()
    f.service.setLiveHost(null)
    await withHelper(f)
    const process = f.cli.last
    expect(f.service.hasBackgroundWork('thread')).toBe(true)
    process.emit(notification('bash-1'))
    await later(30)
    // Nobody read the report, so the task is still owed (the idle caps end it); a discard never discharges.
    expect(f.service.hasBackgroundWork('thread')).toBe(true)
    expect(process.interrupts).toBe(0)
    // Claude starts its own turn; nobody could read it, so it is interrupted at its first frame.
    process.emit(textDelta('hidden work'))
    await vi.waitFor(() => expect(process.interrupts).toBe(1))
    process.emit(resultFrame({ text: 'hidden work', origin: 'task-notification' }))
    // The next turn runs on the same process and gets only its own text.
    f.cli.reply = (message, self) => self.answer(String(message.uuid), 'my turn')
    expect(await f.chat({ history: '' })).toBe('my turn')
    expect(f.cli.processes).toHaveLength(1)
  })
})

describe('Stop and process lifetime', () => {
  it('Stop closes the live query, ends its background work and clears the obligations, even after the turn ended', async () => {
    const f = fixture()
    f.cli.reply = (message, process) => {
      process.emit(roster({ id: 'bash-1' }))
      process.answer(String(message.uuid), 'started')
    }
    await f.turn()
    expect(f.service.hasBackgroundWork('thread')).toBe(true)
    expect(f.service.stopThread('thread')).toBe('stopped')
    expect(f.cli.last.closed).toBe(true)
    expect(f.service.hasBackgroundWork('thread')).toBe(false)
    expect(f.host.backgroundWork).toHaveBeenLastCalledWith('thread', false)
    expect(f.service.stopThread('thread')).toBe('not_active')
    // The next turn starts a new process.
    await f.turn()
    expect(f.cli.processes).toHaveLength(2)
  })

  it('refuses a model, folder or instruction change while background work exists, and replaces the process when there is none', async () => {
    const f = fixture()
    f.cli.reply = (message, process) => {
      process.emit(roster({ id: 'bash-1' }))
      process.answer(String(message.uuid), 'started')
    }
    await f.turn()
    f.cli.reply = undefined
    for (const change of [{ model: 'opus' }, { systemPromptAppend: 'new rules' }, { cwd: join(f.home, 'other') }])
      await expect(f.chat({ history: '', ...change })).rejects.toMatchObject({ code: 'claude_background_work_blocks_change', message: expect.stringContaining('Stop') })
    expect(f.cli.processes).toHaveLength(1)
    expect(f.cli.last.closed).toBe(false)
    expect(f.service.hasBackgroundWork('thread')).toBe(true)
    // After Stop the same change just starts a new process.
    f.service.stopThread('thread')
    f.cli.reply = (message, process) => process.answer(String(message.uuid), 'on opus')
    expect(await f.chat({ model: 'opus', history: '' })).toBe('on opus')
    expect(f.cli.processes).toHaveLength(2)
  })

  it('a process that dies ends its obligations and the next turn starts a new one that resumes the session', async () => {
    const f = fixture()
    f.cli.reply = (message, process) => {
      process.emit(roster({ id: 'bash-1' }))
      process.answer(String(message.uuid), 'started')
    }
    await f.turn()
    expect(f.service.hasBackgroundWork('thread')).toBe(true)
    f.cli.last.end()
    await vi.waitFor(() => expect(f.service.hasBackgroundWork('thread')).toBe(false))
    expect(f.host.backgroundWork).toHaveBeenLastCalledWith('thread', false)
    f.cli.reply = (message, process) => process.answer(String(message.uuid), 'back')
    expect(await f.chat({ history: '' })).toBe('back')
    expect(f.cli.processes).toHaveLength(2)
    expect(f.cli.last.options.resume).toBe(SESSION)
  })

  it('a turn on a process that dies mid-turn fails with the usual message', async () => {
    const f = fixture()
    silent(f.cli)
    const turn = f.chat()
    await inputs(f.cli, 1)
    f.cli.last.end()
    await expect(turn).rejects.toThrow('Claude Code ended before completing the turn')
  })

  it('a stopped turn is resumed warm: the same process takes the next turn', async () => {
    const f = fixture()
    await f.turn({ history: 'h0' }, 'h0')
    f.cli.reply = undefined
    const abort = new AbortController()
    const stopped = f.chat({ signal: abort.signal, history: 'h0' })
    await inputs(f.cli, 2)
    f.cli.last.emit(textDelta('partial', f.cli.last.uuid(1)))
    await new Promise((resolve) => setTimeout(resolve, 20))
    abort.abort()
    await expect(stopped).rejects.toThrow()
    // The adapter fingerprints the stopped turn as the history the next turn will send.
    f.service.commitInterrupted('thread', 'h1')
    f.cli.reply = (message, process) => {
      process.emit(resultFrame({ uuids: [f.cli.last.uuid(1)], terminalReason: 'aborted_streaming' }))
      process.answer(String(message.uuid), 'next')
    }
    expect(await f.chat({ history: 'h1' })).toBe('next')
    expect(f.cli.processes).toHaveLength(1)
  })
})

describe('idle release and the cap on live processes', () => {
  it('closes an idle thread with no background work after the idle timeout, and the next turn resumes the session', async () => {
    vi.useFakeTimers()
    const f = fixture({ idleCloseMs: 1000 })
    await f.turn({ history: 'h' }, 'h')
    expect(f.service.liveThreadIds()).toEqual(['thread'])
    await vi.advanceTimersByTimeAsync(999)
    expect(f.cli.last.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(f.cli.last.closed).toBe(true)
    expect(f.service.liveThreadIds()).toEqual([])
    await f.turn({ history: 'h' }, 'h')
    expect(f.cli.processes).toHaveLength(2)
    // Resumed like a one-shot turn: no replayed history in the prompt.
    expect(f.cli.last.options.resume).toBe(SESSION)
    expect(f.cli.last.text(0)).not.toContain('Previous conversation')
  })

  it('a main thread with no background work changes model exactly as before: a fresh process with the history in the prompt', async () => {
    const f = fixture()
    await f.turn({ history: 'earlier turns' }, 'earlier turns')
    await f.turn({ model: 'opus:medium', history: 'earlier turns' }, 'earlier turns')
    expect(f.cli.processes).toHaveLength(2)
    expect(f.cli.processes[0].closed).toBe(true)
    expect(f.cli.last.options).toMatchObject({ model: 'opus', resume: undefined })
    expect(f.cli.last.text(0)).toContain('Previous conversation')
    expect(f.cli.last.text(0)).toContain('earlier turns')
  })

  it('keeps the process while background work is pending, and releases it at the pin cap counted from when it became owed, however active the process is', async () => {
    vi.useFakeTimers()
    const f = fixture({ idleCloseMs: 1000, idleReleaseMs: 5000, maxPinMs: 12_000 })
    f.cli.reply = (message, process) => {
      process.emit(roster({ id: 'bash-1' }))
      process.answer(String(message.uuid), 'started')
    }
    await f.turn()
    const process = f.cli.last
    // The short idle close does not apply while work is pending.
    await vi.advanceTimersByTimeAsync(4000)
    expect(process.closed).toBe(false)
    // Provider activity keeps the idle clock going but does not move the cap.
    for (let elapsed = 4000; elapsed < 11_000; elapsed += 1000) {
      process.emit({ type: 'system', subtype: 'task_progress', session_id: SESSION, task_id: 'bash-1' })
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(process.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1500)
    expect(process.closed).toBe(true)
    expect(f.service.hasBackgroundWork('thread')).toBe(false)
    expect(f.host.backgroundWork).toHaveBeenLastCalledWith('thread', false)
  })

  it('caps live processes: the least recently used idle one is closed, and a turn with none to close runs as a one-shot query', async () => {
    const f = fixture({ maxSessions: 2 })
    await f.turn({ threadId: 'a' })
    await f.turn({ threadId: 'b' })
    await f.turn({ threadId: 'c' })
    expect(f.cli.processes[0].closed).toBe(true)
    expect(f.service.liveThreadIds().sort()).toEqual(['b', 'c'])

    // Both remaining threads are needed: b has background work, c a turn in flight.
    f.cli.reply = (message, process) => {
      process.emit(roster({ id: 'bash-1' }))
      process.answer(String(message.uuid), 'started')
    }
    await f.turn({ threadId: 'b' })
    f.cli.reply = undefined
    const running = f.chat({ threadId: 'c', prompt: 'busy', history: '' })
    const [, , busy] = f.cli.processes
    await vi.waitFor(() => expect(busy.inputs).toHaveLength(2))
    f.cli.reply = (message, process) => process.answer(String(message.uuid), 'one-shot')
    const before = f.cli.processes.length
    expect(await f.turn({ threadId: 'd' })).toBe('one-shot')
    expect(f.cli.processes).toHaveLength(before + 1)
    // A one-shot query's prompt ends with its turn, which ends the process.
    await vi.waitFor(() => expect(f.cli.last.inputEnded).toBe(true))
    expect(f.service.liveThreadIds().sort()).toEqual(['b', 'c'])
    busy.answer(busy.uuid(1), 'busy done')
    expect(await running).toBe('busy done')
  })
})

describe('result routing and steering edge cases', () => {
  const helper = (f: ReturnType<typeof fixture>) => {
    f.cli.reply = (message, process) => {
      process.emit(roster({ id: 'bash-1' }))
      process.answer(String(message.uuid), 'started')
    }
  }
  /** One finished turn that left a shell running; the process then answers nothing on its own. */
  const withHelperTurn = async (f: ReturnType<typeof fixture>) => {
    helper(f)
    await f.turn()
    f.cli.reply = undefined
  }

  it('a result that echoes the id of a finished turn belongs to no one and never ends the turn that is waiting', async () => {
    const f = fixture()
    await f.turn({ prompt: 'A' })
    const process = f.cli.last
    f.cli.reply = undefined
    let done = false
    const b = f.chat({ prompt: 'B', history: '' }).then((text) => {
      done = true
      return text
    })
    await inputs(f.cli, 2)
    process.emit(resultFrame({ uuids: [process.uuid(0)], text: 'late result of A' }))
    await later(30)
    expect(done).toBe(false)
    process.answer(process.uuid(1), 'B text')
    expect(await b).toBe('B text')
  })

  it('a live turn reports a Mousse subagent call with its bounded record: marked at the start, named once the input is known, closed with the result', async () => {
    const f = fixture()
    const events: Array<Record<string, unknown>> = []
    f.cli.reply = (message, process) => {
      const uuid = String(message.uuid)
      const name = 'mcp__mousse__delegate_task'
      process.emit(
        toolStart('call-1', name, uuid),
        { type: 'assistant', session_id: SESSION, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name, input: { title: 'Reviewer' } }] } },
        {
          type: 'user', session_id: SESSION, parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: JSON.stringify({ started: true, delegationId: 'd-1', title: 'Reviewer' }) }] }
        }
      )
      process.answer(uuid, 'delegated')
    }
    await f.chat({ onTool: (event) => events.push(event as never) })
    expect(events.map((event) => event.phase)).toEqual(['start', 'start', 'complete'])
    expect(events[0]).toMatchObject({ record: { input: { recordVersion: 1 } } })
    expect(events[1]).toMatchObject({ record: { input: { title: 'Reviewer' } } })
    expect(events[2]).toMatchObject({ record: { response: expect.stringContaining('d-1') } })
  })

  it('routes the unstamped frames of a turn to it, and drops late ones that no turn is waiting for', async () => {
    const f = fixture()
    f.cli.reply = (message, process) => process.answer(String(message.uuid), 'abc', ['a', 'b', 'c'])
    expect(await f.turn()).toBe('abc')
    f.cli.last.emit(textDelta('late'))
    f.cli.reply = (message, process) => process.answer(String(message.uuid), 'second')
    expect(await f.turn({ history: '' })).toBe('second')
  })

  it('a steered turn ignores an abort result even when Claude echoes no id on it', async () => {
    const f = fixture()
    silent(f.cli)
    const drainSteer = vi.fn<() => string | undefined>().mockReturnValueOnce('steer').mockReturnValue(undefined)
    let ended = false
    const turn = f.chat({ drainSteer }).finally(() => { ended = true })
    await inputs(f.cli, 1)
    const process = f.cli.last
    process.emit(textDelta('x', process.uuid(0)))
    await inputs(f.cli, 2)
    process.emit(resultFrame({ terminalReason: 'aborted_streaming', queued: 1 }))
    await later(30)
    expect(ended).toBe(false)
    process.emit(textDelta('after'), resultFrame({ uuids: [process.uuid(1)], text: 'after' }))
    expect(await turn).toBe('x\n\nafter')
  })

  it('a steer still waiting for foreground work when the turn result arrives is not pushed: it is handed back as the next turn', async () => {
    const f = fixture()
    silent(f.cli)
    let open!: () => void
    const drainSteer = vi.fn<() => string | undefined>().mockReturnValueOnce('late steer').mockReturnValue(undefined)
    const onSteer = vi.fn()
    const returnSteer = vi.fn()
    const turn = f.chat({ drainSteer, onSteer, returnSteer })
    await inputs(f.cli, 1)
    const process = f.cli.last
    process.backgroundGate = new Promise<void>((resolve) => { open = resolve })
    process.emit(textDelta('answer', process.uuid(0)))
    await vi.waitFor(() => expect(process.backgrounded).toBe(1))
    // The result arrives while the steer waits for the foreground work to move.
    process.emit(resultFrame({ uuids: [process.uuid(0)], text: 'answer' }))
    await later(30)
    open()
    expect(await turn).toBe('answer')
    expect(process.inputs).toHaveLength(1)
    expect(returnSteer).toHaveBeenCalledExactlyOnceWith('late steer', undefined)
    expect(onSteer).not.toHaveBeenCalled()
  })

  it('a steer collected while the process is still being set up is delivered after the turn is pushed', async () => {
    const f = fixture()
    await f.turn({ mode: 'plan', history: 'h' }, 'h')
    const process = f.cli.last
    // The turn switches the permission mode before it pushes its prompt; that takes a while.
    process.permissionGate = later(250)
    silent(f.cli)
    const drainSteer = vi.fn<() => string | undefined>().mockReturnValueOnce('early steer').mockReturnValue(undefined)
    const onSteer = vi.fn()
    const turn = f.chat({ mode: 'default', history: 'h', drainSteer, onSteer })
    await later(150)
    // Nothing was collected, or dropped, while the prompt was not pushed yet.
    expect(drainSteer).not.toHaveBeenCalled()
    await inputs(f.cli, 3)
    expect(process.inputs[2]).toMatchObject({ priority: 'now' })
    expect(process.text(2)).toContain('early steer')
    expect(onSteer).toHaveBeenCalledExactlyOnceWith('early steer')
    process.emit(resultFrame({ uuids: [process.uuid(1), process.uuid(2)], text: 'ok' }))
    expect(await turn).toBe('ok')
  })

  /** Turn two reads the helper's notification and is cut off by a plain interrupt (nothing of it is unechoed). */
  const cutOffAfterNotification = async (f: ReturnType<typeof fixture>) => {
    helper(f)
    await f.turn({ history: 'h' }, 'h')
    const process = f.cli.last
    f.cli.reply = undefined
    const abort = new AbortController()
    const second = f.chat({ signal: abort.signal, history: 'h' })
    await inputs(f.cli, 2)
    process.emit(textDelta('working', process.uuid(1)), notification('bash-1'))
    await later(20)
    abort.abort()
    await expect(second).rejects.toThrow()
    f.service.commitInterrupted('thread', 'h')
    return process
  }

  it('after a plain interrupt the wake for a notification the cut-off turn read opens a continuation, which commits it', async () => {
    const f = fixture()
    const process = await cutOffAfterNotification(f)
    expect(process.interruptOptions).toEqual([undefined])
    // Still owed: no turn saw the report.
    expect(f.service.hasBackgroundWork('thread')).toBe(true)
    expect(f.host.continuationStarted).not.toHaveBeenCalled()
    // Claude had the notification queued, so it starts a wake turn: it must not run unseen.
    process.emit(resultFrame({ uuids: [process.uuid(1)], terminalReason: 'aborted_streaming' }))
    process.emit(textDelta('The helper finished.'))
    await vi.waitFor(() => expect(f.host.continuationStarted).toHaveBeenCalledTimes(1))
    process.emit(resultFrame({ text: 'The helper finished.', origin: 'task-notification' }))
    const text = await f.service.chat({ threadId: 'thread', cwd: f.home, model: 'sonnet', prompt: '', continuation: true, onText: () => undefined })
    expect(text).toBe('The helper finished.')
    f.service.commitConversation('thread', '')
    expect(f.service.hasBackgroundWork('thread')).toBe(false)
  })

  it('a turn that did not see a helper\'s notification never commits it', async () => {
    const f = fixture()
    const process = await cutOffAfterNotification(f)
    f.cli.reply = (message, self) => {
      self.emit(resultFrame({ uuids: [self.uuid(1)], terminalReason: 'aborted_streaming' }))
      self.answer(String(message.uuid), 'third')
    }
    expect(await f.turn({ history: 'h' }, 'h')).toBe('third')
    // The next turn committed, but it never saw the report: the task is still owed.
    expect(f.service.hasBackgroundWork('thread')).toBe(true)
    expect(process.closed).toBe(false)
  })

  it('a cancel that also drops queued messages may have dropped the notification: the task stays owed, is not committed, and the thread is told', async () => {
    const f = fixture()
    helper(f)
    await f.turn({ history: 'h' }, 'h')
    const process = f.cli.last
    f.cli.reply = undefined
    const abort = new AbortController()
    const second = f.chat({
      history: 'h',
      signal: abort.signal,
      drainSteer: vi.fn<() => string | undefined>().mockReturnValueOnce('queued steer').mockReturnValue(undefined)
    })
    await inputs(f.cli, 2)
    process.emit(textDelta('working', process.uuid(1)), notification('bash-1'))
    // The steer reaches Claude's queue but Claude has not started it.
    await inputs(f.cli, 3)
    abort.abort()
    await expect(second).rejects.toThrow()
    f.service.commitInterrupted('thread', 'h')
    expect(process.interruptOptions).toEqual([undefined, { cancelQueued: true }])
    await vi.waitFor(() => expect(f.host.notice).toHaveBeenCalledExactlyOnceWith('thread', expect.stringMatching(/may not have been delivered.*stays waiting.*Stop releases it now/)))
    f.cli.reply = (message, self) => {
      self.emit(resultFrame({ uuids: [self.uuid(1)], terminalReason: 'aborted_streaming' }))
      self.answer(String(message.uuid), 'third')
    }
    await f.turn({ history: 'h' }, 'h')
    expect(f.service.hasBackgroundWork('thread')).toBe(true)
    expect(f.host.continuationStarted).not.toHaveBeenCalled()
  })

  it('a steer Claude already folded into the turn is not queued: Stop interrupts plainly, the notification survives and its wake runs', async () => {
    const f = fixture()
    helper(f)
    await f.turn({ history: 'h' }, 'h')
    const process = f.cli.last
    f.cli.reply = undefined
    const abort = new AbortController()
    const second = f.chat({
      history: 'h',
      signal: abort.signal,
      drainSteer: vi.fn<() => string | undefined>().mockReturnValueOnce('steer').mockReturnValue(undefined)
    })
    await inputs(f.cli, 2)
    process.emit(textDelta('working', process.uuid(1)), notification('bash-1'))
    await inputs(f.cli, 3)
    // Claude took the steer into the running turn; later frames carry only the prompt's id.
    process.markStarted(process.uuid(2))
    abort.abort()
    await expect(second).rejects.toThrow()
    await vi.waitFor(() => expect(process.interrupts).toBe(1))
    expect(process.interruptOptions).toEqual([undefined])
    await later(30)
    expect(f.host.notice).not.toHaveBeenCalled()
    // The notification was not dropped: Claude starts the wake it owes, and it opens a continuation.
    process.emit(resultFrame({ uuids: [process.uuid(1), process.uuid(2)], terminalReason: 'aborted_streaming' }))
    process.emit(textDelta('The helper finished.'))
    await vi.waitFor(() => expect(f.host.continuationStarted).toHaveBeenCalledTimes(1))
  })

  it('the wake a cut-off turn owes is not swallowed by a message pushed before it', async () => {
    const f = fixture()
    const process = await cutOffAfterNotification(f)
    f.cli.reply = undefined
    let done = false
    const mine = f.chat({ prompt: 'mine', history: 'h' }).then((text) => { done = true; return text })
    await inputs(f.cli, 3)
    process.emit(resultFrame({ uuids: [process.uuid(1)], terminalReason: 'aborted_streaming' }))
    // The wake begins before Claude takes the message: its first frame names no one.
    process.emit(textDelta('wake text'))
    await vi.waitFor(() => expect(f.host.continuationStarted).toHaveBeenCalledTimes(1))
    process.emit(resultFrame({ text: 'wake text', origin: 'task-notification' }))
    await later(30)
    expect(done).toBe(false)
    process.answer(process.uuid(2), 'my answer')
    expect(await mine).toBe('my answer')
    const wake = await f.service.chat({ threadId: 'thread', cwd: f.home, model: 'sonnet', prompt: '', continuation: true, onText: () => undefined })
    expect(wake).toBe('wake text')
  })

  it('a blocking error for a lost task says the result may never arrive and that Stop releases it', async () => {
    const f = fixture()
    helper(f)
    await f.turn({ history: 'h' }, 'h')
    const process = f.cli.last
    f.cli.reply = undefined
    const abort = new AbortController()
    const second = f.chat({
      history: 'h',
      signal: abort.signal,
      drainSteer: vi.fn<() => string | undefined>().mockReturnValueOnce('queued steer').mockReturnValue(undefined)
    })
    await inputs(f.cli, 2)
    process.emit(textDelta('working', process.uuid(1)), notification('bash-1'))
    await inputs(f.cli, 3)
    abort.abort()
    await expect(second).rejects.toThrow()
    f.service.commitInterrupted('thread', 'h')
    // The cancel runs asynchronously: the tasks are lost once it has.
    await vi.waitFor(() => expect(f.host.notice).toHaveBeenCalled())
    await expect(f.chat({ history: 'h', model: 'opus' })).rejects.toMatchObject({
      message: expect.stringMatching(/may not arrive.*Press Stop to release it now/)
    })
    await expect(f.chat({ history: 'h', model: 'opus' })).rejects.not.toMatchObject({ message: expect.stringContaining('Wait for it to finish') })
  })

  it('what a discarded wake left is cleared by the next turn that begins afterwards and commits, not before', async () => {
    const f = fixture()
    f.service.setLiveHost(null)
    await withHelperTurn(f)
    const process = f.cli.last
    process.emit(notification('bash-1'))
    await later(30)
    expect(f.service.hasBackgroundWork('thread')).toBe(true)
    // The model may not be changed meanwhile, and the error says what to do.
    await expect(f.chat({ history: '', model: 'opus' })).rejects.toMatchObject({ message: expect.stringContaining('Press Stop') })
    f.cli.reply = (message, self) => self.answer(String(message.uuid), 'next')
    expect(await f.chat({ history: '' })).toBe('next')
    // Not committed yet: the turn has to commit.
    expect(f.service.hasBackgroundWork('thread')).toBe(true)
    f.service.commitConversation('thread', '')
    expect(f.service.hasBackgroundWork('thread')).toBe(false)
  })

  it('a cancel that swept the queue makes every carried task lost, not only the ones the cancelled turn read', async () => {
    const f = fixture()
    const process = await cutOffAfterNotification(f)
    f.cli.reply = undefined
    const abort = new AbortController()
    // A later turn, which read nothing, is cancelled with a steer Claude has not started.
    const third = f.chat({
      history: 'h',
      signal: abort.signal,
      drainSteer: vi.fn<() => string | undefined>().mockReturnValueOnce('queued steer').mockReturnValue(undefined)
    })
    await inputs(f.cli, 4)
    abort.abort()
    await expect(third).rejects.toThrow()
    f.service.commitInterrupted('thread', 'h')
    await vi.waitFor(() => expect(process.interruptOptions).toEqual([undefined, undefined, { cancelQueued: true }]))
    await vi.waitFor(() => expect(f.host.notice).toHaveBeenCalledExactlyOnceWith('thread', expect.stringContaining('four-hour limit')))
    await expect(f.chat({ history: 'h', model: 'opus' })).rejects.toMatchObject({ message: expect.stringMatching(/may not arrive/) })
  })

  it('a discarded wake never discharges anything, not even what a cut-off turn left for it', async () => {
    const f = fixture()
    const process = await cutOffAfterNotification(f)
    f.service.setLiveHost(null)
    process.emit(resultFrame({ uuids: [process.uuid(1)], terminalReason: 'aborted_streaming' }))
    // The wake Claude owes for the notification starts; there is no host to run it, so it is stopped.
    process.emit(textDelta('hidden work'))
    await vi.waitFor(() => expect(process.interrupts).toBe(2))
    process.emit(resultFrame({ text: 'hidden work', origin: 'task-notification' }))
    await later(30)
    expect(f.service.hasBackgroundWork('thread')).toBe(true)
    await vi.waitFor(() => expect(f.host.notice).not.toHaveBeenCalled())
  })

  it('a steer still queued when a steered continuation is cancelled is cancelled with it, or stays owned', async () => {
    for (const receipts of [true, false]) {
      const f = fixture()
      await withHelperTurn(f)
      const process = f.cli.last
      process.receipts = receipts
      process.emit(notification('bash-1'), textDelta('reading the report'))
      await vi.waitFor(() => expect(f.host.continuationStarted).toHaveBeenCalledTimes(1))
      const abort = new AbortController()
      const continuation = f.service.chat({
        threadId: 'thread', cwd: f.home, model: 'sonnet', prompt: '', continuation: true, onText: () => undefined, signal: abort.signal,
        drainSteer: vi.fn<() => string | undefined>().mockReturnValueOnce('queued steer').mockReturnValue(undefined)
      })
      // The steer reaches Claude's queue; Claude has not started it.
      await inputs(f.cli, 2)
      const steer = process.uuid(1)
      abort.abort()
      await expect(continuation).rejects.toThrow()
      await vi.waitFor(() => expect(process.interrupts).toBe(receipts ? 2 : 1))
      // Claude is asked to cancel it; a Claude that cannot says so, and the cancelled wake keeps owning it.
      expect(process.interruptOptions).toEqual(receipts ? [undefined, { cancelQueued: true }] : [undefined])
      const session = (f.service as unknown as { live: Map<string, { owedResults: number }> }).live.get('thread')!
      if (receipts) {
        expect(process.queued).toEqual([])
        await vi.waitFor(() => expect(session.owedResults).toBe(0))
      } else {
        expect(session.owedResults).toBe(1)
        // The steer's own result belongs to the cancelled wake, not to the next turn.
        f.service.commitInterrupted('thread', '')
        f.cli.reply = undefined
        let done = false
        const next = f.chat({ history: '' }).then((text) => { done = true; return text })
        await inputs(f.cli, 3)
        process.emit(resultFrame({ uuids: [steer], text: 'stray' }))
        await later(30)
        expect(done).toBe(false)
        process.answer(process.uuid(2), 'next')
        expect(await next).toBe('next')
      }
    }
  })

  it('a turn that failed before pushing leaves no boundary: the next request does not reuse the process', async () => {
    const f = fixture()
    helper(f)
    await f.turn({ history: 'h' }, 'h')
    f.cli.reply = (message, process) => process.emit(resultFrame({ uuids: [String(message.uuid)], error: 'rate limit' }))
    await expect(f.chat({ history: 'h' })).rejects.toThrow('rate limit')
    f.service.commitFailed('thread', 'h + A')
    // Turn B fails before it pushes anything (an image Claude cannot take).
    await expect(f.chat({ history: 'h + A', images: [{ name: 'x.bmp', mimeType: 'image/bmp', data: 'AAAA' }] as never })).rejects.toThrow('Unsupported Claude image')
    f.service.commitFailed('thread', 'h + A + B')
    // Claude never saw B, so a request that carries B must not continue on the process.
    await expect(f.chat({ history: 'h + A + B' })).rejects.toMatchObject({ message: expect.stringContaining('conversation changed') })
  })

  it('a message pushed before the wake that folds the cut-off notification in sees it, and commits it', async () => {
    const f = fixture()
    const process = await cutOffAfterNotification(f)
    f.cli.reply = undefined
    const mine = f.chat({ prompt: 'mine', history: 'h' })
    await inputs(f.cli, 3)
    process.emit(resultFrame({ uuids: [process.uuid(1)], terminalReason: 'aborted_streaming' }))
    // The wake Claude owed folds the message in.
    process.emit(textDelta('report and answer', process.uuid(2)), resultFrame({ uuids: [process.uuid(2)], text: 'report and answer', origin: 'task-notification' }))
    expect(await mine).toBe('report and answer')
    f.service.commitConversation('thread', 'h')
    expect(f.service.hasBackgroundWork('thread')).toBe(false)
  })

  it('Stop right after a cancel that dropped queued messages posts no note: the helpers it ended have no result to miss', async () => {
    const f = fixture()
    helper(f)
    await f.turn({ history: 'h' }, 'h')
    const process = f.cli.last
    f.cli.reply = undefined
    const abort = new AbortController()
    const second = f.chat({
      history: 'h',
      signal: abort.signal,
      drainSteer: vi.fn<() => string | undefined>().mockReturnValueOnce('queued steer').mockReturnValue(undefined)
    })
    await inputs(f.cli, 2)
    process.emit(textDelta('working', process.uuid(1)), notification('bash-1'))
    await inputs(f.cli, 3)
    abort.abort()
    await expect(second).rejects.toThrow()
    expect(f.service.stopThread('thread')).toBe('stopped')
    await later(60)
    expect(f.host.notice).not.toHaveBeenCalled()
  })

  it('tells the drain token to the provider when a steer is pushed, so the drain is never restored', async () => {
    const f = fixture()
    silent(f.cli)
    const steerTaken = vi.fn()
    const turn = f.chat({
      drainSteer: () => undefined,
      drainSteerEntry: vi.fn<() => { text: string; token: string } | undefined>().mockReturnValueOnce({ text: 'steer', token: 'drain-1' }).mockReturnValue(undefined),
      steerTaken
    })
    await inputs(f.cli, 2)
    expect(steerTaken).toHaveBeenCalledExactlyOnceWith('drain-1')
    const process = f.cli.last
    process.emit(resultFrame({ uuids: [process.uuid(0), process.uuid(1)], text: 'ok' }))
    await turn
  })

  it('a result held back for a steer still lets the folded run adopt the cut-off notification', async () => {
    const f = fixture()
    const process = await cutOffAfterNotification(f)
    f.cli.reply = undefined
    let open!: () => void
    process.backgroundGate = new Promise<void>((resolve) => { open = resolve })
    const mine = f.chat({
      prompt: 'mine',
      history: 'h',
      drainSteer: vi.fn<() => string | undefined>().mockReturnValueOnce('late steer').mockReturnValue(undefined),
      returnSteer: vi.fn()
    })
    await inputs(f.cli, 3)
    await vi.waitFor(() => expect(process.backgrounded).toBe(1))
    const uuid = process.uuid(2)
    // The wake that folds the message in answers while the steer still waits for foreground work to move.
    process.emit(resultFrame({ uuids: [process.uuid(1)], terminalReason: 'aborted_streaming' }))
    process.emit(textDelta('report and answer', uuid), resultFrame({ uuids: [uuid], text: 'report and answer', origin: 'task-notification' }))
    await later(30)
    open()
    expect(await mine).toBe('report and answer')
    f.service.commitConversation('thread', 'h')
    expect(f.service.hasBackgroundWork('thread')).toBe(false)
  })

  /** Turn A is cancelled with a steer Claude has not started; its interrupt then never answers. */
  const cancelThatNeverAnswers = async (f: ReturnType<typeof fixture>) => {
    await f.turn({ history: 'h' }, 'h')
    const process = f.cli.last
    f.cli.reply = undefined
    const abort = new AbortController()
    const first = f.chat({
      history: 'h',
      signal: abort.signal,
      drainSteer: vi.fn<() => string | undefined>().mockReturnValueOnce('queued steer').mockReturnValue(undefined)
    })
    await inputs(f.cli, 3)
    process.interruptGate = new Promise(() => undefined)
    abort.abort()
    await expect(first).rejects.toThrow()
    f.service.commitInterrupted('thread', 'h')
    await vi.waitFor(() => expect(process.interrupts).toBe(1))
    return process
  }

  it('an interrupt that never answers fails the waiting push within the bound, closes the process and the next turn starts a fresh one', async () => {
    const f = fixture({ interruptTimeoutMs: 150 })
    const process = await cancelThatNeverAnswers(f)
    const started = Date.now()
    const second = f.chat({ history: 'h' })
    await expect(second).rejects.toThrow(/did not answer a cancel in time/)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(process.closed).toBe(true)
    expect(f.service.liveThreadIds()).toEqual([])
    f.cli.reply = (message, self) => self.answer(String(message.uuid), 'fresh')
    expect(await f.chat({ history: 'h' })).toBe('fresh')
    expect(f.cli.processes).toHaveLength(2)
  })

  it('cancelling a turn that waits on a cancel frees its call at once', async () => {
    const f = fixture({ interruptTimeoutMs: 600_000 })
    await cancelThatNeverAnswers(f)
    const abort = new AbortController()
    const second = f.chat({ history: 'h', signal: abort.signal })
    second.catch(() => undefined)
    await later(100)
    expect(f.cli.last.inputs).toHaveLength(3)
    const before = Date.now()
    abort.abort()
    await expect(second).rejects.toThrow()
    expect(Date.now() - before).toBeLessThan(1000)
    // The process is not closed for it: the first cancel is still unanswered, and Stop ends it.
    expect(f.cli.last.closed).toBe(false)
  })

  it('a sweep that took a wake\'s steer does not fail the wake that is still running', async () => {
    const f = fixture()
    await withHelperTurn(f)
    const process = f.cli.last
    process.emit(notification('bash-1'), textDelta('reading the report'))
    await vi.waitFor(() => expect(f.host.continuationStarted).toHaveBeenCalledTimes(1))
    const id = f.host.continuationStarted.mock.calls[0][1].id
    let ended = false
    const wake = f.service.chat({
      threadId: 'thread', cwd: f.home, model: 'sonnet', prompt: '', continuation: true, continuationId: id, onText: () => undefined,
      drainSteer: vi.fn<() => string | undefined>().mockReturnValueOnce('steer for the wake').mockReturnValue(undefined)
    }).finally(() => { ended = true })
    await inputs(f.cli, 2)
    const steerId = process.uuid(1)
    // Another run's cancel sweeps the wake's queued steer up.
    const live = (f.service as unknown as { live: Map<string, { cancelId(id: string): void }> }).live.get('thread')!
    live.cancelId(steerId)
    await later(50)
    expect(ended).toBe(false)
    process.emit(textDelta('the report is read'), resultFrame({ text: 'the report is read', origin: 'task-notification' }))
    expect(await wake).toContain('the report is read')
  })

  it('closing the process while a push waits on a cancel releases the push', async () => {
    const f = fixture({ interruptTimeoutMs: 600_000 })
    await cancelThatNeverAnswers(f)
    const second = f.chat({ history: 'h' })
    second.catch(() => undefined)
    await later(100)
    expect(f.cli.last.inputs).toHaveLength(3)
    expect(f.service.stopThread('thread')).toBe('stopped')
    await expect(second).rejects.toThrow()
  })

  it('a prompt pushed while a cancel waits for its receipt is not swept up by it', async () => {
    const f = fixture()
    await f.turn({ history: 'h' }, 'h')
    const process = f.cli.last
    f.cli.reply = undefined
    const abort = new AbortController()
    const first = f.chat({
      history: 'h',
      signal: abort.signal,
      drainSteer: vi.fn<() => string | undefined>().mockReturnValueOnce('queued steer').mockReturnValue(undefined)
    })
    await inputs(f.cli, 3)
    // The first interrupt's receipt is slow.
    let release!: () => void
    process.interruptGate = new Promise<void>((resolve) => { release = resolve })
    abort.abort()
    await expect(first).rejects.toThrow()
    f.service.commitInterrupted('thread', 'h')
    await vi.waitFor(() => expect(process.interrupts).toBe(1))
    // A new turn starts meanwhile: its prompt waits for the cancel to finish instead of racing it.
    f.cli.reply = (message, self) => self.answer(String(message.uuid), 'second answer')
    const second = f.chat({ history: 'h' })
    await later(150)
    expect(process.inputs).toHaveLength(3)
    process.interruptGate = undefined
    release()
    expect(await second).toBe('second answer')
    expect(process.interruptOptions).toEqual([undefined, { cancelQueued: true }])
  })

  it('a continuation a run already claimed that Claude then folded a message into ends without a result of its own', async () => {
    const f = fixture()
    await withHelperTurn(f)
    const process = f.cli.last
    process.emit(notification('bash-1'), textDelta('reading the report'))
    await vi.waitFor(() => expect(f.host.continuationStarted).toHaveBeenCalledTimes(1))
    const id = f.host.continuationStarted.mock.calls[0][1].id
    const claimed = f.service.chat({ threadId: 'thread', cwd: f.home, model: 'sonnet', prompt: '', continuation: true, continuationId: id, onText: () => undefined })
    claimed.catch(() => undefined)
    // A message of ours is pushed straight into the live session (a race the host cannot normally lose).
    const live = (f.service as unknown as { live: Map<string, { beginRun(consumer: () => void): { done: Promise<unknown> }; push(run: unknown, message: unknown): string }> }).live.get('thread')!
    const run = live.beginRun(() => undefined)
    live.push(run, { type: 'user', message: { role: 'user', content: 'mine' }, parent_tool_use_id: null, session_id: '' })
    await inputs(f.cli, 2)
    const uuid = process.uuid(1)
    process.emit(textDelta('report and answer', uuid), resultFrame({ uuids: [uuid], text: 'report and answer', origin: 'task-notification' }))
    await run.done
    // The claimed wake has no turn of its own: it fails as folded, with no text to publish as "Done.".
    await expect(claimed).rejects.toMatchObject({ code: 'claude_continuation_folded' })
  })

  it('a steered continuation ignores an abort result that echoes no id and ends at its own result', async () => {
    const f = fixture()
    await withHelperTurn(f)
    const process = f.cli.last
    process.emit(notification('bash-1'), textDelta('reading the report'))
    await vi.waitFor(() => expect(f.host.continuationStarted).toHaveBeenCalledTimes(1))
    let ended = false
    const continuation = f.service.chat({
      threadId: 'thread', cwd: f.home, model: 'sonnet', prompt: '', continuation: true, onText: () => undefined,
      drainSteer: vi.fn<() => string | undefined>().mockReturnValueOnce('please also check X').mockReturnValue(undefined)
    }).finally(() => { ended = true })
    await inputs(f.cli, 2)
    expect(process.inputs[1]).toMatchObject({ priority: 'now' })
    process.emit(resultFrame({ terminalReason: 'aborted_streaming', origin: 'task-notification', queued: 1 }))
    await later(30)
    expect(ended).toBe(false)
    process.emit(textDelta('checked X', process.uuid(1)), resultFrame({ uuids: [process.uuid(1)], text: 'checked X', origin: 'task-notification' }))
    expect(await continuation).toContain('checked X')
  })

  it('with no host, a message folded into the wake turn is not interrupted with it, and the abandoned wake ends', async () => {
    const f = fixture()
    f.service.setLiveHost(null)
    await withHelperTurn(f)
    const process = f.cli.last
    process.emit(notification('bash-1'))
    await later(30)
    f.cli.reply = undefined
    const mine = f.chat({ prompt: 'mine', history: '' })
    await inputs(f.cli, 2)
    // The wake turn begins before Claude takes the message; it may carry it.
    process.emit(textDelta('wake text'))
    await later(30)
    expect(process.interrupts).toBe(0)
    process.emit(textDelta('answer to mine', process.uuid(1)), resultFrame({ uuids: [process.uuid(1)], text: 'answer to mine', origin: 'task-notification' }))
    expect(await mine).toBe('answer to mine')
    expect(process.interrupts).toBe(0)
    f.service.commitConversation('thread', '')
    // The abandoned wake is over: the next turn's unstamped frames are its own.
    f.cli.reply = (message, self) => self.answer(String(message.uuid), 'next', ['n', 'ext'])
    expect(await f.turn({ history: '' })).toBe('next')
  })

  it('after a failed turn a plain resend continues on the process, an undone conversation does not', async () => {
    const f = fixture()
    helper(f)
    await f.turn({ history: 'h' }, 'h')
    const failing = (message: { uuid?: string }, process: { emit(...frames: Record<string, unknown>[]): void }) =>
      process.emit(resultFrame({ uuids: [String(message.uuid)], error: 'rate limit' }))
    f.cli.reply = failing as never
    await expect(f.chat({ history: 'h' })).rejects.toThrow('rate limit')
    // The adapter reports what the failed turn left: the history with its request in it.
    f.service.commitFailed('thread', 'h + failed request')
    f.cli.reply = (message, process) => process.answer(String(message.uuid), 'again')
    // The conversation was undone back to before the failed request: the process still holds it.
    await expect(f.chat({ history: 'h' })).rejects.toMatchObject({ message: expect.stringContaining('conversation changed') })
    expect(f.cli.processes).toHaveLength(1)
    // A plain resend carries the boundary the failed turn left.
    expect(await f.chat({ history: 'h + failed request' })).toBe('again')
    expect(f.cli.processes).toHaveLength(1)
    expect(f.cli.last.text(2)).not.toContain('Previous conversation')
  })

  it('after a failed turn the next message continues on the same process, even with background work running', async () => {
    const f = fixture()
    helper(f)
    await f.turn({ history: 'h' }, 'h')
    f.cli.reply = (message, process) => process.emit(resultFrame({ uuids: [String(message.uuid)], error: 'rate limit' }))
    await expect(f.chat({ history: 'h' })).rejects.toThrow('rate limit')
    f.service.commitFailed('thread', 'h + the failed request')
    f.cli.reply = (message, process) => process.answer(String(message.uuid), 'ok again')
    expect(await f.chat({ history: 'h + the failed request' })).toBe('ok again')
    expect(f.cli.processes).toHaveLength(1)
    expect(f.cli.last.text(2)).not.toContain('Previous conversation')
  })

  it('says what changed when it refuses a change, and that the conversation changed when only the history did', async () => {
    const f = fixture()
    helper(f)
    await f.turn({ history: 'h' }, 'h')
    f.cli.reply = undefined
    await expect(f.chat({ history: 'h', model: 'opus' })).rejects.toMatchObject({ message: expect.stringContaining('model changed') })
    await expect(f.chat({ history: 'h', systemPromptAppend: 'new' })).rejects.toMatchObject({ message: expect.stringContaining('instructions changed') })
    // The history no longer matches what the process holds (an undo or edit).
    await expect(f.chat({ history: 'something else' })).rejects.toMatchObject({ message: expect.stringContaining('conversation changed') })
  })

  it('the idle release cannot close the process between acquiring it and pushing the turn', async () => {
    vi.useFakeTimers()
    const f = fixture({ idleCloseMs: 1000 })
    await f.turn({ mode: 'plan', history: 'h' }, 'h')
    const process = f.cli.last
    process.permissionGate = new Promise((resolve) => setTimeout(resolve, 5000))
    f.cli.reply = (message, self) => self.answer(String(message.uuid), 'ok')
    const turn = f.chat({ mode: 'default', history: 'h' })
    await vi.advanceTimersByTimeAsync(2500)
    expect(process.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(4000)
    expect(await turn).toBe('ok')
    expect(f.cli.processes).toHaveLength(1)
  })

  it('what a helper asks for after a cancelled turn is not refused as "Turn cancelled"', async () => {
    const f = fixture()
    await f.turn({ child: { readOnly: true }, history: 'h' }, 'h')
    const process = f.cli.last
    silent(f.cli)
    const abort = new AbortController()
    const second = f.chat({ child: { readOnly: true }, history: 'h', signal: abort.signal })
    await inputs(f.cli, 2)
    process.emit(textDelta('working', process.uuid(1)))
    await later(20)
    abort.abort()
    await expect(second).rejects.toThrow()
    const decision = await process.options.canUseTool!('Read', {}, { signal: new AbortController().signal } as never)
    expect(decision).toMatchObject({ behavior: 'allow' })
  })

  it('a stray root frame that no task announced opens no continuation and does not pin the process', async () => {
    vi.useFakeTimers()
    const f = fixture({ idleCloseMs: 1000 })
    await f.turn()
    const process = f.cli.last
    process.emit(textDelta('stray'))
    await vi.advanceTimersByTimeAsync(10)
    expect(f.host.continuationStarted).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1500)
    expect(process.closed).toBe(true)
  })

  it.each([true, false])('a steer still queued when its turn is cancelled never ends a later turn (receipts %s)', async (receipts) => {
    const f = fixture()
    await f.turn({ history: 'h' }, 'h')
    const process = f.cli.last
    process.receipts = receipts
    silent(f.cli)
    const abort = new AbortController()
    const drainSteer = vi.fn<() => string | undefined>().mockReturnValueOnce('queued steer').mockReturnValue(undefined)
    const second = f.chat({ history: 'h', drainSteer, signal: abort.signal })
    await inputs(f.cli, 2)
    process.emit(textDelta('go', process.uuid(1)))
    await inputs(f.cli, 3)
    abort.abort()
    await expect(second).rejects.toThrow()
    f.service.commitInterrupted('thread', 'h')
    process.emit(resultFrame({ uuids: [process.uuid(1)], terminalReason: 'aborted_streaming' }))
    // The next turn runs; the steer's own result, if Claude still produces one, is not the next turn's.
    let done = false
    const third = f.chat({ history: 'h' }).then((text) => {
      done = true
      return text
    })
    await inputs(f.cli, 4)
    process.emit(resultFrame({ uuids: [process.uuid(2)], text: 'steer result' }))
    await later(30)
    expect(done).toBe(false)
    process.answer(process.uuid(3), 'third')
    expect(await third).toBe('third')
  })

  it('never stops individual tasks: aborts, steers and Stop interrupt or close, and the process is created without a per-task stop', async () => {
    const f = fixture()
    f.cli.reply = (message, process) => {
      process.emit(roster({ id: 'bash-1' }, { id: 'agent-1', type: 'local_agent' }))
      process.answer(String(message.uuid), 'started')
    }
    await f.turn({ history: 'h' }, 'h')
    const process = f.cli.last
    silent(f.cli)
    const abort = new AbortController()
    const steered = f.chat({ history: 'h', signal: abort.signal, drainSteer: vi.fn<() => string | undefined>().mockReturnValueOnce('steer').mockReturnValue(undefined) })
    await inputs(f.cli, 2)
    process.emit(textDelta('x', process.uuid(1)))
    await inputs(f.cli, 3)
    abort.abort()
    await expect(steered).rejects.toThrow()
    expect(f.service.stopThread('thread')).toBe('stopped')
    expect(process.stoppedTasks).toEqual([])
    expect(JSON.stringify(process.options)).not.toContain('perTaskStopAffordance')
    expect(process.closed).toBe(true)
  })
})

describe('closing the service', () => {
  it('logout() and stop() close every live process', async () => {
    const f = fixture()
    await f.turn({ threadId: 'a' })
    await f.turn({ threadId: 'b' })
    await f.service.logout()
    expect(f.cli.processes.every((process) => process.closed)).toBe(true)
    expect(f.service.liveThreadIds()).toEqual([])
    const g = fixture()
    await g.turn()
    g.service.stop()
    expect(g.cli.last.closed).toBe(true)
  })

  it('declares no per-task stop affordance, so an interrupt stops helpers the way Stop does', async () => {
    const f = fixture()
    await f.turn()
    expect(JSON.stringify(f.cli.last.options)).not.toContain('perTaskStopAffordance')
  })
})

beforeEach(() => {
  vi.useRealTimers()
})
