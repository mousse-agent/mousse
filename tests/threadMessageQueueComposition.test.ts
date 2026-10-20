// One composition check: a headless main service keeps agents, tasks and the queue apart on save.
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enqueueMessage } from '../src/mms/queue/ThreadMessageQueue'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'

describe('queue persistence through the main service', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-queue-main-'))
    process.env.MOUSSE_HOME = home
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  it('headless MMS send/accept load-merges agents/tasks and never overwrites messageQueue', async () => {
    // This exercises persistence; catalog refresh must not contact provider services.
    const providerInit = vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const service = await MousseMainService.create({
      homeDir: home,
      headless: true,
      ownerKind: 'test'
    }).finally(() => providerInit.mockRestore())
    try {
    const thread = service.threads.createThread('Headless persist')
    service.threads.saveThreadData(thread.id, {
      messages: [],
      agents: [
        {
          id: 'agent-1',
          cliType: 'mousse',
          worktreePath: home,
          branch: 'main',
          executionMode: 'headless',
          status: 'completed',
          task: 'done',
          createdAt: new Date().toISOString()
        }
      ],
      tasks: [
        {
          id: 'task-1',
          description: 'T',
          status: 'completed',
          createdAt: new Date().toISOString()
        }
      ],
      mousseAgentSessions: []
    })
    service.threads.saveMessageQueue(thread.id, [
      enqueueMessage([], { threadId: thread.id, content: 'keep-queue' }).item
    ])

    const orchSvc = service.orchestrator
    orchSvc.bindThread(thread.id, [], undefined, service.threads.loadMessageQueue(thread.id))

    const contextInputs = {
      systemPromptText: '',
      mcpToolsText: '',
      otherToolsText: '',
      signature: 'headless'
    }
    const llm = (orchSvc as unknown as {
      llm: {
        getSelectedModelContextLimit: () => { limit: number }
        getContextInputs: () => Promise<typeof contextInputs>
        chat: () => Promise<unknown>
      }
    }).llm
    vi.spyOn(llm, 'getSelectedModelContextLimit').mockReturnValue({ limit: 100_000 })
    vi.spyOn(llm, 'getContextInputs').mockResolvedValue(contextInputs)
    vi.spyOn(llm, 'chat').mockResolvedValue({
      text: 'headless-ok',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      modelName: 'test',
      totalResponseTimeMs: 1,
      totalTokensUsed: 2,
      tokensPerSecond: 1,
      contextInputs,
      toolEvents: [],
      nativeMessages: []
    })

    // Real orchestrator send/accept path (provider mocked); MMS-owned persist must merge.
    await orchSvc.send('from-headless', false, { threadId: thread.id })
    await vi.waitFor(() => {
      expect(orchSvc.isActiveTurnRunning(thread.id)).toBe(false)
    })

    const data = service.threads.loadThreadData(thread.id)
    const userContents = data.messages.filter((m) => m.role === 'user').map((m) => m.content)
    expect(userContents).toContain('from-headless')
    expect(data.agents.some((a) => a.id === 'agent-1')).toBe(true)
    expect(data.tasks.some((t) => t.id === 'task-1')).toBe(true)
    // Queue item is either still pending (dedicated queue API) or was properly drained as a turn —
    // never silently wiped by saveThreadData without acceptance.
    const queueContents = service.threads.loadMessageQueue(thread.id).map((i) => i.content)
    expect(queueContents.includes('keep-queue') || userContents.includes('keep-queue')).toBe(true)

    } finally {
      await service.stop()
    }
  })
})
