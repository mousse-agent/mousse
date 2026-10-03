import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import { MousseMainService } from '../../../src/mms/MousseMainService'
import { ProviderAuthService } from '../../../src/mms/providers/ProviderAuthService'
import { LlmClient } from '../../../src/mms/orchestrator/LlmClient'
import { newId, validateStreamDescriptor, type StreamDescriptor } from '../../../src/shared/net'
import { defaultAgentSettings } from '../../../src/shared/agents/defaults'
import { portableRepository, type DispatchResultBody } from '../../../src/mms/bridge/dispatch'
import { git } from '../../../src/mms/bridge/dispatch/git'
import { inputRef } from '../../../src/mms/bridge/dispatch/bundle'
import { providerResponse, streamOf } from '../../fixtures/agent-platform/agent-runtime-policy/helpers'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture() {
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  vi.spyOn(LlmClient.prototype, 'generateTitle').mockResolvedValue('Owned native fixture')
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('External HTTP is forbidden in this deterministic qualification') })
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bridge-composed-execution-'))), repo = join(root, 'repo')
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(repo); await git(repo, ['init', '--template=']); await writeFile(join(repo, 'base.txt'), 'base'); await git(repo, ['add', '.']); await git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'base'])
  const target = await MousseMainService.create({ homeDir: join(root, 'target'), repoRoot: repo, headless: true, requireOwnership: false })
  cleanup.push(() => target.stop())
  const caller = await MousseMainService.create({ homeDir: join(root, 'caller'), repoRoot: repo, headless: true, requireOwnership: false })
  cleanup.push(() => caller.stop())
  await target.net.request('net.init', { listen: true }); await target.net.request('net.protect', { passphrase: 'target-native-fixture' })
  const invite = await target.net.request('bridge.invite', {}) as { invite: string }
  await caller.net.request('bridge.join', { invite: invite.invite }); await caller.net.request('net.protect', { passphrase: 'caller-native-fixture' })
  const node = target.net.runtime().identity.self()!.node
  await vi.waitFor(() => expect(caller.net.session(node).state()).toBe('open'), { timeout: 10_000 })
  const provider = target.providerAuth.models.getProviders().find(p => target.providerAuth.models.getModels(p.id).some(m => m.api === 'anthropic-messages'))!
  expect(provider).toBeDefined()
  const model = target.providerAuth.models.getModels(provider.id).find(m => m.api === 'anthropic-messages')!
  vi.spyOn(target.providerAuth, 'has').mockReturnValue(true)
  vi.spyOn(target.providerAuth.models, 'getAuth').mockResolvedValue({ apiKey: 'deterministic-fixture-only' } as never)
  target.settings.set({ provider: { llmProvider: provider.id, model: model.id } })
  return { root, repo, target, caller, node, provider, model }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

it('steers and aborts the exact composed remote native run without cancelling a later local run', async () => {
  const f = await fixture(), thread = f.target.threads.createThread('Owned native turn'), ref = { nodeId: f.node, entityId: thread.id }, id = newId('rpc')
  const calls: Array<{ context: Context; signal?: AbortSignal }> = [], gates = [deferred(), deferred(), deferred()]
  vi.spyOn(f.target.providerAuth.models, 'streamSimple').mockImplementation((_model, context, options) => {
    const index = calls.length; calls.push({ context: structuredClone(context), signal: options?.signal })
    const response = providerResponse([{ type: 'text', text: 'native deterministic partial' }], 'stop')
    return { async *[Symbol.asyncIterator]() { yield { type: 'text_start', contentIndex: 0, partial: response }; yield { type: 'text_delta', contentIndex: 0, delta: 'native deterministic partial', partial: response }; await gates[index].promise }, result: async () => response } as never
  })
  const sending = f.caller.bridge.hub.send(ref, 'Original owned remote prompt', { id, idem: 'owned-native-send', deadlineMs: 15_000 }).catch(error => error)
  await vi.waitFor(() => expect(calls).toHaveLength(1))
  expect(await f.caller.bridge.hub.steer(ref, id, 'Keep the exact mid-turn steering text')).toEqual({ ok: true })
  gates[0].resolve()
  await vi.waitFor(() => expect(calls).toHaveLength(2))
  expect(JSON.stringify(calls[1].context.messages)).toContain('Keep the exact mid-turn steering text')
  expect(await f.caller.bridge.hub.abort(ref, id)).toEqual({ ok: true })
  expect(await sending).toMatchObject({ code: 'outcome_uncertain' })
  await vi.waitFor(() => { expect(calls[1].signal?.aborted).toBe(true); expect(f.target.orchestrator.getOrCreateSession(thread.id).turnAdmitted).toBe(false) })
  gates[1].resolve()
  const local = new AbortController(), later = f.target.orchestrator.runChannelTurn(thread.id, 'Later local owned prompt', f.target.threads, { signal: local.signal })
  await vi.waitFor(() => expect(calls).toHaveLength(3))
  expect(await f.caller.bridge.hub.abort(ref, id)).toEqual({ ok: false })
  expect(calls[2].signal?.aborted).toBe(false)
  local.abort(); await later; gates[2].resolve()
  const durable = f.target.threads.loadThreadData(thread.id)
  expect(durable.messages.map(message => message.content).join('\n')).toContain('Original owned remote prompt')
  expect(f.target.net.runtime().db.database.prepare("SELECT DISTINCT execution FROM net_rpc_aliases WHERE method='orchestrator.send'").all()).toHaveLength(1)
}, 30_000)

