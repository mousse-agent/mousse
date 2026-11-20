/**
 * The service keeps one runtime (agents, tasks, activity) per thread it has touched. Before this, nothing but a
 * delete ever dropped one: every started thread got one at startup and every thread read got one for good, so a
 * service with 4 threads loaded held 261. Now the idle sweep (`ThreadResidency.sweepNow`) drops a runtime nothing
 * holds once it is unused for the idle time, and archiving drops it at once; one that holds live work stays.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import type { OrchestratorService } from '../src/mms/orchestrator/OrchestratorService'
import { ThreadRuntimeManager } from '../src/mms/runtime/ThreadRuntimeManager'
import { UnseenDoneStore } from '../src/mms/runtime/UnseenDoneStore'
import { PtyManager } from '../src/mms/terminals/PtyManager'
import { createOrchestrator } from './run/phase6Fixture'
import type { ChatMessage } from '../src/shared/types'

const MINUTE = 60_000

describe('thread runtimes are released', () => {
  let home: string
  let store: ThreadDataStore
  let orch: OrchestratorService
  let runtimes: ThreadRuntimeManager
  let questions: UserQuestionService
  let clock: number
  const previous = { home: process.env.MOUSSE_HOME, sqlite: process.env.MOUSSE_SQLITE_THREAD_STORE }

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-runtime-release-')))
    // Threads in thread.db, so an idle session can be released as in the app.
    process.env.MOUSSE_SQLITE_THREAD_STORE = '1'
    store = new ThreadDataStore(new ProjectManager())
    orch = createOrchestrator(home, store)
    // Saved as the profile saves (`persistOrchestratorThread`), so an idle session can be released.
    orch.setPersistCallback((threadId) => {
      if (!threadId || !orch.hasSession(threadId)) return
      store.mutateThreadData(threadId, () => ({ messages: orch.liveMessagesForSave(threadId) as ChatMessage[], llmContext: orch.getNativeContext(threadId) }))
    })
    clock = Date.parse('2026-11-16T12:00:00.000Z')
    orch.residency.now = () => clock
    questions = new UserQuestionService()
    runtimes = new ThreadRuntimeManager()
    runtimes.attach({ threadStore: store, orchestrator: orch, ptyManager: new PtyManager(), questions, unseenDone: new UnseenDoneStore(home) })
  })

  afterEach(() => {
    store.closeThreadStorage()
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* left for the OS */ }
    if (previous.home === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previous.home
    if (previous.sqlite === undefined) delete process.env.MOUSSE_SQLITE_THREAD_STORE
    else process.env.MOUSSE_SQLITE_THREAD_STORE = previous.sqlite
  })

  /** A thread whose turn finished and was seen, with a finished agent saved: what most threads look like. */
  function finishedThread(title: string): string {
    const id = store.createThread(title, undefined, undefined, { started: true }).id
    runtimes.getOrHydrate(id).agents.create({ cliType: 'codex', executionMode: 'headless', worktreePath: home, branch: '', task: 'done work', status: 'completed' })
    runtimes.setActivity(id, 'processing')
    runtimes.setActivity(id, 'completed')
    runtimes.markSeen(id)
    expect(runtimes.get(id)?.activity).toBe('idle')
    return id
  }

  it('an idle finished thread is dropped after the idle time, and reads back the same from disk', () => {
    const id = finishedThread('Finished')
    clock += 5 * MINUTE
    orch.residency.sweepNow()
    expect(runtimes.get(id)).toBeDefined()

    clock += 6 * MINUTE
    orch.residency.sweepNow()
    expect(runtimes.get(id)).toBeUndefined()
    expect(runtimes.runtimeCount()).toBe(0)
    expect(runtimes.getActivitySnapshot()).toEqual({})
    // The next use hydrates it again with what was saved.
    expect(runtimes.listAgents(id).map((agent) => agent.status)).toEqual(['completed'])
  })

  it('a read moves the idle time on', () => {
    const id = finishedThread('Read')
    clock += 9 * MINUTE
    runtimes.getOrHydrate(id)
    clock += 9 * MINUTE
    orch.residency.sweepNow()
    expect(runtimes.get(id)).toBeDefined()
  })

  it('archiving a thread drops its runtime at once', async () => {
    const id = finishedThread('Archived')
    await orch.settleThread(id, true)
    expect(runtimes.get(id)).toBeUndefined()
  })

  it('an archived thread still loaded keeps its runtime until its session is released, then the sweep drops it', async () => {
    const id = finishedThread('Archived while loaded')
    orch.getOrCreateSession(id)
    await orch.settleThread(id, true)
    expect(runtimes.get(id)).toBeDefined()
    // Once the session is gone, an archived thread's runtime does not wait for the idle time again.
    clock += 11 * MINUTE
    orch.residency.sweepNow()
    expect(orch.hasSession(id)).toBe(false)
    expect(runtimes.get(id)).toBeUndefined()
  })

  // What keeps a runtime however long it is idle. Each row is live state a reload from disk would not rebuild.
  const held: Array<[string, (id: string) => void]> = [
    ['a running turn (Working)', (id) => runtimes.setActivity(id, 'processing')],
    ['waiting for input', (id) => runtimes.setActivity(id, 'awaiting_input')],
    ['paused until a usage limit resets', (id) => runtimes.setActivity(id, 'paused')],
    ['Done, not seen yet', (id) => { runtimes.setActivity(id, 'processing'); runtimes.setActivity(id, 'completed') }],
    ['a running agent', (id) => { runtimes.getOrHydrate(id).agents.create({ cliType: 'codex', executionMode: 'headless', worktreePath: home, branch: '', task: 'work', status: 'running' }) }],
    ['a task in progress', (id) => { runtimes.createTask(id, { description: 'work', status: 'in_progress' }) }],
    ['delegated tasks still running', (id) => runtimes.setPendingDelegations(id, true)],
    ['provider background work', (id) => runtimes.setPendingBackgroundWork(id, true)],
    ['an open terminal', (id) => runtimes.registerPty(id, 'pty-1')],
    ['a question waiting for an answer', (id) => { void questions.requestAnswers([{ id: 'q1', prompt: 'x', options: [{ id: 'a', label: 'A' }] }], id).catch(() => undefined) }],
    // The session is used again just before the sweep (below), so it stays loaded while the runtime ages.
    ['a loaded session', (id) => { orch.getOrCreateSession(id) }],
    ['a window showing it', (id) => orch.setThreadViewed('window-1', id, true)]
  ]

  it.each(held)('a thread with %s keeps its runtime, idle or archived', async (_label, hold) => {
    const id = store.createThread('Held', undefined, undefined, { started: true }).id
    runtimes.getOrHydrate(id)
    hold(id)
    clock += 60 * MINUTE
    if (orch.hasSession(id)) orch.residency.touch(id)
    orch.residency.sweepNow()
    expect(runtimes.get(id)).toBeDefined()
    store.setThreadSettled(id, true)
    if (orch.hasSession(id)) orch.residency.touch(id)
    orch.residency.sweepNow()
    expect(runtimes.get(id)).toBeDefined()
  })

  it('the kill switch for releasing idle threads also keeps runtimes', () => {
    const id = finishedThread('Kept by the switch')
    orch.residency.setEnabled(() => false)
    clock += 60 * MINUTE
    orch.residency.sweepNow()
    expect(runtimes.get(id)).toBeDefined()
  })

  it('startup makes runtimes only for threads with work, not for every started thread', () => {
    const plain = store.createThread('Started, nothing left', undefined, undefined, { started: true }).id
    const withTask = store.createThread('Task left running', undefined, undefined, { started: true }).id
    runtimes.createTask(withTask, { description: 'work', status: 'in_progress' })
    runtimes.persistAgentsTasks(withTask)

    const restarted = new ThreadRuntimeManager()
    restarted.attach({ threadStore: store, orchestrator: orch, ptyManager: new PtyManager(), questions: new UserQuestionService() })
    restarted.restoreOnStartup()
    expect(restarted.get(plain)).toBeUndefined()
    expect(restarted.get(withTask)?.tasks.list().map((task) => task.status)).toEqual(['interrupted'])
  })

  it('after a restart, a thread used before the background pass reaches it is settled on that use, and the pass leaves its new work alone', async () => {
    const used = store.createThread('Opened right after the restart', undefined, undefined, { started: true }).id
    const later = store.createThread('Not opened', undefined, undefined, { started: true }).id
    for (const id of [used, later]) {
      runtimes.createTask(id, { description: 'cut short', status: 'in_progress' })
      runtimes.persistAgentsTasks(id)
    }

    const restarted = new ThreadRuntimeManager()
    restarted.attach({ threadStore: store, orchestrator: orch, ptyManager: new PtyManager(), questions: new UserQuestionService() })
    // What the daemon does before it is ready: no thread is read yet.
    restarted.beginRestart()
    expect(restarted.get(used)).toBeUndefined()
    expect(restarted.get(later)).toBeUndefined()
    // The first read already shows what the restart cut short as interrupted.
    expect(restarted.listTasks(used).map((task) => task.status)).toEqual(['interrupted'])
    restarted.createTask(used, { description: 'started after the restart', status: 'in_progress' })
    // The rest, after ready, in the background.
    await restarted.settleRestartedThreads()
    expect(restarted.listTasks(used).map((task) => task.status)).toEqual(['interrupted', 'in_progress'])
    expect(restarted.get(later)?.tasks.list().map((task) => task.status)).toEqual(['interrupted'])
  })
})
