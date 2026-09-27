import { existsSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import type { Thread } from '../src/shared/types'
import type { AgentEpisodeState } from '../src/shared/agentEpisodes'
import { lifecycleHarness } from './fixtures/resource-lifecycle-harness'
import { checkoutStorageSnapshot, createQualificationRepository, primaryCheckoutSnapshot } from './fixtures/resource-lifecycle-qualification'
import { providerResponse, streamOf } from './fixtures/agent-platform/agent-runtime-policy/helpers'
import type { MousseAgentService } from '../src/mms/agents/MousseAgentService'

it('returns isolated checkout bytes and native runtimes to baseline across nine episodes in three tasks while retaining identities and history', async () => {
  const f = await lifecycleHarness()
  try {
    const repo = createQualificationRepository(f.root), primary = primaryCheckoutSnapshot(repo)
    const { project } = await f.rpc.request<{ project: { id: string } }>('projects.open', { path: repo })
    const models = f.services.providerAuth.models
    const provider = models.getProviders().find((entry) => models.getModels(entry.id).length > 0)!
    const model = models.getModels(provider.id)[0]
    vi.spyOn(f.services.providerAuth, 'has').mockReturnValue(true)
    vi.spyOn(models, 'getAuth').mockResolvedValue({ apiKey: 'fixture' } as never)
    vi.spyOn(models, 'streamSimple').mockImplementation(() => streamOf(providerResponse([{ type: 'text', text: 'Retained native result' }], 'stop')) as never)
    f.services.settings.set({ provider: { llmProvider: provider.id, model: model.id } })
    const runtimes = (f.services.orchestrator as unknown as { mousseAgents: MousseAgentService }).mousseAgents
    const tasks: Array<{ thread: Thread; identity?: string }> = []
    for (let index = 0; index < 3; index++) tasks.push({ thread: (await f.rpc.request<{ thread: Thread }>('threads.create', { name: `episode storage ${index}`, projectId: project.id })).thread })
    let materializedBytes: number | undefined
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const [index, entry] of tasks.entries()) {
        const operationId = `storage-episode-${index}-${cycle}`
        const request = { threadId: entry.thread.id, task: 'Retain this conversation and settle', operationId, workspace: 'isolated', access: 'read-only' }
        if (cycle === 0) await f.rpc.request('agents.createNamed', { ...request, name: 'Persistent Reviewer' })
        else await f.rpc.request('agents.recallNamed', { ...request, agent: entry.identity, expectedAgentGeneration: cycle, resumeResult: true })
        let state!: AgentEpisodeState
        await vi.waitFor(async () => {
          state = await f.rpc.request('agents.listNamed', { threadId: entry.thread.id })
          const episode = state.episodes.find((item) => item.id === operationId)!
          expect(episode.state).toBe('completed')
          expect(existsSync(episode.binding.worktreePath)).toBe(false)
          expect(runtimes.getActiveCount()).toBe(0)
          expect(runtimes.exportSessions()).toHaveLength(0)
        }, { timeout: 15_000 })
        if (entry.identity) expect(state.identities[0].id).toBe(entry.identity)
        entry.identity = state.identities[0].id
        expect(state.identities[0]).toMatchObject({ state: 'dormant', contextGeneration: cycle + 1 })
        expect(state.episodes).toHaveLength(cycle + 1)
      }
      const storage = checkoutStorageSnapshot(repo)
      expect(storage.materializedCheckouts).toBe(3)
      if (materializedBytes === undefined) materializedBytes = storage.materializedBytes
      else expect(storage.materializedBytes).toBe(materializedBytes)
      expect(primaryCheckoutSnapshot(repo)).toEqual(primary)
    }
  } finally { await f.close(); vi.restoreAllMocks() }
}, 120_000)
