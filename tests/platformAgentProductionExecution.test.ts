import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { LocalMmsClient, MmsProtocolServer } from '../src/mms/protocol'
import { AGENT_DEFINITION_CAPABILITY } from '../src/shared/agentPlatform'
import { defaultAgentSettings } from '../src/shared/agents/defaults'
import { canonicalJson, sha256Hex } from '../src/shared/agents/hashes'
import { createAgentDefinitionsClient } from '../src/renderer/services/agentDefinitionsClient'
import { providerResponse, streamOf } from './fixtures/agent-platform/agent-runtime-policy/helpers'

const roots: string[] = []
const previousHome = process.env.MOUSSE_HOME

afterEach(() => {
  vi.restoreAllMocks()
  if (previousHome === undefined) delete process.env.MOUSSE_HOME
  else process.env.MOUSSE_HOME = previousHome
  for (const root of roots.splice(0)) {
    const rel = relative(realpathSync(tmpdir()), realpathSync(root))
    if (isAbsolute(rel) || !rel.startsWith('mousse-agent-production-') || rel.includes('..')) throw new Error('Unexpected fixture root')
    rmSync(root, { recursive: true, force: true })
  }
})

async function fixture(outputs: AssistantMessage[]) {
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const root = mkdtempSync(join(tmpdir(), 'mousse-agent-production-')); roots.push(root)
  const homeDir = join(root, 'home')
  const main = await MousseMainService.create({ homeDir, repoRoot: root, requireOwnership: false, headless: true })
  const host = main.getInstallationHost()!
  const alice = host.manager.create({ displayName: 'Alice', slug: 'alice' })
  const bob = host.manager.create({ displayName: 'Bob', slug: 'bob' })
  const services = await main.getProfileServices(alice.id)
  const captured: Context[] = []
  const provider = services.providerAuth.models.getProviders().find((entry) => services.providerAuth.models.getModels(entry.id).length > 0)!
  const model = services.providerAuth.models.getModels(provider.id)[0]
  vi.spyOn(services.providerAuth, 'has').mockReturnValue(true)
  vi.spyOn(services.providerAuth.models, 'getAuth').mockResolvedValue({ apiKey: 'fixture' } as never)
  vi.spyOn(services.providerAuth.models, 'streamSimple').mockImplementation((_model, context) => {
    captured.push(structuredClone(context))
    const next = outputs.shift()
    if (!next) throw new Error('fixture provider exhausted')
    return streamOf(next) as never
  })
  const integrations = services.settings.get().integrations
  services.settings.set({ integrations: { ...integrations, tools: { enabled: true, enabledTools: ['read', 'write', 'ask_user', 'create_task'] } } })
  const server = new MmsProtocolServer({ mms: main, ownerToken: 'fixture-owner' })
  const endpoint = await server.start()
  const clients: LocalMmsClient[] = []
  const connect = async (profile: string) => {
    const rpc = new LocalMmsClient({ homeDir, endpoint, ownerToken: 'fixture-owner', requestedCapabilities: ['profiles-v1', AGENT_DEFINITION_CAPABILITY] })
    clients.push(rpc); await rpc.connect(); await rpc.request('profiles.bind', { profile })
    return { rpc, agents: createAgentDefinitionsClient(rpc) }
  }
  return { root, homeDir, main, alice, bob, services, captured, modelRef: { providerId: provider.id, modelId: model.id }, connect, close: async () => {
    await Promise.allSettled(clients.map((client) => client.close()))
    await server.stop(); await main.stop()
  } }
}

function settings(name: string, modelRef: { providerId: string; modelId: string }, approval: 'inherit' | 'always' = 'inherit') {
  const value = defaultAgentSettings({ name, slug: name.toLowerCase().replaceAll(' ', '-') })
  value.primaryModel.ref = modelRef
  value.context.includeProjectInstructions = false
  value.tools = { mode: 'explicit', allowlist: ['read', 'write', 'ask_user', 'create_task'] }
  value.approval.policy = approval
  value.recovery.retryCount = 0
  return value
}

