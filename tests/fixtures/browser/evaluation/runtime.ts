import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserBroker } from '../../../../src/mms/browser/BrowserBroker'
import { createAllowHttpPolicy, createFilesystemArtifactPort } from '../../../../src/mms/browser/defaultPorts'
import { createBrowserAutomation } from '../../../../src/mms/browser/automation'
import type { BrowserToolContext } from '../../../../src/shared/browser/automation'
import type { ExecutionContext, ExecutionPolicySnapshot } from '../../../../src/shared/execution/types'
import type { BrowserResolvedArtifact } from '../../../../src/shared/browser/types'
import { assertNotCoreCache, isolateCertifiedBrowser, type ChromeSource } from './chrome'
import { DEFAULT_BUDGETS } from './pin'
import type { ObservationMode } from './types'

const HOST_RESOLVER = '--host-resolver-rules=MAP foo.test 127.0.0.1'

export interface EvaluationRuntime {
  profileId: string
  chrome: ChromeSource & { ok: true }
  home: string
  tools: ReturnType<typeof createBrowserAutomation>['tools']
  sessions: ReturnType<typeof createBrowserAutomation>['sessions']
  broker: BrowserBroker
  context: (vision: boolean, runId: string) => BrowserToolContext
  stageUpload: (bytes: string, displayName: string) => Promise<{ artifactId: string; grant: BrowserResolvedArtifact }>
  close: () => Promise<void>
}

function policy(profileId: string): ExecutionPolicySnapshot {
  return {
    id: `eval-policy-${profileId}`,
    profileId,
    version: 1,
    allowedTools: ['browser_open', 'browser_tabs', 'browser_observe', 'browser_find', 'browser_act', 'browser_wait', 'browser_extract', 'browser_request_human'],
    allowedCapabilities: ['browser.session', 'browser.observe', 'browser.action', 'browser.extract', 'browser.task'],
    allowedEffects: ['read', 'write', 'external'],
    approvalEffects: [],
    maxToolCalls: DEFAULT_BUDGETS.maxToolCalls,
    maxElapsedMs: DEFAULT_BUDGETS.maxElapsedMs,
    maxArtifactBytes: 10_000_000
  }
}

export function visionFor(mode: ObservationMode): boolean {
  return mode !== 'structured'
}

export async function createEvaluationRuntime(): Promise<EvaluationRuntime> {
  const isolated = await isolateCertifiedBrowser()
  if (!isolated.source.ok) throw new Error(isolated.source.message)
  assertNotCoreCache(isolated.home)
  assertNotCoreCache(isolated.browserRoot)
  const profileId = randomUUID()
  const grants = new Map<string, BrowserResolvedArtifact>()
  const filesystem = createFilesystemArtifactPort(isolated.artifactRoot)
  const artifacts = {
    write: filesystem.write.bind(filesystem),
    resolveReadOnly: async ({ artifactIds }: { artifactIds: string[] }) => {
      return artifactIds.map((artifactId) => {
        const grant = grants.get(artifactId)
        if (!grant) throw new Error(`Missing upload grant ${artifactId}`)
        return grant
      })
    }
  }
  const broker = new BrowserBroker({
    profileRoot: isolated.profileRoot,
    browserRoot: isolated.browserRoot,
    artifactRoot: isolated.artifactRoot,
    policy: createAllowHttpPolicy(),
    artifacts,
    transport: 'in-process',
    chromeExtraArgs: [HOST_RESOLVER]
  })
  await broker.start()
  const automation = createBrowserAutomation({
    profileId,
    profileRoot: isolated.profileRoot,
    broker
  })
  const snapshot = policy(profileId)
  return {
    profileId,
    chrome: isolated.source,
    home: isolated.home,
    tools: automation.tools,
    sessions: automation.sessions,
    broker,
    context(vision, runId) {
      const executionId = 'eval-' + createHash('sha256').update(runId).digest('hex').slice(0, 32)
      const execution: ExecutionContext = {
        profileId,
        threadId: 'thread-eval',
        turnId: `turn-${executionId}`,
        runId: executionId,
        actor: { kind: 'workflow' },
        policySnapshotId: snapshot.id,
        source: 'cli',
        cancellationId: `cancel-${executionId}`
      }
      return { execution, policy: snapshot, vision, target: { backend: 'managed-chromium' } }
    },
    async stageUpload(bytes, displayName) {
      const artifactId = `grant_${randomUUID().slice(0, 8)}`
      const path = join(isolated.stageRoot, displayName)
      mkdirSync(isolated.stageRoot, { recursive: true })
      writeFileSync(path, bytes)
      const grant: BrowserResolvedArtifact = {
        artifactId,
        path,
        byteLength: Buffer.byteLength(bytes),
        displayName,
        mediaType: 'text/plain'
      }
      grants.set(artifactId, grant)
      return { artifactId, grant }
    },
    async close() {
      await automation.sessions.closeAll()
      await broker.close()
    }
  }
}
