import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { lookup, Resolver } from 'node:dns/promises'
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
import { DirectTransport } from '../../../src/mms/net/transports/direct'
import { ProcessSupervisor } from '../../../src/mms/net/transports/runtime/process'
import { dispatchMethod } from '../../../src/mms/protocol/handlers'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture(cloudflare = false, preflight?: (address: string) => Promise<void>) {
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
  await target.net.request('net.init', cloudflare ? {} : { listen: true }); await target.net.request('net.protect', { passphrase: 'target-native-fixture' })
  if (cloudflare) await target.net.request('net.transport.configure', { id: 'cloudflared', enabled: true, settings: { mode: 'quick' } })
  if (preflight) for (const route of target.net.status().routes) await preflight(route.address)
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

it.skipIf(process.env.MOUSSE_NET_QA_OPT_IN !== '1')('qualifies the composed Bridge workflow through a real quick Cloudflare tunnel', async () => {
  const answers = new Map<string, Array<{ address: string; family: number }>>(), dnsEvidence: Array<{ systemDns: boolean; injectedResolver: boolean }> = []
  const ownedChildren: Array<{ pid: number; directory: string }> = [], actualStart = ProcessSupervisor.prototype.start
  vi.spyOn(ProcessSupervisor.prototype, 'start').mockImplementation(function () {
    actualStart.call(this)
    const owned = this as unknown as { child?: { pid?: number }; options: { args: string[]; cwd?: string } }
    if (owned.options.args.includes('--url') && owned.child?.pid && owned.options.cwd) ownedChildren.push({ pid: owned.child.pid, directory: owned.options.cwd })
  })
  let prePayloadAttempts = 0
  const actualResolve = DirectTransport.prototype.resolve, actualDial = DirectTransport.prototype.dial
  async function measure(host: string): Promise<void> {
    if (!answers.has(host)) {
      let rows: Array<{ address: string; family: number }> = [], systemDns = false
      try { rows = await lookup(host, { all: true }); systemDns = rows.length > 0 } catch { /* Recorded below; no production DNS change. */ }
      if (!systemDns) {
        if (process.env.MOUSSE_QA_DNS_FALLBACK !== '1') throw new Error('System DNS failed; this QA run did not authorize a measured resolver fallback')
        const resolver = new Resolver({ timeout: 3000, tries: 2 }); resolver.setServers(['1.1.1.1'])
        for (let attempt = 0; attempt < 15 && !rows.length; attempt++) {
          try { rows = (await resolver.resolve4(host)).map(address => ({ address, family: 4 })) } catch { await new Promise(resolve => setTimeout(resolve, 1000)) }
        }
      }
      if (!rows.length) throw new Error('The actual tunnel hostname has no measured address')
      answers.set(host, rows); dnsEvidence.push({ systemDns, injectedResolver: true })
    }
  }
  vi.spyOn(DirectTransport.prototype, 'resolve').mockImplementation(async function (route, signal) {
    const url = new URL(route.address), host = url.hostname
    if (!host.endsWith('.trycloudflare.com')) return actualResolve.call(this, route, signal)
    await measure(host)
    if (signal.aborted) throw new Error('QA resolve cancelled')
    // Populate only the production resolver's measured-address cache. Its actual
    // WebSocket dial still preserves the original URL/Host/SNI/certificate checks.
    ;(this as unknown as { resolved: Map<string, Array<{ address: string; family: number }>> }).resolved.set(route.address, answers.get(host)!)
  })
  vi.spyOn(DirectTransport.prototype, 'dial').mockImplementation(async function (route, signal) {
    const url = new URL(route.address)
    if (!url.hostname.endsWith('.trycloudflare.com')) return actualDial.call(this, route, signal)
    for (let attempt = 0; ; attempt++) {
      prePayloadAttempts++
      await this.resolve(route, signal)
      try { return await actualDial.call(this, route, signal) } catch (error) {
        if (attempt >= 7 || signal.aborted) throw error
        // No tunnel payload or TLS hello has been sent: only edge/WS readiness retries.
        await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 5000); const abort = () => { clearTimeout(timer); reject(new Error('QA dial cancelled')) }; signal.addEventListener('abort', abort, { once: true }) })
      }
    }
  })
  const f = await fixture(true, address => measure(new URL(address).hostname))
  const routes = f.target.net.status().routes
  expect(routes.map(route => route.transport)).toEqual(['cloudflared'])
  const created = await f.caller.bridge.hub.create(f.node, 'Cloudflare actual thread') as { thread: { id: string } }, thread = f.target.threads.getThread(created.thread.id)!, ref = { nodeId: f.node, entityId: thread.id }
  const message = { id: 'cf-large-display', role: 'assistant' as const, content: 'cf-display-'.repeat(240000), timestamp: new Date().toISOString() }
  f.target.threads.mutateThreadData(thread.id, () => ({ messages: [message] })); f.target.orchestrator.getOrCreateSession(thread.id).messages = [message]
  const views: unknown[] = [], errors: unknown[] = []
  await f.caller.bridge.hub.attachFor('cf-actual-owner', ref, view => { views.push(view) }, code => { errors.push(code) })
  await vi.waitFor(() => expect(views.some(view => (view as { kind: string; value?: { messages: Array<{ content: string }> } }).kind === 'snapshot' && (view as { value: { messages: Array<{ content: string }> } }).value.messages[0]?.content === message.content)).toBe(true), { timeout: 15_000 })
  await dispatchMethod({ mms: f.target, globalSequence: () => 0 }, 'threads.rename', { threadId: thread.id, name: 'Actual CF local rename' })
  await vi.waitFor(() => expect(JSON.stringify(views)).toContain('Actual CF local rename'))
  f.target.threads.mutateThreadData(thread.id, () => ({ messages: [] })); f.target.orchestrator.getOrCreateSession(thread.id).messages = []
  const calls: Array<{ context: Context; signal?: AbortSignal }> = [], gates = [deferred(), deferred()]
  vi.spyOn(f.target.providerAuth.models, 'streamSimple').mockImplementation((_model, context, options) => {
    const index = calls.length; calls.push({ context: structuredClone(context), signal: options?.signal }); const response = providerResponse([{ type: 'text', text: 'CF native fixture' }], 'stop')
    return { async *[Symbol.asyncIterator]() { await gates[index].promise }, result: async () => response } as never
  })
  const id = newId('rpc'), sending = f.caller.bridge.hub.send(ref, 'Actual CF native turn', { id, deadlineMs: 20_000 }).catch(error => error)
  await vi.waitFor(() => expect(calls).toHaveLength(1))
  expect(await f.caller.bridge.hub.steer(ref, id, 'Cloudflare mid-turn steer')).toEqual({ ok: true }); gates[0].resolve()
  await vi.waitFor(() => expect(calls).toHaveLength(2)); expect(JSON.stringify(calls[1].context)).toContain('Cloudflare mid-turn steer')
  expect(await f.caller.bridge.hub.abort(ref, id)).toEqual({ ok: true }); expect(await sending).toMatchObject({ code: 'outcome_uncertain' })
  await vi.waitFor(() => expect(calls[1].signal?.aborted).toBe(true)); gates[1].resolve()
  expect(errors).toEqual([]); expect(f.caller.net.session(f.node).peer.node).toBe(f.node)
  expect(f.caller.net.session(f.node).peer.user).toBe(f.caller.net.runtime().identity.self()!.user)
  expect(f.target.net.runtime().db.database.prepare("SELECT DISTINCT execution FROM net_rpc_aliases WHERE method='orchestrator.send'").all()).toHaveLength(1)
  f.caller.bridge.hub.detachOwner('cf-actual-owner')
  await f.caller.stop(); await f.target.stop()
  expect(ownedChildren.length).toBeGreaterThan(0)
  for (const child of ownedChildren) {
    await vi.waitFor(() => expect(() => process.kill(child.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' })))
    await expect(stat(child.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  }
  const evidence = { gate: 'composed-bridge-cloudflared-quick', dnsEvidence, prePayloadAttempts, onlyCloudflareRoute: true, sameUserAuthenticated: true, mutualPinnedTls: true, verifiedDisplayBytes: Buffer.byteLength(message.content), actualNativeSteerAbort: true, ownedTunnelChildrenStopped: true, ownedTunnelDirectoriesRemoved: true, paidProviderQualified: false }
  if (process.env.MOUSSE_QA_EVIDENCE_OUT) await writeFile(process.env.MOUSSE_QA_EVIDENCE_OUT, JSON.stringify(evidence) + '\n', { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify(evidence))
}, 120_000)

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
