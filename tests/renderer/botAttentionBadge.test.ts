// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fakeBots, installPreload, summary, type FakeBots } from './fakeBotsClient'
import { TitleBar } from '../../src/renderer/components/TitleBar'
import { setBotsClient, useBotsStore } from '../../src/renderer/stores/botsStore'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useChatsStore } from '../../src/renderer/stores/chatsStore'

vi.mock('../../src/renderer/components/WindowCaptionButtons', () => ({ WindowCaptionButtons: () => null }))
vi.mock('../../src/renderer/components/TitleBarNav', () => ({ TitleBarNav: () => null }))
vi.mock('../../src/renderer/components/downloads/DownloadsIndicator', () => ({ DownloadsIndicator: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
let fake: FakeBots
let badge: ReturnType<typeof vi.fn>
beforeEach(() => {
  fake = fakeBots()
  installPreload(fake)
  badge = vi.fn(async () => {})
  Object.assign(window.mousse, { app: { setAttentionCount: badge } })
  setBotsClient(fake.client)
  useBotsStore.setState({ profileId: null })
  useAppStore.setState({ threadsSidebarOpen: false, threadsSidebarView: 'threads', threads: [], threadActivity: {} })
  useChatsStore.setState({ snapshot: { agents: [], chats: [], devices: [] } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setBotsClient(null)
})
const show = async () => { await act(async () => {
  useBotsStore.getState().activate('p1')
  root.render(createElement(TitleBar))
}) }
const change = async () => { await act(async () => { fake.emit.changed('a') }) }

it('sends zero with no bots and counts a waiting bot once alongside threads, before Chats opens', async () => {
  await show()
  expect(badge).toHaveBeenLastCalledWith(0)
  fake.bots = [summary('a', { state: 'needs_you' })]
  await change()
  expect(badge).toHaveBeenLastCalledWith(1)
  await act(async () => useAppStore.setState({
    threads: [{ id: 't', name: 'Thread', startedAt: '2026-11-01', createdAt: '2026-11-01', order: 0 }],
    threadActivity: { t: 'awaiting_input' }
  }))
  expect(badge).toHaveBeenLastCalledWith(2)
  expect(host.querySelector('button[aria-label="Show sidebar · 1 thread and 1 bot need you"]')).not.toBeNull()
})

it('loads waiting bots at activation before mounting the title bar or opening Chats', async () => {
  fake.bots = [summary('a', { state: 'needs_you' })]
  await act(async () => useBotsStore.getState().activate('p1'))
  expect(useBotsStore.getState().bots.map((bot) => bot.id)).toEqual(['a'])
  await show()
  expect(badge).toHaveBeenLastCalledWith(1)
})

it.each(['answered', 'paused', 'deleted'])('clears the badge after %s on another window or device', async (reason) => {
  fake.bots = [summary('a', { state: 'needs_you' })]
  await show()
  expect(badge).toHaveBeenLastCalledWith(1)
  fake.bots = reason === 'deleted' ? [] : [summary('a', { state: reason === 'paused' ? 'paused' : 'idle' })]
  await change()
  expect(badge).toHaveBeenLastCalledWith(0)
  expect(host.querySelector('button[aria-label="Show sidebar"]')).not.toBeNull()
})


it('counts a waiting bot once despite multiple waiting work items, including when stuck', async () => {
  fake.bots = [summary('a', { state: 'stuck', needsOwner: true, work: ['one', 'two'].map((id) => ({ id, title: id, status: 'paused', waitsFor: 'answer', startedAt: '2026-11-01' })) })]
  await show()
  expect(badge).toHaveBeenLastCalledWith(1)
  fake.bots = [summary('a', { state: 'stuck' })]
  await change()
  expect(badge).toHaveBeenLastCalledWith(0)
})


it.each([
  [0, 1, '1 bot needs you'],
  [0, 2, '2 bots need you'],
  [1, 2, '1 thread and 2 bots need you'],
  [2, 1, '2 threads and 1 bot need you']
] as const)('names %s threads and %s bots in the sidebar toggle', async (threads, bots, label) => {
  fake.bots = Array.from({ length: bots }, (_, i) => summary(`b${i}`, { state: 'working', needsOwner: true }))
  useAppStore.setState({
    threads: Array.from({ length: threads }, (_, i) => ({ id: `t${i}`, name: 'Thread', startedAt: '2026-11-01', createdAt: '2026-11-01', order: i })),
    threadActivity: Object.fromEntries(Array.from({ length: threads }, (_, i) => [`t${i}`, 'awaiting_input']))
  })
  await show()
  expect(host.querySelector(`button[aria-label="Show sidebar · ${label}"]`)).not.toBeNull()
})

it('refreshes at activation and on pushes without title bar polling', async () => {
  vi.useFakeTimers()
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  try {
    await show()
    const calls = fake.calls.filter(([method]) => method === 'list').length
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(fake.calls.filter(([method]) => method === 'list')).toHaveLength(calls)
    await change()
    expect(fake.calls.filter(([method]) => method === 'list')).toHaveLength(calls + 1)
  } finally { visibility.mockRestore(); vi.useRealTimers() }
})
