/**
 * Thread runtimes over the protocol: multi-tenant isolation, PTY replay, questions and daemon restart.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'

describe('ThreadRuntime over the protocol', () => {
  let home: string
  let mms: MousseMainService
  let server: MmsProtocolServer
  let ownerToken: string
  let endpoint: string

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-rt4-'))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({
      homeDir: home,
      headless: true,
      ownerKind: 'test'
    })
    await mms.start()
    ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    endpoint = await server.start()
  })

  afterEach(async () => {
    // Kill PTYs first — node-pty may lock the temp home cwd on Windows.
    try {
      mms.ptyManager.killAll()
    } catch {
      /* ignore */
    }
    await server.stop()
    await mms.stop()
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      /* Windows EPERM when handles linger — best-effort */
    }
    delete process.env.MOUSSE_HOME
  })

  async function client(): Promise<LocalMmsClient> {
    const c = new LocalMmsClient({
      homeDir: home,
      ownerToken,
      endpoint,
      clientType: 'test'
    })
    await c.connect()
    return c
  }

  it('concurrent turns in multiple threads stay isolated for agents/tasks', async () => {
    const t1 = mms.threads.createThread('T1')
    const t2 = mms.threads.createThread('T2')
    const c = await client()

    await c.request('tasks.create', {
      threadId: t1.id,
      description: 'task-on-t1'
    })
    await c.request('tasks.create', {
      threadId: t2.id,
      description: 'task-on-t2'
    })

    // Independent background activity per thread (not just registry listing).
    mms.threadRuntimes.setActivity(t1.id, 'processing')
    mms.threadRuntimes.setActivity(t2.id, 'idle')

    const list1 = await c.request<{ tasks: { description: string }[] }>('tasks.list', {
      threadId: t1.id
    })
    const list2 = await c.request<{ tasks: { description: string }[] }>('tasks.list', {
      threadId: t2.id
    })
    expect(list1.tasks.map((t) => t.description)).toEqual(['task-on-t1'])
    expect(list2.tasks.map((t) => t.description)).toEqual(['task-on-t2'])
    // Exact per-thread activity invariants (no tautological or-branches).
    expect(mms.threadRuntimes.getActivity(t1.id)).toBe('processing')
    expect(mms.threadRuntimes.getActivity(t2.id)).toBe('idle')
    expect(list1.tasks).not.toEqual(list2.tasks)
    await c.close()
  })

  it('a turn the orchestrator reports paused shows the thread as Paused, and a new turn replaces it', async () => {
    const thread = mms.threads.createThread('Limited')
    const c = await client()
    mms.threadRuntimes.setActivity(thread.id, 'processing')

    mms.orchestrator.emit('turn-paused', { threadId: thread.id })
    expect(mms.threadRuntimes.getActivity(thread.id)).toBe('paused')
    expect(mms.threadRuntimes.getActivitySnapshot()[thread.id]).toBe('paused')

    mms.orchestrator.emit('turn-started', { threadId: thread.id })
    expect(mms.threadRuntimes.getActivity(thread.id)).toBe('processing')
    await c.close()
  })

  it('thread selection via GUI does not kill PTY on another thread', async () => {
    const t1 = mms.threads.createThread('PtyA')
    const t2 = mms.threads.createThread('PtyB')
    const c = await client()
    const script = join(home, 'projectless-terminal.cjs')
    writeFileSync(script, 'require("node:fs").writeFileSync("scratch-owner.txt",process.cwd());setInterval(()=>{},1000)')
    const quote = (value: string) => process.platform === 'win32' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, `'"'"'`)}'`
    const created = await c.request<{ ptyId: string }>('pty.create', {
      threadId: t1.id,
      agentId: 'agent-1',
      cwd: tmpdir(),
      command: `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(script)}`
    })
    const directory = mms.threads.getThreadDir(t1.id), scratch = join(directory, 'terminal-workspace')
    await vi.waitFor(() => expect(existsSync(join(scratch, 'scratch-owner.txt'))).toBe(true), { timeout: 10_000 })
    expect(readFileSync(join(scratch, 'scratch-owner.txt'), 'utf8')).toBe(scratch)
    expect(JSON.parse(readFileSync(join(directory, 'terminal-workspace.json'), 'utf8'))).toEqual({
      schemaVersion: 1, kind: 'task-terminal-scratch', threadId: t1.id, workspaceRelativePath: 'terminal-workspace'
    })
    await expect(c.request('pty.create', { threadId: '__unbound__', agentId: 'bypass', cwd: scratch })).rejects.toThrow(/task-bound terminal/)
    expect(created.ptyId).toBeTruthy()
    expect(mms.ptyManager.isAlive(created.ptyId)).toBe(true)

    // "Select" t2 by listing agents/tasks only — must not kill t1 PTY
    await c.request('agents.list', { threadId: t2.id })
    await c.request('tasks.list', { threadId: t2.id })
    expect(mms.ptyManager.isAlive(created.ptyId)).toBe(true)

    const list = await c.request<{ ptys: { ptyId: string }[] }>('pty.list', {
      threadId: t1.id
    })
    expect(list.ptys.some((p) => p.ptyId === created.ptyId)).toBe(true)
    await c.request('pty.kill', { ptyId: created.ptyId })
    await c.close()
  })

  it('PTY output is replayable from the sequence and scrollback after client disconnect', async () => {
    const t1 = mms.threads.createThread('PtyReplay')
    const c = await client()
    const script = join(home, 'replay-marker.cjs')
    writeFileSync(script, 'console.log("replay-marker-1");setInterval(()=>{},1000)')
    const quote = (value: string) => process.platform === 'win32' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, `'"'"'`)}'`
    const created = await c.request<{ ptyId: string }>('pty.create', {
      threadId: t1.id,
      agentId: 'a',
      cwd: tmpdir(),
      command: `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(script)}`
    })
    let since = { sequence: 0, chunks: [] as unknown[] }
    await vi.waitFor(async () => {
      since = await c.request<typeof since>('pty.outputSince', { ptyId: created.ptyId, afterSequence: 0 })
      expect(since.sequence).toBeGreaterThan(0)
    }, { timeout: 10_000 })
    expect(since.chunks.length).toBeGreaterThan(0)
    await c.close()

    const c2 = await client()
    const alive = await c2.request<{ alive: boolean }>('pty.isAlive', {
      ptyId: created.ptyId
    })
    expect(alive.alive).toBe(true)
    const re = await c2.request<{ scrollback: string }>('pty.scrollback', {
      ptyId: created.ptyId
    })
    expect(re.scrollback).toContain('replay-marker-1')
    const later = await c2.request<{ chunks: unknown[] }>('pty.outputSince', { ptyId: created.ptyId, afterSequence: since.sequence })
    expect(later.chunks).toEqual([])
    await c2.request('pty.kill', { ptyId: created.ptyId })
    await c2.close()
  })

  it('pending question survives client disconnect; answer reaches waiter', async () => {
    const thread = mms.threads.createThread('Q')
    let answered: unknown = null
    const wait = mms.questions.requestAnswers(
      [{ id: 'q1', prompt: 'Choose', options: [{ id: 'a', label: 'A' }] }],
      thread.id
    ).then((a) => {
      answered = a
    })

    await vi.waitFor(() => {
      expect(mms.questions.listPendingForThread(thread.id).length).toBe(1)
    })

    const c = await client()
    const pending = await c.request<{
      pending: Array<{ requestId: string }>
    }>('orchestrator.pendingQuestions', { threadId: thread.id })
    expect(pending.pending.length).toBe(1)
    const requestId = pending.pending[0].requestId

    await c.close()

    const c2 = await client()
    const pending2 = await c2.request<{
      pending: Array<{ requestId: string }>
    }>('orchestrator.pendingQuestions', { threadId: thread.id })
    expect(pending2.pending.some((p) => p.requestId === requestId)).toBe(true)

    const ok = await c2.request<{ ok: boolean }>('orchestrator.answerQuestions', {
      requestId,
      answers: { q1: 'a' }
    })
    expect(ok.ok).toBe(true)
    await wait
    expect(answered).toEqual({ q1: 'a' })
    await c2.close()
  })

  it('threads.setPermissionMode stores the mode, records an event and leaves a pending question alone', async () => {
    const thread = mms.threads.createThread('Mode')
    const wait = mms.questions.requestAnswers([{ id: 'q1', prompt: 'Choose', options: [{ id: 'a', label: 'A' }] }], thread.id)
    await vi.waitFor(() => expect(mms.questions.listPendingForThread(thread.id)).toHaveLength(1))
    const c = await client()

    const result = await c.request<{ thread: { permissionMode?: string } }>('threads.setPermissionMode', { threadId: thread.id, mode: 'ask' })
    expect(result.thread.permissionMode).toBe('ask')
    expect(mms.threads.getThread(thread.id)?.permissionMode).toBe('ask')
    expect(mms.runEngine.listEvents(thread.id).filter((event) => event.type === 'thread.permission_mode'))
      .toEqual([expect.objectContaining({ payload: expect.objectContaining({ from: null, to: 'ask' }) })])
    // The question raised under the old mode is still pending and answerable.
    const pendingId = mms.questions.listPendingForThread(thread.id)[0].requestId
    expect(mms.questions.listPendingForThread(thread.id)).toHaveLength(1)

    await expect(c.request('threads.setPermissionMode', { threadId: thread.id, mode: 'yolo' })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(c.request('threads.setPermissionMode', { threadId: 'missing', mode: 'full' })).rejects.toMatchObject({ code: 'thread_not_found' })
    await expect(c.request('threads.setPermissionMode', { threadId: thread.id, mode: 'full', extra: true })).rejects.toBeTruthy()
    expect(mms.threads.getThread(thread.id)?.permissionMode).toBe('ask')

    mms.questions.submitAnswers(pendingId, { q1: 'a' }, { kind: 'user' })
    await wait
    await c.close()
  })

  it('orchestrator.send takes no permission mode: the mode is the thread\'s, never a per-message override', async () => {
    const thread = mms.threads.createThread('NoOverride')
    const c = await client()
    await expect(c.request('orchestrator.send', { threadId: thread.id, content: 'hi', permissionMode: 'full' })).rejects.toBeTruthy()
    expect(mms.orchestrator.getMessagesForPersistence(thread.id)).toEqual([])
    await c.close()
  })

  it('answering a question records a visible user message in the transcript', async () => {
    const thread = mms.threads.createThread('QVisible')
    const wait = mms.questions.requestAnswers(
      [
        {
          id: 'scope',
          prompt: 'Which scope?',
          options: [
            { id: 'frontend', label: 'Frontend only' },
            { id: 'backend', label: 'Backend only' }
          ]
        }
      ],
      thread.id
    )
    await vi.waitFor(() => {
      expect(mms.questions.listPendingForThread(thread.id).length).toBe(1)
    })

    const c = await client()
    const pending = await c.request<{
      pending: Array<{ requestId: string }>
    }>('orchestrator.pendingQuestions', { threadId: thread.id })
    const requestId = pending.pending[0].requestId
    const ok = await c.request<{ ok: boolean }>('orchestrator.answerQuestions', {
      requestId,
      answers: { scope: 'backend' }
    })
    expect(ok.ok).toBe(true)
    await wait

    const snap = await c.request<{
      messages: Array<{ role: string; content: string }>
    }>('thread.snapshot', { threadId: thread.id })
    const userMsgs = snap.messages.filter((m) => m.role === 'user')
    expect(userMsgs).toHaveLength(1)
    expect(userMsgs[0].content).toBe('Q: Which scope?\nA: Backend only')
    await c.close()
  })

  it('dismissing a question records a visible dismissal message', async () => {
    const thread = mms.threads.createThread('QDismissed')
    const wait = mms.questions
      .requestAnswers(
        [{ id: 'q1', prompt: 'Choose', options: [{ id: 'a', label: 'A' }] }],
        thread.id
      )
      .then(
        () => 'resolved',
        () => 'rejected'
      )
    await vi.waitFor(() => {
      expect(mms.questions.listPendingForThread(thread.id).length).toBe(1)
    })

    const c = await client()
    const pending = await c.request<{
      pending: Array<{ requestId: string }>
    }>('orchestrator.pendingQuestions', { threadId: thread.id })
    const ok = await c.request<{ ok: boolean }>('orchestrator.dismissQuestions', {
      requestId: pending.pending[0].requestId
    })
    expect(ok.ok).toBe(true)
    await expect(wait).resolves.toBe('rejected')

    const snap = await c.request<{
      messages: Array<{ role: string; content: string }>
    }>('thread.snapshot', { threadId: thread.id })
    const userMsgs = snap.messages.filter((m) => m.role === 'user')
    expect(userMsgs).toHaveLength(1)
    expect(userMsgs[0].content).toBe('Dismissed question: Choose')
    await c.close()
  })

  it.each(['interactive', 'gui', 'headless'] as const)('daemon restart marks running and starting %s agents interrupted and leaves ready ones', async (executionMode) => {
    const thread = mms.threads.createThread('Restart')
    const agents = mms.threadRuntimes.getOrHydrate(thread.id).agents
    // Interactive agents are only interrupted when their recorded PTY died with the daemon.
    const base = { cliType: 'codex' as const, worktreePath: home, branch: 'restart-test', executionMode, ...(executionMode === 'interactive' ? { ptyId: 'stale-pty-id' } : {}) }
    const running = agents.create({ ...base, status: 'running', task: 'running work' })
    const starting = agents.create({ ...base, status: 'starting', task: 'starting work' })
    const ready = agents.create({ ...base, status: 'ready', task: 'ready work' })
    mms.threadRuntimes.restoreOnStartup()
    const statusOf = (id: string) => mms.threadRuntimes.listAgents(thread.id).find((x) => x.id === id)?.status
    expect(statusOf(running.id)).toBe('interrupted')
    expect(statusOf(starting.id)).toBe('interrupted')
    expect(statusOf(ready.id)).toBe('ready')
  })

  it('pending questions do not survive daemon restart and cannot be answered', async () => {
    const thread = mms.threads.createThread('QRestart')
    const wait = mms.questions.requestAnswers(
      [{ id: 'q1', prompt: 'x', options: [{ id: 'a', label: 'A' }] }],
      thread.id
    ).catch((e: Error) => e.message)
    expect(mms.questions.listPendingForThread(thread.id)).toHaveLength(1)
    const result = mms.questions.markInterruptedByDaemonRestart()
    expect(result.survivesDaemonRestart).toBe(false)
    expect(mms.questions.listPendingForThread(thread.id)).toHaveLength(0)
    expect(mms.questions.submitAnswers('nope', { q1: 'a' })).toBe(false)
    await expect(wait).resolves.toMatch(/restart|interrupted/i)
  })

  it('agents/tasks persist and remain thread-scoped across hydrate', async () => {
    const t1 = mms.threads.createThread('Persist1')
    const c = await client()
    await c.request('tasks.create', { threadId: t1.id, description: 'durable-task' })
    mms.threadRuntimes.persistAgentsTasks(t1.id)

    // Drop in-memory runtime and rehydrate
    mms.threadRuntimes.disposeRuntime(t1.id)
    // dispose kills PTYs and questions only — rehydrate loads from disk
    const again = mms.threadRuntimes.getOrHydrate(t1.id)
    expect(again.tasks.list().some((t) => t.description === 'durable-task')).toBe(true)
    await c.close()
  })

  it('snapshot includes agents, tasks, activity, pending questions', async () => {
    const t = mms.threads.createThread('Snap')
    const c = await client()
    await c.request('tasks.create', { threadId: t.id, description: 's' })
    mms.threadRuntimes.getOrHydrate(t.id).agents.create({
      cliType: 'codex', worktreePath: home, branch: 'snap', executionMode: 'headless', status: 'ready', task: 'snap agent'
    })
    void mms.questions.requestAnswers([{ id: 'q1', prompt: 'Choose', options: [{ id: 'a', label: 'A' }] }], t.id).catch(() => undefined)
    const snap = await c.request<{
      agents: { task: string }[]
      tasks: { description: string }[]
      activity: string
      pendingQuestions: unknown[]
      activeTurn: { active: boolean; running: boolean }
    }>('thread.snapshot', { threadId: t.id })
    expect(snap.agents.map((a) => a.task)).toEqual(['snap agent'])
    expect(snap.tasks.map((x) => x.description)).toEqual(['s'])
    expect(snap.pendingQuestions).toHaveLength(1)
    expect(snap.activity).toBe('awaiting_input')
    expect(snap.activeTurn).toEqual({ active: false, running: false })
    await c.close()
  })

  describe('saved approval requests (SPEC §17)', () => {
    const approvalQuestion = [{ id: 'permission', prompt: 'Allow Claude Code to run a command (Bash)?\nnpm test', options: [{ id: 'allow', label: 'Allow once' }, { id: 'reject', label: 'Reject' }] }]
    const approvalTag = {
      action: 'command' as const,
      permissionKey: 'claude:command',
      options: [{ id: 'allow', decision: 'allow' as const, scope: 'once' as const }, { id: 'reject', decision: 'reject' as const }],
      tool: { name: 'Bash', input: { command: 'npm test' }, cwd: '/work/app' }
    }
    const startRun = async (threadId: string, key = 'approval-run') => {
      const sent = await mms.runEngine.dispatch({ kind: 'send', threadId, clientRequestId: key, source: 'gui' })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      mms.runEngine.markStarting(sent.runId)
      const run = mms.runEngine.markRunning(sent.runId)
      // The binding a real turn records: it says which mode the run asks under and who started it.
      mms.runEngine.recordExecutionBinding(run.runId, {
        instanceId: 'claude-subscription', driver: 'claude-code', accountGeneration: 0, homeId: 'default', configRevision: 0, model: 'sonnet',
        policy: { mode: 'default', origin: 'interactive', approvals: 'ask', permissionMode: 'ask' }
      } as never)
      return run
    }
    const clientAs = async (clientType: 'gui' | 'cli'): Promise<LocalMmsClient> => {
      const c = new LocalMmsClient({ homeDir: home, ownerToken, endpoint, clientType })
      await c.connect()
      return c
    }
    type Answer = { ok: boolean; reason?: string; decision?: string; answeredBy?: { kind: string; via?: string }; cancelReason?: string }

    it('survives a client reconnect, is answered by the CLI, and a second client learns who won', async () => {
      const thread = mms.threads.createThread('Approval')
      await startRun(thread.id)
      const gui = await clientAs('gui')
      const live: string[] = []
      gui.onEvent((event, delivery) => {
        if (event.type === 'questions.pending' && !delivery?.replay) live.push((event.data as { requestId: string }).requestId)
      })
      await gui.subscribe(0)
      const waiter = mms.questions.requestAnswers(approvalQuestion, thread.id, { approval: approvalTag })
      await vi.waitFor(() => expect(mms.questions.listPendingForThread(thread.id)).toHaveLength(1))
      const requestId = mms.questions.listPendingForThread(thread.id)[0]!.requestId
      await vi.waitFor(() => expect(live).toEqual([requestId]))

      // A reconnect and a resubscribe show the same card and notify nobody again.
      await gui.close()
      const reopened = await clientAs('gui')
      const replayed: string[] = []
      reopened.onEvent((event, delivery) => {
        if (event.type === 'questions.pending' && (event.data as { requestId: string }).requestId === requestId) replayed.push(delivery?.replay ? 'replay' : 'live')
      })
      await reopened.subscribe(0)
      expect(replayed.filter((kind) => kind === 'live')).toEqual([])
      const pending = await reopened.request<{ pending: Array<{ requestId: string; approval?: { answerPath: string } }> }>('orchestrator.pendingQuestions', { threadId: thread.id })
      expect(pending.pending).toEqual([expect.objectContaining({ requestId, approval: expect.objectContaining({ answerPath: 'live' }) })])
      const snap = await reopened.request<{ pendingQuestions: Array<{ requestId: string }>; activity: string }>('thread.snapshot', { threadId: thread.id })
      expect(snap.pendingQuestions.map((entry) => entry.requestId)).toEqual([requestId])

      // The CLI answers; the callback gets the answer once.
      const cli = await clientAs('cli')
      await expect(cli.request<Answer>('orchestrator.answerQuestions', { requestId, answers: { permission: 'allow' } })).resolves.toEqual({ ok: true })
      await expect(waiter).resolves.toEqual({ permission: 'allow' })
      expect(mms.runEngine.approvals.get(requestId)).toMatchObject({ status: 'answered', decision: 'allow', answeredBy: { kind: 'user', via: 'cli' } })
      // The GUI, a moment later, is told who decided what.
      await expect(reopened.request<Answer>('orchestrator.answerQuestions', { requestId, answers: { permission: 'reject' } })).resolves.toEqual({
        ok: false, reason: 'already_answered', answeredBy: { kind: 'user', via: 'cli' }, decision: 'allow'
      })
      expect((await reopened.request<{ pending: unknown[] }>('orchestrator.pendingQuestions', { threadId: thread.id })).pending).toEqual([])
      await reopened.close()
      await cli.close()
    })

    it('threads.approvalRequests lists the thread\'s requests with the answers they got, oldest first', async () => {
      const thread = mms.threads.createThread('History')
      const other = mms.threads.createThread('Elsewhere')
      await startRun(thread.id, 'history-run')
      const gui = await clientAs('gui')
      type Listed = { threadId: string; requests: Array<{ requestId: string; action: string; prompt: string; status: string; decision?: string; scope?: string; answeredBy?: { kind: string; via?: string }; createdAt: string; settledAt?: string }> }
      const first = mms.questions.requestAnswers(approvalQuestion, thread.id, { approval: approvalTag })
      await vi.waitFor(() => expect(mms.questions.listPendingForThread(thread.id)).toHaveLength(1))
      const firstId = mms.questions.listPendingForThread(thread.id)[0]!.requestId
      const waiting = await gui.request<Listed>('threads.approvalRequests', { threadId: thread.id })
      expect(waiting).toEqual({ threadId: thread.id, requests: [expect.objectContaining({ requestId: firstId, action: 'command', status: 'pending', prompt: approvalQuestion[0]!.prompt })] })
      expect(waiting.requests[0]!.decision).toBeUndefined()

      await gui.request('orchestrator.answerQuestions', { requestId: firstId, answers: { permission: 'allow' } })
      await expect(first).resolves.toEqual({ permission: 'allow' })
      const second = mms.questions.requestAnswers(approvalQuestion, thread.id, { approval: approvalTag })
      await vi.waitFor(() => expect(mms.questions.listPendingForThread(thread.id)).toHaveLength(1))
      const secondId = mms.questions.listPendingForThread(thread.id)[0]!.requestId
      await gui.request('orchestrator.answerQuestions', { requestId: secondId, answers: { permission: 'reject' } })
      await second

      const listed = await gui.request<Listed>('threads.approvalRequests', { threadId: thread.id })
      expect(listed.requests.map(({ requestId, status, decision, answeredBy }) => ({ requestId, status, decision, answeredBy }))).toEqual([
        { requestId: firstId, status: 'answered', decision: 'allow', answeredBy: { kind: 'user', via: 'gui' } },
        { requestId: secondId, status: 'answered', decision: 'reject', answeredBy: { kind: 'user', via: 'gui' } }
      ])
      expect(listed.requests.every((request) => typeof request.settledAt === 'string')).toBe(true)
      // Only the thread's own requests, and only for a thread that exists.
      expect((await gui.request<Listed>('threads.approvalRequests', { threadId: other.id })).requests).toEqual([])
      await expect(gui.request('threads.approvalRequests', { threadId: 'missing' })).rejects.toMatchObject({ code: 'thread_not_found' })
      await expect(gui.request('threads.approvalRequests', { threadId: thread.id, extra: 1 })).rejects.toBeTruthy()
      await gui.close()
    })

    it('"Always for this thread" from the CLI makes a rule that is listed, answers the same request, stays in its thread and is revoked over the protocol', async () => {
      const thread = mms.threads.createThread('Always')
      const other = mms.threads.createThread('Other')
      await startRun(thread.id, 'always-run')
      await startRun(other.id, 'other-run')
      const cli = await clientAs('cli')
      const waiter = mms.questions.requestAnswers(approvalQuestion, thread.id, { approval: approvalTag })
      const pending = await cli.request<{ pending: Array<{ requestId: string; questions: Array<{ options: Array<{ id: string; decision?: string; scope?: string }> }> }> }>('orchestrator.pendingQuestions', { threadId: thread.id })
      const requestId = pending.pending[0]!.requestId
      expect(pending.pending[0]!.questions[0]!.options.map((option) => option.id)).toEqual(['allow', 'allow_always', 'reject'])
      await expect(cli.request<Answer>('orchestrator.answerQuestions', { requestId, answers: { permission: 'allow_always' } })).resolves.toEqual({ ok: true })
      await expect(waiter).resolves.toEqual({ permission: 'allow' })

      const listed = await cli.request<{ threadId: string; rules: Array<{ id: string; permissionKey: string; action: string; summary: string; grantedUnder: string; active: boolean }> }>('threads.approvalRules', { threadId: thread.id })
      expect(listed.rules).toEqual([expect.objectContaining({ permissionKey: 'claude:command', action: 'command', grantedUnder: 'ask', active: true, summary: expect.stringContaining('npm test') })])
      expect((await cli.request<{ rules: unknown[] }>('threads.approvalRules', { threadId: other.id })).rules).toEqual([])

      // The same request is answered without asking; the other thread, a near miss and a request without a fingerprint ask.
      const again = mms.questions.requestAnswers(approvalQuestion, thread.id, { approval: approvalTag })
      expect(mms.questions.listPendingForThread(thread.id)).toEqual([])
      await expect(again).resolves.toEqual({ permission: 'allow' })
      for (const [threadId, approval] of [
        [other.id, approvalTag],
        [thread.id, { ...approvalTag, tool: { ...approvalTag.tool, input: { command: 'npm test --watch' } } }],
        [thread.id, { ...approvalTag, tool: { ...approvalTag.tool, cwd: '/work/other' } }],
        [thread.id, { ...approvalTag, tool: undefined }]
      ] as Array<[string, typeof approvalTag]>) {
        const asked = mms.questions.requestAnswers(approvalQuestion, threadId, { approval }).catch(() => undefined)
        expect(mms.questions.listPendingForThread(threadId), JSON.stringify(approval.tool)).toHaveLength(1)
        mms.questions.dismissAllForThread(threadId)
        await asked
      }

      // Revoking is validated and scoped to the thread.
      await expect(cli.request('threads.approvalRules', { threadId: 'missing' })).rejects.toMatchObject({ code: 'thread_not_found' })
      await expect(cli.request('threads.clearApprovalRules', { threadId: 'missing' })).rejects.toMatchObject({ code: 'thread_not_found' })
      await expect(cli.request('threads.clearApprovalRules', { threadId: thread.id, all: true })).rejects.toBeTruthy()
      await expect(cli.request('threads.approvalRules', { threadId: thread.id, extra: 1 })).rejects.toBeTruthy()
      expect(await cli.request('threads.clearApprovalRules', { threadId: other.id, ruleId: listed.rules[0]!.id })).toMatchObject({ removed: 0, rules: [] })
      expect(mms.runEngine.approvals.listRules(thread.id)).toHaveLength(1)
      expect(await cli.request('threads.clearApprovalRules', { threadId: thread.id, ruleId: listed.rules[0]!.id })).toMatchObject({ removed: 1, rules: [] })
      const asked = mms.questions.requestAnswers(approvalQuestion, thread.id, { approval: approvalTag }).catch(() => undefined)
      expect(mms.questions.listPendingForThread(thread.id)).toHaveLength(1)
      mms.questions.dismissAllForThread(thread.id)
      await asked
      await cli.close()
    })

    it('a rule is shown as paused while the thread is stricter than the mode it was granted under', async () => {
      const thread = mms.threads.createThread('Paused')
      await startRun(thread.id, 'paused-run')
      mms.orchestrator.setThreadPermissionMode(thread.id, 'accept_edits')
      const cli = await clientAs('cli')
      const waiter = mms.questions.requestAnswers(approvalQuestion, thread.id, { approval: approvalTag })
      // The run has no binding, so it asks as the strictest mode: the rule is granted under Ask and holds everywhere.
      mms.questions.settle(mms.questions.listPendingForThread(thread.id)[0]!.requestId, { permission: 'allow_always' }, { kind: 'user' })
      await waiter
      expect((await cli.request<{ rules: Array<{ active: boolean }> }>('threads.approvalRules', { threadId: thread.id })).rules.map((rule) => rule.active)).toEqual([true])
      // Hand-made rule granted under Full access: paused while the thread asks about more.
      mms.runEngine.approvals.create({ requestId: 'x', threadId: thread.id, instanceId: 'i', provider: 'claude', action: 'command', permissionKey: 'claude:command', fingerprint: 'b'.repeat(64), permissionMode: 'full', questions: [{ id: 'permission', prompt: 'Run it again?', options: [{ id: 'allow', label: 'Allow once', decision: 'allow', scope: 'once' }, { id: 'allow_always', label: 'Always', decision: 'allow', scope: 'always' }, { id: 'reject', label: 'Reject', decision: 'reject' }] }] })
      mms.questions.settle('x', { permission: 'allow_always' }, { kind: 'user' })
      const rules = (await cli.request<{ rules: Array<{ grantedUnder: string; active: boolean }> }>('threads.approvalRules', { threadId: thread.id })).rules
      expect(rules.map((rule) => [rule.grantedUnder, rule.active]).sort()).toEqual([['ask', true], ['full', false]])
      await cli.close()
    })

    it('an answer to a request that was closed says so', async () => {
      const thread = mms.threads.createThread('Closed')
      const run = await startRun(thread.id)
      const waiter = mms.questions.requestAnswers(approvalQuestion, thread.id, { approval: approvalTag }).catch((error: Error) => error.message)
      const requestId = mms.questions.listPendingForThread(thread.id)[0]!.requestId
      mms.runEngine.markTerminal(run.runId, 'failed', { error: 'boom' })
      await expect(waiter).resolves.toMatch(/closed/)
      const c = await clientAs('gui')
      await expect(c.request<Answer>('orchestrator.answerQuestions', { requestId, answers: { permission: 'allow' } })).resolves.toEqual({ ok: false, reason: 'cancelled', cancelReason: 'turn_ended' })
      await c.close()
    })

    it('stays pending across a profile restart as a request whose answer continues the thread', async () => {
      const thread = mms.threads.createThread('Restart')
      const run = await startRun(thread.id)
      const waiter = mms.questions.requestAnswers(approvalQuestion, thread.id, { approval: approvalTag }).catch(() => undefined)
      const requestId = mms.questions.listPendingForThread(thread.id)[0]!.requestId
      await server.stop()
      await mms.stop()
      await waiter

      mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
      await mms.start()
      ownerToken = mms.getOwnerLease()!.owner.token
      server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
      endpoint = await server.start()

      const c = await clientAs('cli')
      const pending = await c.request<{ pending: Array<{ requestId: string; approval?: { answerPath: string; uncertain?: boolean } }> }>('orchestrator.pendingQuestions', { threadId: thread.id })
      expect(pending.pending).toEqual([expect.objectContaining({ requestId, approval: expect.objectContaining({ answerPath: 'continue' }) })])
      expect(mms.runEngine.approvals.get(requestId)).toMatchObject({ status: 'pending', decision: null, runId: run.runId })
      // Nothing was started or granted by the restart.
      expect(mms.runEngine.listRuns(thread.id)).toHaveLength(1)
      await c.close()
    })

    it('orchestrator.send takes no approval or answerer fields: they are the daemon\'s own', async () => {
      const thread = mms.threads.createThread('NoInternals')
      const c = await clientAs('cli')
      for (const field of [{ permissionDecisions: [] }, { bindDelivery: { requestIds: ['r'] } }, { settleApprovals: { answeredBy: { kind: 'user' } } }, { actor: { kind: 'user' } }])
        await expect(c.request('orchestrator.send', { threadId: thread.id, content: 'hi', ...field })).rejects.toBeTruthy()
      expect(mms.orchestrator.getMessagesForPersistence(thread.id)).toEqual([])
      await c.close()
    })
  })
})
