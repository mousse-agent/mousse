import { expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Context } from '@earendil-works/pi-ai'
import { MousseMainService } from '../../../../src/mms/MousseMainService'
import { ProviderAuthService } from '../../../../src/mms/providers/ProviderAuthService'
import { NetDatabase } from '../../../../src/mms/net/store/database'
import { FileKeyStore } from '../../../../src/mms/net/identity/FileKeyStore'
import { NetIdentityService } from '../../../../src/mms/net/identity/NetIdentityService'
import { newId, type Roster, type NodeDelegation, type RpcArtifactRef } from '../../../../src/shared/net'
import { defaultAgentSettings } from '../../../../src/shared/agents/defaults'
import { DispatchService, portableRepository, mmsDispatchRuntime } from '../../../../src/mms/bridge/dispatch'
import { git } from '../../../../src/mms/bridge/dispatch/git'
import { providerResponse, streamOf } from '../../../fixtures/agent-platform/agent-runtime-policy/helpers'

it('runs a pinned published agent through the actual MMS native provider/tool lifecycle in its Dispatch worktree', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mousse-dispatch-native-'))), home = join(root, 'home'), repo = join(root, 'repo')
  await mkdir(repo); await git(repo, ['init', '--template=']); await writeFile(join(repo, 'base.txt'), 'base'); await git(repo, ['add', '.']); await git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'base'])
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const main = await MousseMainService.create({ homeDir: home, repoRoot: repo, requireOwnership: false, headless: true })
  let db: NetDatabase | undefined
  try {
    const owner = main.getInstallationHost()!.manager.create({ displayName: 'Dispatch fixture', slug: 'dispatch-fixture' }), services = await main.getProfileServices(owner.id)
    const provider = services.providerAuth.models.getProviders().find(entry => services.providerAuth.models.getModels(entry.id).length > 0)!, model = services.providerAuth.models.getModels(provider.id)[0]
    vi.spyOn(services.providerAuth, 'has').mockReturnValue(true)
    vi.spyOn(services.providerAuth.models, 'getAuth').mockResolvedValue({ apiKey: 'fixture' } as never)
    const outputs = [providerResponse([{ type: 'toolCall', id: 'write-1', name: 'write', arguments: { path: 'result.txt', content: 'real native loop bytes' } }], 'toolUse'), providerResponse([{ type: 'text', text: 'completed dispatch' }], 'stop')], captured: Context[] = []
    vi.spyOn(services.providerAuth.models, 'streamSimple').mockImplementation((_model, context) => { captured.push(structuredClone(context)); const next = outputs.shift(); if (!next) throw new Error('Fixture provider exhausted'); return streamOf(next) as never })
    const integrations = services.settings.get().integrations
    services.settings.set({ integrations: { ...integrations, tools: { enabled: true, enabledTools: ['write', 'read'] } } })
    const settings = defaultAgentSettings({ name: 'Dispatch fixture', slug: 'dispatch-fixture' }); settings.primaryModel.ref = { providerId: provider.id, modelId: model.id }; settings.tools = { mode: 'explicit', allowlist: ['write'] }; settings.context.includeProjectInstructions = false; settings.context.includeCurrentThread = false; settings.context.attachmentPolicy = 'none'; settings.context.sources = []; settings.memory.scope = 'off'; settings.recovery.retryCount = 0; settings.approval.policy = 'always'
    const draft = services.platform.agentDefinitions.createDraft({ settings, systemPrompt: 'PINNED_DISPATCH_PROMPT' }), published = services.platform.agentDefinitions.publish(draft.id, draft.draftHash)
    const domain = await services.platform.agentDomain('agentDefinitions.tryRun', { id: draft.id })
    db = new NetDatabase({ profileDir: services.getProfileHomeDir() })
    const keys = new FileKeyStore(services.getProfileHomeDir()), identity = new NetIdentityService({ database: db.database, keys, clock: db.clock, coordinator: db }); await identity.bootstrapAuthority('Native fixture')
    const callbacks: Array<() => void> = [], approvals: string[] = []
    const runtime = mmsDispatchRuntime({ profileId: owner.id, resolveAgent: async id => domain.resolver.resolve({ definitionId: id, revision: published.revision }), orchestrator: services.orchestrator, approveToolRequest: async request => { approvals.push(request.argumentDigest); return { status: 'approved', digest: request.argumentDigest } } })
    let bundle: Uint8Array | undefined
    const service = new DispatchService({ db, identity, profileId: owner.id, installationHome: await realpath(home), threads: services.threads, runtime, artifacts: { readInput: async () => { throw new Error('not used') }, prepareResult: async bytes => { bundle = bytes; const ref: RpcArtifactRef = { stream: newId('stream'), event: newId('event'), blob: `blb_${createHash('sha256').update(bytes).digest('hex')}` }; return { ref, commit: () => undefined } } } })
    const portable = await portableRepository(repo), base = await git(repo, ['rev-parse', 'HEAD']); await service.bindRepository(portable.repoId, repo)
    const roster = identity.verifySigned<Roster>(identity.roster()!, keys.rootKey()!), delegation = identity.verifySigned<NodeDelegation>(roster.nodes[0], keys.rootKey()!), execution = newId('execution')
    const context = { id: newId('rpc'), caller: { ...identity.self()!, delegation }, signal: new AbortController().signal, deadlineAt: db.clock.now() + 15_000, progress: () => undefined, onTerminalCommit: (work: () => void) => callbacks.push(work) }
    await service.run({ repoId: portable.repoId, baseCommit: base, agent: draft.id, prompt: 'Write result.txt inside the dispatch worktree.', limits: { maxTurns: 2, maxToolCalls: 1, maxElapsedMs: 10_000 } }, context, execution)
    const record = service.query(execution, context)!
    expect(await readFile(join(record.worktree!.path, 'result.txt'), 'utf8')).toBe('real native loop bytes')
    expect(captured).toHaveLength(2); expect(captured[0].systemPrompt).toContain('PINNED_DISPATCH_PROMPT'); expect(approvals).toHaveLength(1)
    expect(bundle!.length).toBeGreaterThan(0)
    const data = services.threads.loadThreadData(record.threadId!)
    expect(data.messages.map(message => message.content).join('\n')).toContain('completed dispatch')
    db.transaction(() => callbacks.forEach(work => work())); await service.drainCleanup()
    expect(service.query(execution, context)).toMatchObject({ state: 'completed', phase: 'complete', definition: { revision: published.revision } })
  } finally { db?.close(); await main.stop(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) }
}, 30_000)
