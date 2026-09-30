import { writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { AgentEpisodeStore } from '../src/mms/agents/AgentEpisodeStore'
import type { AgentEpisode } from '../src/shared/agentEpisodes'
import { gitFoundationFixture } from './fixtures/gitFoundation'

it('an interrupted explicit fresh-context episode prevents later fallback to obsolete native instructions', () => {
  const f = gitFoundationFixture()
  try {
    const store = new AgentEpisodeStore(f.thread), agent = store.create('Reviewer')
    const input = (id: string, generation: number, fresh = false): Parameters<AgentEpisodeStore['begin']>[0] => ({
      id, agentId: agent.id, contextGeneration: generation, task: 'Review',
      policy: { version: 1, workspace: 'shared', access: 'read-only' },
      binding: { workspaceId: 'task', generation: 1, worktreePath: f.repo, consistency: 'moving' },
      parentConversation: { branchId: 'main', boundary: 0 },
      request: { name: 'Reviewer', ...(fresh ? { contextMode: 'fresh' as const } : {}) }
    })
    store.begin(input('original-context', 0))
    store.complete('original-context', 0, {}, 'completed', { version: 2, agentId: agent.id, worktreePath: f.repo,
      task: 'Obsolete instruction', assignment: {}, messages: [], history: [{ role: 'user', content: 'OBSOLETE_PRIVATE_INSTRUCTION', timestamp: 1 }],
      runState: 'completed', updatedAt: new Date().toISOString() })
    expect(JSON.stringify(store.context(agent.id))).toContain('OBSOLETE_PRIVATE_INSTRUCTION')
    store.begin(input('fresh-context-crashed', 1, true))
    const restarted = new AgentEpisodeStore(f.thread)
    restarted.interruptOrphans()
    expect(restarted.contextSource(agent.id)).toBeUndefined()
    restarted.begin(input('continue-after-reset', 2))
    restarted.complete('continue-after-reset', 2, {}, 'interrupted')
    expect(new AgentEpisodeStore(f.thread).contextSource(agent.id)).toBeUndefined()
  } finally { f.dispose() }
})

it.each(['lastEpisodeId', 'contextGeneration', 'orphanEpisode'])('rejects corrupt %s before named context and retention claims can be projected', (corruption) => {
  const f = gitFoundationFixture()
  try {
    const store = new AgentEpisodeStore(f.thread), agent = store.create('Reviewer')
    const input = { id: 'qualified-episode', agentId: agent.id, contextGeneration: 0, task: 'Review',
      policy: { version: 1, workspace: 'shared', access: 'read-only' } as const,
      binding: { workspaceId: 'task', generation: 1, worktreePath: f.repo, consistency: 'moving' as const },
      parentConversation: { branchId: 'main', boundary: 0 } }
    store.begin(input); store.complete(input.id, 0, { resultSha: f.baseSha })
    const state = store.read()
    if (corruption === 'lastEpisodeId') state.identities[0].lastEpisodeId = 'missing-episode'
    else if (corruption === 'contextGeneration') state.identities[0].contextGeneration = 0
    else state.episodes.push({ ...state.episodes[0], id: 'unclaimed-active-episode', state: 'running', completedAt: undefined, contextGeneration: 1 } as AgentEpisode)
    writeFileSync(store.path, JSON.stringify(state))
    expect(() => new AgentEpisodeStore(f.thread).read()).toThrow(/episode|context generation/i)
  } finally { f.dispose() }
})
