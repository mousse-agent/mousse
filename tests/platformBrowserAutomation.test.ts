import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { copyFileSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecutionContext, ExecutionPolicySnapshot } from '../src/shared/execution/types'
import type { BrowserObservation, BrowserSessionRecord } from '../src/shared/browser/types'
import { BrowserBroker } from '../src/mms/browser/BrowserBroker'
import { createAllowHttpPolicy } from '../src/mms/browser/defaultPorts'
import { BrowserSessionManager } from '../src/mms/browser/automation/BrowserSessionManager'
import { BrowserToolDispatcher } from '../src/mms/browser/automation/BrowserToolDispatcher'
import { certifiedInstallDir, certifiedMetadataPath, resolveCertifiedBrowser } from '../src/browser-worker/binary/resolver'
import { ensureManagedChrome, MANAGED_BROWSER_ROOT, startFixtureSite } from './fixtures/browser/harness'

const chrome = await ensureManagedChrome()
const PROFILE_ID = '10000000-0000-4000-8000-000000000001'
const OTHER_PROFILE_ID = '20000000-0000-4000-8000-000000000002'
const managers: Array<{ close(): Promise<void> }> = []
const isolatedRoots: string[] = []
let origin = ''
let closeSite: () => Promise<void> = async () => undefined

