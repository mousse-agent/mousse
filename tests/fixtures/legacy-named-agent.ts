import { randomUUID } from 'node:crypto'
import { AgentEpisodeStore } from '../../src/mms/agents/AgentEpisodeStore'
import type { AgentEpisode } from '../../src/shared/agentEpisodes'

/**
 * Leaves a finished named-agent episode in a thread's `agent-episodes.json`, the way a build that
 * still had named agents left it. Nothing creates these any more, but old task data keeps them and
 * lifecycle code still reads them.
 */
export function seedLegacyNamedEpisode(threadDirectory: string, input: {
  worktreePath: string
  name?: string
  episodeId?: string
  workspace?: 'shared' | 'isolated'
  access?: 'read-only' | 'write'
  branch?: string
  baseSha?: string
  resultSha?: string
}): { agentId: string; episode: AgentEpisode } {
  const store = new AgentEpisodeStore(threadDirectory)
  const agentId = randomUUID(), id = input.episodeId ?? `legacy-${randomUUID()}`
  const workspace = input.workspace ?? 'shared'
  store.begin({
    id, agentId, contextGeneration: 0, task: 'Legacy named agent task',
    policy: { version: 1, workspace, access: input.access ?? 'read-only' },
    binding: {
      workspaceId: workspace === 'shared' ? 'task' : id, generation: 1, worktreePath: input.worktreePath,
      ...(input.branch ? { branch: input.branch } : {}), ...(input.baseSha ? { baseSha: input.baseSha } : {}),
      consistency: workspace === 'shared' ? 'moving' : 'snapshot'
    },
    parentConversation: { branchId: 'main', boundary: 0 },
    request: { name: input.name ?? 'Legacy Reviewer' }
  }, input.name ?? 'Legacy Reviewer')
  const episode = store.complete(id, 0, input.resultSha ? { resultSha: input.resultSha } : {})
  return { agentId, episode }
}
