import { homeThread } from './preload'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { BotChatMessage, BotSummary } from '../../../src/shared/bots/personal/chat'
import type { PersonalBotsClient } from '../../../src/renderer/services/personalBotsClient'
import { BotChatView } from '../../../src/renderer/components/bots/BotChatView'
import { setBotsClient, useBotsStore } from '../../../src/renderer/stores/botsStore'
import '../../../src/renderer/styles/app.css'
import '../../../src/renderer/styles/chats.css'
import '../../../src/renderer/styles/bots.css'

const AT = '2026-11-07T09:00:00.000Z'
// Working on a chat turn in its home thread: what that thread writes is the reply streaming into the chat.
const bot: BotSummary = { id: 'alpha', name: 'alpha', description: 'Looks after my PC.', look: { colour: 'green', accessory: 'beret' }, state: 'working', stateText: 'Working…', unread: 0, createdAt: AT, homeThreadId: 'home1', chat: { activationId: 'act1' } }
const WORDS = 'the drive check finished and the backup folder is smaller than last week so nothing needs moving today'.split(' ')
const prose = (seed: number, length: number) => { let text = ''; for (let index = seed; text.length < length; index++) text += `${WORDS[(index * 7) % WORDS.length]} `; return text.trim() }
/**
 * 160 messages, more than the chat loads at first (50) and draws (60). "lighthouse" is in the newest message, on screen,
 * and in the oldest, which is neither loaded nor drawn when the search starts.
 */
const MESSAGES: BotChatMessage[] = Array.from({ length: 160 }, (_, index) => {
  const seq = index + 1
  const marked = seq === 1 || seq === 160 ? ' The lighthouse photo is attached.' : ''
  return { seq, id: `m${seq}`, at: AT, author: seq % 2 ? 'owner' : 'bot', kind: 'text', text: `${prose(seq, 80 + (seq * 37) % 400)}.${marked}`, chips: [] }
})

const client = new Proxy({
  list: async () => [bot],
  get: async () => ({ summary: bot, permissions: [], runs: [] }),
  messages: async (_botId: string, page: { beforeSeq?: number; limit?: number } = {}) => {
    const before = page.beforeSeq === undefined ? MESSAGES : MESSAGES.filter((message) => message.seq < page.beforeSeq!)
    return { messages: before.slice(-(page.limit ?? 50)) }
  },
  markRead: async () => undefined
} as Record<string, unknown>, { get: (target, key: string) => target[key] ?? (async () => { throw new Error(`${key} is not in the fixture`) }) }) as unknown as PersonalBotsClient

const root = createRoot(document.getElementById('root')!)
const errors: string[] = []
window.addEventListener('error', (event) => errors.push(event.message))
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)))
const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
const transcript = () => document.querySelector<HTMLElement>('.bot-conversation .chat-transcript')!
let streamed = ''
let streaming: ReturnType<typeof setInterval> | undefined

;(window as unknown as { qa: unknown }).qa = {
  load: async () => {
    setBotsClient(client)
    // Listens to the home thread, as the app does for the profile it opens.
    useBotsStore.getState().activate('profile')
    await useBotsStore.getState().refresh()
    await useBotsStore.getState().loadChat(bot.id)
    flushSync(() => root.render(<div className="chat-workspace" style={{ display: 'flex', width: 1000, height: 720 }}><BotChatView bot={bot} /></div>))
  },
  ready: () => Boolean(document.querySelector('[data-message-id="m160"]')),
  frames: async (count: number) => { for (let index = 0; index < count; index++) await frame() },
  /** The reply starts streaming in the home thread: a few words every 30 ms, a paragraph now and then. */
  stream: () => {
    for (const listener of homeThread.added) listener({ threadId: 'home1', message: { id: 'u1', role: 'user', content: 'Check the drives.', timestamp: AT } })
    let words = 0
    streaming = setInterval(() => {
      words += 1
      streamed += `checking drive ${words} for free space${words % 10 === 0 ? '.\n\n' : ' '}`
      for (const listener of homeThread.updated) listener({ threadId: 'home1', message: { id: 'r1', role: 'assistant', content: streamed, timestamp: AT, streaming: true } })
    }, 30)
  },
  /** How tall the reply's live bubble is: it grows while the reply streams. */
  liveHeight: () => document.querySelector('.bot-conversation .bot-live-reply')?.getBoundingClientRect().height ?? 0,
  /** Opens Find from the bot's menu. */
  openFind: async () => {
    document.querySelector<HTMLButtonElement>('button[aria-label="Bot menu"]')!.click()
    for (let index = 0; index < 30; index++) {
      const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"], button')).find((element) => element.textContent?.trim() === 'Find in chat')
      if (item) { item.click(); return true }
      await frame()
    }
    return false
  },
  /** Types the query the way a person does: React sees an input event. */
  search: (value: string) => {
    const field = document.querySelector<HTMLInputElement>('input[aria-label="Find in chat"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  },
  /** The centre of a find bar button, in page pixels, for a real click. */
  point: (label: string) => { const box = document.querySelector(`button[aria-label="${label}"]`)!.getBoundingClientRect(); return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) } },
  /** The count, the message the current match is in and whether it shows, and how far the view is from the chat's end. */
  view: () => {
    const lane = transcript()
    const box = lane.getBoundingClientRect()
    const highlight = (CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights.get('mousse-find-active')
    const range = highlight ? Array.from(highlight)[0] : undefined
    const rect = range?.getBoundingClientRect()
    return {
      count: document.querySelector('.chat-find-count')?.textContent ?? null,
      message: range?.startContainer.parentElement?.closest<HTMLElement>('[data-message-id]')?.dataset.messageId ?? null,
      inView: rect ? rect.height > 0 && rect.top >= box.top && rect.bottom <= box.bottom : false,
      fromEnd: Math.round(lane.scrollHeight - lane.scrollTop - lane.clientHeight)
    }
  },
  errors: () => errors,
  unmount: () => { clearInterval(streaming); root.unmount() }
}
