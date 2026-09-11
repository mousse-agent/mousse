import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserBackendRouter, type BrowserBackendPort } from '../src/mms/browser/BrowserBackendRouter'
import { BrowserSessionManager } from '../src/mms/browser/automation/BrowserSessionManager'
import { BrowserToolDispatcher } from '../src/mms/browser/automation/BrowserToolDispatcher'
import { BROWSER_AUTOMATION_TOOLS, type BrowserToolContext } from '../src/shared/browser/automation'
import type { BrowserSessionRecord, BrowserWorkerRequest, BrowserWorkerResponse } from '../src/shared/browser/types'

const profileId = '11111111-1111-4111-8111-111111111111'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

function request(method: BrowserWorkerRequest['method'], params: Record<string, unknown>): BrowserWorkerRequest {
  return { version: 1, id: 'command_1', profileId, method, params }
}
function backend(kind: BrowserSessionRecord['backend']) {
  let sequence = 0
  const call = vi.fn<BrowserBackendPort['call']>(async (req) => ({ version: 1, id: req.id, ok: true,
    result: req.method === 'session.open' ? { session: { id: `session_${kind}_${++sequence}`, profileId: req.profileId,
      threadId: req.params.threadId, runId: req.params.runId, backend: kind, persistent: false, browserVersion: 'fixture', generation: 1,
      lifecycle: 'agent-controlled', controlLeaseId: 'lease_1', createdAt: '2026-09-11T00:00:00Z', updatedAt: '2026-09-11T00:00:00Z' } } : { tabs: [] } }))
  return { call }
}
function context(source: 'gui' | 'cli' = 'gui'): BrowserToolContext {
  return { execution: { profileId, threadId: 'thread_1', runId: 'run_1', turnId: 'turn_1', actor: { kind: 'main' },
    policySnapshotId: 'policy_1', source, cancellationId: 'cancel_1' },
    policy: { version: 1, id: 'policy_1', profileId, allowedTools: BROWSER_AUTOMATION_TOOLS,
      allowedCapabilities: ['browser.session', 'browser.observe', 'browser.action', 'browser.extract'], allowedEffects: ['read', 'write', 'external'],
      approvalEffects: [], maxToolCalls: 100, maxElapsedMs: 60_000, maxArtifactBytes: 1024 * 1024 } }
}
async function manager(router: BrowserBackendRouter) {
  const root = await mkdtemp(join(tmpdir(), 'mousse-browser-routing-'))
  roots.push(root)
  return new BrowserSessionManager({ profileId, profileRoot: root, broker: router })
}

