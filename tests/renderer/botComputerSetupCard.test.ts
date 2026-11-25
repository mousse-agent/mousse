// @vitest-environment jsdom
/**
 * A bot's setup card for computer use: whichever of its runs asked, it shows in the bot's chat beside its secret requests,
 * filed under the bot's chat thread, and Not now there closes that card.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fakeBots, installPreload, summary, type FakeBots } from './fakeBotsClient'
import type { ComputerUseSetupRequestView, ComputerUseStatus } from '../../src/shared/computerUse'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/components/chats/ChatResourcesPanel', () => ({ ChatResourcesPanel: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkTranscript', () => ({ NetworkTranscript: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkChatActions', () => ({ NetworkChatActions: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkTaskPicker', () => ({ NetworkTaskPicker: () => null }))
vi.mock('../../src/renderer/components/chats/ChatBrowserAccess', () => ({ ChatBrowserAccess: () => null }))
vi.mock('../../src/renderer/components/ComposerQuestionModal', () => ({ ComposerQuestionModal: () => null }))
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

const { ChatWorkspace } = await import('../../src/renderer/components/chats/ChatWorkspace')
const { useChatsStore } = await import('../../src/renderer/stores/chatsStore')
const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')

const HOME = 'bot-home-thread'
const OPEN: ComputerUseSetupRequestView = { requestId: 'cur_9', threadId: HOME, originThreadId: 'bot-run-thread', hostName: 'Ada', reason: 'Export the invoices from the accounting app', createdAt: new Date().toISOString() }
const off: ComputerUseStatus = { state: 'found', enabled: false, installable: true, source: 'default', path: '/bin/cua-driver' }
const inbox = summary('inbox', { name: 'Inbox helper', homeThreadId: HOME })

let root: Root
let host: HTMLElement
let fake: FakeBots
let open: ComputerUseSetupRequestView | null
let calls: Array<[string, unknown]>
const chatsInitial = useChatsStore.getInitialState()
const botsInitial = useBotsStore.getInitialState()

const settle = async () => { for (let turn = 0; turn < 8; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  open = OPEN
  calls = []
  fake = fakeBots()
  const request = async (method: string, params: Record<string, unknown>) => {
    calls.push([method, params])
    if (method === 'computerUse.setupRequest.get') return { request: params.threadId === open?.threadId ? open : null }
    if (method === 'computerUse.status') return off
    if (method === 'computerUse.setupRequest.dismiss') { open = null; return { dismissed: true } }
    throw new Error('offline')
  }
  installPreload(fake, { platformRequest: { request }, orchestrator: { onComputerUseSetupRequestChanged: () => () => undefined } })
  setBotsClient(fake.client)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  setBotsClient(null)
  useChatsStore.setState(chatsInitial)
  useBotsStore.setState(botsInitial)
})

it("shows a run's request in the bot's chat, and Not now there closes the bot's card", async () => {
  fake.bots = [inbox]
  await act(async () => useChatsStore.getState().activate('p1'))
  await act(async () => root.render(createElement(ChatWorkspace)))
  await act(async () => useChatsStore.getState().openBot(inbox.id))
  await settle()
  const card = () => host.querySelector('.bot-input-area [role="group"][aria-label="Set up computer use"]')
  expect(card()?.textContent).toContain('Export the invoices from the accounting app')
  expect(calls).toContainEqual(['computerUse.setupRequest.get', { threadId: HOME }])
  const notNow = [...card()!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Not now')!
  await act(async () => { notNow.click() })
  await settle()
  expect(calls).toContainEqual(['computerUse.setupRequest.dismiss', { threadId: HOME, requestId: 'cur_9' }])
  expect(card()).toBeNull()
})
