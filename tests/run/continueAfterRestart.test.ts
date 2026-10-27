/**
 * SPEC §16.4 continue after restart: `orchestrator.send` with `continuationOfRunId` records the
 * continued run, opens the turn with a system line, replays on a repeated `continue:<runId>`
 * request, and needs `acknowledgeUncertain` for an `uncertain` run.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadSession } from '../../src/mms/orchestrator/ThreadSession'
import { Reconciler } from '../../src/mms/run/Reconciler'
import type { AgentActivityItem } from '../../src/shared/agentActivity'
import type { ChatMessage } from '../../src/shared/types'
import { formatRestartNote } from '../../src/mms/run/restartNote'
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

    // Which runs a continuation may name is decided in RunEngine (runEngine.test.ts) and mapped to a code by the protocol (runProtocolValidation.test.ts).
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
    expect(systemOf(second)).toContain(
      formatRestartNote({ epoch: 2, runIds: [sent.runId!], uncertainRunIds: [], cutOffTools: [] })
    )
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
    expect(system).toContain(
      formatRestartNote({ epoch: 2, runIds: [], uncertainRunIds: [], cutOffTools: [], queuedRunIds: [sent.runId] })
    )
  })

  describe('the restart note names the commands and subagents a restart cut off (#172)', () => {
    const at = '2026-10-27T10:00:00.000Z'
    const NOTE_PREFIX = 'The Mousse daemon restarted during the previous turn.'
    const item = (id: string, runId: string, extra: Record<string, unknown>): ChatMessage => {
      const activity = { id, callId: `call-${id}`, startedAt: at, runId, status: 'running', ...extra } as AgentActivityItem
      return {
        id,
        role: 'system',
        kind: 'mcp_tool_call',
        content: '',
        timestamp: at,
        toolCall: { title: activity.toolName, summary: activity.toolName, details: [], status: activity.status === 'running' ? 'processing' : 'complete' },
        activity
      } as ChatMessage
    }
    /** What the previous daemon saved when it died: work still `running`, finished work, and a prompt. */
    const savedWork = (runId: string): ChatMessage[] => [
      { id: 'user-1', role: 'user', content: 'SECRET PROMPT TEXT: deploy with key sk-live-abcdef123456', timestamp: at },
      item('cmd', runId, { toolName: 'Bash', kind: 'command', command: "bash -lc 'DEPLOY_TOKEN=topsecret123 npm run build'", output: 'SECRET OUTPUT', cwd: '/srv/secret-dir' }),
      item('agent', runId, { toolName: 'Agent', kind: 'subagent', description: 'Audit the schema', nativeId: 'task-7' }),
      item('child', runId, { toolName: 'Bash', kind: 'command', command: 'git status', parentId: 'agent' }),
      item('helper-2', runId, { toolName: 'spawnAgent', callId: 'helper:thr-1#2', kind: 'subagent', agentType: 'explorer', nativeId: 'thr-1' }),
      item('finished', runId, { toolName: 'Bash', kind: 'command', command: 'echo already done', status: 'done', endedAt: at })
    ]
    const snapshot = (d: Phase6Daemon, threadId: string) =>
      d.store.loadThreadData(threadId).messages.filter((message) => message.activity).map((message) => `${message.id}:${message.activity!.status}:${message.activity!.interruptedBy ?? ''}`)
    const systemOf = (d: Phase6Daemon, threadId: string) => d.orch.getMessages(threadId).filter((message) => message.role === 'system').map((message) => message.content)
    const noteIn = (d: Phase6Daemon, threadId: string) => systemOf(d, threadId).filter((text) => text.startsWith(NOTE_PREFIX))

    /** A daemon dies with a run active and its work saved as `running`. */
    const crashWithWork = async (dir: string, seed: (runId: string) => ChatMessage[] = savedWork) => {
      const pi = piAdapter((input) => `after: ${input.prompt}`)
      const first = phase6Daemon(dir, [pi], { pid: 1 })
      const thread = first.store.createThread('Cut off')
      first.orch.setThreadModelOverride(thread.id, PI)
      const sent = await first.engine.dispatch({ kind: 'send', threadId: thread.id, clientRequestId: 'before-crash', source: 'gui' })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      first.engine.markStarting(sent.runId)
      first.engine.markRunning(sent.runId)
      first.store.mutateThreadData(thread.id, () => ({ messages: seed(sent.runId) }))
      await first.crash()
      return { threadId: thread.id, runId: sent.runId, pi }
    }
    const expectNote = (text: string) => {
      expect(text).toContain('This work was cut off and will not report back on its own')
      expect(text).toContain('\n- command: DEPLOY_TOKEN=[redacted] npm run build')
      expect(text).toContain('\n- command: git status')
      expect(text).toContain('\n- subagent: Audit the schema (id task-7)')
      expect(text).toContain('\n- subagent: explorer (id thr-1)')
      expect(text).not.toContain('already done')
      // Prompts, output, directories and credentials never reach the note.
      expect(text).not.toMatch(/SECRET|sk-live|topsecret|secret-dir/)
    }

    it('a bound thread: the sweep ends the rows once, on disk too, and the first turn names them', async () => {
      const dir = setupHome()
      const { threadId, runId, pi } = await crashWithWork(dir)
      const second = phase6Daemon(dir, [pi], { pid: 2 })
      daemons.push(second)
      expect(second.boot.interrupted).toEqual([runId])
      const saves = vi.spyOn(second.store, 'mutateThreadData')

      // (a) Opening the thread closes what was running and leaves the finished command alone.
      const saved = second.store.loadThreadData(threadId).messages
      second.orch.bindThread(threadId, saved)
      const expected = ['cmd:interrupted:daemon_restart', 'agent:interrupted:daemon_restart', 'child:interrupted:daemon_restart', 'helper-2:interrupted:daemon_restart', 'finished:done:']
      expect(snapshot(second, threadId)).toEqual(expected)
      const bound = second.orch.getMessages(threadId).filter((message) => message.activity)
      expect(bound.map((message) => `${message.id}:${message.activity!.status}`)).toEqual(expected.map((entry) => entry.split(':').slice(0, 2).join(':')))
      expect(bound.find((message) => message.id === 'cmd')?.toolCall?.status).toBe('complete')
      expect(saves).toHaveBeenCalledTimes(1)
      const endedAt = bound.find((message) => message.id === 'cmd')!.activity!.endedAt

      // (b) Opening it again, with the new rows or with the old copy, closes nothing more and writes nothing.
      second.orch.bindThread(threadId, second.store.loadThreadData(threadId).messages)
      second.orch.bindThread(threadId, saved)
      expect(saves).toHaveBeenCalledTimes(1)
      expect(snapshot(second, threadId)).toEqual(expected)
      expect(second.store.loadThreadData(threadId).messages.find((message) => message.id === 'cmd')?.activity?.endedAt).toBe(endedAt)

      // (c) The first turn names them, once.
      await second.orch.send('Next', false, { threadId, clientRequestId: 'next-1' })
      const notes = noteIn(second, threadId)
      expect(notes).toHaveLength(1)
      expectNote(notes[0]!)
      await second.orch.send('Again', false, { threadId, clientRequestId: 'next-2' })
      expect(noteIn(second, threadId)).toHaveLength(1)
      expect(snapshot(second, threadId)).toEqual(expected)
      expect(second.store.loadThreadData(threadId).messages.find((message) => message.id === 'cmd')?.activity?.endedAt).toBe(endedAt)
    })

    it('a thread never opened before the first turn gets the same note (CLI or channel send)', async () => {
      const dir = setupHome()
      const { threadId, pi } = await crashWithWork(dir)
      const second = phase6Daemon(dir, [pi], { pid: 2 })
      daemons.push(second)
      await second.orch.send('Next', false, { threadId, clientRequestId: 'next-1' })
      const notes = noteIn(second, threadId)
      expect(notes).toHaveLength(1)
      expectNote(notes[0]!)
      expect(snapshot(second, threadId).filter((entry) => entry.includes('interrupted:daemon_restart'))).toHaveLength(4)
    })

    it('a second restart before the first turn still gets the note: the tag is saved with the thread', async () => {
      const dir = setupHome()
      const { threadId, pi } = await crashWithWork(dir)
      const second = phase6Daemon(dir, [pi], { pid: 2 })
      second.orch.bindThread(threadId, second.store.loadThreadData(threadId).messages)
      await second.crash()

      const third = phase6Daemon(dir, [pi], { pid: 3 })
      daemons.push(third)
      expect(snapshot(third, threadId)).toContain('cmd:interrupted:daemon_restart')
      await third.orch.send('Next', false, { threadId, clientRequestId: 'next-1' })
      const notes = noteIn(third, threadId)
      expect(notes).toHaveLength(1)
      expectNote(notes[0]!)
    })

    it('no list when nothing was cut off: a hydrate writes nothing and the note stays short', async () => {
      const dir = setupHome()
      const { threadId, pi } = await crashWithWork(dir, (runId) => [
        { id: 'user-1', role: 'user', content: 'hello', timestamp: at },
        item('finished', runId, { toolName: 'Bash', kind: 'command', command: 'ls', status: 'done', endedAt: at })
      ])
      const second = phase6Daemon(dir, [pi], { pid: 2 })
      daemons.push(second)
      const saves = vi.spyOn(second.store, 'mutateThreadData')
      second.orch.bindThread(threadId, second.store.loadThreadData(threadId).messages)
      expect(saves).not.toHaveBeenCalled()
      await second.orch.send('Next', false, { threadId, clientRequestId: 'next-1' })
      expect(noteIn(second, threadId)).toEqual(['The Mousse daemon restarted during the previous turn. Interrupted: 1 run(s).'])
    })

    it('a stopped run is not named: only the runs the restart cut off are', async () => {
      const dir = setupHome()
      const { threadId, pi } = await crashWithWork(dir, (runId) => [
        item('cmd', runId, { toolName: 'Bash', kind: 'command', command: 'npm run build' }),
        item('earlier', 'run-from-before', { toolName: 'Bash', kind: 'command', command: 'npm run lint', status: 'interrupted', interruptedBy: 'stop' })
      ])
      const second = phase6Daemon(dir, [pi], { pid: 2 })
      daemons.push(second)
      await second.orch.send('Next', false, { threadId, clientRequestId: 'next-1' })
      const [text] = noteIn(second, threadId)
      expect(text).toContain('command: npm run build')
      expect(text).not.toContain('npm run lint')
    })

    it('a live turn is never swept: its running items stay running', async () => {
      const dir = setupHome()
      const { threadId, pi } = await crashWithWork(dir)
      const second = phase6Daemon(dir, [pi], { pid: 2 })
      daemons.push(second)
      const session = second.orch.getOrCreateSession(threadId)
      expect(snapshot(second, threadId)).toContain('cmd:interrupted:daemon_restart')
      // The same rows reloaded into a session whose turn is admitted stay as they are.
      const live = new ThreadSession('live-thread')
      live.turnAdmitted = true
      live.load([item('cmd', 'run-live', { toolName: 'Bash', kind: 'command', command: 'sleep 9' })])
      ;(second.orch as any).closeStaleActivity(live)
      expect(live.messages[0]!.activity?.status).toBe('running')
      expect(session.messages.find((message) => message.id === 'cmd')?.activity?.status).toBe('interrupted')
    })

    it('a graceful restart: rows the shutdown closed, a background agent and a plan included, are named', async () => {
      const dir = setupHome()
      let started = false
      const gated = piAdapter((input) => new Promise<string>((_resolve, reject) => {
        started = true
        input.signal.addEventListener('abort', () => reject(input.signal.reason as Error), { once: true })
      }))
      const start = gated.startTurn.bind(gated)
      gated.startTurn = async (input, sink, ctl, host) => {
        const event = (callId: string, title: string, activity: Record<string, unknown>) =>
          sink.tool({ kind: 'mcp_tool_call', phase: 'start', callId, title, summary: title, details: [], activity } as never)
        event('toolu_cmd', 'Bash', { kind: 'command', toolName: 'Bash', command: 'npm run build' })
        event('toolu_agent', 'Agent', { kind: 'subagent', toolName: 'Agent', description: 'Audit the schema', nativeId: 'task-9', background: true })
        event('toolu_plan', 'ExitPlanMode', { kind: 'plan', toolName: 'ExitPlanMode', text: 'SECRET PLAN TEXT' })
        return start(input, sink, ctl, host)
      }
      const first = phase6Daemon(dir, [gated], { pid: 1 })
      const thread = first.store.createThread('Shutdown')
      // The profile services save the session through this callback; the bare harness has none.
      first.orch.setPersistCallback((threadId) => {
        if (threadId) first.store.mutateThreadData(threadId, () => ({ messages: first.orch.getMessagesForPersistence(threadId) }))
      })
      first.orch.setThreadModelOverride(thread.id, PI)
      await first.orch.send('Work slowly', false, { threadId: thread.id, clientRequestId: 'gated-1', awaitMode: 'ack' })
      await waitFor(() => started, 'the gated turn')
      await first.shutdown()

      const second = phase6Daemon(dir, [piAdapter((input) => `after: ${input.prompt}`)], { pid: 2 })
      daemons.push(second)
      const rows = second.store.loadThreadData(thread.id).messages.filter((message) => message.activity)
      expect(rows.map((message) => `${message.activity!.toolName}:${message.activity!.status}`)).toEqual(['Bash:interrupted', 'Agent:interrupted', 'ExitPlanMode:interrupted'])
      await second.orch.send('Next', false, { threadId: thread.id, clientRequestId: 'next-1' })
      const [text] = noteIn(second, thread.id)
      expect(text).toContain('\n- command: npm run build')
      expect(text).toContain('\n- subagent: Audit the schema (id task-9)')
      expect(text).toContain('\n- ExitPlanMode')
      expect(text).not.toContain('SECRET')
    })
  })
})
