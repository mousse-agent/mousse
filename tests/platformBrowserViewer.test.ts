import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ExecutionContext, ExecutionPolicySnapshot } from '../src/shared/execution/types'
import type { BrowserObservation, BrowserSessionRecord } from '../src/shared/browser/types'
import { viewerPointToCss } from '../src/shared/browser/viewer'
import { BrowserViewerService } from '../src/mms/browser/viewer'
import { BrowserSessionManager } from '../src/mms/browser/automation/BrowserSessionManager'
import { createInProcessBroker, ensureManagedChrome, startFixtureSite } from './fixtures/browser/harness'

const chrome = await ensureManagedChrome()
let closeSite: () => Promise<void> = async () => undefined
const brokers: Array<{ close(): Promise<void> }> = []
const roots: string[] = []
let origin = ''
const PROFILE_A = '11111111-1111-4111-8111-111111111111'
const PROFILE_B = '22222222-2222-4222-8222-222222222222'

const policy = (profileId: string): ExecutionPolicySnapshot => ({
  id: `viewer-${profileId}`, profileId, version: 1,
  allowedTools: ['browser_open', 'browser_tabs', 'browser_observe', 'browser_find', 'browser_act', 'browser_wait', 'browser_extract', 'browser_request_human'],
  allowedCapabilities: ['browser.session', 'browser.observe', 'browser.action', 'browser.extract', 'browser.task'],
  allowedEffects: ['read', 'write', 'external'], approvalEffects: [], maxToolCalls: 40, maxElapsedMs: 60_000, maxArtifactBytes: 10_000_000
})

function context(profileId: string, runId?: string) {
  const current = policy(profileId)
  return {
    execution: { profileId, threadId: 'viewer-thread', turnId: `viewer-turn-${runId ?? 'main'}`, ...(runId ? { runId } : {}), actor: { kind: 'workflow' } as ExecutionContext['actor'], policySnapshotId: current.id, source: 'gui' as const, cancellationId: `viewer-cancel-${runId ?? 'main'}` },
    policy: current,
    target: { backend: 'managed-chromium' as const },
    vision: true
  }
}

beforeAll(async () => {
  if (!chrome.ok) return
  const site = await startFixtureSite()
  origin = site.origin
  closeSite = site.close
})
afterAll(async () => { await closeSite() })
afterEach(async () => { while (brokers.length) await brokers.pop()!.close(); while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }) })

