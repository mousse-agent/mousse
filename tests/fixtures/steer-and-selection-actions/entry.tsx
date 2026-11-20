import React, { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { MessageList } from '../../../src/renderer/chat/components/agent-elements/message-list'
import { mousseToUIMessages } from '../../../src/renderer/chat/adapters/mousseToUI'
import { PromptUndoProvider } from '../../../src/renderer/components/PromptUndoControls'
import { SelectionReplyButton } from '../../../src/renderer/components/SelectionReplyButton'
import { useAppStore } from '../../../src/renderer/stores/appStore'
import type { ChatMessage, Thread } from '../../../src/shared/types'
import '../../../src/renderer/styles/app.css'

const at = (n: number) => new Date(Date.UTC(2026, 10, 18, 10, 0, 0) + n * 1000).toISOString()
const LONG = 'Also, before you change anything in the build, check whether the lockfile still matches package.json, and if it does not, regenerate it with the same npm version the CI image uses so the diff stays small.'
const messages: ChatMessage[] = [
  { id: 'u', role: 'user', content: 'Fix the build', timestamp: at(0), turnId: 't1' },
  { id: 'a1', role: 'assistant', content: 'Looking at the failing step first.', timestamp: at(1), turnId: 't1' },
  { id: 's1', role: 'user', content: 'use pnpm, not npm', timestamp: at(2), turnId: 't1', steered: true },
  { id: 's2', role: 'user', content: LONG, timestamp: at(3), turnId: 't1', steered: true },
  { id: 's3', role: 'user', content: 'The cache key changed yesterday.', timestamp: at(4), turnId: 't1', steered: true, origin: { kind: 'agent', threadId: 'helper', runId: 'run:helper', hops: 1, title: 'Helper' } },
  { id: 'a2', role: 'assistant', content: 'Switched to pnpm and regenerated the lockfile.', timestamp: at(5), turnId: 't1' },
] as ChatMessage[]

useAppStore.setState({ activeThreadId: 'thread', profileId: 'profile', threads: [{ id: 'thread', name: 'Fix the build' } as Thread] })
// The turn's history, so the prompt actions are the real ones (Repeat this included) rather than a bare toolbar.
const proof = { compactionGeneration: 0, fidelity: 'exact' as const, safeBoundaryProof: 'test' }
const actions = [{ id: 'action-t1', turnId: 't1', conversationBranchId: 'main', state: 'completed', nativeContextStartBoundary: { messageIndex: 0, ...proof }, nativeContextBoundary: { messageIndex: 5, ...proof } }]
;(window as unknown as { mousse: unknown }).mousse = { actions: { list: async () => ({ actions, receipts: [], journalGeneration: 1, activeBranchId: 'main' }) } }
let setPaneWidth: (width: string) => void = () => {}
const root = createRoot(document.getElementById('root')!)
const errors: string[] = []
window.addEventListener('error', (event) => errors.push(event.message))
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)))
const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
const box = (element: Element | null) => {
  if (!element) return null
  const { left, right, top, bottom, width, height } = element.getBoundingClientRect()
  return { left, right, top, bottom, width, height }
}

function Chat() {
  const ui = useMemo(() => mousseToUIMessages(messages), [])
  const [width, setWidth] = useState('100vw')
  setPaneWidth = setWidth
  return (
    <PromptUndoProvider threadId="thread" busy={false} revision={1}>
      <div style={{ width, display: 'flex', flexDirection: 'column' }}>
        <div style={{ height: 520, display: 'flex', flexDirection: 'column' }}>
          <MessageList messages={ui} status="ready" />
        </div>
        <textarea className="composer-input" />
        <SelectionReplyButton />
      </div>
    </PromptUndoProvider>
  )
}

;(window as unknown as { qa: unknown }).qa = {
  show: () => flushSync(() => root.render(<Chat />)),
  ready: () => document.querySelectorAll('[data-steered-id] .chat-message-toolbar').length === 3,
  /** Narrows the chat pane, as a split view or a small window would. */
  narrow: (width: number) => flushSync(() => setPaneWidth(`${width}px`)),
  /** Every steer's actions, once Repeat this is among them (the menu shows once the turn's history has arrived). */
  repeatReady: () => document.querySelectorAll('[data-steered-id] .chat-message-toolbar button[aria-label="Message actions"]').length === 2,
  frames: async (count: number) => { for (let index = 0; index < count; index++) await frame() },
  /** Each steered message: its row, its message, its bubble and its actions. */
  steers: () => [...document.querySelectorAll('[data-steered-id]')].map((item) => ({
    id: item.getAttribute('data-steered-id'),
    item: box(item),
    message: box(item.firstElementChild),
    bubble: box(item.querySelector('.chat-user-bubble')),
    actions: box(item.querySelector('.chat-message-toolbar')),
  })),
  /** Selects the first steer's text, which ends near the window's right edge, and measures the bar beside it. */
  select: async () => {
    const text = document.querySelector('[data-steered-id="s1"] .chat-user-text')!
    const range = document.createRange()
    range.selectNodeContents(text)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    for (let index = 0; index < 5; index++) await frame()
    const bar = document.querySelector('[role="toolbar"][aria-label="Selected text actions"]')
    return {
      windowWidth: window.innerWidth,
      selectionRight: [...range.getClientRects()].at(-1)!.right,
      bar: box(bar),
      buttons: bar ? [...bar.querySelectorAll('button')].map((button) => button.getAttribute('aria-label')) : [],
    }
  },
  /** For the screenshot: every steer's actions shown, as on hover. */
  reveal: async () => {
    for (const toolbar of document.querySelectorAll<HTMLElement>('[data-steered-id] .chat-message-toolbar')) toolbar.style.opacity = '1'
    await frame(); await frame()
  },
  errors: () => errors,
  unmount: () => root.unmount(),
}
