import Ajv from 'ajv'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserBackendRouter, type BrowserBackendPort } from '../src/mms/browser/BrowserBackendRouter'
import { BrowserSessionManager } from '../src/mms/browser/automation/BrowserSessionManager'
import { BrowserToolDispatcher } from '../src/mms/browser/automation/BrowserToolDispatcher'
import { getBrowserToolDefinitions } from '../src/mms/orchestrator/browser/tools'
import { browserBackendCapabilities } from '../src/shared/browser/capabilities'
import { BROWSER_AUTOMATION_TOOLS, type BrowserToolContext } from '../src/shared/browser/automation'
import { ATTACHED_CAPABILITY_DEFAULT } from '../src/shared/browser/attached'

const profileId = '11111111-1111-4111-8111-111111111111'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function schema(name: string, backend: 'electron-attached' | 'managed-chromium', vision = false) {
  return new Ajv().compile(getBrowserToolDefinitions({ vision, backend }).find((tool) => tool.name === name)!.parameters)
}
function context(backend: 'electron-attached' | 'managed-chromium'): BrowserToolContext {
  return { execution: { profileId, threadId: 'thread_1', runId: 'run_1', turnId: 'turn_1', actor: { kind: 'main' }, policySnapshotId: 'policy_1', source: 'gui', cancellationId: 'cancel_1' },
    policy: { version: 1, id: 'policy_1', profileId, allowedTools: BROWSER_AUTOMATION_TOOLS, allowedCapabilities: ['browser.session', 'browser.observe', 'browser.action', 'browser.extract'], allowedEffects: ['read', 'write', 'external'], approvalEffects: [], maxToolCalls: 100, maxElapsedMs: 60_000, maxArtifactBytes: 1024 },
    target: backend === 'electron-attached' ? { backend, uiTabId: 'human_tab' } : { backend } }
}
function backendPort(backend: 'electron-attached' | 'managed-chromium', screenshots = false) {
  return { call: vi.fn<BrowserBackendPort['call']>(async (request) => ({ version: 1, id: request.id, ok: true, result: {
    session: { id: `session_${backend}`, profileId, threadId: 'thread_1', runId: 'run_1', backend, persistent: false, browserVersion: 'fixture', generation: 1, lifecycle: 'agent-controlled', controlLeaseId: 'lease_1', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
    capabilities: { ...ATTACHED_CAPABILITY_DEFAULT, capabilities: { ...ATTACHED_CAPABILITY_DEFAULT.capabilities, screenshots } }
  } })) }
}

describe('host-owned browser backend capability reporting', () => {
  it.each([
    ['browser_act', { action: { type: 'unsupported-fixture-action' } }],
    ['browser_act', { action: { type: 'navigate', url: 'not a URL' } }],
    ['browser_open', { url: 'file:///private/fixture.txt' }],
    ['browser_wait', { condition: { type: 'unsupported-fixture-wait' } }]
  ] as const)('preserves invalid classification for %s validation without contacting a backend', async (name, args) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-browser-validation-')); roots.push(root)
    const managed = backendPort('managed-chromium'), attached = backendPort('electron-attached')
    const sessions = new BrowserSessionManager({ profileId, profileRoot: root, broker: new BrowserBackendRouter({ profileId, managed, attached }) })
    const result = await new BrowserToolDispatcher({ sessions }).invoke(name, args, context('managed-chromium'))
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_action', errorInfo: { category: 'invalid', retryable: false } } })
    expect(managed.call).not.toHaveBeenCalled()
    expect(attached.call).not.toHaveBeenCalled()
    await sessions.closeAll()
  })

  it('limits attached tabs and uploads while keeping managed operations available', () => {
    for (const operation of ['list', 'switch']) expect(schema('browser_tabs', 'electron-attached')({ sessionId: 'session_1', operation })).toBe(true)
    for (const operation of ['new', 'close']) {
      expect(schema('browser_tabs', 'electron-attached')({ sessionId: 'session_1', operation })).toBe(false)
      expect(schema('browser_tabs', 'managed-chromium')({ sessionId: 'session_1', operation })).toBe(true)
    }
    const upload = { sessionId: 'session_1', tabId: 'tab_1', generation: 1, observationId: 'obs_1', controlLeaseId: 'lease_1', action: { type: 'upload', target: { kind: 'ref', ref: 'el_1' }, artifactIds: ['artifact_1'] } }
    expect(schema('browser_act', 'electron-attached')(upload)).toBe(false)
    expect(schema('browser_act', 'managed-chromium')(upload)).toBe(true)
  })

  it('advertises screenshots only for vision-bound tools', () => {
    expect(getBrowserToolDefinitions({ backend: 'electron-attached', vision: false }).map((tool) => tool.name)).not.toContain('browser_screenshot')
    expect(getBrowserToolDefinitions({ backend: 'electron-attached', vision: true }).map((tool) => tool.name)).not.toContain('browser_screenshot')
    expect(getBrowserToolDefinitions({ backend: 'electron-attached', vision: true, screenshots: true }).map((tool) => tool.name)).toContain('browser_screenshot')
    expect(browserBackendCapabilities('electron-attached', false)).toMatchObject({ screenshots: false, uploads: false, downloads: false, tabs: ['list', 'switch'] })
  })

  it.each(['electron-attached', 'managed-chromium'] as const)('returns host-derived %s capabilities through actual open dispatch', async (backend) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-browser-capabilities-')); roots.push(root)
    const managed = backendPort('managed-chromium'), attached = backendPort('electron-attached')
    const sessions = new BrowserSessionManager({ profileId, profileRoot: root, broker: new BrowserBackendRouter({ profileId, managed, attached }) })
    const tools = new BrowserToolDispatcher({ sessions })
    const result = await tools.invoke('browser_open', {}, { ...context(backend), vision: true })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('Expected browser open')
    expect(result.value.capabilities).toEqual(browserBackendCapabilities(backend, true))
    expect((backend === 'electron-attached' ? managed : attached).call).not.toHaveBeenCalled()
    await sessions.closeAll()
  })

  it('intersects actual attached screenshot support with the trusted vision binding', async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-browser-capabilities-')); roots.push(root)
    const attached = backendPort('electron-attached', true)
    const sessions = new BrowserSessionManager({ profileId, profileRoot: root, broker: new BrowserBackendRouter({ profileId, managed: backendPort('managed-chromium'), attached }) })
    const result = await sessions.open({ ...context('electron-attached'), vision: true }, {})
    expect(result.capabilities?.screenshots).toBe(true)
    await sessions.closeAll()
  })

  it('rejects model-supplied host capability/backend claims before contacting a backend', async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-browser-capabilities-')); roots.push(root)
    const managed = backendPort('managed-chromium'), attached = backendPort('electron-attached')
    const sessions = new BrowserSessionManager({ profileId, profileRoot: root, broker: new BrowserBackendRouter({ profileId, managed, attached }) })
    const result = await new BrowserToolDispatcher({ sessions }).invoke('browser_open', { backend: 'managed-chromium', capabilities: { uploads: true } }, context('electron-attached'))
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_action' } })
    expect(managed.call).not.toHaveBeenCalled()
    expect(attached.call).not.toHaveBeenCalled()
  })
})
