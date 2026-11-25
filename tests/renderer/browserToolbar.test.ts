// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { Bot, User } from '../../src/renderer/lib/icons'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserActivityIndicator,
  BrowserDeviceToolbar,
  BrowserNotice,
  BrowserStartPage,
  ClearCookiesDialog,
  browserTabActivity,
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

describe('who is using the tab, in the browser toolbar', () => {
  it('reads the tab\'s activity, and shows nothing for an idle or disconnected tab', () => {
    expect(browserTabActivity(undefined)).toBe('idle')
    expect(browserTabActivity({ owner: 'agent' })).toBe('idle')
    expect(browserTabActivity({ owner: 'agent', activity: 'agent-busy' })).toBe('agent-busy')
    expect(browserTabActivity({ owner: 'disconnected', activity: 'agent-busy' })).toBe('idle')
    render(createElement(BrowserActivityIndicator, { activity: 'idle', busy: false, onResume: vi.fn() }))
    expect(host.innerHTML).toBe('')
  })

  it.each([
    ['agent-busy', 'Agent is acting in this tab — click the page to take over', Bot],
    ['agent-waiting', 'Agent waiting to use this tab', Bot],
    ['user-active', 'You’re using this tab', User],
    ['waiting-human', 'The agent handed this tab to you', User]
  ] as const)('%s: says so in its tooltip with the agent\'s or the person\'s icon, and asks nothing', (activity, text, icon) => {
    render(createElement(BrowserActivityIndicator, { activity, busy: false, onResume: vi.fn() }))
    const indicator = host.querySelector('.browser-activity')!
    expect(indicator.getAttribute('data-state')).toBe(activity)
    expect(indicator.getAttribute('title')).toBe(text)
    expect(indicator.querySelector('[role="status"]')?.textContent).toBe(text)
    const drawn = document.createElement('div')
    drawn.innerHTML = renderToStaticMarkup(createElement(icon, { size: 14 }))
    expect(indicator.querySelector('svg')?.innerHTML).toBe(drawn.querySelector('svg')?.innerHTML)
    // No switch, and no question to answer.
    expect(host.querySelector('[role="switch"]')).toBeNull()
    expect(host.querySelector('[data-mousse-decision]')).toBeNull()
    expect(buttonByText('Resume agent') !== undefined).toBe(activity === 'waiting-human')
  })

  it('hands a tab the agent gave the person back with Resume agent', () => {
    const onResume = vi.fn()
    render(createElement(BrowserActivityIndicator, { activity: 'waiting-human', busy: false, onResume }))
    click(buttonByText('Resume agent'))
    expect(onResume).toHaveBeenCalledOnce()
    render(createElement(BrowserActivityIndicator, { activity: 'waiting-human', busy: true, onResume }))
    expect(buttonByText('Resume agent')?.disabled).toBe(true)
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

describe('browser start page', () => {
  it('shows one short address instruction', () => {
    render(createElement(BrowserStartPage))
    const page = host.querySelector('.browser-blank')!
    expect(page.querySelectorAll('p')).toHaveLength(1)
    expect(page.querySelector('p')?.textContent).toBe('Enter an address above')
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

  it('names a tab by its page title, else its host, else its position', () => {
    const page = (id: string, url: string, title: string): BrowserTabState => ({ ...tab(id, null), url, title })
    const items = surfaceTabItems({ opened: ['browser'], terminals: [], documents: [], browsers: [
      page('a', 'https://example.test/docs', 'Docs home'),
      page('b', 'https://www.example.test/plain.txt', 'https://www.example.test/plain.txt'),
      page('c', 'about:blank', 'New tab')
    ] })
    expect(items.map((item) => item.label)).toEqual(['Docs home', 'example.test', 'Browser 3'])
  })
})
