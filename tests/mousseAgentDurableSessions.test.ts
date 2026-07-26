import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { AssistantMessage, Message, ToolResultMessage } from '@earendil-works/pi-ai'
import {
  extractPartialNativeMessages,
  isSafetyLimitError,
  MousseAgentService,
  parseMousseAgentSessionSnapshot,
  parseMousseAgentSessions
} from '../src/mms/agents/MousseAgentService'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { userMessage } from '../src/mms/orchestrator/nativeContext'
import type { MousseAgentSessionSnapshot } from '../src/shared/types'

const usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

function assistantToolCall(): AssistantMessage {
  return {
    role: 'assistant',
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-test',
    content: [
      {
        type: 'toolCall',
        id: 'call-1',
        name: 'read_file',
        arguments: { path: 'a.ts' }
      }
    ],
    usage,
    stopReason: 'toolUse',
    timestamp: 2
  }
}

const toolResult: ToolResultMessage = {
  role: 'toolResult',
  toolCallId: 'call-1',
  toolName: 'read_file',
  content: [{ type: 'text', text: 'file contents' }],
  details: {},
  isError: false,
  timestamp: 3
}

function makeService(llm: {
  chat: (...args: never[]) => Promise<unknown>
}): MousseAgentService {
  return new MousseAgentService(llm as never, {
    spawnAgents: async () => [],
    completeAgent: async () => undefined
  })
}