describe('native Agent Editor Try Run production host', () => {
  it('runs an exact published revision through framed MMS in an isolated scratch and profile/thread history', async () => {
    const f = await fixture([
      providerResponse([{ type: 'toolCall', id: 'task-1', name: 'create_task', arguments: { description: 'run-scoped task' } }], 'toolUse'),
      providerResponse([{ type: 'toolCall', id: 'write-1', name: 'write', arguments: { path: 'result.txt', content: 'pinned bytes' } }], 'toolUse'),
      providerResponse([{ type: 'text', text: 'pinned answer' }], 'stop')
    ])
    try {
      const a = await f.connect(f.alice.id), b = await f.connect(f.bob.id)
      const created = await a.agents.create({ profileId: f.alice.id, settings: settings('Pinned Agent', f.modelRef), systemPrompt: 'PINNED_SYSTEM' })
      const published = await a.agents.publish({ profileId: f.alice.id, id: created.id, expectedDraftHash: created.draftHash })
      await a.agents.saveDraft({ profileId: f.alice.id, id: created.id, expectedDraftHash: created.draftHash,
        settings: settings('Pinned Agent', f.modelRef), systemPrompt: 'CHANGED_DRAFT' })
      const result = await a.agents.tryRun({ profileId: f.alice.id, id: created.id, revision: published.revision, prompt: 'write the fixture' })
      expect(result).toMatchObject({ ok: true, status: 'completed', summary: 'pinned answer' })
      expect(result.trace.some((entry) => entry.message.includes(published.revision))).toBe(true)
      expect(result.trace.some((entry) => entry.message.includes('isolated scratch'))).toBe(true)
      const runRoot = join(f.services.getProfileHomeDir(), 'agent-runs', result.runId!)
      expect(readFileSync(join(runRoot, 'workspace', 'result.txt'), 'utf8')).toBe('pinned bytes')
      expect(JSON.stringify(f.captured[0])).toContain('PINNED_SYSTEM')
      expect(JSON.stringify(f.captured[0])).not.toContain('CHANGED_DRAFT')
      const record = JSON.parse(readFileSync(join(runRoot, 'run.json'), 'utf8'))
      expect(record).toMatchObject({ profileId: f.alice.id, threadId: result.threadId, definitionRevision: published.revision, state: 'completed' })
      expect(record.integrity).toMatch(/^[a-f0-9]{64}$/)
      expect(f.services.threadRuntimes.getOrHydrate(result.threadId!).tasks.list().map((task) => task.description)).toEqual(['run-scoped task'])
      expect(f.services.tasks.list()).toEqual([])
      expect((await b.agents.list({ profileId: f.bob.id }))).toEqual([])
      await expect(b.agents.tryRun({ profileId: f.bob.id, id: created.id, revision: published.revision, prompt: 'cross profile' })).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' })
      expect(f.services.orchestrator.getMessages(result.threadId!).map((message) => message.content)).toEqual(expect.arrayContaining(['write the fixture', 'pinned answer']))
    } finally { await f.close() }
  }, 30_000)

  it('uses the durable question channel for full reviewed approval and denies oversized hidden arguments', async () => {
    const f = await fixture([
      providerResponse([{ type: 'toolCall', id: 'write-approval', name: 'write', arguments: { path: 'approved.txt', content: 'reviewed bytes' } }], 'toolUse'),
      providerResponse([{ type: 'text', text: 'approved answer' }], 'stop')
    ])
    try {
      const a = await f.connect(f.alice.id)
      const created = await a.agents.create({ profileId: f.alice.id, settings: settings('Approval Agent', f.modelRef, 'always'), systemPrompt: 'approve exactly' })
      const running = a.agents.tryRun({ profileId: f.alice.id, id: created.id, expectedDraftHash: created.draftHash, prompt: 'approve write' })
      let pending: Array<{ requestId: string; questions: Array<{ prompt: string }> }> = []
      await vi.waitFor(async () => {
        pending = (await a.rpc.request<{ pending: typeof pending }>('orchestrator.pendingQuestions', {})).pending
        expect(pending).toHaveLength(1)
      })
      expect(pending[0].questions[0].prompt).toContain('reviewed bytes')
      expect(pending[0].questions[0].prompt).toMatch(/Digest: [a-f0-9]{64}/)
      expect(await a.rpc.request('orchestrator.answerQuestions', { requestId: pending[0].requestId, answers: { approval: 'approve' } })).toEqual({ ok: true })
      const result = await running
      expect(result.status).toBe('completed')
      expect(existsSync(join(f.services.getProfileHomeDir(), 'agent-runs', result.runId!, 'workspace', 'approved.txt'))).toBe(true)
      const oversized = 'critical-tail'.padStart(7_000, 'x')
      const direct = (f.services.platform.agentRuns as unknown as { approveOwned(root: string, request: object): Promise<{ status: string }> }).approveOwned
      const runRoot = join(f.services.getProfileHomeDir(), 'agent-runs', result.runId!)
      const denied = await direct.call(f.services.platform.agentRuns, runRoot, { runId: result.runId, threadId: result.threadId,
        toolName: 'write', canonicalToolName: 'write', arguments: { path: 'hidden.txt', content: oversized }, argumentDigest: '0'.repeat(64), classification: 'write' })
      expect(denied.status).toBe('denied')
      expect((await a.rpc.request<{ pending: unknown[] }>('orchestrator.pendingQuestions', {})).pending).toEqual([])
    } finally { await f.close() }
  }, 30_000)

  it('settles the framed request as cancelled when the profile run owner drains', async () => {
    const f = await fixture([])
    try {
      const a = await f.connect(f.alice.id)
      vi.mocked(f.services.providerAuth.models.streamSimple).mockImplementation((_model, _context, options) => ({
        async *[Symbol.asyncIterator]() { await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true })) },
        result: async () => providerResponse([], 'aborted')
      }) as never)
      const created = await a.agents.create({ profileId: f.alice.id, settings: settings('Cancel Agent', f.modelRef), systemPrompt: 'wait' })
      const request = a.agents.tryRun({ profileId: f.alice.id, id: created.id, expectedDraftHash: created.draftHash, prompt: 'wait' })
      await vi.waitFor(() => expect(f.services.platform.agentRuns.getActiveCount()).toBe(1))
      f.services.platform.agentRuns.beginShutdown()
      const result = await request
      expect(result).toMatchObject({ ok: false, status: 'failed' })
      const record = JSON.parse(readFileSync(join(f.services.getProfileHomeDir(), 'agent-runs', result.runId!, 'run.json'), 'utf8'))
      expect(record.state).toBe('cancelled')
      expect(f.services.questions.listAllPending()).toEqual([])
    } finally { await f.close() }
  }, 30_000)

  it('cancels a native ask_user wait at the per-run deadline and clears only its thread question', async () => {
    const f = await fixture([providerResponse([{ type: 'toolCall', id: 'ask-1', name: 'ask_user', arguments: { questions: [
      { id: 'choice', prompt: 'Wait forever?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] }
    ] } }], 'toolUse')])
    try {
      const a = await f.connect(f.alice.id)
      const value = settings('Deadline Agent', f.modelRef); value.limits.maxElapsedMs = 100
      const created = await a.agents.create({ profileId: f.alice.id, settings: value, systemPrompt: 'ask' })
      const result = await a.agents.tryRun({ profileId: f.alice.id, id: created.id, expectedDraftHash: created.draftHash, prompt: 'ask now' })
      expect(result).toMatchObject({ ok: false, status: 'failed' })
      expect(result.summary).toContain('cancelled')
      expect(f.services.questions.listAllPending()).toEqual([])
    } finally { await f.close() }
  }, 30_000)

  it('fails unsupported host settings explicitly before provider dispatch', async () => {
    const f = await fixture([])
    try {
      const a = await f.connect(f.alice.id)
      for (const [name, mutate, pointer] of [
        ['Browser Agent', (value: ReturnType<typeof settings>) => { value.browser.mode = 'native' }, '/settings/browser/mode'],
        ['Memory Agent', (value: ReturnType<typeof settings>) => { value.memory.scope = 'profile_agent' }, '/settings/memory/scope'],
        ['Files Agent', (value: ReturnType<typeof settings>) => { value.context.selectedFiles = ['project.txt'] }, '/settings/context/selectedFiles']
      ] as const) {
        const value = settings(name, f.modelRef); mutate(value)
        const created = await a.agents.create({ profileId: f.alice.id, settings: value, systemPrompt: 'unsupported' })
        const rejection = await a.agents.tryRun({ profileId: f.alice.id, id: created.id, expectedDraftHash: created.draftHash, prompt: 'must not dispatch' }).catch((error: unknown) => error)
        expect(rejection).toMatchObject({ code: 'SETTINGS_UNSUPPORTED' })
        expect(JSON.stringify(rejection)).toContain(pointer)
      }
      const cliSettings = settings('CLI Agent', f.modelRef)
      cliSettings.recovery = defaultAgentSettings({ name: 'CLI Agent', slug: 'cli-agent' }).recovery
      const cli = await a.agents.create({ profileId: f.alice.id, runtimeKind: 'codex', settings: cliSettings, systemPrompt: 'unsupported' })
      await expect(a.agents.tryRun({ profileId: f.alice.id, id: cli.id, expectedDraftHash: cli.draftHash, prompt: 'must not spawn' }))
        .rejects.toMatchObject({ code: 'SETTINGS_UNSUPPORTED' })
      expect(f.captured).toEqual([])
    } finally { await f.close() }
  }, 30_000)

  it('marks an integrity-valid running record interrupted on restart without replay', async () => {
    const f = await fixture([providerResponse([{ type: 'text', text: 'seeded' }], 'stop')])
    let runFile = ''
    try {
      const a = await f.connect(f.alice.id)
      const created = await a.agents.create({ profileId: f.alice.id, settings: settings('Recovery Agent', f.modelRef), systemPrompt: 'seed' })
      const result = await a.agents.tryRun({ profileId: f.alice.id, id: created.id, expectedDraftHash: created.draftHash, prompt: 'seed record' })
      runFile = join(f.services.getProfileHomeDir(), 'agent-runs', result.runId!, 'run.json')
    } finally { await f.close() }
    const stored = JSON.parse(readFileSync(runFile, 'utf8'))
    delete stored.integrity; delete stored.result; stored.state = 'running'
    stored.integrity = sha256Hex(canonicalJson(stored))
    writeFileSync(runFile, JSON.stringify(stored), 'utf8')
    const restarted = await MousseMainService.create({ homeDir: f.homeDir, repoRoot: f.root, requireOwnership: false, headless: true })
    try {
      await restarted.getProfileServices(f.alice.id)
      expect(JSON.parse(readFileSync(runFile, 'utf8')).state).toBe('interrupted')
      expect(f.captured).toHaveLength(1)
    } finally { await restarted.stop() }
  }, 30_000)
})
