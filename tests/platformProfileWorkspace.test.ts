import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../src/renderer/stores/appStore'

afterEach(() => vi.unstubAllGlobals())

it('restores each profile layout and resets a new profile to its own defaults', () => {
  const values = new Map<string, string>()
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  } })
  useAppStore.getState().activateProfile('alice')
  useAppStore.setState({ sidebarWidth: 42, threadsSidebarWidth: 330, threadsSidebarOpen: false, mainAreaOpen: true })
  useAppStore.getState().activateProfile('bob')
  expect(useAppStore.getState()).toMatchObject({ sidebarWidth: 30, threadsSidebarWidth: 260, threadsSidebarOpen: true, mainAreaOpen: false })
  useAppStore.setState({ sidebarWidth: 35, threadsSidebarWidth: 210 })
  useAppStore.getState().activateProfile('alice')
  expect(useAppStore.getState()).toMatchObject({ sidebarWidth: 42, threadsSidebarWidth: 330, threadsSidebarOpen: false, mainAreaOpen: true })
  useAppStore.getState().activateProfile('bob')
  expect(useAppStore.getState()).toMatchObject({ sidebarWidth: 35, threadsSidebarWidth: 210 })
})

it('preserves the active profile on restart without overwriting it during bootstrap', async () => {
  const values = new Map<string, string>()
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  } })
  vi.resetModules()
  const first = (await import('../src/renderer/stores/appStore')).useAppStore
  first.getState().activateProfile('default')
  first.setState({ sidebarWidth: 48, threadsSidebarOpen: false })
  const saved = values.get('mousse-profile-default-workspace')
  expect(JSON.parse(saved!)).toMatchObject({ sidebarWidth: 48, threadsSidebarOpen: false })
  first.setState({ activeThreadId: 'selected-thread' })
  first.getState().activateProfile('default')
  expect(first.getState().sidebarWidth).toBe(48)
  expect(first.getState().activeThreadId).toBe('selected-thread')

  vi.resetModules()
  const restarted = (await import('../src/renderer/stores/appStore')).useAppStore
  restarted.setState({ mainAreaOpen: true })
  expect(values.get('mousse-profile-default-workspace')).toBe(saved)
  restarted.getState().activateProfile('default')
  expect(restarted.getState()).toMatchObject({ sidebarWidth: 48, threadsSidebarOpen: false, mainAreaOpen: false })
})
