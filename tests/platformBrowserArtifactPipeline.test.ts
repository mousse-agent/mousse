import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserBroker } from '../src/mms/browser/BrowserBroker'
import { BrowserBackendRouter } from '../src/mms/browser/BrowserBackendRouter'
import { BrowserArtifactService } from '../src/mms/browser/BrowserArtifactService'
import { BrowserSessionManager } from '../src/mms/browser/automation/BrowserSessionManager'
import { BrowserViewerService } from '../src/mms/browser/viewer/BrowserViewerService'
import { createAllowHttpPolicy } from '../src/mms/browser/defaultPorts'
import { BROWSER_AUTOMATION_TOOLS, type BrowserToolContext } from '../src/shared/browser/automation'
import { MANAGED_BROWSER_ROOT, startFixtureSite } from './fixtures/browser/harness'
import { resolveCertifiedBrowser } from '../src/browser-worker/binary/resolver'
import type { BrowserObservation, BrowserSessionRecord, BrowserWorkerRequest, BrowserWorkerResponse } from '../src/shared/browser/types'

const browserRoot = process.env.MOUSSE_TEST_BROWSER_ROOT || MANAGED_BROWSER_ROOT
const chromeReady = resolveCertifiedBrowser(browserRoot).status === 'ready'
const screenshot = { artifactId: 'art_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pixelWidth: 100, pixelHeight: 100, cssToImageScaleX: 1, cssToImageScaleY: 1 }

it.skipIf(!chromeReady)('imports a real managed-browser screenshot into session-authorized viewer artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mousse-browser-artifact-pipeline-'))
  const profileId = '44444444-4444-4444-8444-444444444444'
  const artifactRoot = join(root, 'browser', 'worker-artifacts')
  const artifacts = new BrowserArtifactService({ profileId, profileRoot: root, workerArtifactRoot: artifactRoot })
  // Uses the already-certified local fixture binary. This test never downloads one.
  const broker = new BrowserBroker({ profileRoot: root, artifactRoot, browserRoot, policy: createAllowHttpPolicy(), transport: 'in-process' })
  const router = new BrowserBackendRouter({ profileId, managed: broker })
  const sessions = new BrowserSessionManager({ profileId, profileRoot: root, broker: router,
    decorateObservation: (context, observation) => artifacts.decorateObservation(context, observation) })
  const site = await startFixtureSite()
  const context: BrowserToolContext = { execution: { profileId, threadId: 'artifact_thread', runId: 'artifact_run', turnId: 'turn_1', actor: { kind: 'workflow' },
    policySnapshotId: 'policy_1', cancellationId: 'cancel_1', source: 'gui' }, target: { backend: 'managed-chromium' }, vision: true,
    policy: { id: 'policy_1', profileId, version: 1, allowedTools: BROWSER_AUTOMATION_TOOLS, allowedCapabilities: ['browser.session', 'browser.observe', 'browser.action'],
      allowedEffects: ['read', 'write', 'external'], approvalEffects: [], maxToolCalls: 30, maxElapsedMs: 60000, maxArtifactBytes: 10 * 1024 * 1024 } }
  try {
    const opened = await sessions.open(context, { url: site.origin + '/form.html' })
    const sessionId = opened.session!.id
    const viewer = new BrowserViewerService({ sessions, context,
      artifactResolver: (id, owner, selectedSessionId) => artifacts.describe({ profileId: owner.execution.profileId, threadId: owner.execution.threadId, runId: owner.execution.runId, sessionId: selectedSessionId }, id) })
    const snapshot = await viewer.observe({ sessionId })
    expect(snapshot.artifacts).toHaveLength(1)
    expect(snapshot.observation!.screenshot!.artifactId).toBe(snapshot.artifacts[0].id)
    expect(snapshot.artifacts[0].id).not.toMatch(/^art_/)
    const scope = { profileId, threadId: context.execution.threadId, runId: context.execution.runId, sessionId }
    const file = await artifacts.read(scope, snapshot.artifacts[0].id, context.policy.maxArtifactBytes)
    const bytes = Buffer.from(file.bytes)
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(bytes.readUInt32BE(16)).toBe(snapshot.observation!.screenshot!.pixelWidth)
    expect(bytes.readUInt32BE(20)).toBe(snapshot.observation!.screenshot!.pixelHeight)
    await expect(artifacts.read({ ...scope, sessionId: 'another_session' }, file.ref.id, context.policy.maxArtifactBytes)).rejects.toThrow()
    const constrained = await sessions.observe({ ...context, policy: { ...context.policy, maxArtifactBytes: 1 } }, { sessionId, includeScreenshot: true })
    expect(constrained.observation!.screenshot).toBeUndefined()
    expect(constrained.observation!.elements.length).toBeGreaterThan(0)
    expect(constrained.observation!.warnings).toContain('Screenshot unavailable: artifact access or byte budget check failed.')
  } finally {
    await sessions.closeAll()
    await router.shutdown()
    await broker.close()
    await artifacts.dispose()
    await site.close()
    await rm(root, { recursive: true, force: true })
  }
}, 60000)

