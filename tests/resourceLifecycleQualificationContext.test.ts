import { writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { AgentEpisodeStore } from '../src/mms/agents/AgentEpisodeStore'
import type { AgentEpisode } from '../src/shared/agentEpisodes'
import { seedLegacyNamedEpisode } from './fixtures/legacy-named-agent'
import { gitFoundationFixture } from './fixtures/gitFoundation'

it('startup marks an episode that was still running as interrupted and keeps its identity usable', () => {
  const f = gitFoundationFixture()
  try {
    const { agentId, episode: finished } = seedLegacyNamedEpisode(f.thread, { name: 'Reviewer', episodeId: 'finished-episode', worktreePath: f.repo })
    const store = new AgentEpisodeStore(f.thread)
    const state = store.read()
    state.identities[0].activeEpisodeId = 'orphan-episode'
    state.episodes.push({ ...finished, id: 'orphan-episode', state: 'running', completedAt: undefined, result: undefined, contextGeneration: 1 })
    writeFileSync(store.path, JSON.stringify(state))

    new AgentEpisodeStore(f.thread).interruptOrphans()

    const after = new AgentEpisodeStore(f.thread)
    expect(after.read().episodes.map((episode) => [episode.id, episode.state])).toEqual([['finished-episode', 'completed'], ['orphan-episode', 'interrupted']])
    expect(after.read().episodes[1].completedAt).toBeTruthy()
    expect(after.resolve('Reviewer')).toMatchObject({ id: agentId, state: 'dormant', contextGeneration: 2, lastEpisodeId: 'orphan-episode' })
    expect(after.resolve('Reviewer')?.activeEpisodeId).toBeUndefined()
  } finally { f.dispose() }
})

it.each(['lastEpisodeId', 'contextGeneration', 'orphanEpisode'])('rejects corrupt %s before named context and retention claims can be projected', (corruption) => {
  const f = gitFoundationFixture()
  try {
    seedLegacyNamedEpisode(f.thread, { name: 'Reviewer', episodeId: 'qualified-episode', worktreePath: f.repo, resultSha: f.baseSha })
    const store = new AgentEpisodeStore(f.thread)
    const state = store.read()
    if (corruption === 'lastEpisodeId') state.identities[0].lastEpisodeId = 'missing-episode'
    else if (corruption === 'contextGeneration') state.identities[0].contextGeneration = 0
    else state.episodes.push({ ...state.episodes[0], id: 'unclaimed-active-episode', state: 'running', completedAt: undefined, contextGeneration: 1 } as AgentEpisode)
    writeFileSync(store.path, JSON.stringify(state))
    expect(() => new AgentEpisodeStore(f.thread).read()).toThrow(/episode|context generation/i)
  } finally { f.dispose() }
})
