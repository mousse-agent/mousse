import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { OrchestratorService } from '../src/mms/orchestrator/OrchestratorService'
import { AgentRegistry } from '../src/mms/agents/AgentRegistry'
import { TaskQueue } from '../src/mms/tasks/TaskQueue'
import { WorktreeManager } from '../src/mms/worktree/WorktreeManager'
import { PtyManager } from '../src/mms/terminals/PtyManager'
import { HeadlessAgentRunner } from '../src/mms/terminals/HeadlessAgentRunner'
import { MacroEngine } from '../src/mms/macros/MacroEngine'
import { getDefaultSettings } from '../src/shared/settings'
import type { ChatMessage } from '../src/shared/types'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

describe('thread-scoped orchestrator conversation events', () => {
  let home: string
  let store: ThreadDataStore
  let orch: OrchestratorService

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-scoped-'))
    process.env.MOUSSE_HOME = home
    store = new ThreadDataStore(new ProjectManager())
    orch = createOrchestrator(home, store)
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  it('emits thread-message without legacy message for background thread mutations', () => {
    const selected = store.createThread('Selected')
    const background = store.createThread('Background')
    orch.bindThread(selected.id, [], undefined, [])

    const legacyAdds: ChatMessage[] = []
    const scopedAdds: Array<{ threadId: string; message: ChatMessage }> = []
    orch.on('message', (msg: ChatMessage) => legacyAdds.push(msg))
    orch.on('thread-message', (payload: { threadId: string; message: ChatMessage }) =>
      scopedAdds.push(payload)
    )

    const bgSession = orch.getOrCreateSession(background.id)
    // Exercise private ALS-scoped mutators (same path used during concurrent turns).
    const internal = orch as unknown as {
      sessionAls: { run: <T>(session: unknown, fn: () => T) => T }
      addSystemMessage: (content: string) => void
      addMessage: (role: 'user' | 'assistant', content: string) => ChatMessage
      updateStreamingAssistantMessage: (
        id: string,
        content: string,
        streaming: boolean
      ) => void
    }

    internal.sessionAls.run(bgSession, () => {
      internal.addSystemMessage('background system note')
    })

    expect(scopedAdds).toHaveLength(1)
    expect(scopedAdds[0].threadId).toBe(background.id)
    expect(scopedAdds[0].message.content).toBe('background system note')
    expect(legacyAdds).toHaveLength(0)
  })

  it('keeps internal queue provenance durable but out of transcript presentation', () => {
    const thread = store.createThread('Internal')
    orch.bindThread(thread.id, [], undefined, [])
    const session = orch.getOrCreateSession(thread.id)
    const added: ChatMessage[] = []
    orch.on('thread-message', ({ message }: { message: ChatMessage }) => added.push(message))

    const internal = orch as unknown as {
      sessionAls: { run: <T>(session: unknown, fn: () => T) => T }
      acceptTurnUserInput: (
        session: unknown,
        content: string,
        images: undefined,
        display: boolean,
        queueItemId: string
      ) => void
    }
    internal.sessionAls.run(session, () => {
      internal.acceptTurnUserInput(session, 'automatic report', undefined, false, 'internal-queue-id')
    })

    expect(orch.getMessages(thread.id)).toEqual([])
    expect(orch.getMessagesForPersistence(thread.id)).toEqual([
      expect.objectContaining({
        content: 'automatic report',
        hidden: true,
        queueItemId: 'internal-queue-id'
      })
    ])
    expect(added).toEqual([])
  })

  it('routes background subagent failure and its wake through the owning thread', async () => {
    const selected = store.createThread('Selected')
    const background = store.createThread('Background')
    orch.bindThread(selected.id, [], undefined, [])
    const owner = orch.getOrCreateSession(background.id)
    const agent = owner.agents.create({
      cliType: 'mousse',
      worktreePath: '/tmp/background-agent',
      branch: 'mousse/agent-background',
      executionMode: 'gui',
      status: 'running',
      task: 'background task'
    })
    owner.tasks.create('background task', agent.id)

    const batch = new Set([agent.id])
    const internal = orch as unknown as {
      agentOwners: Map<string, typeof owner>
      delegationBatches: Set<Set<string>>
      delegationBatchOwners: WeakMap<Set<string>, typeof owner>
      scheduleQueueDrain: (session: typeof owner) => void
    }
    internal.agentOwners.set(agent.id, owner)
    internal.delegationBatches.add(batch)
    internal.delegationBatchOwners.set(batch, owner)
    const drainSpy = vi.spyOn(internal, 'scheduleQueueDrain').mockImplementation(() => undefined)

    orch.reportGuiAgentFailure(agent.id, 'provider stream failed')
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(owner.agents.get(agent.id)?.status).toBe('failed')
    expect(owner.tasks.findByAgentId(agent.id)?.status).toBe('failed')
    expect(owner.queue).toEqual([
      expect.objectContaining({
        content: expect.stringContaining(agent.id),
        source: 'wake',
        internal: true,
        state: 'pending'
      })
    ])
    expect(orch.listQueue(background.id)).toEqual([])
    expect(drainSpy).toHaveBeenCalledWith(owner)
  })

  it('durably queues hidden automatic wakes on their originating threads', async () => {
    const selected = store.createThread('Selected')
    const background = store.createThread('Background')
    orch.bindThread(selected.id, [], undefined, [])

    const internal = orch as unknown as {
      sessionAls: { run: <T>(session: unknown, fn: () => T) => T }
      scheduleOrchestratorWake: (message: string) => void
      scheduleQueueDrain: (session: unknown) => void
    }
    const drainSpy = vi.spyOn(internal, 'scheduleQueueDrain').mockImplementation(() => undefined)

    internal.scheduleOrchestratorWake('selected update')
    internal.sessionAls.run(orch.getOrCreateSession(background.id), () => {
      internal.scheduleOrchestratorWake('background update')
    })

    await new Promise((resolve) => setTimeout(resolve, 150))

    const selectedInternal = store.loadMessageQueue(selected.id)
    const backgroundInternal = store.loadMessageQueue(background.id)
    expect(selectedInternal).toEqual([
      expect.objectContaining({ content: 'selected update', source: 'wake', internal: true })
    ])
    expect(backgroundInternal).toEqual([
      expect.objectContaining({ content: 'background update', source: 'wake', internal: true })
    ])
    expect(orch.listQueue(selected.id)).toEqual([])
    expect(orch.listQueue(background.id)).toEqual([])
    expect(drainSpy).toHaveBeenCalledTimes(2)
  })

  it('mirrors legacy message events only for the bound (selected) thread', () => {
    const selected = store.createThread('Bound')
    orch.bindThread(selected.id, [], undefined, [])

    const legacyAdds: ChatMessage[] = []
    const scopedAdds: Array<{ threadId: string; message: ChatMessage }> = []
    const legacyUpdates: ChatMessage[] = []
    const scopedUpdates: Array<{ threadId: string; message: ChatMessage }> = []
    const legacySyncs: ChatMessage[][] = []
    const scopedSyncs: Array<{ threadId: string; messages: ChatMessage[] }> = []

    orch.on('message', (msg: ChatMessage) => legacyAdds.push(msg))
    orch.on('thread-message', (payload: { threadId: string; message: ChatMessage }) =>
      scopedAdds.push(payload)
    )
    orch.on('message-updated', (msg: ChatMessage) => legacyUpdates.push(msg))
    orch.on('thread-message-updated', (payload: { threadId: string; message: ChatMessage }) =>
      scopedUpdates.push(payload)
    )
    orch.on('messages-sync', (messages: ChatMessage[]) => legacySyncs.push(messages))
    orch.on('thread-messages', (payload: { threadId: string; messages: ChatMessage[] }) =>
      scopedSyncs.push(payload)
    )

    const internal = orch as unknown as {
      sessionAls: { run: <T>(session: unknown, fn: () => T) => T }
      addMessage: (role: 'user' | 'assistant', content: string) => ChatMessage
      updateStreamingAssistantMessage: (
        id: string,
        content: string,
        streaming: boolean
      ) => void
      removeMessage: (id: string) => void
      boundSession: { threadId: string }
    }

    const bound = orch.getOrCreateSession(selected.id)
    expect(bound.threadId).toBe(internal.boundSession.threadId)

    let assistantId = ''
    internal.sessionAls.run(bound, () => {
      const msg = internal.addMessage('assistant', '')
      assistantId = msg.id
      internal.updateStreamingAssistantMessage(assistantId, 'hello bound', false)
    })

    expect(scopedAdds.some((p) => p.threadId === selected.id)).toBe(true)
    expect(legacyAdds.length).toBeGreaterThan(0)
    expect(scopedUpdates.some((p) => p.threadId === selected.id)).toBe(true)
    expect(legacyUpdates.length).toBeGreaterThan(0)

    internal.sessionAls.run(bound, () => {
      internal.removeMessage(assistantId)
    })
    expect(scopedSyncs.some((p) => p.threadId === selected.id)).toBe(true)
    expect(legacySyncs.length).toBeGreaterThan(0)
  })

  it('does not broadcast legacy messages-sync for background remove/finalize', () => {
    const selected = store.createThread('Sel')
    const background = store.createThread('Bg')
    orch.bindThread(selected.id, [], undefined, [])

    const legacySyncs: ChatMessage[][] = []
    const scopedSyncs: Array<{ threadId: string }> = []
    orch.on('messages-sync', (messages: ChatMessage[]) => legacySyncs.push(messages))
    orch.on('thread-messages', (payload: { threadId: string }) => scopedSyncs.push(payload))

    const bg = orch.getOrCreateSession(background.id)
    const internal = orch as unknown as {
      sessionAls: { run: <T>(session: unknown, fn: () => T) => T }
      addMessage: (role: 'user' | 'assistant', content: string) => ChatMessage
      removeMessage: (id: string) => void
    }

    internal.sessionAls.run(bg, () => {
      const msg = internal.addMessage('user', 'temp')
      internal.removeMessage(msg.id)
    })

    expect(scopedSyncs.some((p) => p.threadId === background.id)).toBe(true)
    expect(legacySyncs).toHaveLength(0)
  })

  it('runs background channel turns with live events and orchestration actions', async () => {
    const selected = store.createThread('Selected thread')
    const thread = store.createThread('Channel thread')
    orch.bindThread(selected.id, [], undefined, [])
    const spawnAgents = vi.spyOn(orch, 'spawnAgents').mockResolvedValue(['Agent started'])

    const llm = (orch as unknown as {
      llm: {
        getSelectedModelContextLimit: () => { limit: number }
        getContextInputs: () => Promise<unknown>
        generateTitle: (content: string) => Promise<string>
        chat: (...args: unknown[]) => Promise<unknown>
      }
    }).llm
    const contextInputs = {
      systemPromptText: '',
      mcpToolsText: '',
      otherToolsText: '',
      signature: 'channel-live-events'
    }
    vi.spyOn(llm, 'getSelectedModelContextLimit').mockReturnValue({ limit: 100_000 })
    vi.spyOn(llm, 'getContextInputs').mockResolvedValue(contextInputs)
    vi.spyOn(llm, 'generateTitle').mockResolvedValue('Channel thread')
    vi.spyOn(llm, 'chat').mockImplementation(async (...args: unknown[]) => {
      const onTool = args[1] as (event: unknown) => void
      const onThinking = args[3] as (event: unknown) => void
      const onText = args[4] as (event: unknown) => void
      onThinking({ phase: 'start', content: '' })
      onThinking({ phase: 'delta', content: 'checking' })
      onTool({
        phase: 'start',
        callId: 'call-1',
        kind: 'mcp_tool_call',
        title: 'Read file',
        summary: 'Reading',
        details: []
      })
      onTool({
        phase: 'complete',
        callId: 'call-1',
        kind: 'mcp_tool_call',
        title: 'Read file',
        summary: 'Read complete',
        details: ['done']
      })
      onThinking({ phase: 'complete', content: 'checked' })
      onText({ phase: 'start', content: '', contentIndex: 0 })
      onText({ phase: 'delta', content: 'live answer', contentIndex: 0 })
      onText({ phase: 'complete', content: 'live answer', contentIndex: 0 })
      return {
        text:
          'live answer\n```mousse-actions\n' +
          '{"actions":[{"type":"spawn_agents","agents":[{"cliType":"mousse","task":"Remote task"}]}]}\n' +
          '```',
        aborted: false,
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
      }
    })

    const adds: Array<{ threadId: string; message: ChatMessage }> = []
    const updates: Array<{ threadId: string; message: ChatMessage }> = []
    const lifecycle: string[] = []
    orch.on('thread-message', (event) => adds.push(event))
    orch.on('thread-message-updated', (event) => updates.push(event))
    orch.on('turn-started', () => lifecycle.push('started'))
    orch.on('turn-completed', () => lifecycle.push('completed'))

    const result = await orch.runChannelTurn(thread.id, 'from Telegram', store)

    expect(result).toMatchObject({ text: 'live answer', silent: false })
    expect(lifecycle).toEqual(['started', 'completed'])
    expect(adds.every((event) => event.threadId === thread.id)).toBe(true)
    expect(adds.some((event) => event.message.role === 'user' && event.message.content === 'from Telegram')).toBe(true)
    expect(adds.some((event) => event.message.kind === 'thinking')).toBe(true)
    expect(adds.some((event) => event.message.kind === 'mcp_tool_call')).toBe(true)
    expect(updates.some((event) => event.message.toolCall?.status === 'complete')).toBe(true)
    expect(updates.some((event) => event.message.role === 'assistant' && event.message.content === 'live answer')).toBe(true)
    expect(spawnAgents).toHaveBeenCalledWith([
      expect.objectContaining({ cliType: 'mousse', task: 'Remote task' })
    ])
    expect(adds.some((event) => event.message.kind === 'tool_call')).toBe(true)
    expect(orch.getMessages(thread.id).some((message) => message.content === 'from Telegram')).toBe(true)
  })
})

