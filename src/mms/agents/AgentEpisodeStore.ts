import { enableVersionedLifecycleWriter } from '../queue/ThreadLifecycleAdmission'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEpisode, AgentEpisodeState, NamedAgentIdentity } from '../../shared/agentEpisodes'
import type { MousseAgentSessionSnapshot } from '../../shared/types'
import { canonicalJson } from '../../shared/agents/hashes'
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
      const owned = state.episodes.filter((episode) => episode.agentId === agent.id)
      const pending = owned.filter((episode) => !terminal(episode.state))
      const completed = owned.filter((episode) => terminal(episode.state))
      const last = completed.at(-1)
      if (pending.length > 1 || pending[0]?.id !== agent.activeEpisodeId || agent.activeEpisodeId && (!active || active.agentId !== agent.id || terminal(active.state))) throw new Error('Invalid active agent episode')
      if (agent.lastEpisodeId !== last?.id || agent.contextGeneration !== completed.length || owned.some((episode, index) => episode.contextGeneration !== index)) throw new Error('Invalid named-agent context generation or last episode')
    }
    if (state.integrations !== undefined && !Array.isArray(state.integrations)) throw new Error('Invalid named-agent integrations')
    const integrated = new Set<string>()
    for (const result of state.integrations ?? []) {
      const episode = state.episodes.find((entry) => entry.id === result.episodeId)
      if (!episode || !terminal(episode.state) || episode.policy.workspace !== 'isolated' || episode.policy.access !== 'write' || episode.result?.resultSha !== result.resultSha || !result.operationId || !result.receiptId || !/^[a-f0-9]{40,64}$/.test(result.integrationSha) || integrated.has(result.episodeId)) throw new Error('Invalid named-agent integration disposition')
      integrated.add(result.episodeId)
    }
    return state
  }

  resolve(idOrName: string): NamedAgentIdentity | undefined {
    const key = nameKey(idOrName)
    return this.read().identities.find((agent) => agent.state !== 'retired' &&
      (agent.id === idOrName || [agent.name, ...agent.aliases].some((name) => nameKey(name) === key)))
  }

  /** Daemon startup only: contexts survive; no stale command or approval is replayed. */
  interruptOrphans(): void {
    this.mutate((state) => {
      for (const episode of state.episodes.filter((entry) => !terminal(entry.state))) {
        const agent = state.identities.find((entry) => entry.id === episode.agentId)!
        const publication = this.readPublication(episode)
        episode.state = publication?.status ?? 'interrupted'; episode.completedAt = new Date().toISOString()
        episode.result = publication?.result ?? { reason: 'Daemon restarted; explicit recall required' }
        agent.contextGeneration += 1; agent.lastEpisodeId = episode.id; agent.state = 'dormant'; delete agent.activeEpisodeId
      }
    })
  }

  private contextPath(agentId: string, episodeId: string): string {
    if (![agentId, episodeId].every((id) => /^[a-z0-9][a-z0-9_-]{2,127}$/i.test(id))) throw new Error('Invalid agent context identity')
    return join(this.threadDirectory, 'agent-contexts', agentId, `${episodeId}.json`)
  }
  private readPublication(episode: AgentEpisode): { snapshot: MousseAgentSessionSnapshot; status: 'completed' | 'failed' | 'interrupted'; result: NonNullable<AgentEpisode['result']> } | undefined {
    const path = this.contextPath(episode.agentId, episode.id)
    if (!existsSync(path)) return undefined
    const publication = JSON.parse(readFileSync(path, 'utf8'))
    if (publication.schemaVersion !== 1 || publication.agentId !== episode.agentId || publication.episodeId !== episode.id || publication.expectedContextGeneration !== episode.contextGeneration || publication.snapshot?.agentId !== episode.agentId || publication.snapshot.runState === 'running' || !terminal(publication.status) || !publication.result) throw new Error('Invalid native context publication')
    return publication
  }

  private mutate<T>(fn: (state: AgentEpisodeState) => T): T {
    enableVersionedLifecycleWriter(this.threadDirectory)
    return withThreadDataMutationLock(this.threadDirectory, () => {
      const state = this.read(), before = canonicalJson(state)
      const value = fn(state)
      if (canonicalJson(state) !== before) atomicWriteJsonSync(this.path, state)
      return structuredClone(value)
    })
  }
}
