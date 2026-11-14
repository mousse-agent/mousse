import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { getDefaultSettings, type ThemeId } from '../../../src/shared/settings'
import { applyAppearance } from '../../../src/renderer/hooks/useTheme'
import { useBotsStore } from '../../../src/renderer/stores/botsStore'
import { NewBotDialog } from '../../../src/renderer/components/bots/NewBotDialog'

// No service: New bot's model choices are refused, so it shows Look and What it does.
;(window as unknown as { mousse: unknown }).mousse = { platform: 'win32', platformRequest: { request: () => Promise.reject(new Error('no service in this fixture')) } }

const errors: string[] = []
window.addEventListener('error', (event) => errors.push(event.message))
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)))

const LINE = 'The sandbox research will look at the actual Mousse repo on your disk and base the ideas on the real bot code. '
/** A busy bot chat: long, high-contrast lines everywhere the dialog and its fields could sit. */
function Transcript() {
  return <main className="chat-workspace" id="transcript" style={{ position: 'fixed', inset: 0, display: 'block', overflow: 'hidden', padding: 12, fontSize: 18, lineHeight: 1.5, color: 'var(--text-primary)' }}>
    {Array.from({ length: 30 }, (_, index) => <p key={index} style={{ margin: 0, whiteSpace: 'nowrap', fontWeight: index % 3 ? 400 : 700 }}>{LINE.repeat(3)}</p>)}
  </main>
}

const root = createRoot(document.getElementById('root')!)
const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
const rect = (element: Element | null) => { const r = element!.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom } }

;(window as unknown as { qa: unknown }).qa = {
  /** The owner's appearance, as the app applies it. */
  appearance: (theme: ThemeId, acrylic: boolean) => applyAppearance({ ...getDefaultSettings().appearance, theme, acrylic }),
  /** New bot on What it does, with a name typed and the sentence still empty (its placeholder showing), over the chat. */
  show: () => {
    useBotsStore.setState((state) => ({ newBotOpen: true, newBotDraft: { ...state.newBotDraft, name: 'Funbo', step: 'about', touched: true } }))
    flushSync(() => root.render(<><Transcript /><NewBotDialog /></>))
  },
  ready: () => Boolean(document.querySelector('#bot-new-text')),
  frames: async (count: number) => { for (let index = 0; index < count; index++) await frame() },
  /** Shows or hides the chat behind without moving anything. No caret either: it blinks between two captures. */
  behind: (visible: boolean) => {
    (document.activeElement as HTMLElement | null)?.blur()
    document.getElementById('transcript')!.style.visibility = visible ? 'visible' : 'hidden'
  },
  measure: () => ({
    window: { width: window.innerWidth, height: window.innerHeight },
    dialog: rect(document.querySelector('[role="dialog"]')),
    name: rect(document.querySelector('#bot-new-name')),
    text: rect(document.querySelector('#bot-new-text')),
  }),
  errors: () => errors,
  unmount: () => root.unmount(),
}
