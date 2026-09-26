import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { MmsProtocolServer, LocalMmsClient } from '../src/mms/protocol'
import type { AgentEpisodeState } from '../src/shared/agentEpisodes'
import { providerResponse, streamOf } from './fixtures/agent-platform/agent-runtime-policy/helpers'
import { git, gitFoundationFixture } from './fixtures/gitFoundation'

it.each(['shared', 'isolated'] as const)('keeps same-named agents in two tasks isolated across service restart and recalls only the selected native context (%s)', async (workspace) => {
  const f = gitFoundationFixture()
  const responses: AssistantMessage[] = [], captured: Context[] = []
  let main: MousseMainService | undefined, server: MmsProtocolServer | undefined, rpc: LocalMmsClient | undefined
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const stop = async () => { await rpc?.close(); rpc = undefined; await server?.stop(); server = undefined; await main?.stop(); main = undefined }
  const start = async () => {
    main = await MousseMainService.create({ homeDir: f.home, headless: true, ownerKind: 'test' })
    await main.start()
    const ownerToken = main.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms: main, ownerToken })
    rpc = new LocalMmsClient({ homeDir: f.home, endpoint: await server.start(), ownerToken, clientType: 'gui' })
    await rpc.connect()
    const provider = main.providerAuth.models.getProviders().find((entry) => main!.providerAuth.models.getModels(entry.id).length > 0)!
    const model = main.providerAuth.models.getModels(provider.id)[0]
    vi.spyOn(main.providerAuth, 'has').mockReturnValue(true)
    vi.spyOn(main.providerAuth.models, 'getAuth').mockResolvedValue({ apiKey: 'fixture' } as never)
    vi.spyOn(main.providerAuth.models, 'streamSimple').mockImplementation((_model, context) => {
      captured.push(structuredClone(context))
      const response = responses.shift()
      if (!response) throw new Error('Unrequested model replay or exhausted qualification responses')
      return streamOf(response) as never
    })
    main.settings.set({ provider: { llmProvider: provider.id, model: model.id } })
  }
  const complete = async (threadId: string, operationId: string) => {
    let state!: AgentEpisodeState
    await vi.waitFor(async () => {
      state = await rpc!.request<AgentEpisodeState>('agents.listNamed', { threadId })
      expect(state.episodes.find((episode) => episode.id === operationId)?.state).toBe('completed')
    }, { timeout: 15_000, interval: 40 })
    return state
  }
  try {
    await start()
    const project = main!.projects.openProject(f.repo)
    const first = main!.threads.createThread('first context owner', project.id), second = main!.threads.createThread('second context owner', project.id)
    const markers = ['ALPHA_PRIVATE_CONTEXT_319', 'BETA_PRIVATE_CONTEXT_847']
    const identities: string[] = []
    for (const [index, thread] of [first, second].entries()) {
      responses.push(providerResponse([{ type: 'text', text: markers[index] }], 'stop'))
      await rpc!.request('agents.createNamed', { threadId: thread.id, name: 'Reviewer', task: 'Remember your unique private context', operationId: `qualified-create-${index}`, workspace, access: workspace === 'isolated' ? 'write' : 'read-only' })
      const state = await complete(thread.id, `qualified-create-${index}`)
      identities.push(state.identities[0].id)
      if (workspace === 'isolated') {
        const episode = state.episodes[0]
        await vi.waitFor(() => expect(existsSync(episode.binding.worktreePath), 'completed isolated checkout must be retired before restart').toBe(false), { timeout: 15_000 })
        expect(git(f.repo, 'rev-parse', episode.binding.branch!)).toBe(episode.result!.resultSha)
      }
    }
    expect(identities[0]).not.toBe(identities[1])
    const locations = [first, second].map((thread) => main!.threads.getThreadDir(thread.id))
    await stop()
    for (const [index, path] of locations.entries()) {
      const sessions = readFileSync(join(path, 'mousse-agent-sessions.json'), 'utf8')
      expect(sessions).toContain(identities[index])
      expect(sessions).not.toContain(identities[1 - index])
      expect(sessions).not.toContain(markers[1 - index])
    }
    await start()
    expect(captured).toHaveLength(2)
    await expect(rpc!.request('agents.recallNamed', { threadId: second.id, agent: identities[0], task: 'Wrong task', operationId: 'qualified-cross-task', expectedAgentGeneration: 1 }))
      .rejects.toThrow(/unavailable|identity|generation/i)
    responses.push(providerResponse([{ type: 'text', text: 'Recalled first task only' }], 'stop'))
    await rpc!.request('agents.recallNamed', { threadId: first.id, agent: 'Reviewer', task: 'Recall your context', operationId: 'qualified-recall-first', expectedAgentGeneration: 1, workspace, access: workspace === 'isolated' ? 'write' : 'read-only', resumeResult: workspace === 'isolated' })
    const recalled = await complete(first.id, 'qualified-recall-first')
    expect(recalled.identities[0]).toMatchObject({ id: identities[0], contextGeneration: 2, state: 'dormant' })
    expect(JSON.stringify(captured[2].messages)).toContain(markers[0])
    expect(JSON.stringify(captured[2].messages)).not.toContain(markers[1])
    expect(JSON.stringify(captured[2].messages)).toContain('Mousse recall notice')
    if (workspace === 'isolated') {
      const episode = recalled.episodes.find((entry) => entry.id === 'qualified-recall-first')!
      await vi.waitFor(() => expect(existsSync(episode.binding.worktreePath), 'recalled episode also releases its completed checkout').toBe(false), { timeout: 15_000 })
      expect(episode.binding.baseSha).toBe(recalled.episodes[0].result!.resultSha)
    }
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseSha)
    expect(f.read(f.repo)).toBe('base\n')
  } finally { await stop(); vi.restoreAllMocks(); f.dispose() }
}, 60_000)