it.each(['shared-remote', 'bundle'])('runs actual composed native Dispatch with %s and publishes a verified Git result once', async mode => {
  const f = await fixture(), sender = join(f.root, 'sender')
  await git(f.root, ['clone', f.repo, sender])
  const base = await git(f.repo, ['rev-parse', 'HEAD'])
  await writeFile(join(sender, 'input.txt'), 'verified incoming base'); await git(sender, ['add', '.']); await git(sender, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'incoming base'])
  const incoming = await git(sender, ['rev-parse', 'HEAD'])
  if (mode === 'shared-remote') await git(f.repo, ['remote', 'add', 'origin', `file://${sender}`])
  else { await git(f.repo, ['remote', 'add', 'origin', 'https://example.invalid/team/repo.git']); await git(sender, ['remote', 'set-url', 'origin', 'https://example.invalid/team/repo.git']) }
  const portable = await portableRepository(f.repo)
  await f.target.bridge.dispatch.bindRepository(portable.repoId, f.repo, mode === 'shared-remote' ? { allowFetch: true, remote: 'origin' } : {})
  const outputs: AssistantMessage[] = [providerResponse([{ type: 'toolCall', id: 'write-1', name: 'write', arguments: { path: 'result.txt', content: 'actual native tool bytes' } }], 'toolUse'), providerResponse([{ type: 'text', text: 'native composed dispatch complete' }], 'stop')], contexts: Context[] = []
  vi.spyOn(f.target.providerAuth.models, 'streamSimple').mockImplementation((_model, context) => { contexts.push(structuredClone(context)); const next = outputs.shift(); if (!next) throw new Error('Deterministic provider exhausted'); return streamOf(next) as never })
  const integrations = f.target.settings.get().integrations
  f.target.settings.set({ integrations: { ...integrations, tools: { enabled: true, enabledTools: ['write', 'read'] } } })
  const settings = defaultAgentSettings({ name: 'Composed Dispatch', slug: 'composed-dispatch' })
  settings.primaryModel.ref = { providerId: f.provider.id, modelId: f.model.id }; settings.tools = { mode: 'explicit', allowlist: ['write'] }; settings.context.includeProjectInstructions = false; settings.context.includeCurrentThread = false; settings.context.attachmentPolicy = 'none'; settings.context.sources = []; settings.memory.scope = 'off'; settings.recovery.retryCount = 0; settings.approval.policy = 'inherit'
  const draft = f.target.platform.agentDefinitions.createDraft({ settings, systemPrompt: 'PINNED_COMPOSED_DISPATCH' }), published = f.target.platform.agentDefinitions.publish(draft.id, draft.draftHash)
  const id = newId('rpc'), request = { repoId: portable.repoId, baseCommit: incoming, agent: draft.id, prompt: 'Write result.txt in the isolated worktree.', limits: { maxTurns: 2, maxToolCalls: 1, maxElapsedMs: 10_000 }, ...(mode === 'shared-remote' ? { fetch: true } : {}) }
  let result: DispatchResultBody
  if (mode === 'bundle') {
    await git(sender, ['update-ref', inputRef(incoming), incoming]); const path = join(f.root, 'input.bundle')
    await git(sender, ['bundle', 'create', path, inputRef(incoming), `^${base}`])
    expect((await portableRepository(sender)).repoId).toBe(portable.repoId)
    f.caller.bridge.hub.prepareDispatchWithBundle(f.node, request, await readFile(path), { id, idem: 'one-native-dispatch', deadlineMs: 15_000 })
    result = await f.caller.bridge.hub.resumeDispatchWithBundle(id) as DispatchResultBody
  } else result = await f.caller.bridge.hub.dispatch(f.node, request, { id, idem: 'one-native-dispatch', deadlineMs: 15_000 }) as DispatchResultBody
  expect(result).toMatchObject({ kind: 'bridge.dispatch.result.v1', rpc: id, baseCommit: incoming, agent: { revision: published.revision, profileId: f.target.profileId } })
  expect(await git(f.repo, ['show', `${result.ref}:result.txt`])).toBe('actual native tool bytes')
  expect(await git(f.repo, ['show', `${result.ref}:input.txt`])).toBe('verified incoming base')
  expect(contexts).toHaveLength(2); expect(contexts[0].systemPrompt).toContain('PINNED_COMPOSED_DISPATCH')
  expect(f.target.threads.loadThreadData(result.threadId).messages.map(message => message.content).join('\n')).toContain('native composed dispatch complete')
  const db = f.target.net.runtime().db, record = JSON.parse(String(db.database.prepare('SELECT record FROM net_dispatches WHERE execution=?').get(result.execution)!.record))
  expect(record.state).toBe('completed')
  expect(f.target.bridge.threads.store.getById(result.artifact.stream, result.artifact.event)).toBeDefined()
  expect(f.target.net.runtime().blobs.isReferenced(result.artifact.blob, result.artifact.stream)).toBe(true)
  await f.target.bridge.dispatch.drainCleanup()
  expect(await f.caller.bridge.hub.query(id)).toEqual(result)
  expect(db.database.prepare('SELECT * FROM net_dispatches').all()).toHaveLength(1)
  expect(db.database.prepare("SELECT DISTINCT execution FROM net_rpc_aliases WHERE method='bridge.dispatch'").all()).toHaveLength(1)
  expect(contexts).toHaveLength(2)
  expect(await git(sender, ['for-each-ref', '--format=%(refname)', 'refs/heads/mousse/dispatch/'])).toBe('')
  expect(result.artifact.blob).toBe(`blb_${result.bundleHash}`)
  const descriptor = await f.caller.bridge.hub.call(f.node, 'bridge.artifacts.open', { forRpcId: id, forMethod: 'bridge.dispatch' }) as StreamDescriptor
  expect(validateStreamDescriptor(descriptor)).toBe(true)
  expect(descriptor.id).toBe(result.artifact.stream)
  expect(descriptor.artifact).toMatchObject({ rpc: id, method: 'bridge.dispatch', caller: f.caller.net.runtime().identity.self()!.node })
  const store = f.caller.bridge.threads.store, session = f.caller.net.session(f.node), errors: unknown[] = []
  store.createStream(descriptor, 1)
  const subscription = session.subscribe(descriptor.id, { onRecord() {}, onCaughtUp() {}, onError: code => { errors.push(code) } })
  try {
    await vi.waitFor(() => expect(store.getById(result.artifact.stream, result.artifact.event)).toBeDefined())
    expect(errors).toEqual([])
    const received = await session.getBlob(result.artifact.stream, result.artifact.blob)
    expect(createHash('sha256').update(received).digest('hex')).toBe(result.bundleHash)
    const receivedPath = join(f.root, 'result.bundle'); await writeFile(receivedPath, received)
    await git(sender, ['bundle', 'verify', receivedPath])
    await git(sender, ['fetch', '--no-write-fetch-head', receivedPath, `${result.ref}:refs/heads/verified-result`])
    expect(await git(sender, ['show', 'refs/heads/verified-result:result.txt'])).toBe('actual native tool bytes')
  } finally { subscription.close() }
}, 30_000)
