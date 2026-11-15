import './preload'
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
const bot: BotSummary = { id: 'wide', name: 'alpha', description: 'Looks after my PC.', look: { colour: 'green', accessory: 'beret' }, state: 'idle', stateText: '', unread: 0, createdAt: AT }
const row = (seq: number, author: 'bot' | 'owner', text: string): BotChatMessage => ({ seq, id: `m${seq}`, at: AT, author, kind: 'text', text, chips: [] })

/** Two replies that fill the bubble's width (long words, a table), a short one, and the owner's messages between. */
const MESSAGES: BotChatMessage[] = [
  row(1, 'owner', 'run some command pls'),
  row(2, 'bot', 'Done. I ran a few commands that only read info, and nothing was changed. Want me to run something next? I could list the apps using the most memory, find your biggest folders, or check your network.'),
  row(3, 'owner', 'and the drives?'),
  row(4, 'bot', ['| Drive | Free | Size |', '|---|---|---|', '| C: | 268.5 GB free out of 951.8 GB | 1 TB NVMe system drive |', '| D: | 1.2 TB free out of 1.8 TB | 2 TB SATA storage drive |'].join('\n')),
  row(5, 'bot', 'Short one.')
]
const WIDE = ['m2', 'm4']

const client = new Proxy({
  list: async () => [bot],
  get: async () => ({ summary: bot, permissions: [], runs: [] }),
  messages: async () => ({ messages: MESSAGES }),
  markRead: async () => undefined
} as Record<string, unknown>, { get: (target, key: string) => target[key] ?? (async () => { throw new Error(`${key} is not in the fixture`) }) }) as unknown as PersonalBotsClient

const root = createRoot(document.getElementById('root')!)
const errors: string[] = []
window.addEventListener('error', (event) => errors.push(event.message))
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)))
const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
const transcript = () => document.querySelector<HTMLElement>('.bot-conversation .chat-transcript')!
const article = (id: string) => document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!
let width = 0

/** The chat in a pane of `px` wide, as the Chats tab gives it beside its list. */
function render(px: number) {
  width = px
  flushSync(() => root.render(<div className="chat-workspace" style={{ display: 'flex', width: px, height: 720 }}><BotChatView bot={bot} /></div>))
}

;(window as unknown as { qa: unknown }).qa = {
  load: async () => {
    setBotsClient(client)
    await useBotsStore.getState().refresh()
    await useBotsStore.getState().loadChat(bot.id)
  },
  render,
  /** A fresh chat at `px`: no reply's tools keep a move from an earlier step. */
  remount: (px: number) => { flushSync(() => root.render(<></>)); render(px) },
  ready: () => MESSAGES.every((message) => article(message.id)?.querySelector('.bot-bubble, .bot-you-bubble')) && WIDE.every((id) => article(id).querySelector('.bot-message-tools button')),
  frames: async (count: number) => { for (let index = 0; index < count; index++) await frame() },
  /** The middle of a reply's bubble, in page pixels, for a real pointer move. */
  point: (id: string) => { const box = article(id).querySelector('.bot-bubble')!.getBoundingClientRect(); return { x: Math.round(box.left + 40), y: Math.round(box.top + box.height / 2) } },
  /** Keyboard focus on a reply's Copy. */
  focusCopy: (id: string) => { article(id).querySelector<HTMLButtonElement>('.bot-message-tools button[aria-label="Copy"]')!.focus(); return document.activeElement?.getAttribute('aria-label') },
  /** Focus on the last control before a reply, so that the next Tab enters it. */
  focusBefore: (id: string) => {
    const target = article(id)
    const before = Array.from(document.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, textarea, [tabindex]:not([tabindex="-1"])'))
      .filter((element) => !target.contains(element) && element.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING)
    before.at(-1)!.focus()
    return document.hasFocus()
  },
  /** The focused control's label while the focus is in reply `id`, else null. */
  focusedIn: (id: string) => (article(id).contains(document.activeElement) ? document.activeElement!.getAttribute('aria-label') ?? document.activeElement!.tagName : null),
  /** The transcript's sideways overflow, and where a reply's tools are when shown. */
  measure: (id?: string) => {
    const lane = transcript()
    const edge = lane.getBoundingClientRect().left + lane.clientWidth
    const tools = id ? article(id).querySelector<HTMLElement>('.bot-message-tools') : null
    const shown = tools ? Array.from(tools.querySelectorAll<HTMLElement>('button')).filter((button) => Number(getComputedStyle(button.closest('.bot-react-bar, .bot-message-actions') ?? button).opacity) > 0.5) : []
    return {
      width,
      scrollWidth: lane.scrollWidth,
      clientWidth: lane.clientWidth,
      ...(tools ? {
        open: tools.getBoundingClientRect().width > 0 && shown.length > 0,
        // The rightmost visible tool's right edge, against the transcript's.
        over: Math.max(...shown.map((button) => button.getBoundingClientRect().right)) - edge
      } : {})
    }
  },
  errors: () => errors,
  unmount: () => root.unmount()
}
