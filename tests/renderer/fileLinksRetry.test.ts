// @vitest-environment jsdom
/**
 * File links that arrive while the Files tab's chunk has failed to load stay held, and reach the tab once each
 * when Retry loads it.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const files = vi.hoisted(() => ({ loads: 0, links: [] as unknown[] }))
vi.mock('../../src/renderer/components/FilesPanel', async () => {
  files.loads += 1
  if (files.loads === 1) throw new TypeError('Failed to fetch dynamically imported module')
  const { createElement: element, useEffect } = await import('react')
  const { fileLinksListening } = await import('../../src/renderer/services/fileLinks')
  return {
    FilesPanel: () => {
      useEffect(() => {
        const open = (event: Event) => { files.links.push((event as CustomEvent).detail) }
        window.addEventListener('mousse:open-file', open)
        const stop = fileLinksListening()
        return () => { stop(); window.removeEventListener('mousse:open-file', open) }
      }, [])
      return element('div', { 'data-testid': 'files' })
    }
  }
})
const stub = (testId: string) => () => createElement('div', { 'data-testid': testId })
vi.mock('../../src/renderer/components/ProjectTerminalPanel', () => ({ ProjectTerminalPanel: stub('terminal') }))
vi.mock('../../src/renderer/components/BrowserPanel', () => ({ BrowserPanel: stub('browser') }))
vi.mock('../../src/renderer/components/changes/ChangesPanel', () => ({ ChangesPanel: stub('changes') }))
vi.mock('../../src/renderer/components/PullRequestPanel', () => ({ PullRequestPanel: stub('pull-request') }))
vi.mock('../../src/renderer/components/DocumentPanel', () => ({ DocumentPanel: stub('documents') }))

const { MainViewPanel } = await import('../../src/renderer/components/MainViewPanel')
const { useAppStore } = await import('../../src/renderer/stores/appStore')

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  useAppStore.setState({
    mainAreaOpen: true, settingsOpen: false, usageOpen: false, scheduledOpen: false, activeThreadId: 'thread_a',
    mainView: 'git', openedSurfaceKinds: ['git'], projectTerminalTabs: [], browserTabs: [], documentTabs: []
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const settle = () => act(async () => { for (let i = 0; i < 10; i += 1) await new Promise((done) => setTimeout(done, 0)) })
const openFile = (detail: unknown) => act(() => { window.dispatchEvent(new CustomEvent('mousse:open-file', { detail })) })

it('holds links while the Files chunk has failed, and hands them over once when Retry loads it', async () => {
  act(() => root.render(createElement(MainViewPanel)))
  await settle()
  // The first link mounts the tab; its chunk fails to load.
  openFile({ path: 'a.ts' })
  await settle()
  expect(files.loads).toBe(1)
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load.")
  // Links keep arriving while it has failed: none is lost, none is delivered yet.
  openFile({ path: 'b.ts', line: 2 })
  expect(files.links).toEqual([])

  act(() => { host.querySelector<HTMLButtonElement>('.lazy-load-failed-retry')!.click() })
  await settle()
  expect(files.loads).toBe(2)
  expect(host.querySelector('[data-testid="files"]')).not.toBeNull()
  expect(files.links).toEqual([{ path: 'a.ts' }, { path: 'b.ts', line: 2 }])

  // From now on, links go straight to the tab, once each.
  openFile({ path: 'c.ts' })
  expect(files.links).toEqual([{ path: 'a.ts' }, { path: 'b.ts', line: 2 }, { path: 'c.ts' }])
})
