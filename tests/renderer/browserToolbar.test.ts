// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserAccessControl,
  BrowserDeviceToolbar,
  BrowserNotice,
  ClearCookiesDialog,
  browserAgentState,
  deviceWidthLabel
} from '../../src/renderer/components/browser/BrowserToolbarParts'
import { surfaceTabItems } from '../../src/renderer/lib/surfaces'
import type { BrowserTabState } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function render(element: ReactElement) {
  act(() => root.render(element))
}

function click(element: Element | null | undefined) {
  if (!element) throw new Error('element missing')
  act(() => (element as HTMLElement).click())
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((button) => button.textContent === text)
}

describe('agent access in the browser toolbar', () => {
  it('keeps off, allowed, agent and human apart', () => {
    expect(browserAgentState(false, undefined)).toBe('off')
    expect(browserAgentState(true, undefined)).toBe('allowed')
    expect(browserAgentState(true, 'agent')).toBe('agent')
    expect(browserAgentState(true, 'human')).toBe('human')
    // Whoever holds the tab wins over the profile switch, so a takeover stays visible after revocation.
    expect(browserAgentState(false, 'human')).toBe('human')
  })

  it('shows the state and toggles access with the shared switch', () => {
    const onChange = vi.fn()
    render(createElement(BrowserAccessControl, { state: 'off', allowed: false, busy: false, onChange }))
    const control = host.querySelector('.browser-access')!
    expect(control.getAttribute('data-state')).toBe('off')
    expect(control.getAttribute('title')).toBe('Agents can’t use browser tabs')
    const toggle = host.querySelector<HTMLButtonElement>('button[role="switch"]')!
    expect(toggle.className).toContain('toggle-switch')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.getAttribute('aria-label')).toBe('Agent access to all browser tabs')
    click(toggle)
    expect(onChange).toHaveBeenCalledWith(true)

    render(createElement(BrowserAccessControl, { state: 'agent', allowed: true, busy: true, onChange }))
    expect(host.querySelector('[role="status"]')?.textContent).toBe('An agent is using this tab')
    expect(host.querySelector<HTMLButtonElement>('button[role="switch"]')?.disabled).toBe(true)
  })
})

describe('browser action results', () => {
  it('announces a result and an error, and dismisses', () => {
    const onDismiss = vi.fn()
    render(createElement(BrowserNotice, { notice: { kind: 'done', text: 'Cookies cleared' }, onDismiss }))
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Cookies cleared')

    render(createElement(BrowserNotice, { notice: { kind: 'error', text: 'Couldn’t clear cache', detail: 'disk full' }, onDismiss }))
    const alert = host.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('Couldn’t clear cache')
    expect(alert.querySelector('.browser-notice-text')?.getAttribute('title')).toBe('disk full')
    click(host.querySelector('button[aria-label="Dismiss"]'))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('confirms clearing cookies in a themed dialog', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(createElement(ClearCookiesDialog, { open: true, onCancel, onConfirm }))
    expect(document.querySelector('.modal-overlay[role="dialog"]')?.textContent).toContain('Clear browser cookies?')
    click(buttonByText('Cancel'))
    expect(onCancel).toHaveBeenCalledOnce()
    click(buttonByText('Clear cookies'))
    expect(onConfirm).toHaveBeenCalledOnce()
  })
})

describe('device toolbar', () => {
  it('shows Auto for Responsive and a width in px otherwise', () => {
    expect(deviceWidthLabel('responsive')).toBe('Auto')
    expect(deviceWidthLabel('iphone-14')).toBe('390 px')
    expect(deviceWidthLabel('unknown')).toBe('Auto')
  })

  it('uses the shared select, not a native one', () => {
    render(createElement(BrowserDeviceToolbar, { presetId: 'responsive', onChange: vi.fn() }))
    expect(host.querySelector('select')).toBeNull()
    expect(host.querySelector('.ui-select[aria-label="Device"]')?.textContent).toContain('Responsive')
    expect(host.textContent).not.toContain('px')
  })
})

describe('browser tabs kept in every thread', () => {
  const tab = (id: string, ownerThreadId: string | null): BrowserTabState => ({
    id, ownerThreadId, url: 'about:blank', title: 'New tab', zoomFactor: 1, deviceToolbarOpen: false, devicePreset: 'responsive'
  })

  it('marks only tabs with no owning thread', () => {
    const items = surfaceTabItems({ opened: ['browser'], terminals: [], browsers: [tab('a', 'thread-1'), tab('b', null)], documents: [] })
    expect(items.map((item) => [item.resourceId, item.everyThread ?? false])).toEqual([['a', false], ['b', true]])
  })
})
