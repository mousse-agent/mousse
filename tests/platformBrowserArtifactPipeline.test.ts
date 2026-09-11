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

it('imports a real managed-browser screenshot into session-authorized viewer artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mousse-browser-artifact-pipeline-'))
  const profileId = '44444444-4444-4444-8444-444444444444'
  const artifactRoot = join(root, 'browser', 'worker-artifacts')
  const artifacts = new BrowserArtifactService({ profileId, profileRoot: root, workerArtifactRoot: artifactRoot })
  // Uses the already-certified local fixture binary. This test never downloads one.
  const broker = new BrowserBroker({ profileRoot: root, artifactRoot, browserRoot: MANAGED_BROWSER_ROOT, policy: createAllowHttpPolicy(), transport: 'in-process' })
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