describe('host-selected browser backend routing', () => {
  it('operates the selected attached tab through the real tool dispatcher and retains its backend', async () => {
    const managed = backend('managed-chromium'), attached = backend('electron-attached')
    const router = new BrowserBackendRouter({ profileId, managed, attached })
    const sessions = await manager(router), tools = new BrowserToolDispatcher({ sessions })
    const owner = { ...context(), target: { backend: 'electron-attached' as const, uiTabId: 'existing_tab' } }
    const opened = await tools.invoke('browser_open', {}, owner)
    expect(opened.ok).toBe(true)
    if (!opened.ok) throw new Error('open failed')
    expect(attached.call.mock.calls[0][0]).toMatchObject({ method: 'session.open', params: { uiTabId: 'existing_tab', threadId: 'thread_1', runId: 'run_1' } })
    expect(attached.call.mock.calls[0][0].params).not.toHaveProperty('url')
    expect(attached.call.mock.calls[0][0].params).not.toHaveProperty('backend')
    await tools.invoke('browser_tabs', { sessionId: opened.value.session!.id }, { ...owner, target: { backend: 'managed-chromium' } })
    expect(attached.call.mock.calls[1][0].method).toBe('tabs.list')
    expect(managed.call).not.toHaveBeenCalled()
    await expect(sessions.tabs({ ...owner, execution: { ...owner.execution, runId: 'other_run' } }, opened.value.session!.id, {})).rejects.toMatchObject({ code: 'profile_mismatch' })
    expect(attached.call).toHaveBeenCalledTimes(2)
  })

  it('requires explicit GUI target selection while CLI defaults to managed Chromium', async () => {
    const managed = backend('managed-chromium'), router = new BrowserBackendRouter({ profileId, managed })
    const sessions = await manager(router)
    await expect(sessions.open(context(), {})).rejects.toMatchObject({ code: 'setup_required' })
    expect(managed.call).not.toHaveBeenCalled()
    expect((await sessions.open(context('cli'), {})).session?.backend).toBe('managed-chromium')
    expect((await sessions.open({ ...context(), target: { backend: 'managed-chromium' } }, {})).session?.backend).toBe('managed-chromium')
  })

  it('never falls back when the selected in-app backend is unavailable or disconnects', async () => {
    const managed = backend('managed-chromium')
    const params = { backend: 'electron-attached', uiTabId: 'existing_tab', threadId: 'thread_1' }
    const unavailable = new BrowserBackendRouter({ profileId, managed })
    expect(await unavailable.call(request('session.open', params))).toMatchObject({ ok: false, error: { code: 'setup_required' } })
    const attached = backend('electron-attached')
    attached.call.mockRejectedValue(new Error('GUI disconnected'))
    const router = new BrowserBackendRouter({ profileId, managed, attached })
    await expect(router.call(request('session.open', params))).rejects.toThrow('GUI disconnected')
    expect(managed.call).not.toHaveBeenCalled()
  })

  it('rejects cross-profile, storage substitution, and model-supplied target fields before dispatch', async () => {
    const managed = backend('managed-chromium'), attached = backend('electron-attached')
    const router = new BrowserBackendRouter({ profileId, managed, attached })
    const open = request('session.open', { backend: 'electron-attached', uiTabId: 'existing_tab' })
    expect(await router.call({ ...open, profileId: 'another_profile' })).toMatchObject({ error: { code: 'profile_mismatch' } })
    expect(await router.call({ ...open, params: { ...open.params, persistent: true } })).toMatchObject({ error: { code: 'invalid_action' } })
    expect(await router.call(request('session.open', { backend: 'managed-chromium', uiTabId: 'existing_tab' }))).toMatchObject({ error: { code: 'invalid_action' } })
    const tools = new BrowserToolDispatcher({ sessions: await manager(router) })
    const output = await tools.invoke('browser_open', { uiTabId: 'model_selected', backend: 'managed-chromium' }, { ...context(), target: { backend: 'electron-attached', uiTabId: 'existing_tab' } })
    expect(output.ok).toBe(false)
    expect(managed.call).not.toHaveBeenCalled()
    expect(attached.call).not.toHaveBeenCalled()
  })

  it('rejects backend/session response substitution and command replay after close', async () => {
    const managed = backend('managed-chromium'), attached = backend('electron-attached')
    const router = new BrowserBackendRouter({ profileId, managed, attached })
    const open = request('session.open', { backend: 'electron-attached', uiTabId: 'existing_tab', threadId: 'thread_1' })
    attached.call.mockImplementationOnce(managed.call)
    expect(await router.call(open)).toMatchObject({ error: { code: 'worker_disconnected' } })
    const response = await router.call(open), id = (response.result as { session: BrowserSessionRecord }).session.id
    expect(await router.call(request('tabs.list', { sessionId: id, backend: 'managed-chromium' }))).toMatchObject({ error: { code: 'invalid_action' } })
    await router.call(request('session.close', { sessionId: id }))
    const count = attached.call.mock.calls.length
    expect(await router.call(request('tabs.list', { sessionId: id }))).toMatchObject({ error: { code: 'session_closed' } })
    expect(attached.call).toHaveBeenCalledTimes(count)
  })

  it('retains a pending backend operation across caller cancellation and shutdown timeout', async () => {
    let settle!: (response: BrowserWorkerResponse) => void
    const managed = backend('managed-chromium')
    managed.call.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve }))
    const router = new BrowserBackendRouter({ profileId, managed })
    const controller = new AbortController()
    const pending = router.call(request('session.open', { backend: 'managed-chromium', threadId: 'thread_1' }), { signal: controller.signal })
    controller.abort()
    expect(managed.call.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(router.getActiveCount()).toBe(1)
    await expect(router.shutdown({ timeoutMs: 5 })).rejects.toMatchObject({ code: 'profile_busy' })
    expect(router.getActiveCount()).toBe(1)
    expect(() => router.call(request('tabs.list', { sessionId: 'session_1' }))).toThrow('shutting down')
    settle({ version: 1, id: 'command_1', ok: false, error: { code: 'cancelled', message: 'Underlying command settled' } })
    await pending
    await router.shutdown({ timeoutMs: 50 })
    expect(router.getActiveCount()).toBe(0)
  })

  it('does not dispatch a pre-cancelled operation or accept a mismatched response ID', async () => {
    const managed = backend('managed-chromium'), router = new BrowserBackendRouter({ profileId, managed })
    const open = request('session.open', { backend: 'managed-chromium', threadId: 'thread_1' })
    expect(await router.call(open, { signal: AbortSignal.abort() })).toMatchObject({ error: { code: 'cancelled' } })
    expect(managed.call).not.toHaveBeenCalled()
    managed.call.mockResolvedValueOnce({ version: 1, id: 'another_command', ok: true, result: {} })
    expect(await router.call(open)).toMatchObject({ error: { code: 'worker_disconnected' } })
  })
})
