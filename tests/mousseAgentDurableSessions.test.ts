import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai'
import {
  MousseAgentService,
  parseMousseAgentSessionSnapshot,
  parseMousseAgentSessions
} from '../src/mms/agents/MousseAgentService'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import {
  commitNativeMessages,
  compactMessagesAtSafeBoundary,
  createNativeContext,
  getActiveMessages,
  userMessage
} from '../src/mms/orchestrator/nativeContext'
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

describe('Mousse durable subagent sessions', () => {
  it('round-trips a lossless v2 archive and its active compaction boundary through export and restore', () => {
    const progress: AssistantMessage = {
      role: 'assistant',
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-test',
      content: [{ type: 'text', text: `Implemented the first part. ${'progress '.repeat(2_000)}` }],
      usage,
      stopReason: 'stop',
      timestamp: 2
    }
    const task = userMessage(`Implement it carefully. ${'requirement '.repeat(2_000)}`)
    const archive = [task, progress, userMessage('Keep the final behavior stable.')]
    const compacted = compactMessagesAtSafeBoundary(archive, 1)
    expect(compacted.changed).toBe(true)
    const nativeContext = commitNativeMessages(
      commitNativeMessages(createNativeContext(), archive),
      compacted.messages,
      compacted.checkpoint
    )

    const service = new MousseAgentService()
    service.restoreSessions([{
      version: 2,
      agentId: 'agent-v2-archive',
      worktreePath: '/tmp/wt',
      task: 'Implement it carefully.',
      assignment: {},
      messages: [],
      history: getActiveMessages(nativeContext),
      nativeContext,
      runState: 'idle',
      updatedAt: new Date().toISOString()
    }])

    const snapshot = service.exportSessions()[0]
    expect(snapshot?.version).toBe(2)
    expect(snapshot?.nativeContext?.messages).toHaveLength(3)
    expect(snapshot?.nativeContext?.activeStartIndex).toBe(2)
    expect(snapshot?.nativeContext?.compaction?.summary).toContain('Implemented the first part')
    expect(snapshot?.history?.[0]).toMatchObject({ role: 'user' })
    expect((snapshot?.history?.[0] as { content?: string })?.content).toContain('[Compacted conversation summary]')

    const restored = new MousseAgentService()
    restored.restoreSessions([snapshot!])
    const reloaded = restored.exportSessions()[0]
    expect(reloaded?.nativeContext).toEqual(snapshot?.nativeContext)
    expect(reloaded?.history).toEqual(snapshot?.history)
  })

  it('migrates a compacted v1 flat transcript without pretending the lost prefix is native', () => {
    const summary = 'Original task: preserve the public API.'
    const recent = userMessage('Continue with the tests.')
    const service = new MousseAgentService()

    service.restoreSessions([{
      version: 1,
      agentId: 'agent-v1-compacted',
      worktreePath: '/tmp/wt',
      task: 'Preserve API',
      assignment: {},
      messages: [],
      history: [
        userMessage(`[Compacted conversation summary]\n${summary}`),
        recent
      ],
      runState: 'idle',
      updatedAt: new Date().toISOString()
    }])

    const migrated = service.exportSessions()[0]?.nativeContext
    expect(migrated?.fidelity).toBe('legacy-estimated')
    expect(migrated?.messages).toHaveLength(2)
    expect(migrated?.activeStartIndex).toBe(1)
    expect(migrated?.compaction?.summary).toBe(summary)
    expect(service.exportSessions()[0]?.history).toEqual([
      expect.objectContaining({ content: `[Compacted conversation summary]\n${summary}` }),
      recent
    ])
  })

  it('restores sessions on reload as interrupted without auto-restarting model work', () => {
    const service = new MousseAgentService()
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
    expect(events).toHaveLength(1)
    expect(events[0]?.state).toBe('interrupted')
    const restored = service.exportSessions()[0]
    expect(restored?.runState).toBe('interrupted')
    expect(restored?.assignment).toEqual({ provider: 'openai', model: 'gpt-test' })
    expect(restored?.messages.some((message) => message.streaming)).toBe(false)
    expect(restored?.messages.some((message) => message.kind === 'warning')).toBe(true)
    expect(restored?.messages.find((message) => message.id === 'a1')?.incomplete).toBe(true)
    expect(lifecycle.some((event) => event.state === 'interrupted')).toBe(true)
    expect(restored?.history).toHaveLength(2)
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
    expect(
      parseMousseAgentSessionSnapshot({
        version: 0,
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
    expect(legacyOk?.version).toBe(2)
    expect(legacyOk?.history).toEqual([{ role: 'user', content: 'hi', timestamp: 1 }])

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
      expect(loaded.mousseAgentSessions).toEqual([
        expect.objectContaining({
          version: 2,
          agentId: snapshot.agentId,
          history: snapshot.history,
          runState: snapshot.runState
        })
      ])
      expect(JSON.stringify(loaded.mousseAgentSessions?.[0]?.history)).not.toContain('Budget warning')

      // Corrupted persisted state is fail-closed and retained for recovery.
      const sessionsPath = join(store.getThreadDir(thread.id), 'mousse-agent-sessions.json')
      writeFileSync(sessionsPath, '{not-json', 'utf-8')
      expect(() => store.loadThreadData(thread.id)).toThrow(/Corrupt thread data/)
      expect(readFileSync(sessionsPath, 'utf-8')).toBe('{not-json')

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
})
