/**
 * PR 6 §2: bot-thread origin. A turn on any bot thread (an activation's main thread or a context
 * thread it consults) binds with origin `bot`, ahead of its lineage, so a consult never binds as
 * `delegated`. No lineage relationship is added.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentRegistry } from '../../src/mms/agents/AgentRegistry'
import { threadTurnOrigin } from '../../src/mms/harness/policy'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'
import { PtyManager } from '../../src/mms/terminals/PtyManager'
import { WorktreeManager } from '../../src/mms/worktree/WorktreeManager'
import type { BotThreadRole, BotThreads } from '../../src/shared/bots/personal/authority'
import type { TurnOrigin } from '../../src/shared/harness/types'
import { getDefaultSettings } from '../../src/shared/settings'

describe('threadTurnOrigin', () => {
  it('puts a bot thread ahead of a workflow and of its lineage', () => {
    expect(threadTurnOrigin({ botRole: 'activation' })).toBe('bot')
    expect(threadTurnOrigin({ botRole: 'context', lineage: 'subagent' })).toBe('bot')
    expect(threadTurnOrigin({ botRole: 'context', workflow: true })).toBe('bot')
    expect(threadTurnOrigin({ workflow: true, lineage: 'subagent' })).toBe('workflow')
    expect(threadTurnOrigin({ lineage: 'subagent' })).toBe('delegated')
    expect(threadTurnOrigin({ lineage: 'fork' })).toBe('interactive')
    expect(threadTurnOrigin({})).toBe('interactive')
  })
})

describe('the orchestrator binds bot threads as bot', () => {
  let home: string
  let orch: OrchestratorService
  const lineage = new Map<string, 'subagent'>()
  const roles = new Map<string, BotThreadRole>()
  const origin = (threadId: string, workflowInvocationId?: string): TurnOrigin => (orch as unknown as { turnOrigin(threadId: string, workflowInvocationId?: string): TurnOrigin }).turnOrigin(threadId, workflowInvocationId)

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-bot-origin-'))
    orch = new OrchestratorService(new AgentRegistry(), new TaskQueue(), new WorktreeManager(home), new PtyManager(), { get: () => getDefaultSettings() } as never, {} as never)
    ;(orch as unknown as { runEngine: unknown }).runEngine = { delegations: { getLineage: (threadId: string) => (lineage.has(threadId) ? { relationship: lineage.get(threadId) } : null) } }
    lineage.clear()
    roles.clear()
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('reads the bot index first: a context thread with subagent lineage is still bot, never delegated', () => {
    const threads: BotThreads = { roleOf: (threadId) => roles.get(threadId) }
    orch.setBotThreads(threads)
    roles.set('activation-1', 'activation')
    roles.set('context-1', 'context')
    lineage.set('context-1', 'subagent')
    lineage.set('child-1', 'subagent')
    expect(origin('activation-1')).toBe('bot')
    expect(origin('context-1')).toBe('bot')
    expect(origin('child-1')).toBe('delegated')
    expect(origin('person-1')).toBe('interactive')
    expect(origin('person-1', 'wf-1')).toBe('workflow')
  })

  it('keeps today\'s origins without a bot index', () => {
    lineage.set('child-1', 'subagent')
    expect(origin('child-1')).toBe('delegated')
    expect(origin('person-1')).toBe('interactive')
  })

  it('fails the turn when the bot index cannot be read, rather than binding a bot thread as the person\'s', () => {
    orch.setBotThreads({ roleOf: () => { throw new Error('bots.db locked') } })
    expect(() => origin('activation-1')).toThrow('bots.db locked')
  })
})
