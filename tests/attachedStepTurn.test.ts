/**
 * The in-app browser counts the person's conflicts per agent turn (`USER_CONFLICT_REPEAT_MESSAGE`): the daemon names the
 * turn of each in-app step, and the window's command boundary lets that name through.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserBackendRouter, type BrowserBackendPort } from '../src/mms/browser/BrowserBackendRouter'
import { BrowserSessionManager } from '../src/mms/browser/automation/BrowserSessionManager'
import { validateAttachedBrowserWorkerRequest } from '../src/mms/protocol/connectionCommandValidate'
import { BROWSER_AUTOMATION_TOOLS, type BrowserToolContext } from '../src/shared/browser/automation'
import { ATTACHED_CAPABILITY_DEFAULT } from '../src/shared/browser/attached'
import type { BrowserWorkerRequest } from '../src/shared/browser/types'

const profileId = '11111111-1111-4111-8111-111111111111'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const request = (method: BrowserWorkerRequest['method'], params: Record<string, unknown>): BrowserWorkerRequest =>
  ({ version: 1, id: 'req_1', profileId, method, params })
const action = { requestId: 'req_a', sessionId: 'sess_1', tabId: 'tab_1', generation: 1, observationId: 'obs_1', controlLeaseId: 'lease_1', action: { type: 'click', target: { kind: 'ref', ref: 'el_1' } }, timeoutMs: 1000 }

describe('the window\'s command boundary', () => {
  it.each([
    ['session.open', { uiTabId: 'tab_ui', threadId: 'thread_1' }],
    ['session.open', { uiTabId: 'tab_ui', threadId: 'thread_1', ownTabsOnly: true }],
    ['tabs.list', { sessionId: 'sess_1' }],
    ['tabs.new', { sessionId: 'sess_1' }],
    ['tabs.switch', { sessionId: 'sess_1', tabId: 'tab_1' }],
    ['tabs.close', { sessionId: 'sess_1', tabId: 'tab_1' }],
    ['act', action]
  ] as const)('lets the turn of a %s step through', (method, params) => {
    const validated = validateAttachedBrowserWorkerRequest(request(method, { ...params, turn: 'run_1/turn_1' }))
    expect(validated.params).toMatchObject({ ...params, turn: 'run_1/turn_1' })
  })

  it('refuses a turn that is not a short name, and a turn on a person\'s own step', () => {
    expect(() => validateAttachedBrowserWorkerRequest(request('act', { ...action, turn: 7 }))).toThrow()
    expect(() => validateAttachedBrowserWorkerRequest(request('act', { ...action, turn: 'x'.repeat(401) }))).toThrow()
    expect(() => validateAttachedBrowserWorkerRequest(request('human.act', { ...action, turn: 'run_1/turn_1' }))).toThrow()
    expect(() => validateAttachedBrowserWorkerRequest(request('observe', { sessionId: 'sess_1', turn: 'run_1/turn_1' }))).toThrow()
  })
})

describe('the daemon\'s in-app steps', () => {
  function context(backend: 'electron-attached' | 'managed-chromium'): BrowserToolContext {
    return { execution: { profileId, threadId: 'thread_1', runId: 'run_1', turnId: 'turn_1', actor: { kind: 'main' }, policySnapshotId: 'policy_1', source: 'gui', cancellationId: 'cancel_1' },
      policy: { version: 1, id: 'policy_1', profileId, allowedTools: BROWSER_AUTOMATION_TOOLS, allowedCapabilities: ['browser.session', 'browser.observe', 'browser.action', 'browser.extract'], allowedEffects: ['read', 'write', 'external'], approvalEffects: [], maxToolCalls: 100, maxElapsedMs: 60_000, maxArtifactBytes: 1024 },
      target: backend === 'electron-attached' ? { backend, uiTabId: 'human_tab' } : { backend } }
  }
  const port = (backend: 'electron-attached' | 'managed-chromium') => ({ call: vi.fn<BrowserBackendPort['call']>(async (sent) => ({ version: 1, id: sent.id, ok: true, result: sent.method === 'session.open' ? {
    session: { id: `session_${backend}`, profileId, threadId: 'thread_1', runId: 'run_1', backend, persistent: false, browserVersion: 'fixture', generation: 1, lifecycle: 'agent-controlled', controlLeaseId: 'lease_1', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
    capabilities: ATTACHED_CAPABILITY_DEFAULT
  } : sent.method === 'act' ? { requestId: 'req', outcome: 'verified', dispatched: true, artifactIds: [] } : { tabs: [] } })) })

  it.each([
    ['electron-attached', 'run_1/turn_1'],
    ['managed-chromium', undefined]
  ] as const)('%s: names the turn of each step that may change a page', async (backend, turn) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-browser-turn-')); roots.push(root)
    const managed = port('managed-chromium'), attached = port('electron-attached')
    const sessions = new BrowserSessionManager({ profileId, profileRoot: root, broker: new BrowserBackendRouter({ profileId, managed, attached }) })
    const opened = await sessions.open(context(backend), {})
    const sessionId = opened.session!.id
    await sessions.tabs(context(backend), sessionId, { operation: 'new' })
    await sessions.act(context(backend), { sessionId, tabId: 'tab_1', generation: 1, observationId: 'obs_1', controlLeaseId: 'lease_1', action: { type: 'click', target: { kind: 'ref', ref: 'el_1' } } })
    const calls = (backend === 'electron-attached' ? attached : managed).call.mock.calls.map(([sent]) => [sent.method, sent.params.turn])
    expect(calls).toEqual([['session.open', turn], ['tabs.new', turn], ['act', turn]])
    await sessions.closeAll()
  })

  it.each([
    ['a run a person started', { grantId: 'grant_1', rootThreadId: 'thread_1', lease: true }, undefined],
    ['an editor try-run or app-started workflow', undefined, true]
  ] as const)('%s: its in-app session keeps to its own thread\'s tabs only when it has no grant', async (_name, browserGrant, ownTabsOnly) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-browser-scope-')); roots.push(root)
    const attached = port('electron-attached')
    const sessions = new BrowserSessionManager({ profileId, profileRoot: root, broker: new BrowserBackendRouter({ profileId, managed: port('managed-chromium'), attached }) })
    const base = context('electron-attached')
    await sessions.open({ ...base, execution: { ...base.execution, ...(browserGrant ? { browserGrant } : {}) } }, {})
    const [sent] = attached.call.mock.calls[0]!
    expect(sent.params.ownTabsOnly).toBe(ownTabsOnly)
    // The window's command boundary lets the flag through.
    expect(validateAttachedBrowserWorkerRequest(request('session.open', sent.params)).params.ownTabsOnly).toBe(ownTabsOnly)
    await sessions.closeAll()
  })
})
