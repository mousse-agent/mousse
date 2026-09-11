import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { domainObject } from '../src/mms/protocol/domainRegistry'
import { LocalMmsClient, MmsProtocolError } from '../src/mms/protocol/client'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { BROWSER_ATTACHED_V1_CAPABILITY } from '../src/shared/browser/connectionCommands'
import { BROWSER_AUTOMATION_TOOLS, type BrowserToolContext } from '../src/shared/browser/automation'
import {
  BROWSER_VIEWER_CAPABILITY,
  MAX_BROWSER_ATTACHMENTS_PER_CONNECTION,
  type BrowserArtifactReadResult,
  type BrowserAttachmentRegisterResult,
  type BrowserSessionListResult,
  type BrowserSessionSnapshotResult
} from '../src/shared/browser/host'
import { PROFILES_V1_CAPABILITY } from '../src/shared/profiles/types'
import { AttachedBrowserConnectionBackend } from '../src/mms/browser/AttachedBrowserConnectionBackend'
import { MmsBrowserService } from '../src/mms/browser/MmsBrowserService'
import { BrowserArtifactService } from '../src/mms/browser/BrowserArtifactService'
import type { BrowserWorkerRequest, BrowserWorkerResponse } from '../src/shared/browser/types'
import {
  makeBrowserCommandTempRoot,
  removeBrowserCommandTempRoot
} from './fixtures/agent-platform/browser-command-transport/ownedTemp'
import { FakeAttachedExecutor, FIXTURE_PNG } from './fixtures/agent-platform/browser-daemon-composition/fakeAttachedExecutor'

const OWNER_TOKEN = 'fixture-owner-token'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) removeBrowserCommandTempRoot(root)
})

type Inspected = {
  connectionId: string
  clientType: string | null
  capabilities: string[]
  binding: { profileId: string; epoch: number } | null
}

function policy(profileId: string): BrowserToolContext['policy'] {
  return {
    version: 1,
    id: `policy-${profileId}`,
    profileId,
    allowedTools: BROWSER_AUTOMATION_TOOLS,
    allowedCapabilities: ['browser.session', 'browser.observe', 'browser.action', 'browser.extract', 'browser.task'],
    allowedEffects: ['read', 'write', 'external'],
    approvalEffects: [],
    maxToolCalls: 40,
    maxElapsedMs: 60_000,
    maxArtifactBytes: 1024 * 1024
  }
}

function context(profileId: string, threadId: string, source: 'gui' | 'cli' = 'gui', runId?: string): BrowserToolContext {
  const current = policy(profileId)
  return {
    execution: {
      profileId,
      threadId,
      ...(runId ? { runId } : {}),
      turnId: `turn-${source}`,
      actor: { kind: 'main' },
      policySnapshotId: current.id,
      source,
      cancellationId: `cancel-${source}`
    },
    policy: current,
    vision: true
  }
}

async function startHarness() {
  const root = makeBrowserCommandTempRoot()
  roots.push(root)
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  const main = await MousseMainService.create({
    homeDir: home,
    repoRoot: root,
    requireOwnership: false,
    headless: true
  })
  main.domains.register({
    method: 'fixture.inspectConnection',
    scope: 'installation',
    validate: (params) => {
      if (params === undefined || params === null) return {}
      return domainObject(params, [])
    },
    handle: (ctx) => ({
      connectionId: ctx.connection?.id ?? null,
      clientType: ctx.connection?.clientType ?? null,
      capabilities: ctx.connection ? [...ctx.connection.capabilities].sort() : [],
      binding: ctx.connection?.binding ?? null
    })
  })
  const router = main.browserCommandRouter
  const host = main.getInstallationHost()!
  const alice = host.manager.create({ displayName: 'Alice', slug: 'alice' })
  const bob = host.manager.create({ displayName: 'Bob', slug: 'bob' })
  const server = new MmsProtocolServer({ mms: main, ownerToken: OWNER_TOKEN, commandRouter: router })
  const endpoint = await server.start()
  const clients: LocalMmsClient[] = []
  const stop = async (): Promise<void> => {
    await Promise.allSettled(clients.map((client) => client.close()))
    await server.stop()
    await main.stop()
  }
  return { root, home, main, host, alice, bob, router, server, endpoint, clients, stop }
}

