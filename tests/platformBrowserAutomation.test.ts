import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
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
  const sourceRoot = certifiedInstallDir(MANAGED_BROWSER_ROOT)
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
    linkSync(source, target)
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
    try { rmSync(root, { recursive: true, force: true }) } catch { /* Windows may retain the hard-linked executable briefly; it consumes no new space. */ }
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
    const manager = new BrowserSessionManager({ profileId: 'profile-automation', profileRoot: brokerBundle.roots.profileRoot, broker: brokerBundle.broker })
    const tools = new BrowserToolDispatcher({ sessions: manager })
    const main = context('profile-automation', { kind: 'main' })
    const child = context('profile-automation', { kind: 'agent', definitionId: 'agent-child', definitionRevision: 'rev-1' }, 'child-run')
    const workflow = context('profile-automation', { kind: 'workflow' }, 'workflow-run')
    const openedMain = await tools.invoke('browser_open', { url: `${origin}/form.html` }, main)
    const openedChild = await tools.invoke('browser_open', { url: `${origin}/form.html` }, child)
    const openedWorkflow = await tools.invoke('browser_open', { url: `${origin}/form.html` }, workflow)
    expect(openedMain.ok && openedChild.ok && openedWorkflow.ok).toBe(true)
    expect(manager.list(main).map((item) => item.runId)).toEqual([undefined])
    expect(manager.list(child).map((item) => item.runId)).toEqual(['child-run'])
    expect(manager.list(workflow).map((item) => item.runId)).toEqual(['workflow-run'])
    const childSession = openedChild.ok ? openedChild.value.session as BrowserSessionRecord : undefined
    expect(childSession?.profileId).toBe('profile-automation')
    const denied = await tools.invoke('browser_observe', { sessionId: childSession!.id, tabId: 'unknown' }, context('different-profile', { kind: 'main' }))
    expect(denied.ok).toBe(false)
    expect(denied.ok ? '' : denied.error.code).toBe('profile_mismatch')
  }, 120_000)

  it('uses semantic refs, stale-generation fencing, and bounded B2 vision gating', async () => {
    const brokerBundle = await createIsolatedBroker()
    managers.push(brokerBundle.broker)
    const manager = new BrowserSessionManager({ profileId: 'profile-automation', profileRoot: brokerBundle.roots.profileRoot, broker: brokerBundle.broker })
    const tools = new BrowserToolDispatcher({ sessions: manager })
    const owner = context('profile-automation', { kind: 'workflow' }, 'form-run')
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
  }, 120_000)

  it('propagates cancellation and enforces the immutable tool-call budget', async () => {
    const brokerBundle = await createIsolatedBroker()
    managers.push(brokerBundle.broker)
    const manager = new BrowserSessionManager({ profileId: 'profile-automation', profileRoot: brokerBundle.roots.profileRoot, broker: brokerBundle.broker })
    const tools = new BrowserToolDispatcher({ sessions: manager })
    const owner = context('profile-automation', { kind: 'workflow' }, 'wait-run')
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

    const limitedPolicy = policy('profile-automation', 1)
    const limited = { ...owner, execution: { ...owner.execution, turnId: 'limited-turn', policySnapshotId: limitedPolicy.id }, policy: limitedPolicy }
    const second = await tools.invoke('browser_open', { url: `${origin}/form.html` }, limited)
    expect(second.ok).toBe(true)
    const overBudget = await tools.invoke('browser_observe', { sessionId: (second.ok ? second.value.session as BrowserSessionRecord : undefined)!.id }, limited)
    expect(overBudget.ok).toBe(false)
    expect(overBudget.ok ? '' : overBudget.error.code).toBe('policy_denied')
  }, 120_000)
})
