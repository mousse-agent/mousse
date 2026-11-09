// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ComposerNoticeProvider,
  ComposerNoticeSlot,
  ComposerNoticeSource,
  ComposerNoticeStore,
  type ComposerNoticeProps
} from '../../src/renderer/components/ComposerNotice'
import { ServiceLostNotice, SERVICE_LOST_TITLE } from '../../src/renderer/components/ServiceLostNotice'
import { pausedRunNotice } from '../../src/renderer/chat/components/PausedRunNotice'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = Date.parse('2026-11-06T10:00:00Z')
const paused: ComposerNoticeProps = pausedRunNotice({
  pause: { runId: 'run:1', until: new Date(NOW + 2 * 3_600_000).toISOString(), estimated: false, autoResume: false },
  now: NOW,
  busy: null,
  error: null,
  onResume: () => undefined,
  onEndPause: () => undefined,
  onDismissError: () => undefined
})

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

/** The composer's dock as OrchestratorChat renders it. */
const dock = ({ pause = false, lost = false } = {}) => act(() => root.render(
  createElement(ComposerNoticeProvider, null, createElement(Fragment, null,
    createElement(ComposerNoticeSource, { notice: pause ? paused : null }),
    createElement(ServiceLostNotice, { lost, onReconnect: () => undefined, onDismiss: () => undefined }),
    createElement(ComposerNoticeSlot)
  ))
))
const notices = () => [...host.querySelectorAll('.composer-notice')].map((entry) => (entry.querySelector('.composer-notice-title-full') ?? entry.querySelector('.composer-notice-title'))?.textContent)

describe('the dock above the composer', () => {
  it('ranks the lost service over a paused run, then approval, errors and info', () => {
    const store = new ComposerNoticeStore()
    store.set('info', { tone: 'info', title: 'Steered' })
    expect(store.top()?.title).toBe('Steered')
    store.set('error', { tone: 'error', title: 'Send failed' })
    expect(store.top()?.title).toBe('Send failed')
    store.set('approval', { tone: 'warning', title: 'Approval', priority: 'approval' })
    expect(store.top()?.title).toBe('Approval')
    store.set('paused', paused)
    expect(store.top()).toBe(paused)
    store.set('service', { tone: 'error', title: 'Service lost', priority: 'service' })
    expect(store.top()?.title).toBe('Service lost')
    store.set('service', null)
    expect(store.top()).toBe(paused)
  })

  it('puts the lost service over a paused run', async () => {
    dock({ pause: true, lost: true })
    expect(notices()).toEqual([SERVICE_LOST_TITLE])
    dock({ pause: true, lost: false })
    expect(notices()).toEqual([paused.title])
  })
})