describe.skipIf(!chrome.ok)('managed browser viewer takeover', () => {
  it('takes over a real worker session during a pending navigation, fences stale ownership, and reobserves on resume', async () => {
    const bundle = await createInProcessBroker()
    brokers.push(bundle.broker)
    const profileRoot = await mkdtemp(join(tmpdir(), 'mousse-viewer-profile-'))
    roots.push(profileRoot)
    const manager = new BrowserSessionManager({ profileId: PROFILE_A, profileRoot, broker: bundle.broker })
    const owner = context(PROFILE_A, 'viewer-run')
    const opened = await manager.open(owner, { url: `${origin}/form.html` })
    const session = opened.session as BrowserSessionRecord
    const initial = opened.observation as BrowserObservation
    const viewer = new BrowserViewerService({
      sessions: manager,
      context: owner,
      now: () => '2026-01-01T00:00:00.000Z',
      artifactResolver: async (artifactId, context) => ({
        id: artifactId, profileId: context.execution.profileId, runId: context.execution.runId,
        mediaType: 'image/png', byteLength: 128, sha256: 'fixture-sha256', displayName: 'managed-observation.png', createdAt: '2026-01-01T00:00:00.000Z'
      })
    })
    const before = await viewer.snapshot()
    expect(before.session?.id).toBe(session.id)
    const pending = manager.act(owner, {
      sessionId: session.id,
      tabId: initial.tabId,
      generation: initial.generation,
      observationId: initial.observationId,
      controlLeaseId: session.controlLeaseId!,
      action: { type: 'navigate', url: `${origin}/viewer-slow.html` },
      timeoutMs: 20_000
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    const takeover = await viewer.takeControl({ sessionId: session.id })
    expect(takeover.controlOwner).toBe('human')
    await expect(pending).resolves.toMatchObject({ action: { outcome: 'unknown-effect', dispatched: true } })
    await expect(manager.act(owner, {
      sessionId: session.id,
      tabId: initial.tabId,
      generation: initial.generation,
      observationId: initial.observationId,
      controlLeaseId: session.controlLeaseId!,
      action: { type: 'reload' }
    })).rejects.toMatchObject({ code: 'human_controlled' })
    const humanObservation = await viewer.observe({ sessionId: session.id })
    expect(humanObservation.controlOwner).toBe('human')
    const humanNavigation = await viewer.humanAction({
      sessionId: session.id,
      tabId: humanObservation.observation!.tabId,
      generation: humanObservation.observation!.generation,
      observationId: humanObservation.observation!.observationId,
      action: { type: 'navigate', url: `${origin}/form.html` }
    })
    const save = humanNavigation.observation!.elements.find((element) => element.name?.toLowerCase().includes('save') || element.text?.toLowerCase().includes('save'))
    expect(save).toBeTruthy()
    const humanClick = await viewer.humanAction({
      sessionId: session.id,
      tabId: humanNavigation.observation!.tabId,
      generation: humanNavigation.observation!.generation,
      observationId: humanNavigation.observation!.observationId,
      action: { type: 'click', target: { kind: 'ref', ref: save!.ref } }
    })
    expect(humanClick.history.some((entry) => entry.kind === 'action')).toBe(true)
    const humanKey = await viewer.humanAction({
      sessionId: session.id,
      tabId: humanClick.observation!.tabId,
      generation: humanClick.observation!.generation,
      observationId: humanClick.observation!.observationId,
      action: { type: 'key', key: 'Tab' }
    })
    expect(humanKey.history.filter((entry) => entry.kind === 'action').length).toBeGreaterThanOrEqual(2)
    const resumed = await viewer.resumeAgent({ sessionId: session.id })
    expect(resumed.controlOwner).toBe('agent')
    expect(resumed.observation?.observationId).not.toBe(initial.observationId)
    expect(resumed.run?.runId).toBe('viewer-run')
    expect(resumed.observation?.screenshot).toBeUndefined()
    const resumedWithScreenshot = await viewer.observe({ sessionId: session.id })
    expect(resumedWithScreenshot.observation?.screenshot?.artifactId).toBeTruthy()
    expect(resumedWithScreenshot.artifacts).toHaveLength(1)
    await expect(viewer.humanAction({
      sessionId: session.id, tabId: resumed.observation!.tabId, generation: resumed.observation!.generation,
      observationId: resumed.observation!.observationId, action: { type: 'key', key: 'Tab' }
    })).rejects.toMatchObject({ code: 'human_controlled' })
    expect((await viewer.snapshot({ sessionId: session.id })).connection).toBe('connected')
    const invalidArtifactViewer = new BrowserViewerService({
      sessions: manager, context: owner,
      artifactResolver: (artifactId) => ({
        id: artifactId, profileId: PROFILE_B, runId: 'viewer-run', mediaType: 'image/png', byteLength: 1,
        sha256: 'invalid-cross-profile-artifact', displayName: 'outside.png', createdAt: '2026-01-01T00:00:00.000Z'
      })
    })
    await expect(invalidArtifactViewer.observe({ sessionId: session.id })).rejects.toMatchObject({ code: 'profile_mismatch' })
    expect(viewerPointToCss(
      { x: 240, y: 160 },
      { artifactId: 'fixture-image', pixelWidth: 480, pixelHeight: 320, cssToImageScaleX: 2, cssToImageScaleY: 2 },
      { cssWidth: 240, cssHeight: 160, deviceScaleFactor: 2, scrollX: 0, scrollY: 0 }
    )).toEqual({ x: 120, y: 80 })
    expect((await viewer.history({ sessionId: session.id })).map((entry) => entry.kind)).toEqual(expect.arrayContaining(['control', 'observed']))
  }, 120_000)

  it('keeps two profile viewers partitioned and exposes human facing takeover controls in the renderer', async () => {
    const bundle = await createInProcessBroker()
    brokers.push(bundle.broker)
    const profileARoot = await mkdtemp(join(tmpdir(), 'mousse-viewer-a-'))
    const profileBRoot = await mkdtemp(join(tmpdir(), 'mousse-viewer-b-'))
    const managerA = new BrowserSessionManager({ profileId: PROFILE_A, profileRoot: profileARoot, broker: bundle.broker })
    const managerB = new BrowserSessionManager({ profileId: PROFILE_B, profileRoot: profileBRoot, broker: bundle.broker })
    const ownerA = context(PROFILE_A, 'run-a')
    const opened = await managerA.open(ownerA, { url: `${origin}/form.html` })
    const session = opened.session as BrowserSessionRecord
    const viewerA = new BrowserViewerService({ sessions: managerA, context: ownerA })
    const viewerB = new BrowserViewerService({ sessions: managerB, context: context(PROFILE_B, 'run-b') })
    expect((await viewerA.snapshot()).session?.profileId).toBe(PROFILE_A)
    expect((await viewerB.snapshot()).session).toBeUndefined()
    const source = readFileSync(resolve('src/renderer/components/browserAutomation/BrowserAutomationViewer.tsx'), 'utf8')
    expect(source).toContain('Take control')
    expect(source).toContain('Resume agent')
    expect(source).toContain('Close')
    await viewerA.close({ sessionId: session.id })
  }, 120_000)
})

if (!chrome.ok) describe('managed browser viewer blocker', () => {
  it('reports the real browser fixture blocker', () => expect(chrome.ok).toBe(false))
})
