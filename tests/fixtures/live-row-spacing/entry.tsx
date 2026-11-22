import React, { useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { MessageList } from '../../../src/renderer/chat/components/agent-elements/message-list'
import { TurnProgressContext, type TurnProgressState } from '../../../src/renderer/chat/components/agent-elements/turn-progress'
import { mousseToUIMessages } from '../../../src/renderer/chat/adapters/mousseToUI'
import { useAppStore } from '../../../src/renderer/stores/appStore'
import type { ChatMessage } from '../../../src/shared/types'
import '../../../src/renderer/styles/app.css'

const at = (n: number) => new Date(Date.UTC(2026, 10, 18, 10, 0, 0) + n * 1000).toISOString()
const messages: ChatMessage[] = [
  { id: 'u', role: 'user', content: 'Why is the test slow?', timestamp: at(0), turnId: 't-u' },
  { id: 'th', role: 'system', kind: 'thinking', content: '', timestamp: at(1), thinking: { status: 'processing', content: "**Starting the investigation**\n\nI'm starting by looking at the test setup and what it waits for." } },
  // A call whose command has not arrived yet: the live row says "Preparing Bash…".
  { id: 'b', role: 'system', kind: 'tool_call', content: '', timestamp: at(2), toolCall: { title: 'Bash', summary: 'Preparing', details: ['Tool: Bash'], status: 'processing', toolName: 'Bash', input: {} } },
] as ChatMessage[]
const progress: TurnProgressState = { phase: 'tool', step: { kind: 'tool', tool: 'Bash' } as TurnProgressState['step'] }

useAppStore.setState({ messages, activeThreadId: 'thread', profileId: 'profile' })
const root = createRoot(document.getElementById('root')!)
const errors: string[] = []
window.addEventListener('error', (event) => errors.push(event.message))
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)))
const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
const box = (element: Element) => element.getBoundingClientRect()

function Transcript() {
  const ui = useMemo(() => mousseToUIMessages(messages), [])
  return (
    <TurnProgressContext.Provider value={progress}>
      <div style={{ height: 300, width: 760, display: 'flex', flexDirection: 'column' }}>
        <MessageList messages={ui} status="streaming" />
      </div>
    </TurnProgressContext.Provider>
  )
}

/** The px between each row's bottom and the next row's top, for the rows of one stack. */
const gaps = (rows: Element[]) => rows.slice(1).map((row, index) => box(row).top - box(rows[index]!).bottom)

;(window as unknown as { qa: unknown }).qa = {
  show: () => flushSync(() => root.render(<Transcript />)),
  ready: () => Boolean(document.querySelector('.turn-live-thought')) && Boolean(document.querySelector('.turn-live-text [data-turn-progress]')),
  frames: async (count: number) => { for (let index = 0; index < count; index++) await frame() },
  /** The thought's line and the call's line under it. */
  live: () => {
    const text = document.querySelector('.turn-live-text')!
    const lines = [...text.children]
    return { lines: lines.length, gaps: gaps(lines), height: box(document.querySelector('.turn-live')!).height, text: lines.map((line) => line.textContent) }
  },
  /** Opens the run and reports the gaps between the rows it shows. */
  open: async () => {
    document.querySelector<HTMLButtonElement>('.turn-live-toggle')?.click()
    await frame(); await frame()
    const rows = document.querySelector('.turn-live .an-tool-group-rows')
    return { rows: rows ? rows.children.length : 0, gap: rows ? parseFloat(getComputedStyle(rows).rowGap) : -1 }
  },
  errors: () => errors,
  unmount: () => root.unmount(),
}
