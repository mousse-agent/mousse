/**
 * A steer pushed just before Claude Code's reply ends (issue #919): the reply's result arrives with nothing queued
 * (`queued_turn_count` 0) and the steer still unread. Claude Code may then take the steer and answer it as a turn of
 * its own, or it may still drop it. Either way the reply is kept once, and the steer is shown, read and answered once.
 * A real orchestrator, run engine, Claude adapter and provider service; only the Claude Code process is replaced
 * (`FakeClaudeCli`).
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { ClaudeSubscriptionAdapter } from '../../src/mms/harness/drivers/claudeCode/adapter'
import { FakeClaudeCli, lifecycle, resultFrame, textDelta, type FakeClaudeProcess } from './fakeClaudeCli'
import { CLAUDE, phase6Daemon, waitFor } from './phase6Fixture'

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('a steer still unread when Claude Code\'s reply ends', () => {
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

  /**
   * A thread whose first prompt streams "The reply." and waits, with a steer pushed into it. Any later prompt (the
   * steer handed back and sent again) is answered "Answer to the steer.".
   */
  async function steeredReply() {
    home = mkdtempSync(join(tmpdir(), 'mousse-steer-after-result-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const binary = join(home, 'claude')
    writeFileSync(binary, 'fixture')
    chmodSync(binary, 0o755)
    mkdirSync(join(home, 'providers', 'claude-subscription'), { recursive: true })
    writeFileSync(join(home, 'providers', 'claude-subscription', 'settings.json'), JSON.stringify({ loginPolicy: 'cli', binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] }))
    const cli = new FakeClaudeCli()
    cli.reply = (message, claude) => {
      if (message.priority === 'now') return
      const text = claude.text(claude.inputs.length - 1)
      if (text.includes('first')) claude.emit(textDelta('The reply.', String(message.uuid)))
      else claude.answer(String(message.uuid), 'Answer to the steer.')
    }
    const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
      launchConfig: () => ({ binaryPath: binary }),
      query: cli.query,
      runAuth: vi.fn(async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
    })
    stops.push(async () => service.stop())
    const d = phase6Daemon(home, [new ClaudeSubscriptionAdapter(() => service)])
    stops.push(d.stop)
    const thread = d.store.createThread('Steer')
    d.orch.setThreadModelOverride(thread.id, CLAUDE)

    const first = d.orch.send('first', false, { threadId: thread.id, clientRequestId: 'turn-1' })
    await waitFor(() => cli.processes.length === 1 && cli.last.inputs.length === 1, 'the first prompt to be read')
    expect(d.orch.steerThreadOrEnqueueExternal(thread.id, 'STEER', { source: 'gui-steer' })).toMatchObject({ steered: true })
    await waitFor(() => cli.last.inputs.length === 2, 'the steer to be pushed')
    const claude = cli.last
    expect(claude.inputs[1]).toMatchObject({ priority: 'now' })

    const idle = async (): Promise<void> => {
      await waitFor(() => !d.orch.isActiveTurnRunning(thread.id) && d.orch.listQueue(thread.id).length === 0 && d.engine.getActiveRun(thread.id) === null, 'the thread to be idle')
      // Nothing more starts once the queue is empty.
      await later(150)
    }
    const transcript = () =>
      d.orch.getOrCreateSession(thread.id).messages.filter((message) => !message.hidden).map((message) => [message.role, String(message.content)])
    const context = () =>
      d.orch.getNativeContext(thread.id).messages.map((message) => [
        message.role,
        typeof message.content === 'string' ? message.content : (message.content as Array<{ type: string; text?: string }>).map((block) => block.text ?? `[${block.type}]`).join('')
      ])
    /** How many times Claude Code was sent the steer's text as a prompt of its own (the steer handed back and sent again). */
    const sentAgain = (process: FakeClaudeProcess) => process.inputs.filter((input, index) => input.priority !== 'now' && process.text(index).includes('STEER')).length
    return { d, thread, cli, claude, prompt: claude.uuid(0), steer: claude.uuid(1), first, idle, transcript, context, sentAgain }
  }

  it('Claude Code takes it as a turn of its own: its answer is shown and in the model context, and the reply is kept once', async () => {
    const t = await steeredReply()
    // The reply ends before Claude Code queued the steer; right after, a turn of its own takes it.
    t.claude.emit(resultFrame({ uuids: [t.prompt], text: 'The reply.', queued: 0 }), lifecycle(t.steer, 'queued'), lifecycle(t.steer, 'started'))
    await later(50)
    t.claude.answer(t.steer, 'Answer to the steer.')
    await t.first
    await t.idle()

    expect(t.transcript()).toEqual([
      ['user', 'first'],
      ['assistant', 'The reply.'],
      ['user', 'STEER'],
      ['assistant', 'Answer to the steer.']
    ])
    const context = t.context()
    expect(context.filter(([role]) => role === 'user')).toEqual([['user', 'first'], ['user', 'STEER']])
    const answers = context.filter(([role]) => role === 'assistant').map(([, content]) => content).join('\n')
    expect(answers.split('The reply.')).toHaveLength(2)
    expect(answers.split('Answer to the steer.')).toHaveLength(2)
    // Claude Code ran it once, as the turn it took; nothing was sent again.
    expect(t.claude.cancelAsyncCalls).toEqual([t.steer])
    expect(t.sentAgain(t.claude)).toBe(0)
  }, 30_000)

  it('Claude Code had not taken it: it is dropped there, handed back, and runs once as the next turn, with the reply kept once', async () => {
    const t = await steeredReply()
    t.claude.emit(resultFrame({ uuids: [t.prompt], text: 'The reply.', queued: 0 }))
    await t.first
    await t.idle()

    expect(t.transcript()).toEqual([
      ['user', 'first'],
      ['assistant', 'The reply.'],
      ['user', 'STEER'],
      ['assistant', 'Answer to the steer.']
    ])
    const context = t.context()
    expect(context.filter(([role]) => role === 'user')).toEqual([['user', 'first'], ['user', 'STEER']])
    const answers = context.filter(([role]) => role === 'assistant').map(([, content]) => content).join('\n')
    expect(answers.split('The reply.')).toHaveLength(2)
    expect(answers.split('Answer to the steer.')).toHaveLength(2)
    // Dropped from Claude Code's queue unread, then sent once as a prompt of its own.
    expect(t.claude.cancelAsyncCalls).toEqual([t.steer])
    expect(t.claude.queued).not.toContain(t.steer)
    expect(t.cli.processes.reduce((sum, process) => sum + t.sentAgain(process), 0)).toBe(1)
  }, 30_000)

  it('Stop during the turn Claude Code took it into ends that turn: the steer stays read once and is not handed back', async () => {
    const t = await steeredReply()
    t.claude.emit(resultFrame({ uuids: [t.prompt], text: 'The reply.', queued: 0 }), lifecycle(t.steer, 'queued'), lifecycle(t.steer, 'started'))
    t.claude.emit(textDelta('Partial answer', t.steer))
    // The thread still works: the steer's turn is the run's.
    await waitFor(() => t.d.engine.getActiveRun(t.thread.id) !== null && t.d.orch.isActiveTurnRunning(t.thread.id), 'the steer\'s turn to run')
    await later(50)
    expect(t.d.engine.getActiveRun(t.thread.id)).not.toBeNull()
    await t.d.orch.abortRun(t.d.engine.getActiveRun(t.thread.id)!.runId, 'stop-1', t.thread.id)
    await t.first.catch(() => undefined)
    await t.idle()

    const transcript = t.transcript()
    expect(transcript.filter(([role, content]) => role === 'user' && content === 'STEER')).toHaveLength(1)
    expect(transcript.map(([, content]) => content).join('\n').split('The reply.')).toHaveLength(2)
    expect(transcript.slice(0, 3)).toEqual([
      ['user', 'first'],
      ['assistant', 'The reply.'],
      ['user', 'STEER']
    ])
    expect(t.context().filter(([role, content]) => role === 'user' && content === 'STEER')).toHaveLength(1)
    // The steer's turn was ended there.
    expect(t.claude.interrupts > 0 || t.claude.closed).toBe(true)
    // Read by Claude Code, so it is neither waiting in the queue nor sent again.
    expect(t.d.orch.listQueue(t.thread.id)).toHaveLength(0)
    expect(t.cli.processes.reduce((sum, process) => sum + t.sentAgain(process), 0)).toBe(0)
  }, 30_000)
})
