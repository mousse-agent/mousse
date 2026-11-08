// @vitest-environment jsdom
/**
 * An ask in a bot's message (bot-ui §4.5, Bot Phase 1 §5.4, §5.11): "<name> wants to <title>", the
 * note, Not now and Allow, then one line. An `export_memory` ask's Allow picks a folder and saves
 * the memory there through `bots.memory.export`.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotAskCard as Ask } from '../../src/shared/bots/personal/chat'
import { fakeBots, installPreload, message, summary, type FakeBots } from './fakeBotsClient'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/components/editors/MarkdownPreview', async () => {
  const { createElement: h } = await import('react')
  return { MarkdownPreview: ({ value, className }: { value: string; className?: string }) => h('div', { className }, value) }
})

const { BotAskCard, askAnswerLine } = await import('../../src/renderer/components/bots/BotAskCard')
const { BotChatView } = await import('../../src/renderer/components/bots/BotChatView')
const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')

let root: Root
let host: HTMLElement
let fake: FakeBots
let pickFolder: ReturnType<typeof vi.fn>
const botsInitial = useBotsStore.getInitialState()
const ask = (over: Partial<Ask> = {}): Ask => ({ askId: 'k1', title: 'use files on this computer', note: "Read and change any file or folder, except Mousse's own data.", status: 'open', ...over })
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent === label)
const click = async (element: Element | undefined) => { await act(async () => { (element as HTMLElement).click() }); await act(async () => {}) }

beforeEach(() => {
  fake = fakeBots()
  pickFolder = vi.fn(async () => '/home/me/Backups')
  installPreload(fake, { dialog: { pickFolder } })
  setBotsClient(fake.client)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setBotsClient(null)
  useBotsStore.setState(botsInitial)
})

describe('an open ask', () => {
  it('names the bot and what it wants, with the note and two answers', () => {
    act(() => root.render(createElement(BotAskCard, { botName: 'Notes tidier', ask: ask(), onAnswer: () => undefined })))
    expect(host.querySelector('.bot-ask-title')?.textContent).toBe('Notes tidier wants to use files on this computer')
    expect(host.querySelector('.bot-ask-title strong')?.textContent).toBe('use files on this computer')
    expect(host.querySelector('.bot-ask-note')?.textContent).toBe("Read and change any file or folder, except Mousse's own data.")
    expect([...host.querySelectorAll('.bot-ask-actions button')].map((element) => element.textContent)).toEqual(['Not now', 'Allow'])
  })

  it('leaves out an empty note', () => {
    act(() => root.render(createElement(BotAskCard, { botName: 'Bot', ask: ask({ note: '' }), onAnswer: () => undefined })))
    expect(host.querySelector('.bot-ask-note')).toBeNull()
  })

  it('answers Allow and Not now', async () => {
    const onAnswer = vi.fn()
    act(() => root.render(createElement(BotAskCard, { botName: 'Bot', ask: ask(), onAnswer })))
    await click(button('Allow'))
    await click(button('Not now'))
    expect(onAnswer.mock.calls).toEqual([['allow'], ['not_now']])
  })
})

describe('an answered ask', () => {
  it('becomes one line', () => {
    act(() => root.render(createElement(BotAskCard, { botName: 'Bot', ask: ask({ status: 'allowed' }), onAnswer: () => undefined })))
    expect(host.querySelector('.bot-ask')).toBeNull()
    expect(host.querySelector('.bot-ask-answer')?.textContent).toBe('Allowed: use files on this computer')
    expect(host.querySelector('.bot-ask-answer svg')).not.toBeNull()
  })

  it('says a run’s permission applies from the next run, and words Not now and withdrawn', () => {
    expect(askAnswerLine(ask({ status: 'allowed' }), true)).toBe('Allowed: use files on this computer. It uses it from the next run.')
    expect(askAnswerLine(ask({ status: 'not_now' }))).toBe('Not now: use files on this computer')
    expect(askAnswerLine(ask({ status: 'withdrawn' }))).toBe('No longer needed: use files on this computer')
  })
})

describe('in the chat', () => {
  const bot = summary('b1', { name: 'Notes tidier', state: 'needs_you', stateText: 'Wants to use files on this computer' })
  async function show(card: Ask) {
    fake.bots = [bot]
    fake.chats.b1 = [message(1, { text: 'Can I?', ask: card })]
    await act(async () => { await useBotsStore.getState().loadChat('b1') })
    act(() => root.render(createElement(BotChatView, { bot })))
  }

  it('sends the answer and shows the line the reply carries', async () => {
    await show(ask())
    await click(button('Allow'))
    expect(fake.calls).toContainEqual(['answer', 'b1', 'k1', 'allow'])
    expect(host.querySelector('.bot-ask-answer')?.textContent).toBe('Allowed: use files on this computer')
  })

  it('exports the memory to the folder picked, then closes the ask', async () => {
    await show(ask({ kind: 'export_memory', title: 'save its memory to a folder', note: 'You pick the folder. Nothing else changes.' }))
    await click(button('Allow'))
    expect(pickFolder).toHaveBeenCalledTimes(1)
    expect(fake.calls).toContainEqual(['exportMemory', 'b1', '/home/me/Backups'])
    expect(fake.calls).toContainEqual(['answer', 'b1', 'k1', 'allow'])
    expect(fake.calls.findIndex(([name]) => name === 'exportMemory')).toBeLessThan(fake.calls.findIndex(([name]) => name === 'answer'))
    expect(host.querySelector('.bot-ask-answer')?.textContent).toBe('Saved its memory to the folder you picked')
  })

  it('keeps the export ask open when no folder is picked', async () => {
    pickFolder.mockResolvedValueOnce(null)
    await show(ask({ kind: 'export_memory', title: 'save its memory to a folder' }))
    await click(button('Allow'))
    expect(fake.calls.some(([name]) => name === 'exportMemory' || name === 'answer')).toBe(false)
    expect(host.querySelector('.bot-ask')).not.toBeNull()
  })

  it('does nothing but answer for Not now on an export ask', async () => {
    await show(ask({ kind: 'export_memory', title: 'save its memory to a folder' }))
    await click(button('Not now'))
    expect(pickFolder).not.toHaveBeenCalled()
    expect(fake.calls).toContainEqual(['answer', 'b1', 'k1', 'not_now'])
  })
})
