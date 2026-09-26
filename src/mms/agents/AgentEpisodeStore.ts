import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentEpisode, AgentEpisodeState, NamedAgentIdentity } from '../../shared/agentEpisodes'
import { canonicalJson, sha256Hex } from '../../shared/agents/hashes'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { withThreadDataMutationLock } from '../queue/ThreadExecutionLease'

const terminal = (state: AgentEpisode['state']): boolean => ['completed', 'failed', 'interrupted'].includes(state)
const nameKey = (value: string): string => value.normalize('NFKC').trim().toLowerCase()
export class AgentEpisodeStore {
  readonly path: string
  constructor(readonly threadDirectory: string) { this.path = join(threadDirectory, 'agent-episodes.json') }

  read(): AgentEpisodeState {
    if (!existsSync(this.path)) return { schemaVersion: 1, identities: [], episodes: [] }
    const state = JSON.parse(readFileSync(this.path, 'utf8')) as AgentEpisodeState
    if (state.schemaVersion !== 1 || !Array.isArray(state.identities) || !Array.isArray(state.episodes)) throw new Error('Unsupported named-agent store')
    const ids = new Set<string>(), names = new Set<string>(), episodes = new Set<string>()
    for (const agent of state.identities) {
      if (!agent || !agent.id || ids.has(agent.id) || !agent.name || !Array.isArray(agent.aliases) || !Number.isSafeInteger(agent.contextGeneration) || agent.contextGeneration < 0 || !['available', 'dormant', 'retired'].includes(agent.state)) throw new Error('Invalid named-agent identity')
      ids.add(agent.id)
      for (const name of [agent.name, ...agent.aliases]) {
        const key = nameKey(name)
        if (!key || names.has(key)) throw new Error('Ambiguous named-agent alias')
        names.add(key)
      }
    }
    for (const episode of state.episodes) {
      if (!episode || !episode.id || episodes.has(episode.id) || !ids.has(episode.agentId) || episode.policy?.version !== 1 || !['shared', 'isolated'].includes(episode.policy.workspace) || !['read-only', 'write'].includes(episode.policy.access) || !['queued', 'running', 'completed', 'failed', 'interrupted'].includes(episode.state) || !episode.binding?.workspaceId || !episode.requestHash || !Number.isSafeInteger(episode.contextGeneration)) throw new Error('Invalid agent episode')
      if (terminal(episode.state) !== Boolean(episode.completedAt)) throw new Error('Invalid agent episode completion')
      episodes.add(episode.id)
    }
    for (const agent of state.identities) {
      const active = state.episodes.find((episode) => episode.id === agent.activeEpisodeId)
      if (agent.activeEpisodeId && (!active || active.agentId !== agent.id || terminal(active.state))) throw new Error('Invalid active agent episode')
    }
    return state
  }

  resolve(idOrName: string): NamedAgentIdentity | undefined {
    const key = nameKey(idOrName)
    return this.read().identities.find((agent) => agent.state !== 'retired' &&
      (agent.id === idOrName || [agent.name, ...agent.aliases].some((name) => nameKey(name) === key)))
  }

  create(name: string, id = randomUUID()): NamedAgentIdentity {
    const normalized = name.normalize('NFKC').trim()
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,79}$/u.test(normalized)) throw new Error('Agent name must be 1–80 letters, numbers, spaces, dots, underscores or hyphens')
    return this.mutate((state) => {
      if (state.identities.some((agent) => agent.id === id || [agent.name, ...agent.aliases].some((alias) => nameKey(alias) === nameKey(normalized)))) throw new Error('Agent name or identity already exists in this task')
      const agent: NamedAgentIdentity = { id, name: normalized, aliases: [], state: 'available', contextGeneration: 0, createdAt: new Date().toISOString() }
      state.identities.push(agent)
      return agent
    })
  }

  begin(input: Omit<AgentEpisode, 'requestHash' | 'createdAt' | 'completedAt' | 'result' | 'state'>): AgentEpisode {
    const requestHash = sha256Hex(canonicalJson(input))
    return this.mutate((state) => {
      const previous = state.episodes.find((episode) => episode.id === input.id)
      if (previous) {
        if (previous.requestHash !== requestHash) throw new Error('Episode idempotency key reused with different input')
        return previous
      }
      const agent = state.identities.find((entry) => entry.id === input.agentId)
      if (!agent || agent.state === 'retired') throw new Error('Named agent unavailable in this task')
      if (agent.activeEpisodeId) throw new Error(`Named agent already owns episode ${agent.activeEpisodeId}`)
      if (agent.contextGeneration !== input.contextGeneration) throw new Error('Agent context generation changed')
      const episode: AgentEpisode = { ...structuredClone(input), requestHash, createdAt: new Date().toISOString(), state: 'queued' }
      agent.activeEpisodeId = episode.id; agent.state = 'available'
      state.episodes.push(episode)
      return episode
    })
  }

  running(episodeId: string): AgentEpisode {
    return this.mutate((state) => {
      const episode = state.episodes.find((entry) => entry.id === episodeId)
      if (!episode || terminal(episode.state)) throw new Error('Agent episode is no longer admitted')
      episode.state = 'running'
      return episode
    })
  }

  complete(episodeId: string, expectedContextGeneration: number,
    result: NonNullable<AgentEpisode['result']>, status: 'completed' | 'failed' | 'interrupted' = 'completed'): AgentEpisode {
    return this.mutate((state) => {
      const episode = state.episodes.find((entry) => entry.id === episodeId)
      if (!episode) throw new Error('Agent episode missing')
      if (terminal(episode.state)) {
        if (episode.state !== status || canonicalJson(episode.result) !== canonicalJson(result)) throw new Error('Completed episode is immutable')
        return episode
      }
      const agent = state.identities.find((entry) => entry.id === episode.agentId)!
      if (agent.activeEpisodeId !== episode.id || agent.contextGeneration !== expectedContextGeneration || episode.contextGeneration !== expectedContextGeneration) throw new Error('Stale agent context publication')
      episode.state = status; episode.result = structuredClone(result); episode.completedAt = new Date().toISOString()
      agent.contextGeneration += 1; agent.lastEpisodeId = episode.id; agent.state = 'dormant'; delete agent.activeEpisodeId
      return episode
    })
  }

  /** Daemon startup only: contexts survive; no stale command or approval is replayed. */
  interruptOrphans(): void {
    this.mutate((state) => {
      for (const episode of state.episodes.filter((entry) => !terminal(entry.state))) {
        const agent = state.identities.find((entry) => entry.id === episode.agentId)!
        episode.state = 'interrupted'; episode.completedAt = new Date().toISOString(); episode.result = { reason: 'Daemon restarted; explicit recall required' }
        agent.contextGeneration += 1; agent.lastEpisodeId = episode.id; agent.state = 'dormant'; delete agent.activeEpisodeId
      }
    })
  }

  private mutate<T>(fn: (state: AgentEpisodeState) => T): T {
    return withThreadDataMutationLock(this.threadDirectory, () => {
      const state = this.read(), before = canonicalJson(state)
      const value = fn(state)
      if (canonicalJson(state) !== before) atomicWriteJsonSync(this.path, state)
      return structuredClone(value)
    })
  }
}