describe('queued messages UI wiring', () => {
  it('registers QueuedMessages styles attached above the composer', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/app.css'), 'utf8')
    expect(css).toMatch(/\.queued-messages\s*\{/)
    expect(css).toMatch(/\.queued-messages-row\s*\{/)
    expect(css).toMatch(/chat-input-area:has\(\.queued-messages\)\s+\.composer/)
  })

  it('OrchestratorChat mounts QueuedMessages and uses sendToThread / isTurnActive', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/OrchestratorChat.tsx'),
      'utf8'
    )
    expect(source).toMatch(/import\s+\{\s*QueuedMessages\s*\}/)
    expect(source).toMatch(/<QueuedMessages/)
    expect(source).toMatch(/sendToThread/)
    expect(source).toMatch(/isTurnActive/)
    expect(source).toMatch(/abort\(activeThreadId/)
    expect(source).toMatch(/steer\([^,]+,\s*activeThreadId/)
  })

  it('ChatComposer allows ordinary send while loading (queue path)', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/ChatComposer.tsx'),
      'utf8'
    )
    expect(source).not.toMatch(/\(\!loading\s*\|\|\s*isControlWhileLoading\)/)
    expect(source).toMatch(/stack on the per-thread queue/)
  })

  it('App filters thread-scoped conversation events by selected thread', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/renderer/App.tsx'), 'utf8')
    expect(source).toMatch(/onThreadMessage/)
    expect(source).toMatch(/onThreadMessageUpdated/)
    expect(source).toMatch(/onThreadMessages/)
    expect(source).toMatch(/isSelectedThread/)
    expect(source).not.toMatch(/orchestrator\.onMessage\(/)
  })

  it('App keeps the thread list synchronized without stale fetch overwrites', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/renderer/App.tsx'), 'utf8')
    expect(source).toMatch(/threads\.onUpdated\(applyThreadList\)/)
    expect(source).toMatch(/requestedAtRevision === threadListRevision/)
    expect(source).toMatch(/THREAD_LIST_RECONCILE_MS/)
    expect(source).toMatch(/channels\.onActivity\(\(\) => void refreshThreads\(\)\)/)
  })
})