function guiClient(home: string, endpoint: string, extra: string[] = []): LocalMmsClient {
  return new LocalMmsClient({
    homeDir: home,
    endpoint,
    ownerToken: OWNER_TOKEN,
    clientType: 'gui',
    requestedCapabilities: [PROFILES_V1_CAPABILITY, BROWSER_ATTACHED_V1_CAPABILITY, BROWSER_VIEWER_CAPABILITY, ...extra]
  })
}

describe('browser daemon composition', () => {
  it('registers an attached GUI tab, routes the same target, and isolates siblings, reconnect, and managed fallback', async () => {
    const h = await startHarness()
    const aliceServices = await h.main.getProfileServices(h.alice.id)
    const finish = async (): Promise<void> => {
      await h.stop()
    }
    try {
    const thread = aliceServices.threads.createThread('Browser')
    const otherThread = aliceServices.threads.createThread('Other')
    const nativeRun = 'native_run_1'
    const executor = new FakeAttachedExecutor(aliceServices.platform.workerArtifactRoot)
    const alice = guiClient(h.home, h.endpoint)
    alice.setAttachedBrowserCommandHandler(executor.handle)
    h.clients.push(alice)
    await alice.connect()
    const bound = await alice.request<{ profile: { id: string }; epoch: number }>('profiles.bind', { profile: h.alice.id })
    const info = await alice.request<Inspected>('fixture.inspectConnection')
    expect(info.binding).toEqual({ profileId: h.alice.id, epoch: bound.epoch })
    expect(info.capabilities).toEqual(expect.arrayContaining([BROWSER_ATTACHED_V1_CAPABILITY, BROWSER_VIEWER_CAPABILITY]))

    const registrationId = randomUUID()
    const closureToken = randomBytes(32).toString('base64url')
    const registered = await alice.request<BrowserAttachmentRegisterResult>('browser.attachments.register', {
      registrationId,
      registrationEpoch: 1,
      closureToken,
      uiTabId: 'window1:tab_live'
    })
    expect(registered).toMatchObject({
      uiTabId: 'window1:tab_live',
      registrationId,
      registrationEpoch: 1,
      profileId: h.alice.id,
      profileEpoch: bound.epoch,
      artifactRoot: aliceServices.platform.workerArtifactRoot
    })
    expect(registered.artifactRoot.replace(/\\/g, '/')).toMatch(/\/browser\/worker-artifacts$/)
    expect(registered.closureToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const replayed = await alice.request<BrowserAttachmentRegisterResult>('browser.attachments.register', {
      registrationId,
      registrationEpoch: 1,
      closureToken,
      uiTabId: 'window1:tab_live'
    })
    expect(replayed).toEqual(registered)

    await expect(alice.request('browser.attachments.select', { uiTabId: 'window1:tab_live', threadId: 'missing-thread' }))
      .rejects.toMatchObject({ code: 'invalid_action' })
    await alice.request('browser.attachments.select', { uiTabId: 'window1:tab_live', threadId: thread.id })
    await expect(alice.request('browser.attachments.select', { uiTabId: 'window1:tab_live', threadId: otherThread.id }))
      .rejects.toMatchObject({ code: 'invalid_action' })

    const browser = aliceServices.platform.browser
    expect(browser.managedBrokerStarted).toBe(false)
    expect(browser.managedDispatchAttempted).toBe(false)
    await expect(browser.workflow.invoke({
      nodeType: 'browser-session',
      context: context(h.alice.id, otherThread.id).execution,
      policy: policy(h.alice.id),
      config: {},
      input: {}
    })).rejects.toMatchObject({ code: 'setup_required' })
    expect(browser.managedDispatchAttempted).toBe(false)
    await expect(browser.dispatch(context(h.alice.id, otherThread.id), 'browser_open', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'setup_required' }
    })
    expect(browser.managedDispatchAttempted).toBe(false)
    expect(browser.managedBrokerStarted).toBe(false)

    const opened = await browser.dispatch(context(h.alice.id, thread.id), 'browser_open', {})
    expect(opened.ok).toBe(true)
    if (!opened.ok) throw new Error('open failed')
    expect(opened.value.session?.backend).toBe('electron-attached')
    expect(executor.calls[0]).toMatchObject({ method: 'session.open', params: { uiTabId: 'window1:tab_live', threadId: thread.id } })
    expect(executor.calls[0].params).not.toHaveProperty('backend')
    const sessionId = opened.value.session!.id

    const nativeOpened = await browser.dispatch(context(h.alice.id, thread.id, 'gui', nativeRun), 'browser_open', {})
    expect(nativeOpened.ok).toBe(true)
    if (!nativeOpened.ok) throw new Error('native open failed')
    const nativeSessionId = nativeOpened.value.session!.id
    expect(nativeSessionId).not.toBe(sessionId)

    const listed = await alice.request<BrowserSessionListResult>('browser.sessions.list', { threadId: thread.id })
    expect(listed.sessions.map((row) => row.id).sort()).toEqual([nativeSessionId, sessionId].sort())
    expect(listed.selected).toEqual({ backend: 'electron-attached', uiTabId: 'window1:tab_live' })
    expect(JSON.stringify(listed)).not.toContain(registered.artifactRoot)
    expect(JSON.stringify(listed)).not.toContain(info.connectionId)
    expect(listed.sessions.every((row) => !('controlLeaseId' in row))).toBe(true)

    const observed = await alice.request<BrowserSessionSnapshotResult>('browser.sessions.observe', { threadId: thread.id, sessionId })
    expect(observed.observation?.sessionId).toBe(sessionId)
    expect(observed.observation?.screenshot?.artifactId).not.toMatch(/^art_/)
    expect(observed.artifacts).toHaveLength(1)
    const artifactId = observed.artifacts[0].id
    const png = await alice.request<BrowserArtifactReadResult>('browser.artifacts.read', {
      threadId: thread.id,
      sessionId,
      artifactId
    })
    expect(Buffer.from(png.bytesBase64, 'base64')).toEqual(FIXTURE_PNG)
    expect(png.artifact).not.toHaveProperty('path')
    expect(JSON.stringify(png)).not.toContain(registered.artifactRoot)

    const nativeObserved = await alice.request<BrowserSessionSnapshotResult>('browser.sessions.observe', {
      threadId: thread.id,
      sessionId: nativeSessionId
    })
    expect(nativeObserved.run?.runId).toBe(nativeRun)
    expect(nativeObserved.session?.runId).toBe(nativeRun)

    const taken = await alice.request<BrowserSessionSnapshotResult>('browser.sessions.takeControl', { threadId: thread.id, sessionId })
    expect(taken.controlOwner).toBe('human')
    const generation = taken.session!.generation
    const observationId = (await alice.request<BrowserSessionSnapshotResult>('browser.sessions.observe', { threadId: thread.id, sessionId })).observation!.observationId
    const acted = await alice.request<BrowserSessionSnapshotResult>('browser.sessions.humanAction', {
      threadId: thread.id,
      sessionId,
      tabId: taken.observation?.tabs[0]?.id ?? observed.observation!.tabId,
      generation,
      observationId,
      action: { type: 'click', target: { kind: 'ref', ref: 'e1' } }
    })
    expect(acted.observation?.generation).toBe(generation)
    const resumed = await alice.request<BrowserSessionSnapshotResult>('browser.sessions.resume', { threadId: thread.id, sessionId })
    expect(resumed.controlOwner).toBe('agent')
    expect(resumed.session!.generation).toBeGreaterThan(generation)
    await expect(alice.request('browser.sessions.humanAction', {
      threadId: thread.id,
      sessionId,
      tabId: observed.observation!.tabId,
      generation,
      observationId,
      action: { type: 'click', target: { kind: 'ref', ref: 'e1' } }
    })).rejects.toMatchObject({ code: expect.stringMatching(/stale_generation|human_controlled/) })

    const sibling = guiClient(h.home, h.endpoint)
    sibling.setAttachedBrowserCommandHandler(async (command) => ({
      version: 1, id: command.request.id, ok: true, result: { hijacked: true }
    }))
    h.clients.push(sibling)
    await sibling.connect()
    await sibling.request('profiles.bind', { profile: h.alice.id })
    await expect(sibling.request('browser.attachments.register', {
      registrationId: randomUUID(),
      registrationEpoch: 1,
      closureToken: randomBytes(32).toString('base64url'),
      uiTabId: 'window1:tab_live'
    })).rejects.toMatchObject({ code: 'policy_denied' })
    await expect(sibling.request('browser.attachments.select', { uiTabId: 'window1:tab_live', threadId: thread.id }))
      .rejects.toMatchObject({ code: 'policy_denied' })
    await expect(sibling.request('browser.sessions.observe', { threadId: thread.id, sessionId }))
      .rejects.toMatchObject({ code: 'policy_denied' })
    await expect(sibling.request('browser.sessions.takeControl', { threadId: thread.id, sessionId }))
      .rejects.toMatchObject({ code: 'policy_denied' })
    await expect(sibling.request('browser.artifacts.read', { threadId: thread.id, sessionId, artifactId }))
      .rejects.toMatchObject({ code: 'policy_denied' })
    await expect(sibling.request('browser.attachments.acknowledgeClosed', {
      registrationId,
      registrationEpoch: 1,
      closureToken: registered.closureToken
    })).rejects.toMatchObject({ code: 'policy_denied' })

    const bobServices = await h.main.getProfileServices(h.bob.id)
    const bobThread = bobServices.threads.createThread('Bob')
    const bobGui = guiClient(h.home, h.endpoint)
    bobGui.setAttachedBrowserCommandHandler(executor.handle)
    h.clients.push(bobGui)
    await bobGui.connect()
    await bobGui.request('profiles.bind', { profile: h.bob.id })
    await expect(bobGui.request('browser.sessions.observe', { threadId: thread.id, sessionId, profileId: h.alice.id }))
      .rejects.toMatchObject({ code: 'profile_mismatch' })
    await expect(bobGui.request('browser.sessions.observe', { threadId: bobThread.id, sessionId }))
      .rejects.toMatchObject({ code: expect.stringMatching(/session_closed|invalid_action/) })
    await expect(bobGui.request('browser.artifacts.read', { threadId: bobThread.id, sessionId, artifactId }))
      .rejects.toMatchObject({ code: expect.stringMatching(/session_closed|invalid_action|artifact_denied/) })

    const cli = new LocalMmsClient({
      homeDir: h.home,
      endpoint: h.endpoint,
      ownerToken: OWNER_TOKEN,
      clientType: 'cli',
      requestedCapabilities: [PROFILES_V1_CAPABILITY, BROWSER_ATTACHED_V1_CAPABILITY, BROWSER_VIEWER_CAPABILITY]
    })
    h.clients.push(cli)
    await cli.connect()
    await cli.request('profiles.bind', { profile: h.alice.id })
    await expect(cli.request('browser.attachments.register', {
      registrationId: randomUUID(),
      registrationEpoch: 1,
      closureToken: randomBytes(32).toString('base64url'),
      uiTabId: 'cli-tab'
    })).rejects.toBeInstanceOf(MmsProtocolError)

    const beforeDisconnect = executor.calls.length
    await alice.close()
    await vi.waitFor(() => expect(browser.selectedTarget(thread.id)).toBeUndefined())
    await expect(browser.dispatch(context(h.alice.id, thread.id), 'browser_observe', { sessionId, includeScreenshot: true }))
      .resolves.toMatchObject({ ok: false, error: { code: expect.stringMatching(/session_closed|setup_required|worker_disconnected/) } })
    expect(executor.calls.length).toBe(beforeDisconnect)

    const reconnected = guiClient(h.home, h.endpoint)
    const reconnectExecutor = new FakeAttachedExecutor(aliceServices.platform.workerArtifactRoot)
    reconnected.setAttachedBrowserCommandHandler(reconnectExecutor.handle)
    h.clients.push(reconnected)
    await reconnected.connect()
    await reconnected.request('profiles.bind', { profile: h.alice.id })
    const replacement = await reconnected.request<BrowserAttachmentRegisterResult>('browser.attachments.register', {
      registrationId: randomUUID(),
      registrationEpoch: 2,
      closureToken: randomBytes(32).toString('base64url'),
      uiTabId: 'window1:tab_live'
    })
    await reconnected.request('browser.attachments.select', { uiTabId: 'window1:tab_live', threadId: thread.id })
    await expect(browser.dispatch(context(h.alice.id, thread.id), 'browser_observe', { sessionId, includeScreenshot: true }))
      .resolves.toMatchObject({ ok: false, error: { code: expect.stringMatching(/session_closed|setup_required|worker_disconnected/) } })
    expect(reconnectExecutor.calls.some((call) => call.params.sessionId === sessionId)).toBe(false)
    const replacementOpen = await browser.dispatch(context(h.alice.id, thread.id), 'browser_open', {})
    expect(replacementOpen.ok, replacementOpen.ok ? '' : JSON.stringify(replacementOpen)).toBe(true)
    if (!replacementOpen.ok) throw new Error('replacement open failed')
    expect(replacementOpen.value.session!.id).not.toBe(sessionId)

    await expect(reconnected.request('browser.attachments.acknowledgeClosed', {
      registrationId,
      registrationEpoch: 1,
      closureToken: `${registered.closureToken.slice(0, -1)}${registered.closureToken.endsWith('A') ? 'B' : 'A'}`
    })).rejects.toMatchObject({ code: 'policy_denied' })
    await expect(reconnected.request('browser.attachments.acknowledgeClosed', {
      registrationId,
      registrationEpoch: 1,
      closureToken: registered.closureToken
    })).resolves.toEqual({ ok: true })
    await expect(reconnected.request('browser.attachments.acknowledgeClosed', {
      registrationId,
      registrationEpoch: 1,
      closureToken: registered.closureToken
    })).rejects.toMatchObject({ code: 'session_closed' })

    await reconnected.request('browser.attachments.unregister', {
      registrationId: replacement.registrationId,
      registrationEpoch: replacement.registrationEpoch
    })
    } finally {
      await finish()
    }
  }, 30_000)

  it('maps dispatched mutation uncertainty without retry and enforces attachment bounds', async () => {
    const profileId = '11111111-1111-4111-8111-111111111111'
    const registration = {
      registrationId: 'reg_1', registrationEpoch: 1, uiTabId: 'tab_1', connectionId: 'conn_1',
      profileId, profileEpoch: 1, selectedThreadId: 'thread_1'
    }
    const dispatches: string[] = []
    let unknown = false
    const backend = new AttachedBrowserConnectionBackend({
      profileId,
      commandRouter: {
        async dispatch(input) {
          dispatches.push(input.request.id)
          if (unknown) {
            return { status: 'unknown-effect', dispatched: true, code: 'timeout', message: 'Attached mutation timed out after dispatch; remote effect is uncertain' }
          }
          const session = {
            id: 'sess_open', profileId, threadId: 'thread_1', backend: 'electron-attached' as const,
            persistent: false, browserVersion: 'fixture', generation: 1, lifecycle: 'agent-controlled' as const,
            createdAt: '2026-09-11T00:00:00Z', updatedAt: '2026-09-11T00:00:00Z'
          }
          return { status: 'completed' as const, dispatched: true as const, response: { version: 1 as const, id: input.request.id, ok: true, result: { session } } }
        }
      },
      getRegistrationByUiTabId: (uiTabId) => uiTabId === 'tab_1' ? registration : undefined,
      getRegistration: (id) => id === 'reg_1' ? registration : undefined
    })
    const opened = await backend.call({
      version: 1, id: 'open_ok', profileId, method: 'session.open',
      params: { uiTabId: 'tab_1', threadId: 'thread_1' }
    })
    expect(opened).toMatchObject({ ok: true })
    expect(backend.bindingForSession('sess_open')?.registrationId).toBe('reg_1')
    unknown = true
    const act: BrowserWorkerRequest = {
      version: 1, id: 'act_1', profileId, method: 'act',
      params: { sessionId: 'sess_open', requestId: 'req_act', generation: 1 }
    }
    expect(await backend.call(act)).toMatchObject({
      ok: true,
      result: { outcome: 'unknown-effect', dispatched: true, requestId: 'req_act' }
    })
    const open: BrowserWorkerRequest = {
      version: 1, id: 'open_1', profileId, method: 'session.open',
      params: { uiTabId: 'tab_1', threadId: 'thread_1' }
    }
    expect(await backend.call(open)).toMatchObject({
      ok: false,
      error: { code: 'timeout', message: expect.stringMatching(/uncertain|do not retry/i) }
    })
    expect(backend.bindingForSession('sess_missing')).toBeUndefined()
    expect(dispatches).toEqual(['open_ok', 'act_1', 'open_1'])

    const root = makeBrowserCommandTempRoot()
    roots.push(root)
    const artifacts = new BrowserArtifactService({
      profileId, profileRoot: root, workerArtifactRoot: join(root, 'browser', 'worker-artifacts')
    })
    const threads = new Set(['thread_1'])
    const service = new MmsBrowserService({
      profileId,
      profileRoot: root,
      workerArtifactRoot: join(root, 'browser', 'worker-artifacts'),
      artifacts,
      installationBrowserRoot: join(root, 'browser-binaries'),
      threadExists: (id) => threads.has(id),
      createManagedBackend: () => ({ call: async (request) => ({ version: 1, id: request.id, ok: false, error: { code: 'setup_required', message: 'managed must not start' } }) })
    })
    const owner = { connectionId: 'conn_1', profileId, profileEpoch: 1 }
    for (let i = 0; i < MAX_BROWSER_ATTACHMENTS_PER_CONNECTION; i += 1) {
      service.registerAttachment({ registrationId: randomUUID(), registrationEpoch: 1, closureToken: randomBytes(32).toString('base64url'), uiTabId: `tab_${i}` }, owner)
    }
    expect(() => service.registerAttachment({ registrationId: randomUUID(), registrationEpoch: 1, closureToken: randomBytes(32).toString('base64url'), uiTabId: 'tab_overflow' }, owner))
      .toThrow(/Too many attached browser tabs on this window/)
    await artifacts.dispose()
  })

  it('retains a managed backend whose first close fails and retries the same owner', async () => {
    const profileId = '22222222-2222-4222-8222-222222222222'
    const root = makeBrowserCommandTempRoot()
    roots.push(root)
    const artifacts = new BrowserArtifactService({
      profileId,
      profileRoot: root,
      workerArtifactRoot: join(root, 'browser', 'worker-artifacts')
    })
    const close = vi.fn()
      .mockRejectedValueOnce(new Error('managed close failed'))
      .mockResolvedValue(undefined)
    const service = new MmsBrowserService({
      profileId,
      profileRoot: root,
      workerArtifactRoot: join(root, 'browser', 'worker-artifacts'),
      artifacts,
      installationBrowserRoot: join(root, 'browser-binaries'),
      threadExists: (id) => id === 'thread_1',
      createManagedBackend: () => ({
        call: async (request) => ({
          version: 1,
          id: request.id,
          ok: false,
          error: { code: 'setup_required', message: 'fixture managed backend' }
        }),
        close
      })
    })
    expect((await service.dispatch(context(profileId, 'thread_1', 'cli'), 'browser_open', {})).ok).toBe(false)
    expect(service.managedBrokerStarted).toBe(true)

    await expect(service.dispose()).rejects.toThrow(/Failed to dispose profile browser services/)
    expect(close).toHaveBeenCalledTimes(1)
    expect(service.managedBrokerStarted).toBe(true)
    await service.dispose()
    expect(close).toHaveBeenCalledTimes(2)
    expect(service.managedBrokerStarted).toBe(false)
    await artifacts.dispose()
  })
})
