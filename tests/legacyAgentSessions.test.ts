import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  parseMousseAgentSessionSnapshot,
  parseMousseAgentSessions
} from '../src/mms/agents/legacyAgentSessions'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { userMessage } from '../src/mms/orchestrator/nativeContext'
import type { MousseAgentSessionSnapshot } from '../src/shared/types'

describe('Legacy durable subagent sessions', () => {
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

  it('keeps the native context and active history of a v2 snapshot', () => {
    const task = userMessage('Archived setup')
    const recent = userMessage('Continue with the tests.')
    const parsed = parseMousseAgentSessionSnapshot({
      version: 2,
      agentId: 'agent-v2',
      worktreePath: '/tmp/wt',
      task: 'Continue',
      assignment: { provider: 'openai', model: 'model-a' },
      messages: [],
      nativeContext: {
        version: 2,
        messages: [task, recent],
        fidelity: 'native',
        activeStartIndex: 1,
        revision: 3
      },
      runState: 'completed',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })
    expect(parsed?.version).toBe(2)
    expect(parsed?.nativeContext?.messages).toHaveLength(2)
    expect(parsed?.nativeContext?.activeStartIndex).toBe(1)
    expect(parsed?.history).toEqual([recent])
    expect(parsed?.assignment).toEqual({ provider: 'openai', model: 'model-a', effort: undefined })
    expect(parsed?.runState).toBe('completed')
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