async function createIsolatedBroker(): Promise<{ broker: BrowserBroker; roots: { profileRoot: string; browserRoot: string; artifactRoot: string } }> {
  const root = await mkdtemp(join(tmpdir(), 'mousse-m01-browser-'))
  isolatedRoots.push(root)
  const roots = { profileRoot: join(root, 'profiles'), browserRoot: join(root, 'browser-root'), artifactRoot: join(root, 'artifacts') }
  mkdirSync(roots.profileRoot, { recursive: true })
  mkdirSync(roots.artifactRoot, { recursive: true })
  const sourceRoot = realpathSync.native(certifiedInstallDir(MANAGED_BROWSER_ROOT))
  const targetRoot = certifiedInstallDir(roots.browserRoot)
  const copyImmutable = (source: string, target: string): void => {
    const stat = lstatSync(source)
    if (stat.isSymbolicLink()) throw new Error(`Certified browser contains an unexpected symlink: ${source}`)
    if (stat.isDirectory()) {
      mkdirSync(target, { recursive: true })
      for (const entry of readdirSync(source)) copyImmutable(join(source, entry), join(target, entry))
      return
    }
    mkdirSync(join(target, '..'), { recursive: true })
    if (process.platform === 'win32') {
      copyFileSync(source, target)
      return
    }
    try {
      linkSync(source, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      copyFileSync(source, target)
    }
  }
  copyImmutable(sourceRoot, targetRoot)
  mkdirSync(targetRoot, { recursive: true })
  writeFileSync(certifiedMetadataPath(roots.browserRoot), readFileSync(certifiedMetadataPath(MANAGED_BROWSER_ROOT)))
  const resolved = resolveCertifiedBrowser(roots.browserRoot)
  if (resolved.status !== 'ready') throw new Error(`Isolated certified browser did not resolve: ${resolved.message}`)
  const broker = new BrowserBroker({ ...roots, policy: createAllowHttpPolicy(), transport: 'in-process' })
  await broker.start()
  return { broker, roots }
}

beforeAll(async () => {
  if (!chrome.ok) return
  const site = await startFixtureSite()
  origin = site.origin
  closeSite = site.close
}, 120_000)
afterEach(async () => {
  while (managers.length) await managers.pop()!.close()
  while (isolatedRoots.length) {
    const root = isolatedRoots.pop()!
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

const policy = (profileId: string, maxToolCalls = 40): ExecutionPolicySnapshot => ({
  id: `policy-${profileId}-${maxToolCalls}`, profileId, version: 1,
  allowedTools: ['browser_open', 'browser_tabs', 'browser_observe', 'browser_find', 'browser_act', 'browser_wait', 'browser_extract', 'browser_request_human'],
  allowedCapabilities: ['browser.session', 'browser.observe', 'browser.action', 'browser.extract', 'browser.task'],
  allowedEffects: ['read', 'write', 'external'], approvalEffects: [],
  maxToolCalls, maxElapsedMs: 60_000, maxArtifactBytes: 10_000_000
})

function context(profileId: string, actor: ExecutionContext['actor'], runId?: string): { execution: ExecutionContext; policy: ExecutionPolicySnapshot; vision?: boolean } {
  const currentPolicy = policy(profileId)
  return {
    execution: { profileId, threadId: 'thread-automation', turnId: `turn-${actor.kind}-${runId ?? 'main'}`, ...(runId ? { runId } : {}), actor, policySnapshotId: currentPolicy.id, source: 'cli', cancellationId: `cancel-${actor.kind}-${runId ?? 'main'}` },
    policy: currentPolicy,
    vision: false
  }
}

function observation(value: unknown): BrowserObservation {
  const result = value as { observation?: BrowserObservation }
  if (!result.observation) throw new Error('missing observation')
  return result.observation
}

describe.skipIf(!chrome.ok)('M01 browser automation against managed Chrome', () => {
  afterAll(async () => { await closeSite() })

  it('runs main, child-agent, and workflow actors through one worker with strict ownership', async () => {
    const brokerBundle = await createIsolatedBroker()
    managers.push(brokerBundle.broker)
    const manager = new BrowserSessionManager({ profileId: PROFILE_ID, profileRoot: brokerBundle.roots.profileRoot, broker: brokerBundle.broker })
    const tools = new BrowserToolDispatcher({ sessions: manager })
    const main = context(PROFILE_ID, { kind: 'main' })
    const child = context(PROFILE_ID, { kind: 'agent', definitionId: 'agent-child', definitionRevision: 'rev-1' }, 'child-run')
    const workflow = context(PROFILE_ID, { kind: 'workflow' }, 'workflow-run')
    const openedMain = await tools.invoke('browser_open', { url: `${origin}/form.html` }, main)
    const openedChild = await tools.invoke('browser_open', { url: `${origin}/form.html` }, child)
    const openedWorkflow = await tools.invoke('browser_open', { url: `${origin}/form.html` }, workflow)
    expect(openedMain.ok && openedChild.ok && openedWorkflow.ok).toBe(true)
    expect(manager.list(main).map((item) => item.runId)).toEqual([undefined])
    expect(manager.list(child).map((item) => item.runId)).toEqual(['child-run'])
    expect(manager.list(workflow).map((item) => item.runId)).toEqual(['workflow-run'])
    const childSession = openedChild.ok ? openedChild.value.session as BrowserSessionRecord : undefined
    expect(childSession?.profileId).toBe(PROFILE_ID)
    const denied = await tools.invoke('browser_observe', { sessionId: childSession!.id, tabId: 'unknown' }, context(OTHER_PROFILE_ID, { kind: 'main' }))
    expect(denied.ok).toBe(false)
    expect(denied.ok ? '' : denied.error.code).toBe('profile_mismatch')
  }, 120_000)

  it('uses semantic refs, stale-generation fencing, and bounded B2 vision gating', async () => {
    const brokerBundle = await createIsolatedBroker()
    managers.push(brokerBundle.broker)
    const manager = new BrowserSessionManager({ profileId: PROFILE_ID, profileRoot: brokerBundle.roots.profileRoot, broker: brokerBundle.broker })
    const tools = new BrowserToolDispatcher({ sessions: manager })
    const owner = context(PROFILE_ID, { kind: 'workflow' }, 'form-run')
    const opened = await tools.invoke('browser_open', { url: `${origin}/form.html` }, owner)
    expect(opened.ok).toBe(true)
    const initial = observation(opened.ok ? opened.value : {})
    const found = await tools.invoke('browser_find', { sessionId: initial.sessionId, tabId: initial.tabId, query: 'Name' }, owner)
    expect(found.ok && found.value.matches?.length).toBeGreaterThan(0)
    expect(found.ok && found.value.observationId).toBeTruthy()
    const name = (found.ok ? found.value.matches?.find((element) => (element as { role?: string }).role === 'textbox') : undefined) as { ref: string }
    const filled = await tools.invoke('browser_act', {
      sessionId: initial.sessionId, tabId: initial.tabId, generation: initial.generation, observationId: found.ok ? found.value.observationId : initial.observationId,
      controlLeaseId: (opened.ok ? opened.value.session as BrowserSessionRecord : undefined)?.controlLeaseId,
      action: { type: 'fill', target: { kind: 'ref', ref: name.ref }, text: 'Ada' }, expected: { type: 'text', text: 'Ada', present: true }
    }, owner)
    expect(filled.ok, JSON.stringify(filled)).toBe(true)
    const visionDenied = await tools.invoke('browser_act', {
      sessionId: initial.sessionId, tabId: initial.tabId, generation: initial.generation, observationId: initial.observationId,
      controlLeaseId: (opened.ok ? opened.value.session as BrowserSessionRecord : undefined)?.controlLeaseId,
      action: { type: 'click', target: { kind: 'image-point', point: { x: 10, y: 10 } } }
    }, owner)
    expect(visionDenied.ok).toBe(false)
    expect(visionDenied.ok ? '' : visionDenied.error.code).toBe('unsupported')
    const navigated = await tools.invoke('browser_act', {
      sessionId: initial.sessionId, tabId: initial.tabId, generation: initial.generation, observationId: initial.observationId,
      controlLeaseId: (opened.ok ? opened.value.session as BrowserSessionRecord : undefined)?.controlLeaseId,
      action: { type: 'navigate', url: `${origin}/nav-b.html` }
    }, owner)
    expect(navigated.ok).toBe(true)
    const stale = await tools.invoke('browser_act', {
      sessionId: initial.sessionId, tabId: initial.tabId, generation: initial.generation, observationId: initial.observationId,
      controlLeaseId: (opened.ok ? opened.value.session as BrowserSessionRecord : undefined)?.controlLeaseId,
      action: { type: 'fill', target: { kind: 'ref', ref: name.ref }, text: 'stale' }
    }, owner)
    expect(stale.ok).toBe(false)
    expect(['stale_observation', 'stale_ref']).toContain(stale.ok ? '' : stale.error.code)

    await manager.control(owner, initial.sessionId, 'human')
    await manager.control(owner, initial.sessionId, 'agent')
    const fencedAfterResume = await tools.invoke('browser_act', {
      sessionId: initial.sessionId, tabId: initial.tabId, generation: initial.generation, observationId: initial.observationId,
      controlLeaseId: (opened.ok ? opened.value.session as BrowserSessionRecord : undefined)?.controlLeaseId,
      action: { type: 'fill', target: { kind: 'ref', ref: name.ref }, text: 'must-not-dispatch' }
    }, owner)
    expect(fencedAfterResume.ok).toBe(false)
    expect(fencedAfterResume.ok ? '' : fencedAfterResume.error.code).toBe('stale_generation')
    const refreshed = await tools.invoke('browser_observe', { sessionId: initial.sessionId, tabId: initial.tabId }, owner)
    expect(refreshed.ok).toBe(true)
    const refreshedSession = refreshed.ok ? refreshed.value.session as BrowserSessionRecord : undefined
    expect(refreshedSession).toMatchObject({ id: initial.sessionId, profileId: PROFILE_ID, threadId: owner.execution.threadId })
    expect(refreshedSession?.generation).toBeGreaterThan(initial.generation)
    expect(refreshedSession?.controlLeaseId).toBe(manager.list(owner)[0].controlLeaseId)
  }, 120_000)

  it('propagates cancellation and enforces the immutable tool-call budget', async () => {
    const brokerBundle = await createIsolatedBroker()
    managers.push(brokerBundle.broker)
    const manager = new BrowserSessionManager({ profileId: PROFILE_ID, profileRoot: brokerBundle.roots.profileRoot, broker: brokerBundle.broker })
    const tools = new BrowserToolDispatcher({ sessions: manager })
    const owner = context(PROFILE_ID, { kind: 'workflow' }, 'wait-run')
    const opened = await tools.invoke('browser_open', { url: `${origin}/form.html` }, owner)
    expect(opened.ok).toBe(true)
    const session = opened.ok ? opened.value.session as BrowserSessionRecord : undefined
    const controller = new AbortController()
    const waitObservation = observation(opened.ok ? opened.value : {})
    const pending = tools.invoke('browser_wait', { sessionId: session!.id, tabId: waitObservation.tabId, condition: { type: 'text', text: 'never-present', present: true }, timeoutMs: 20_000 }, { ...owner, signal: controller.signal })
    setTimeout(() => controller.abort('test cancellation'), 100)
    const cancelled = await pending
    expect(cancelled.ok).toBe(false)
    expect(cancelled.ok ? '' : cancelled.error.code).toBe('cancelled')

    const limitedPolicy = policy(PROFILE_ID, 1)
    const limited = { ...owner, execution: { ...owner.execution, turnId: 'limited-turn', policySnapshotId: limitedPolicy.id }, policy: limitedPolicy }
    const second = await tools.invoke('browser_open', { url: `${origin}/form.html` }, limited)
    expect(second.ok).toBe(true)
    const overBudget = await tools.invoke('browser_observe', { sessionId: (second.ok ? second.value.session as BrowserSessionRecord : undefined)!.id }, limited)
    expect(overBudget.ok).toBe(false)
    expect(overBudget.ok ? '' : overBudget.error.code).toBe('policy_denied')
  }, 120_000)
})

describe('M01 browser automation authorization boundary', () => {
  it('charges one handoff authorization and never replays a persisted disconnected handoff', async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), 'mousse-m01-handoff-'))
    isolatedRoots.push(profileRoot)
    mkdirSync(join(profileRoot, 'browser'))
    let calls = 0
    const now = new Date().toISOString()
    const broker = { call: async (request: { id: string; method: string; profileId: string; params: Record<string, unknown> }) => {
      calls += 1
      return { version: 1 as const, id: request.id, ok: true as const, result: request.method === 'session.open'
        ? { session: { id: 'session-handoff', profileId: request.profileId, threadId: request.params.threadId,
          persistent: false, backend: 'managed-chromium', browserVersion: 'fixture', generation: 1,
          lifecycle: 'agent-controlled', controlLeaseId: 'lease-agent', createdAt: now, updatedAt: now } }
        : { controlLeaseId: 'lease-human', generation: 2, lifecycle: 'human-controlled' } }
    } }
    const manager = new BrowserSessionManager({ profileId: PROFILE_ID, profileRoot, broker: broker as never })
    const owner = context(PROFILE_ID, { kind: 'main' })
    const opened = await manager.open(owner, {})
    const oneCallPolicy = policy(PROFILE_ID, 1)
    const handoffContext = { ...owner, policy: oneCallPolicy,
      execution: { ...owner.execution, turnId: 'handoff-turn', policySnapshotId: oneCallPolicy.id } }
    await expect(manager.requestHuman(handoffContext, { sessionId: opened.session!.id, reason: 'Please verify.' }))
      .resolves.toMatchObject({ state: 'waiting-human' })
    expect(calls).toBe(2)

    const recovered = new BrowserSessionManager({ profileId: PROFILE_ID, profileRoot, broker: broker as never })
    const beforeReplay = calls
    await expect(recovered.requestHuman({ ...handoffContext,
      execution: { ...handoffContext.execution, turnId: 'recovery-turn' } },
    { sessionId: opened.session!.id, reason: 'Please verify.' })).rejects.toMatchObject({ code: 'unknown_effect' })
    expect(calls).toBe(beforeReplay)
  })

  it('does not let an older same-generation observation overwrite the viewer cache', async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), 'mousse-m01-observation-'))
    isolatedRoots.push(profileRoot)
    mkdirSync(join(profileRoot, 'browser'))
    const now = new Date().toISOString()
    const makeObservation = (capturedAt: string, title: string): BrowserObservation => ({
      sessionId: 'session-observation', tabId: 'tab-1', generation: 1, observationId: `obs-${title}`,
      documentId: 'document-1', capturedAt, url: 'http://127.0.0.1/', title,
      viewport: { cssWidth: 800, cssHeight: 600, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 },
      tabs: [{ id: 'tab-1', title, url: 'http://127.0.0.1/' }], elements: [], truncated: false,
      warnings: [], provenance: 'untrusted-page'
    })
    const newer = makeObservation('2026-09-11T12:00:02.000Z', 'newer')
    const older = makeObservation('2026-09-11T12:00:01.000Z', 'older')
    const broker = { call: async (request: { id: string; method: string; profileId: string; params: Record<string, unknown> }) => ({
      version: 1 as const, id: request.id, ok: true as const,
      result: request.method === 'session.open' ? { session: { id: newer.sessionId, profileId: request.profileId,
        threadId: request.params.threadId, persistent: false, backend: 'managed-chromium', browserVersion: 'fixture',
        generation: 1, lifecycle: 'ready', createdAt: now, updatedAt: now }, observation: newer } : older
    }) }
    const manager = new BrowserSessionManager({ profileId: PROFILE_ID, profileRoot, broker: broker as never })
    const owner = context(PROFILE_ID, { kind: 'main' })
    const opened = await manager.open(owner, {})
    await manager.observe(owner, { sessionId: opened.session!.id })
    expect(manager.latestObservation(owner, opened.session!.id)?.title).toBe('newer')
  })

  it('fails closed on a malformed persisted session inventory', async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), 'mousse-m01-corrupt-'))
    isolatedRoots.push(profileRoot)
    mkdirSync(join(profileRoot, 'browser'))
    writeFileSync(join(profileRoot, 'browser', 'automation-sessions.json'), '{"unexpected":true}')
    expect(() => new BrowserSessionManager({ profileId: PROFILE_ID, profileRoot, broker: { call: async () => { throw new Error('must not dispatch') } } })).toThrow(/inventory is corrupt/)
  })

  it('enforces exact tool grants before dispatch and rejects mismatched worker ownership', async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), 'mousse-m01-policy-'))
    isolatedRoots.push(profileRoot)
    let calls = 0
    let failClose = false
    const broker = {
      call: async (request: { id: string; method: string; profileId: string; params: Record<string, unknown> }) => {
        calls += 1
        if (request.method === 'session.close' && failClose) throw Object.assign(new Error('fixture disconnect'), { code: 'worker_disconnected' })
        const runId = typeof request.params.runId === 'string' ? request.params.runId : undefined
        return {
          version: 1 as const,
          id: request.id,
          ok: true as const,
          result: {
            session: {
              id: `session-${calls}`, profileId: request.profileId, threadId: request.params.threadId,
              ...(runId ? { runId: `${runId}-wrong` } : {}), persistent: false, backend: 'managed-chromium',
              browserVersion: 'fixture', generation: 1, lifecycle: 'ready', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
            }
          }
        }
      }
    }
    const manager = new BrowserSessionManager({ profileId: PROFILE_ID, profileRoot, broker })
    const tools = new BrowserToolDispatcher({ sessions: manager })
    const owner = context(PROFILE_ID, { kind: 'workflow' }, 'policy-run')
    const deniedPolicy = { ...owner.policy, id: 'policy-denied', allowedTools: ['browser_observe'] }
    const deniedContext = { ...owner, policy: deniedPolicy, execution: { ...owner.execution, policySnapshotId: deniedPolicy.id } }
    const denied = await tools.invoke('browser_open', {}, deniedContext)
    expect(denied).toMatchObject({ ok: false, error: { code: 'policy_denied' } })
    expect(calls).toBe(0)

    const mismatched = await tools.invoke('browser_open', {}, owner)
    expect(mismatched).toMatchObject({ ok: false, error: { code: 'invalid_action' } })
    expect(calls).toBe(1)

    const main = context(PROFILE_ID, { kind: 'main' })
    const opened = await tools.invoke('browser_open', {}, main)
    expect(opened.ok).toBe(true)
    if (opened.ok) opened.value.session!.threadId = 'mutated-by-caller'
    expect(manager.list(main)).toMatchObject([{ threadId: 'thread-automation', lifecycle: 'ready' }])
    let handoffs = 0
    const humanTools = new BrowserToolDispatcher({ sessions: manager, requestHuman: async () => { handoffs += 1; return { requestId: 'request-1', state: 'waiting-human' } } })
    const sessionId = opened.ok ? opened.value.session!.id : ''
    const handoffPolicy = { ...main.policy, id: 'policy-handoff', allowedTools: ['browser_open'] }
    const handoffDenied = await humanTools.invoke('browser_request_human', { sessionId, reason: 'Take over' }, { ...main, policy: handoffPolicy, execution: { ...main.execution, policySnapshotId: handoffPolicy.id } })
    expect(handoffDenied).toMatchObject({ ok: false, error: { code: 'policy_denied' } })
    expect(handoffs).toBe(0)
    const approvalPolicy = { ...main.policy, id: 'policy-approval', approvalEffects: ['external' as const] }
    const approvalDenied = await humanTools.invoke('browser_request_human', { sessionId, reason: 'Take over' }, { ...main, policy: approvalPolicy, execution: { ...main.execution, policySnapshotId: approvalPolicy.id } })
    expect(approvalDenied).toMatchObject({ ok: false, error: { code: 'approval_required' } })
    expect(handoffs).toBe(0)
    failClose = true
    await manager.closeAll()
    expect(manager.list(main)).toMatchObject([{ lifecycle: 'disconnected' }])
  })
})