it('preserves a verified action outcome when only screenshot publication fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mousse-browser-artifact-outcome-'))
  const profileId = '55555555-5555-4555-8555-555555555555'
  const session: BrowserSessionRecord = { id: 'session_outcome', profileId, threadId: 'artifact_thread', runId: 'artifact_run', persistent: false,
    backend: 'managed-chromium', browserVersion: 'fixture', generation: 1, lifecycle: 'agent-controlled', controlLeaseId: 'lease_1',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
  const observation: BrowserObservation = { sessionId: session.id, tabId: 'tab_1', generation: 1, observationId: 'obs_1', documentId: 'doc_1',
    capturedAt: '2026-01-01T00:00:00.000Z', url: 'https://example.test', title: 'Fixture', viewport: { cssWidth: 100, cssHeight: 100, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 },
    tabs: [{ id: 'tab_1', title: 'Fixture', url: 'https://example.test' }], elements: [], screenshot, truncated: false, warnings: [], provenance: 'untrusted-page' }
  const broker = { call: async (request: BrowserWorkerRequest): Promise<BrowserWorkerResponse> => request.method === 'session.open'
    ? { version: 1, id: request.id, ok: true, result: { session, observation } }
    : { version: 1, id: request.id, ok: true, result: { requestId: 'action_1', outcome: 'verified', dispatched: true, artifactIds: [], observation } } }
  const sessions = new BrowserSessionManager({ profileId, profileRoot: root, broker: broker as never,
    decorateObservation: async () => { throw new Error('fixture image publication failure') } })
  const context: BrowserToolContext = { execution: { profileId, threadId: 'artifact_thread', runId: 'artifact_run', turnId: 'turn_1', actor: { kind: 'workflow' },
    policySnapshotId: 'policy_1', cancellationId: 'cancel_1', source: 'gui' }, target: { backend: 'managed-chromium' }, vision: true,
    policy: { id: 'policy_1', profileId, version: 1, allowedTools: BROWSER_AUTOMATION_TOOLS, allowedCapabilities: ['browser.session', 'browser.observe', 'browser.action'],
      allowedEffects: ['read', 'write', 'external'], approvalEffects: [], maxToolCalls: 30, maxElapsedMs: 60000, maxArtifactBytes: 1024 } }
  try {
    const opened = await sessions.open(context, {})
    expect(opened.observation?.screenshot).toBeUndefined()
    const acted = await sessions.act(context, { sessionId: session.id, tabId: 'tab_1', generation: 1, observationId: 'obs_1', controlLeaseId: 'lease_1', action: { type: 'reload' } })
    expect(acted.action).toMatchObject({ outcome: 'verified', dispatched: true })
    expect(acted.action?.observation?.screenshot).toBeUndefined()
    expect(acted.action?.observation?.warnings).toContain('Screenshot unavailable: artifact access or byte budget check failed.')
  } finally { await rm(root, { recursive: true, force: true }) }
})