describe('Mousse durable subagent sessions', () => {
  it('checkpoints native history via onNativeMessages during a turn', async () => {
    const checkpoints: Message[][] = []
    let persistCount = 0
    const historyAfterTool: Message[] = [
      userMessage('Implement it'),
      assistantToolCall(),
      toolResult
    ]

    const llm = {
      chat: async (
        _history: Message[],
        _onTool: unknown,
        options: { onNativeMessages?: (messages: Message[]) => void }
      ) => {
        options.onNativeMessages?.(historyAfterTool.slice(0, 2))
        options.onNativeMessages?.(historyAfterTool)
        return {
          text: 'Done.',
          aborted: false,
          nativeMessages: historyAfterTool,
          modelName: 'test',
          totalResponseTimeMs: 10,
          totalTokensUsed: 15,
          tokensPerSecond: 1
        }
      }
    }

    const service = makeService(llm as never)
    service.setPersistCallback(() => {
      persistCount += 1
      checkpoints.push(structuredClone(service.exportSessions()[0]?.history ?? []))
    })

    service.start('agent-cp', 'Implement it', '/tmp/wt')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(persistCount).toBeGreaterThanOrEqual(2)
    expect(checkpoints.some((history) => history.length === 2)).toBe(true)
    expect(checkpoints.some((history) => history.length === 3)).toBe(true)
    expect(service.exportSessions()[0]?.history).toEqual(historyAfterTool)
    expect(service.getRunState('agent-cp')).toBe('idle')
  })

  it('preserves partial native transcript and emits lifecycle events on safety failure', async () => {
    const partial: Message[] = [userMessage('Implement it'), assistantToolCall(), toolResult]
    const lifecycle: Array<{ state: string; reason?: string }> = []
    const failed: Array<{ state: string }> = []

    const safetyError = Object.assign(
      new Error(
        'Agent stopped before producing a final response: tool loop reached its safety limit of 24 model calls.'
      ),
      {
        name: 'ToolLoopSafetyError',
        nativeMessages: partial,
        usage: { totalTokens: 99, modelName: 'test-model' },
        warnings: ['Approaching tool-loop token budget']
      }
    )

    const llm = {
      chat: async (
        _history: Message[],
        _onTool: unknown,
        options: { onNativeMessages?: (messages: Message[]) => void }
      ) => {
        options.onNativeMessages?.(partial)
        throw safetyError
      }
    }

    const service = makeService(llm as never)
    service.on('lifecycle', (event) => lifecycle.push(event))
    service.on('failed', (event) => failed.push(event))

    service.start('agent-safety', 'Implement it', '/tmp/wt')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(isSafetyLimitError(safetyError)).toBe(true)
    expect(extractPartialNativeMessages(safetyError)).toEqual(partial)
    expect(service.getRunState('agent-safety')).toBe('failed')
    expect(service.getLastError('agent-safety')).toMatch(/safety limit/i)
    expect(service.exportSessions()[0]?.history).toEqual(partial)
    expect(service.exportSessions()[0]?.usage?.totalTokens).toBe(99)

    const messages = service.getMessages('agent-safety')
    expect(messages.some((message) => message.kind === 'warning')).toBe(true)
    expect(messages.some((message) => message.role === 'assistant' && message.content.includes('Error:'))).toBe(
      true
    )
    expect(messages.every((message) => message.streaming !== true)).toBe(true)
    expect(failed.some((event) => event.state === 'failed')).toBe(true)
    expect(lifecycle.some((event) => event.state === 'failed')).toBe(true)
  })

  it('retries from checkpointed transcript without duplicating the last user task', async () => {
    const partial: Message[] = [userMessage('Implement the feature'), assistantToolCall()]
    const chatHistories: Message[][] = []
    let call = 0

    const llm = {
      chat: async (
        history: Message[],
        _onTool: unknown,
        options: { onNativeMessages?: (messages: Message[]) => void }
      ) => {
        chatHistories.push(structuredClone(history))
        call += 1
        if (call === 1) {
          options.onNativeMessages?.(partial)
          const err = Object.assign(new Error('tool loop reached its safety limit of 24 model calls.'), {
            nativeMessages: partial
          })
          throw err
        }
        options.onNativeMessages?.([...history, toolResult])
        return {
          text: 'Finished after retry.',
          aborted: false,
          nativeMessages: [...history, toolResult],
          modelName: 'test',
          totalResponseTimeMs: 5,
          totalTokensUsed: 20,
          tokensPerSecond: 2
        }
      }
    }

    const service = makeService(llm as never)
    service.start('agent-retry', 'Implement the feature', '/tmp/wt')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(service.getRunState('agent-retry')).toBe('failed')

    service.retry('agent-retry')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(call).toBe(2)
    expect(chatHistories[1]).toEqual(partial)
    const userTurns = chatHistories[1].filter((message) => message.role === 'user')
    expect(userTurns).toHaveLength(1)
    expect(service.getMessages('agent-retry').filter((message) => message.role === 'user')).toHaveLength(1)
    expect(service.getRunState('agent-retry')).toBe('idle')
    expect(service.getMessages('agent-retry').some((message) => message.content.includes('Finished after retry'))).toBe(
      true
    )
  })

  it('restores sessions on reload as interrupted without auto-restarting model work', async () => {
    const chat = vi.fn(async () => {
      throw new Error('should not auto-restart')
    })
    const service = makeService({ chat } as never)
    const lifecycle: Array<{ state: string; reason?: string }> = []
    service.on('lifecycle', (event) => lifecycle.push(event))

    const snapshot: MousseAgentSessionSnapshot = {
      version: 1,
      agentId: 'agent-reload',
      worktreePath: '/tmp/wt',
      task: 'Implement it',
      assignment: { provider: 'openai', model: 'gpt-test' },
      messages: [
        {
          id: 'u1',
          role: 'user',
          content: 'Implement it',
          timestamp: new Date().toISOString()
        },
        {
          id: 'a1',
          role: 'assistant',
          content: 'Working…',
          timestamp: new Date().toISOString(),
          streaming: true
        }
      ],
      history: [userMessage('Implement it'), assistantToolCall()],
      runState: 'running',
      usage: { totalTokens: 42 },
      updatedAt: new Date().toISOString()
    }

    const events = service.restoreSessions([snapshot])
    expect(chat).not.toHaveBeenCalled()
    expect(events).toHaveLength(1)
    expect(events[0]?.state).toBe('interrupted')
    expect(service.getRunState('agent-reload')).toBe('interrupted')
    expect(service.getMessages('agent-reload').some((message) => message.streaming)).toBe(false)
    expect(service.getMessages('agent-reload').some((message) => message.kind === 'warning')).toBe(true)
    expect(service.getMessages('agent-reload').find((message) => message.id === 'a1')?.incomplete).toBe(true)
    expect(lifecycle.some((event) => event.state === 'interrupted')).toBe(true)
    expect(service.exportSessions()[0]?.history).toHaveLength(2)
  })

  it('validates corrupted and legacy durable session payloads', () => {
    expect(parseMousseAgentSessions(null)).toEqual([])
    expect(parseMousseAgentSessions('nope')).toEqual([])
    expect(parseMousseAgentSessions([{ agentId: 1 }])).toEqual([])
    expect(
      parseMousseAgentSessionSnapshot({
        version: 99,
        agentId: 'x',
        worktreePath: '/t',
        messages: [],
        history: []
      })
    ).toBeNull()

    const legacyOk = parseMousseAgentSessionSnapshot({
      agentId: 'legacy',
      worktreePath: '/tmp',
      messages: [
        {
          id: '1',
          role: 'user',
          content: 'hi',
          timestamp: new Date().toISOString()
        }
      ],
      history: [{ role: 'user', content: 'hi', timestamp: 1 }],
      running: true
    })
    expect(legacyOk?.runState).toBe('running')
    expect(legacyOk?.version).toBe(1)

    const mixed = parseMousseAgentSessions([
      {
        version: 1,
        agentId: 'good',
        worktreePath: '/tmp',
        task: 't',
        assignment: {},
        messages: [
          {
            id: '1',
            role: 'user',
            content: 'hi',
            timestamp: new Date().toISOString()
          }
        ],
        history: [],
        runState: 'idle',
        updatedAt: new Date().toISOString()
      },
      { broken: true },
      null
    ])
    expect(mixed).toHaveLength(1)
    expect(mixed[0]?.agentId).toBe('good')
  })

  it('round-trips durable sessions through ThreadDataStore without polluting native history with warnings', () => {
    const previousHome = process.env.MOUSSE_HOME
    const root = mkdtempSync(join(tmpdir(), 'mousse-agent-sessions-'))
    process.env.MOUSSE_HOME = join(root, 'home')
    try {
      const projects = new ProjectManager()
      const store = new ThreadDataStore(projects)
      projects.setThreadStore(store)
      const thread = store.createThread('session-thread')

      const snapshot: MousseAgentSessionSnapshot = {
        version: 1,
        agentId: 'agent-store',
        worktreePath: '/tmp/wt',
        task: 'Ship it',
        assignment: { model: 'm1' },
        messages: [
          {
            id: 'u',
            role: 'user',
            content: 'Ship it',
            timestamp: new Date().toISOString()
          },
          {
            id: 'w',
            role: 'system',
            kind: 'warning',
            content: 'Budget warning',
            timestamp: new Date().toISOString()
          }
        ],
        history: [userMessage('Ship it')],
        runState: 'failed',
        lastError: 'safety budget',
        warnings: ['Budget warning'],
        usage: { totalTokens: 7 },
        updatedAt: new Date().toISOString()
      }

      store.saveThreadData(thread.id, {
        messages: [],
        agents: [],
        tasks: [],
        mousseAgentSessions: [snapshot]
      })

      const loaded = store.loadThreadData(thread.id)
      expect(loaded.mousseAgentSessions).toEqual([snapshot])
      expect(JSON.stringify(loaded.mousseAgentSessions?.[0]?.history)).not.toContain('Budget warning')

      // Corrupted file becomes empty list (legacy-safe).
      const sessionsPath = join(store.getThreadDir(thread.id), 'mousse-agent-sessions.json')
      writeFileSync(sessionsPath, '{not-json', 'utf-8')
      expect(store.loadThreadData(thread.id).mousseAgentSessions).toEqual([])

      // Missing file is fine.
      rmSync(sessionsPath, { force: true })
      expect(existsSync(sessionsPath)).toBe(false)
      expect(store.loadThreadData(thread.id).mousseAgentSessions).toEqual([])
    } finally {
      if (previousHome === undefined) delete process.env.MOUSSE_HOME
      else process.env.MOUSSE_HOME = previousHome
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('surfaces budget warnings as presentation-only progress messages', () => {
    const service = makeService({
      chat: async () => ({
        text: 'ok',
        aborted: false,
        nativeMessages: [],
        modelName: 't',
        totalResponseTimeMs: 1,
        totalTokensUsed: 1,
        tokensPerSecond: 1
      })
    } as never)

    // Seed a session without running the model.
    service.restoreSessions([
      {
        version: 1,
        agentId: 'agent-warn',
        worktreePath: '/tmp',
        task: 't',
        assignment: {},
        messages: [],
        history: [userMessage('t')],
        runState: 'idle',
        updatedAt: new Date().toISOString()
      }
    ])

    service.pushProgressMessage('agent-warn', 'Token budget is 80% used', 'warning')
    const messages = service.getMessages('agent-warn')
    expect(messages).toEqual([
      expect.objectContaining({
        role: 'system',
        kind: 'warning',
        content: 'Token budget is 80% used'
      })
    ])
    const history = service.exportSessions()[0]?.history ?? []
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ role: 'user', content: 't' })
    expect(JSON.stringify(history)).not.toContain('Token budget')
    expect(service.exportSessions()[0]?.warnings).toContain('Token budget is 80% used')
  })

  it('never spawns recursive subagents from a durable session turn', async () => {
    const completeAgent = vi.fn(async () => undefined)
    const spawnAgents = vi.fn(async () => ['should-not-run'])
    const llm = {
      chat: async () => ({
        text: '```json\n{"type":"spawn_agents","agents":[{"cliType":"mousse","task":"nested"}]}\n```',
        aborted: false,
        nativeMessages: [userMessage('task')],
        modelName: 't',
        totalResponseTimeMs: 1,
        totalTokensUsed: 1,
        tokensPerSecond: 1
      })
    }
    const service = new MousseAgentService(llm as never, { spawnAgents, completeAgent })
    service.start('agent-no-spawn', 'task', '/tmp')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(spawnAgents).not.toHaveBeenCalled()
    expect(
      service.getMessages('agent-no-spawn').some((message) => message.content.includes('Ignored spawn_agents'))
    ).toBe(true)
  })

  it('writes mousse-agent-sessions.json atomically with other thread files', () => {
    const previousHome = process.env.MOUSSE_HOME
    const root = mkdtempSync(join(tmpdir(), 'mousse-agent-atomic-'))
    process.env.MOUSSE_HOME = join(root, 'home')
    try {
      const projects = new ProjectManager()
      const store = new ThreadDataStore(projects)
      projects.setThreadStore(store)
      const thread = store.createThread('atomic')
      store.saveThreadData(thread.id, {
        messages: [],
        agents: [],
        tasks: [],
        mousseAgentSessions: [
          {
            version: 1,
            agentId: 'a',
            worktreePath: '/w',
            task: 't',
            assignment: {},
            messages: [],
            history: [],
            runState: 'idle',
            updatedAt: new Date().toISOString()
          }
        ]
      })
      const raw = readFileSync(join(store.getThreadDir(thread.id), 'mousse-agent-sessions.json'), 'utf-8')
      expect(JSON.parse(raw)[0].agentId).toBe('a')
    } finally {
      if (previousHome === undefined) delete process.env.MOUSSE_HOME
      else process.env.MOUSSE_HOME = previousHome
      rmSync(root, { recursive: true, force: true })
    }
  })
})
