import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../../src/mms/data/AtomicFs'
import { enableVersionedLifecycleWriter } from '../../src/mms/queue/ThreadLifecycleAdmission'
import { canonicalJson, sha256Hex } from '../../src/shared/agents/hashes'
import type { AgentEpisode, AgentEpisodeState } from '../../src/shared/agentEpisodes'

/**
 * Leaves a finished named-agent episode in a thread's `agent-episodes.json`, the way a build that
 * still had named agents left it. Nothing creates these any more, but old task data keeps them and
 * lifecycle code still reads them. The file is written directly: the store has no write path.
 */
export function seedLegacyNamedEpisode(threadDirectory: string, input: {
  worktreePath: string
  name?: string
  /** An existing identity to add a later episode to; omit to create a new identity. */
  agentId?: string
  /** Episodes already finished for that identity (0 for its first). */
  contextGeneration?: number
  receiptId?: string
  episodeId?: string
  workspace?: 'shared' | 'isolated'
  access?: 'read-only' | 'write'
  branch?: string
  baseSha?: string
  resultSha?: string
}): { agentId: string; episode: AgentEpisode } {
  const path = join(threadDirectory, 'agent-episodes.json')
  const state: AgentEpisodeState = existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8')) as AgentEpisodeState
    : { schemaVersion: 1, identities: [], episodes: [] }
  const agentId = input.agentId ?? randomUUID(), id = input.episodeId ?? `legacy-${randomUUID()}`, generation = input.contextGeneration ?? 0
  const name = input.name ?? 'Legacy Reviewer'
  const workspace = input.workspace ?? 'shared'
  const now = new Date().toISOString()
  const request = {
    id, agentId, contextGeneration: generation, task: 'Legacy named agent task',
    policy: { version: 1 as const, workspace, access: input.access ?? 'read-only' },
    binding: {
      workspaceId: workspace === 'shared' ? 'task' : id, generation: 1, worktreePath: input.worktreePath,
      ...(input.branch ? { branch: input.branch } : {}), ...(input.baseSha ? { baseSha: input.baseSha } : {}),
      consistency: workspace === 'shared' ? 'moving' as const : 'snapshot' as const
    },
    parentConversation: { branchId: 'main', boundary: 0 },
    request: { name }
  }
  const episode: AgentEpisode = {
    ...request, requestHash: sha256Hex(canonicalJson(request)), createdAt: now, state: 'completed', completedAt: now,
    result: { ...(input.resultSha ? { resultSha: input.resultSha } : {}), ...(input.receiptId ? { receiptId: input.receiptId } : {}) }
  }
  let identity = state.identities.find((entry) => entry.id === agentId)
  if (!identity) {
    identity = { id: agentId, name, aliases: [], state: 'dormant', contextGeneration: 0, createdAt: now }
    state.identities.push(identity)
  }
  identity.contextGeneration = generation + 1; identity.lastEpisodeId = id; identity.state = 'dormant'
  state.episodes.push(episode)
  enableVersionedLifecycleWriter(threadDirectory)
  atomicWriteJsonSync(path, state)
  return { agentId, episode }
}
