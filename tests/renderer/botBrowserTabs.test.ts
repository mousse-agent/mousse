// @vitest-environment jsdom
/**
 * A bot's side panel, Browser view: the bot's own browser and, beside it, one tab per thread the bot started whose agent
 * has a browser, labelled with the thread's title. Choosing a thread's tab shows that thread's browser, and Take over
 * there takes that thread's browser. A started thread with no browser has no tab; with none, there is no tab row.
 */
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BotSidePanel, useBotSidePanel } from '../../src/renderer/components/bots/BotSidePanel'
import { setBotBrowserTransport, useBotBrowser, useBotBrowserStore } from '../../src/renderer/stores/botBrowserStore'
import { setThreadBrowserTransport, useThreadBrowserStore } from '../../src/renderer/stores/threadBrowserStore'
import type { BotBrowserView } from '../../src/shared/bots/personal/browser'
import type { BotLaunchedThread, BotSummary } from '../../src/shared/bots/personal/chat'
import type { ThreadBrowserView } from '../../src/shared/browser/threadView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

let root: Root
let host: HTMLElement
let threadViews: Record<string, ThreadBrowserView>
let botView: BotBrowserView | undefined
let calls: Array<{ method: string; params: Record<string, unknown> }>
const threadInitial = useThreadBrowserStore.getInitialState()
const botInitial = useBotBrowserStore.getInitialState()

const launched = (threadId: string, title: string): BotLaunchedThread => ({ threadId, title, status: 'running', startedAt: '2026-11-27T06:10:00.000Z', updatedAt: '2026-11-27T06:11:00.000Z' })
const bot = { id: 'bot_a', name: 'MoussePRBot', threads: [launched('thread_app', 'GitHub App setup'), launched('thread_docs', 'Docs pass')] } as unknown as BotSummary

function Harness() {
  const side = useBotSidePanel(bot.id)
  const browser = useBotBrowser(bot.id)
  useEffect(() => { side.show('browser') }, [])
  return createElement(BotSidePanel, { bot, state: side, browser, folder: null, file: null, onFile: () => undefined })
}

beforeEach(() => {
  threadViews = {
    thread_app: { open: true, control: 'bot', tab: { url: 'https://github.com/settings/apps/new', title: 'Register new GitHub App' } },
    thread_docs: { open: false, control: 'bot' }
  }
  botView = { open: true, control: 'bot', activations: ['act_1'], tab: { url: 'https://example.com/', title: 'Example' } }
  calls = []
  ;(window as unknown as { mousse: unknown }).mousse = { platformRequest: { request: vi.fn(async () => ({ ok: true })) }, browser: { onViewFrame: () => () => {} }, personalBots: { onBrowserFrame: () => () => {} } }
  setThreadBrowserTransport((async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params })
    const threadId = params.threadId as string
    if (method === 'browser.view.hold') {
      threadViews[threadId] = { ...threadViews[threadId]!, control: 'owner', holder: 'this-view' }
      return { browser: threadViews[threadId], hold: { id: 'hold_1', lastSeq: 0, computer: 'This PC' } }
    }
    if (method === 'browser.view.unwatch') return { ok: true }
    return { browser: threadViews[threadId] }
  }) as never)
  setBotBrowserTransport((async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params })
    if (method === 'bots.browser.unwatch') return { ok: true }
    if (!botView) throw Object.assign(new Error('No browser yet'), { code: 'not_found' })
    return { browser: botView }
  }) as never)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setThreadBrowserTransport(null)
  setBotBrowserTransport(null)
  useThreadBrowserStore.setState(threadInitial)
  useBotBrowserStore.setState(botInitial)
})

const tabRow = () => host.querySelector('[role="group"][aria-label="MoussePRBot\'s browsers"]')
const tab = (name: string) => [...(tabRow()?.querySelectorAll('button') ?? [])].find((entry) => entry.textContent === name)
const button = (name: string) => [...host.querySelectorAll('button')].find((entry) => entry.textContent === name || entry.getAttribute('aria-label') === name)

describe('a bot\'s Browser view, with the browsers of the threads it started', () => {
  it('lists the bot\'s own browser and each started thread that has one; choosing a thread shows and takes over its browser', async () => {
    act(() => root.render(createElement(Harness)))
    await vi.waitFor(() => expect(tab('GitHub App setup')).toBeDefined())
    // The thread whose agent has no browser has no tab.
    expect([...tabRow()!.querySelectorAll('button')].map((entry) => entry.textContent)).toEqual(['MoussePRBot', 'GitHub App setup'])
    expect(tab('MoussePRBot')!.getAttribute('aria-pressed')).toBe('true')
    expect(host.querySelector('aside.watched-browser-pane')!.getAttribute('aria-label')).toBe('MoussePRBot\'s browser')

    act(() => tab('GitHub App setup')!.click())
    await vi.waitFor(() => expect(host.querySelector('aside.watched-browser-pane')!.getAttribute('aria-label')).toBe('GitHub App setup: the agent\'s browser'))
    expect(tab('GitHub App setup')!.getAttribute('aria-pressed')).toBe('true')
    expect(tab('MoussePRBot')!.getAttribute('aria-pressed')).toBe('false')

    act(() => button('Take over')!.click())
    await vi.waitFor(() => expect(calls.find((call) => call.method === 'browser.view.hold')?.params).toMatchObject({ threadId: 'thread_app', request: { op: 'take' } }))
  })

  it('shows a started thread\'s browser first while the bot has not used its own', async () => {
    botView = undefined
    act(() => root.render(createElement(Harness)))
    await vi.waitFor(() => expect(host.querySelector('aside.watched-browser-pane')?.getAttribute('aria-label')).toBe('GitHub App setup: the agent\'s browser'))
    expect(tab('GitHub App setup')!.getAttribute('aria-pressed')).toBe('true')
  })

  it('has no tab row while no thread it started has a browser', async () => {
    threadViews.thread_app = { open: false, control: 'bot' }
    act(() => root.render(createElement(Harness)))
    await vi.waitFor(() => expect(calls.filter((call) => call.method === 'browser.view.get').map((call) => call.params.threadId)).toEqual(expect.arrayContaining(['thread_app', 'thread_docs'])))
    await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve() })
    expect(tabRow()).toBeNull()
    expect(host.querySelector('aside.watched-browser-pane')!.getAttribute('aria-label')).toBe('MoussePRBot\'s browser')
  })
})
