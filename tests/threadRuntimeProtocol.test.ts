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
})
