import './preload'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { BotSummary } from '../../../src/shared/bots/personal/chat'
import type { PersonalBotsClient } from '../../../src/renderer/services/personalBotsClient'
import { ChatsSidebar } from '../../../src/renderer/components/chats/ChatsSidebar'
import { setBotsClient, useBotsStore } from '../../../src/renderer/stores/botsStore'
import { useChatsStore } from '../../../src/renderer/stores/chatsStore'
import '../../../src/renderer/styles/app.css'

const AT = '2026-11-07T09:00:00.000Z'
const bot = (id: string, over: Partial<BotSummary>): BotSummary => ({ id, name: id, description: '', look: { colour: 'teal', accessory: 'cap' }, state: 'idle', stateText: '', unread: 0, createdAt: AT, ...over })
/** One bot per kind of line: working, waiting on the owner, idle (asleep), paused. */
const BOTS: BotSummary[] = [
  bot('Busy', { state: 'working', stateText: 'Working…', work: [{ id: 'w', title: 'Merging PR #1354', status: 'running', startedAt: AT }], last: { text: 'On it', at: '2026-11-07T09:04:00.000Z', author: 'bot' } }),
  bot('Asking', { state: 'needs_you', stateText: 'Wants to use files on this computer', unread: 2, last: { text: 'May I?', at: '2026-11-07T09:03:00.000Z', author: 'bot' } }),
  bot('Resting', { last: { text: 'Done.', at: '2026-11-07T09:02:00.000Z', author: 'bot' } }),
  bot('Off', { state: 'paused', stateText: 'Paused', last: { text: 'Bye', at: '2026-11-07T09:01:00.000Z', author: 'bot' } })
]

const client = new Proxy({ list: async () => BOTS } as Record<string, unknown>, {
  get: (target, key: string) => target[key] ?? (async () => { throw new Error(`${key} is not in the fixture`) })
}) as unknown as PersonalBotsClient

const root = createRoot(document.getElementById('root')!)
const errors: string[] = []
window.addEventListener('error', (event) => errors.push(event.message))
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)))
const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
/** Red, green, blue and alpha (1 when the colour has none). */
const rgb = (colour: string) => { const [r, g, b, a = 1] = (colour.match(/[\d.]+/g) ?? []).map(Number); return [r!, g!, b!, a] }
const rect = (element: Element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } }
const rows = () => [...document.querySelectorAll<HTMLButtonElement>('.chats-sidebar-content button[aria-label^="Message "]')]

/** Small round marks with no words in them, outside the face's own drawing: what a status dot would be. */
function dots(row: Element): number {
  return [...row.querySelectorAll<HTMLElement>('*')].filter((element) => {
    if (element.closest('svg, canvas, .bot-face')) return false
    const { width, height } = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return width > 0 && height > 0 && width <= 12 && height <= 12 && !element.textContent?.trim()
      && parseFloat(style.borderTopLeftRadius) >= width / 2 && style.backgroundColor !== 'rgba(0, 0, 0, 0)'
  }).length
}

/** A probe with a colour, as the app's CSS resolves it here. */
function resolved(colour: string): number[] {
  const probe = document.body.appendChild(Object.assign(document.createElement('span'), { textContent: 'x' }))
  probe.style.color = colour
  const value = rgb(getComputedStyle(probe).color)
  probe.remove()
  return value
}

/** The live face's markup as BotFace draws it (tests/renderer/botFace.test.ts checks the attributes), with the app's CSS. */
function liveFace(attributes: Record<string, string>) {
  const face = document.body.appendChild(document.createElement('span'))
  face.className = 'bot-face bot-face-live'
  for (const [name, value] of Object.entries(attributes)) face.setAttribute(name, value)
  face.style.width = face.style.height = '36px'
  face.innerHTML = '<canvas class="bot-face-canvas"></canvas><span class="bot-face-z" style="font-size:8px">z</span>'
  const z = face.querySelector('.bot-face-z')!
  const measured = { canvasOpacity: Number(getComputedStyle(face.querySelector('canvas')!).opacity), zOpacity: Number(getComputedStyle(z).opacity), zAnimation: getComputedStyle(z).animationName, zDisplay: getComputedStyle(z).display, z: rect(z), face: rect(face) }
  face.remove()
  return measured
}

;(window as unknown as { qa: unknown }).qa = {
  load: async () => {
    setBotsClient(client)
    useChatsStore.getState().activate('p1')
    useChatsStore.setState({ snapshot: { agents: [], chats: [], devices: [] } })
    await useBotsStore.getState().refresh()
    flushSync(() => root.render(<div className="app" style={{ width: 300, background: '#111' }}><ChatsSidebar /></div>))
  },
  ready: () => rows().length === BOTS.length,
  frames: async (count: number) => { for (let index = 0; index < count; index++) await frame() },
  measure: () => {
    const sidebar = rect(document.querySelector('.chats-sidebar-content')!)
    return {
      sidebar,
      rows: rows().map((row) => {
        const face = row.querySelector<HTMLElement>('.bot-face')!
        const z = face.querySelector('text')
        const line = row.querySelector('[data-tone]')!
        return {
          name: row.getAttribute('aria-label')!.replace('Message ', ''),
          text: line.textContent,
          colour: rgb(getComputedStyle(line).color),
          dots: dots(row),
          face: { tag: face.tagName.toLowerCase(), opacity: Number(getComputedStyle(face).opacity), state: face.getAttribute('data-state') },
          z: z ? { text: z.textContent, rect: rect(z), opacity: Number(getComputedStyle(z).opacity) } : null,
          row: rect(row)
        }
      }),
      colours: { secondary: resolved('var(--text-secondary)'), warning: resolved('var(--warning)') },
      live: {
        paused: liveFace({ 'data-state': 'paused' }),
        resting: liveFace({ 'data-state': 'paused', 'data-resting': 'true' }),
        // Motion off (Animation speed Off or the OS setting): BotFace marks the face still.
        restingStill: liveFace({ 'data-state': 'paused', 'data-resting': 'true', 'data-still': 'true' })
      },
      sections: [...document.querySelectorAll<HTMLButtonElement>('.chat-section-heading h2 button')].map((button) => ({
        title: button.textContent,
        expanded: button.getAttribute('aria-expanded'),
        chevron: getComputedStyle(button.querySelector('svg')!).transform
      })),
      newBot: Boolean(document.querySelector('button[aria-label="New bot"]'))
    }
  },
  fold: (title: string) => [...document.querySelectorAll<HTMLButtonElement>('.chat-section-heading h2 button')].find((button) => button.textContent === title)!.click(),
  errors: () => errors
}
