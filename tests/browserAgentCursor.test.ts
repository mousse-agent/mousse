/**
 * The agent cursor for a thread's agent in an in-app tab: the attached session reports where the
 * agent is about to act before the input is sent, for its window to draw over the tab, and sends
 * nothing of it to the page. A takeover while the cursor glides sends nothing at all.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ElectronAttachedBrowserBackend } from '../src/main/browser/automation/backend'
import { TrustedGuestRegistry } from '../src/main/browser/automation/registry'
import { createLoopbackAttachedPolicy } from '../src/main/browser/automation/policy'
import type { BrowserJournalPort } from '../src/mms/browser/ports'
import { AGENT_CURSOR_GLIDE_MS, agentCursorFor, agentCursorLive, type BrowserAgentCursor } from '../src/shared/browser/agentCursor'
import type { BrowserObservation, BrowserSessionRecord, BrowserWorkerRequest } from '../src/shared/browser/types'
import { createFakeGuestPair } from './fixtures/agent-platform/electron-attached-browser/fakeGuest'

const profileId = 'prof_cursor'
const uiTabId = 'uitab_cursor'
const threadId = 'thread_cursor'

const req = (method: BrowserWorkerRequest['method'], params: Record<string, unknown>): BrowserWorkerRequest => ({ version: 1, id: 'id_' + randomUUID(), profileId, method, params })
const journal = (): BrowserJournalPort => ({ append() {} })

describe('agentCursorFor', () => {
  const viewport = { width: 1280, height: 720 }
  it('places the cursor at the target, in the page\'s viewport', () => {
    expect(agentCursorFor({ type: 'click', target: { kind: 'ref', ref: 'el_1' } }, { x: 50, y: 52 }, viewport, 1000, 'tab_1'))
      .toEqual({ x: 50, y: 52, action: 'click', at: 1000, viewport, tabId: 'tab_1' })
    expect(agentCursorFor({ type: 'fill', target: { kind: 'ref', ref: 'el_1' }, text: 'x' }, { x: 2000, y: -5 }, viewport, 1)).toMatchObject({ x: 1280, y: 0 })
  })

  it('has no place for a navigation or a key without a target; a scroll without one sits mid-page', () => {
    expect(agentCursorFor({ type: 'navigate', url: 'https://example.com' }, undefined, viewport, 1)).toBeUndefined()
    expect(agentCursorFor({ type: 'key', key: 'Enter' }, undefined, viewport, 1)).toBeUndefined()
    expect(agentCursorFor({ type: 'scroll', deltaX: 0, deltaY: 300 }, undefined, viewport, 1)).toMatchObject({ x: 640, y: 360, action: 'scroll' })
  })

  it('fades after a few idle seconds', () => {
    const cursor = agentCursorFor({ type: 'hover', target: { kind: 'ref', ref: 'el_1' } }, { x: 1, y: 1 }, viewport, 10_000)!
    expect(agentCursorLive(cursor, 11_000)).toBe(true)
    expect(agentCursorLive(cursor, 20_000)).toBe(false)
  })
})

describe('the agent cursor over an in-app tab', () => {
  function setup() {
    const registry = new TrustedGuestRegistry({ ownerBinding: () => true })
    const pair = createFakeGuestPair({ profileId })
    registry.registerGuest({ guest: pair.guest, owner: pair.owner, profileId, profileEpoch: 'epoch_1', uiTabId, thread: { kind: 'thread', threadId } })
    const backend = new ElectronAttachedBrowserBackend({ registry, policy: createLoopbackAttachedPolicy(), journal: journal() })
    const cursors: Array<{ uiTabId: string; cursor: BrowserAgentCursor; pageResult: string }> = []
    backend.onAgentCursor((event) => cursors.push({ ...event, pageResult: pair.page.result }))
    return { pair, backend, cursors }
  }
  const open = async (backend: ElectronAttachedBrowserBackend) => {
    const opened = await backend.call(req('session.open', { uiTabId, threadId }))
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
    return opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
  }

  it('reports the point of the element before the click lands, and the page only ever gets the click', async () => {
    const { pair, backend, cursors } = setup()
    const opened = await open(backend)
    const save = opened.observation.elements.find((element) => element.name === 'Save')!
    const started = Date.now()
    const clicked = await backend.call(req('act', { requestId: 'save', sessionId: opened.session.id, tabId: opened.observation.tabId, generation: opened.session.generation,
      observationId: opened.observation.observationId, controlLeaseId: opened.session.controlLeaseId, action: { type: 'click', target: { kind: 'ref', ref: save.ref } } }))
    expect(clicked.ok, JSON.stringify(clicked.error)).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(AGENT_CURSOR_GLIDE_MS - 20)
    expect(cursors).toHaveLength(1)
    const [event] = cursors
    expect(event!.uiTabId).toBe(uiTabId)
    expect(event!.cursor).toMatchObject({ action: 'click', tabId: opened.observation.tabId, viewport: { width: opened.observation.viewport.cssWidth, height: opened.observation.viewport.cssHeight } })
    expect(event!.cursor.x).toBeGreaterThanOrEqual(save.bounds!.x)
    expect(event!.cursor.x).toBeLessThanOrEqual(save.bounds!.x + save.bounds!.width)
    expect(event!.cursor.y).toBeGreaterThanOrEqual(save.bounds!.y)
    expect(event!.cursor.y).toBeLessThanOrEqual(save.bounds!.y + save.bounds!.height)
    // It was reported before the click reached the page; afterwards the page holds the click's result only.
    expect(event!.pageResult).toBe('idle')
    expect(pair.page.result).toContain('saved:')
    const after = (clicked.result as { observation: BrowserObservation }).observation
    expect(after.elements.map((element) => element.role)).toEqual(opened.observation.elements.map((element) => element.role))
    await backend.shutdown()
  })

  it('a takeover while the cursor glides sends nothing to the page', async () => {
    const { pair, backend, cursors } = setup()
    const opened = await open(backend)
    const save = opened.observation.elements.find((element) => element.name === 'Save')!
    const pending = backend.call(req('act', { requestId: 'held', sessionId: opened.session.id, tabId: opened.observation.tabId, generation: opened.session.generation,
      observationId: opened.observation.observationId, controlLeaseId: opened.session.controlLeaseId, action: { type: 'click', target: { kind: 'ref', ref: save.ref } } }))
    await expect.poll(() => cursors.length).toBe(1)
    const takeover = await backend.call(req('control.take', { sessionId: opened.session.id, owner: 'human' }))
    expect(takeover.ok).toBe(true)
    const result = await pending
    expect(result.ok).toBe(false)
    expect(pair.page.result).toBe('idle')
    await backend.shutdown()
  })
})
