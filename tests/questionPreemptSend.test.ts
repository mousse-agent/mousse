import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { OrchestratorService } from '../src/mms/orchestrator/OrchestratorService'
import {
  formatQuestionAnswersMessage,
  formatQuestionDismissMessage
} from '../src/mms/orchestrator/OrchestratorService'
import { userQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { AgentRegistry } from '../src/mms/agents/AgentRegistry'
import { TaskQueue } from '../src/mms/tasks/TaskQueue'
import { WorktreeManager } from '../src/mms/worktree/WorktreeManager'
import { PtyManager } from '../src/mms/terminals/PtyManager'
import { HeadlessAgentRunner } from '../src/mms/terminals/HeadlessAgentRunner'
import { MacroEngine } from '../src/mms/macros/MacroEngine'
import { getDefaultSettings } from '../src/shared/settings'

function createOrchestrator(home: string, store: ThreadDataStore): OrchestratorService {
  process.env.MOUSSE_HOME = home
  const agents = new AgentRegistry()
  const tasks = new TaskQueue()
  const worktrees = new WorktreeManager(home)
  const pty = new PtyManager()
  const headless = new HeadlessAgentRunner()
  const macros = {
    listProviders: () => ['mousse'],
    isHeadlessEnabled: () => false,
    getHeadlessShellCommand: () => 'echo',
    getCliCommand: () => 'echo',
    runPtyMacro: async () => ({ log: [] as string[] })
  } as unknown as MacroEngine
  const settingsStore = { getSettings: () => getDefaultSettings(), get: () => getDefaultSettings() }
  const providerAuth = { getConnectedProviders: () => [] }
  const orch = new OrchestratorService(
    agents,
    tasks,
    worktrees,
    pty,
    headless,
    macros,
    settingsStore as never,
    providerAuth as never
  )
  orch.setThreadStore(store)
  return orch
}

describe('send preempts pending questions instead of queueing', () => {
  let home: string
  let store: ThreadDataStore
  let orch: OrchestratorService

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-preempt-'))
    process.env.MOUSSE_HOME = home
    store = new ThreadDataStore(new ProjectManager())
    orch = createOrchestrator(home, store)
  })

  afterEach(() => {
    userQuestionService.markInterruptedByDaemonRestart()
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  it('default-rejects a quick-action approval with the reject option', async () => {
    const waiter = userQuestionService.requestAnswers(
      [
        {
          id: 'approval',
          prompt: 'Create quick action "X" (send here)? Content: hi',
          options: [
            { id: 'approve', label: 'Approve and create' },
            { id: 'reject', label: 'Reject' }
          ]
        }
      ],
      'thread-qa'
    )
    const result = userQuestionService.autoRejectPendingForThread('thread-qa')
    expect(result).toEqual({ answered: 1, dismissed: 0 })
    await expect(waiter).resolves.toEqual({ approval: 'reject' })
    expect(userQuestionService.listPendingForThread('thread-qa')).toHaveLength(0)
  })

  it('dismisses a generic ask_user with no reject-like option', async () => {
    const waiter = userQuestionService.requestAnswers(
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
      'thread-ask'
    )
    const failed = expect(waiter).rejects.toThrow(/dismiss/i)
    const result = userQuestionService.autoRejectPendingForThread('thread-ask')
    expect(result).toEqual({ answered: 0, dismissed: 1 })
    await failed
    expect(userQuestionService.listPendingForThread('thread-ask')).toHaveLength(0)
  })

  it('sending while blocked on approval rejects it and runs a fresh turn (no queue)', async () => {
    const thread = store.createThread('Blocked')
    orch.bindThread(thread.id, [], undefined, [])
    const session = orch.getOrCreateSession(thread.id)
    session.activeTurn = { abort: new AbortController(), pendingSteer: [] }

    const waiter = userQuestionService.requestAnswers(
      [
        {
          id: 'approval',
          prompt: 'Create quick action "X" (send here)? Content: hi',
          options: [
            { id: 'approve', label: 'Approve and create' },
            { id: 'reject', label: 'Reject' }
          ]
        }
      ],
      thread.id
    )

    // Simulate the blocked tool loop exiting once its question resolves.
    vi.spyOn(orch, 'abortActiveTurn').mockImplementation(() => {
      session.activeTurn?.abort.abort()
      session.activeTurn = null
      return true
    })
    const runSpy = vi
      .spyOn(orch as unknown as { runTurnOnSession: (...args: unknown[]) => Promise<unknown> }, 'runTurnOnSession')
      .mockResolvedValue({ message: 'fresh', actions: [] })

    const result = await orch.send('my new message', false, { threadId: thread.id })

    expect(result.queued).not.toBe(true)
    expect(orch.listQueue(thread.id)).toHaveLength(0)
    await expect(waiter).resolves.toEqual({ approval: 'reject' })
    expect(runSpy).toHaveBeenCalledOnce()
  })

  it('still queues while busy when no question is pending', async () => {
    const thread = store.createThread('Busy')
    orch.bindThread(thread.id, [], undefined, [])
    const session = orch.getOrCreateSession(thread.id)
    session.activeTurn = { abort: new AbortController(), pendingSteer: [] }

    const result = await orch.send('hello while busy', false, { threadId: thread.id })
    expect(result.queued).toBe(true)
    expect(orch.listQueue(thread.id)).toHaveLength(1)
  })

  it('stuck blocked turn still delivers the message as a visible queued prompt, never an invisible steer', async () => {
    const thread = store.createThread('Stuck')
    orch.bindThread(thread.id, [], undefined, [])
    const session = orch.getOrCreateSession(thread.id)
    session.activeTurn = { abort: new AbortController(), pendingSteer: [] }

    const waiter = userQuestionService.requestAnswers(
      [
        {
          id: 'approval',
          prompt: 'Create quick action "X" (send here)? Content: hi',
          options: [
            { id: 'approve', label: 'Approve and create' },
            { id: 'reject', label: 'Reject' }
          ]
        }
      ],
      thread.id
    )

    // Simulate a turn that never settles even after abort: abort flips the
    // signal but the (absent) tool loop never releases the session.
    vi.spyOn(orch, 'abortActiveTurn').mockImplementation(() => {
      session.activeTurn?.abort.abort()
      return true
    })
    // Skip the bounded settle wait: the turn is stuck by construction.
    vi.spyOn(
      orch as unknown as { waitForTurnToSettle: (...args: unknown[]) => Promise<void> },
      'waitForTurnToSettle'
    ).mockResolvedValue(undefined)

    const result = await orch.send('my new message', false, { threadId: thread.id })

    // Visible queued prompt — not an invisible steer into the dying turn.
    expect(result.queued).toBe(true)
    expect(result.queueItem?.content).toBe('my new message')
    expect(orch.listQueue(thread.id).map((i) => i.content)).toEqual(['my new message'])
    expect(session.activeTurn?.pendingSteer).toEqual([])
    await expect(waiter).resolves.toEqual({ approval: 'reject' })
    expect(userQuestionService.listPendingForThread(thread.id)).toHaveLength(0)
  })
})

describe('question answers as visible user messages', () => {
  it('formats answers with option labels, custom text verbatim, multi-select joined', () => {
    expect(
      formatQuestionAnswersMessage(
        [
          {
            id: 'approval',
            prompt: 'Create quick action "X" (send here)? Content: hi',
            options: [
              { id: 'approve', label: 'Approve and create' },
              { id: 'reject', label: 'Reject' }
            ]
          }
        ],
        { approval: 'reject' }
      )
    ).toBe('Q: Create quick action "X" (send here)? Content: hi\nA: Reject')

    expect(
      formatQuestionAnswersMessage(
        [
          {
            id: 'scope',
            prompt: 'Which scope?',
            options: [
              { id: 'frontend', label: 'Frontend only' },
              { id: 'backend', label: 'Backend only' }
            ]
          },
          {
            id: 'note',
            prompt: 'Anything else?',
            options: [
              { id: 'yes', label: 'Yes' },
              { id: 'no', label: 'No' }
            ]
          }
        ],
        { scope: 'backend', note: 'ship it friday' }
      )
    ).toBe('Q: Which scope?\nA: Backend only\n\nQ: Anything else?\nA: ship it friday')

    expect(
      formatQuestionAnswersMessage(
        [
          {
            id: 'areas',
            prompt: 'Which areas?',
            allowMultiple: true,
            options: [
              { id: 'a', label: 'A' },
              { id: 'b', label: 'B' }
            ]
          },
          { id: 'missing', prompt: 'Skipped?', options: [{ id: 'x', label: 'X' }] }
        ],
        { areas: ['a', 'b'] }
      )
    ).toBe('Q: Which areas?\nA: A, B\n\nQ: Skipped?\nA: (no answer)')
  })

  it('formats dismissals with the question prompt', () => {
    expect(
      formatQuestionDismissMessage([
        { id: 'q1', prompt: 'Which scope?', options: [{ id: 'a', label: 'A' }] }
      ])
    ).toBe('Dismissed question: Which scope?')
    expect(formatQuestionDismissMessage([])).toBe('Dismissed the question.')
  })

  it('records the response as a visible user message without touching model context', () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-qvisible-'))
    process.env.MOUSSE_HOME = home
    try {
      const localStore = new ThreadDataStore(new ProjectManager())
      const localOrch = createOrchestrator(home, localStore)
      const thread = localStore.createThread('Visible')
      const seen: Array<{ threadId: string }> = []
      localOrch.on('thread-message', (payload) => seen.push(payload))

      const msg = localOrch.recordQuestionResponseMessage(
        thread.id,
        'Q: Which scope?\nA: Backend only'
      )
      expect(msg?.role).toBe('user')
      expect(msg?.content).toBe('Q: Which scope?\nA: Backend only')

      // Visible in the transcript...
      const visible = localOrch.getMessages(thread.id).filter((m) => m.role === 'user')
      expect(visible.map((m) => m.content)).toEqual(['Q: Which scope?\nA: Backend only'])
      // ...broadcast to subscribers...
      expect(seen.map((s) => s.threadId)).toEqual([thread.id])
      // ...but never injected into the model's native context mid-turn.
      const session = localOrch.getOrCreateSession(thread.id)
      expect(session.nativeContext.messages).toHaveLength(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
      delete process.env.MOUSSE_HOME
    }
  })

  it('record is a best-effort no-op for unknown threads', () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-qmissing-'))
    process.env.MOUSSE_HOME = home
    try {
      const localStore = new ThreadDataStore(new ProjectManager())
      const localOrch = createOrchestrator(home, localStore)
      expect(localOrch.recordQuestionResponseMessage('nope', 'Q: x\nA: y')).toBeNull()
      expect(localOrch.recordQuestionResponseMessage('nope', '   ')).toBeNull()
    } finally {
      rmSync(home, { recursive: true, force: true })
      delete process.env.MOUSSE_HOME
    }
  })
})
