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
  useBotsStore.getState().activate('p1')
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
const show = async () => { await act(async () => root.render(createElement(TitleBar))) }
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
  expect(host.querySelector('button[aria-label="Show sidebar · 2 items need you"]')).not.toBeNull()
})

it('loads waiting bots on mount without a change event or opening Chats', async () => {
  fake.bots = [summary('a', { state: 'needs_you' })]
  await show()
  expect(badge).toHaveBeenLastCalledWith(1)
})

it.each(['ask answered', 'chat question answered', 'work question answered', 'paused', 'deleted'])('clears the badge after %s on another window or device', async (reason) => {
  fake.bots = [summary('a', { state: 'needs_you' })]
  await show()
  expect(badge).toHaveBeenLastCalledWith(1)
  fake.bots = reason === 'deleted' ? [] : [summary('a', { state: reason === 'paused' ? 'paused' : 'idle' })]
  await change()
  expect(badge).toHaveBeenLastCalledWith(0)
  expect(host.querySelector('button[aria-label="Show sidebar"]')).not.toBeNull()
})
