import type { AgentEpisodeState } from '../../shared/agentEpisodes'
import type { ChangeReceipt } from '../../shared/threadActions'

/** Named episodes that still own their result, including the context a future Recall would resume. */
export function namedEpisodeClaims(state: AgentEpisodeState, receipts: readonly ChangeReceipt[], readPublication: (agentId: string, episodeId: string) => unknown) {
  const contextEpisodes = new Set<string>()
  const resolvedContext = new Set<string>()
  const identities = new Map(state.identities.map((identity) => [identity.id, identity]))
  for (const episode of [...state.episodes].reverse()) {
    if (resolvedContext.has(episode.agentId) || identities.get(episode.agentId)?.state === 'retired' || !['completed', 'failed', 'interrupted'].includes(episode.state)) continue
    if (![episode.agentId, episode.id].every((id) => /^[a-z0-9][a-z0-9_-]{2,127}$/i.test(id))) throw new Error('Invalid context publication identity')
    const publication = readPublication(episode.agentId, episode.id)
    if (publication !== undefined) {
      const value = publication as Record<string, unknown> | null
      const snapshot = value?.snapshot as Record<string, unknown> | undefined
      if (value?.schemaVersion !== 1 || value.agentId !== episode.agentId || value.episodeId !== episode.id || value.expectedContextGeneration !== episode.contextGeneration || snapshot?.agentId !== episode.agentId || snapshot.runState === 'running' || !['completed', 'failed', 'interrupted'].includes(String(value.status)) || !value.result || typeof value.result !== 'object' || Array.isArray(value.result)) throw new Error('Invalid context publication')
      contextEpisodes.add(episode.id)
      resolvedContext.add(episode.agentId)
    } else if (episode.request?.contextMode === 'fresh') resolvedContext.add(episode.agentId)
  }
  return state.episodes.map((episode) => {
    const identity = identities.get(episode.agentId)!
    const recall = identity.state !== 'retired' && (episode.id === identity.lastEpisodeId || episode.id === identity.activeEpisodeId || contextEpisodes.has(episode.id))
    const disposition = state.integrations?.find((entry) => entry.episodeId === episode.id)
    const integrated = disposition && receipts.some((receipt) => receipt.id === disposition.receiptId && receipt.operationId === disposition.operationId && receipt.kind === 'integration' && receipt.afterSha === disposition.integrationSha && receipt.contributions?.some((contribution) => contribution.actorId === episode.agentId && contribution.resultSha === disposition.resultSha))
    const pending = episode.policy.workspace === 'isolated' && episode.policy.access === 'write' && !integrated && episode.result?.resultSha !== episode.binding.baseSha
    return { episode, recall, pending }
  })
}
