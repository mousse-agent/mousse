/**
 * Phase 4: multi-tenant thread runtimes, PTY isolation, questions, delete fence.
 */

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { userQuestionService } from '../src/mms/orchestrator/UserQuestionService'

describe('Phase 4 ThreadRuntime + protocol', () => {
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

    const created = await c.request<{ ptyId: string }>('pty.create', {
      threadId: t1.id,
      agentId: 'agent-1',
      cwd: tmpdir()
    })
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

  it('PTY output sequence replay after client disconnect', async () => {
    const t1 = mms.threads.createThread('PtyReplay')
    const c = await client()
    const created = await c.request<{ ptyId: string }>('pty.create', {
      threadId: t1.id,
      agentId: 'a',
      cwd: tmpdir()
    })
    // Write something (shell may not echo; still exercise sequence API)
    await c.request('pty.write', { ptyId: created.ptyId, data: 'echo hello\r' })
    await new Promise((r) => setTimeout(r, 100))
    const since = await c.request<{
      sequence: number
      chunks: unknown[]
      scrollback: string
    }>('pty.outputSince', { ptyId: created.ptyId, afterSequence: 0 })
    expect(typeof since.sequence).toBe('number')
    expect(since.sequence).toBeGreaterThanOrEqual(0)
    await c.close()

    const c2 = await client()
    const alive = await c2.request<{ alive: boolean }>('pty.isAlive', {
      ptyId: created.ptyId
    })
    expect(alive.alive).toBe(true)
    const re = await c2.request<{ scrollback: string }>('pty.scrollback', {
      ptyId: created.ptyId
    })
    expect(typeof re.scrollback).toBe('string')
    await c2.request('pty.kill', { ptyId: created.ptyId })
    await c2.close()
  })

  it('pending question survives client disconnect; answer reaches waiter', async () => {
    const thread = mms.threads.createThread('Q')
    let answered: unknown = null
    const wait = userQuestionService.requestAnswers(
      [{ id: 'q1', prompt: 'Choose', options: [{ id: 'a', label: 'A' }] }],
      thread.id
    ).then((a) => {
      answered = a
    })

    await vi.waitFor(() => {
      expect(userQuestionService.listPendingForThread(thread.id).length).toBe(1)
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

  it('thread delete is fenced while turn or PTY is active', async () => {
    const thread = mms.threads.createThread('Fence')
    const c = await client()
    const created = await c.request<{ ptyId: string }>('pty.create', {
      threadId: thread.id,
      agentId: 'x',
      cwd: tmpdir()
    })
    await expect(
      c.request('threads.delete', { threadId: thread.id })
    ).rejects.toThrow(/active|Cannot delete/i)

    await c.request('pty.kill', { ptyId: created.ptyId })
    await c.request('threads.delete', { threadId: thread.id })
    expect(mms.threads.getThread(thread.id)).toBeUndefined()
    await c.close()
  })

  it('daemon restart marks non-reattachable agent state interrupted truthfully', async () => {
    const thread = mms.threads.createThread('Restart')
    mms.threadRuntimes.getOrHydrate(thread.id).agents.create({
      cliType: 'claude-code',
      worktreePath: home,
      branch: 'test',
      executionMode: 'interactive',
      status: 'running',
      ptyId: 'stale-pty-id',
      task: 'stale work'
    })
    mms.threadRuntimes.restoreOnStartup()
    const agents = mms.threadRuntimes.listAgents(thread.id)
    const a = agents.find((x) => x.ptyId === 'stale-pty-id')
    expect(a).toBeTruthy()
    expect(a!.status).toBe('interrupted')
  })

  it('pending questions do not survive daemon restart and cannot be answered', async () => {
    const thread = mms.threads.createThread('QRestart')
    const wait = userQuestionService.requestAnswers(
      [{ id: 'q1', prompt: 'x', options: [{ id: 'a', label: 'A' }] }],
      thread.id
    ).catch((e: Error) => e.message)
    expect(userQuestionService.listPendingForThread(thread.id)).toHaveLength(1)
    const result = userQuestionService.markInterruptedByDaemonRestart()
    expect(result.survivesDaemonRestart).toBe(false)
    expect(userQuestionService.listPendingForThread(thread.id)).toHaveLength(0)
    expect(userQuestionService.submitAnswers('nope', { q1: 'a' })).toBe(false)
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
    mms.threadRuntimes.setActivity(t.id, 'processing')
    const snap = await c.request<{
      agents: unknown[]
      tasks: unknown[]
      activity: string
      pendingQuestions: unknown[]
      activeTurn: { active: boolean; running: boolean }
    }>('thread.snapshot', { threadId: t.id })
    expect(Array.isArray(snap.agents)).toBe(true)
    expect(snap.tasks.length).toBe(1)
    expect(snap.activity).toBe('processing')
    expect(Array.isArray(snap.pendingQuestions)).toBe(true)
    expect(snap.activeTurn).toBeTruthy()
    await c.close()
  })
})
