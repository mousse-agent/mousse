import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { MessageList } from '../../../src/renderer/chat/components/agent-elements/message-list'
import '../../../src/renderer/styles/app.css'
import '../../../src/renderer/components/sideCard/sideCard.css'

const WORDS = 'the quick brown fox jumps over a lazy dog while reading a long transcript of prior turns'.split(' ')
const prose = (seed: number, chars: number) => {
  let out = ''
  for (let index = seed; out.length < chars; index += 1) out += `${WORDS[(index * 7) % WORDS.length]} `
  return out.trim()
}

/** `prompts` turns, each with a reply of `replyChars` characters. */
function thread(name: string, prompts: number, replyChars: number): UIMessage[] {
  return Array.from({ length: prompts }, (_, index) => [
    { id: `${name}-u${index}`, role: 'user', parts: [{ type: 'text', text: `Prompt ${index} of ${name}` }] },
    { id: `${name}-a${index}`, role: 'assistant', parts: [{ type: 'text', text: prose(index, replyChars) }] },
  ] as UIMessage[]).flat()
}

type Shown = { name: string; messages: UIMessage[]; width: number; height: number; hidden: boolean; reserved: number }
let show!: (next: Partial<Shown>) => void

function Fixture() {
  const [shown, setShown] = useState<Shown>({ name: 'none', messages: [], width: 1000, height: 800, hidden: false, reserved: 0 })
  show = (next) => setShown((previous) => ({ ...previous, ...next }))
  // The thread pane, as in the app: the docked side card writes the width it reserves on it.
  return (
    <aside className="sidebar sidebar-full" style={{ display: shown.hidden ? 'none' : 'flex', height: shown.height, width: shown.width, ['--side-card-reserved' as string]: `${shown.reserved}px` }}>
      <div className="chat" style={{ display: 'flex', height: '100%', flexDirection: 'column' }}>
        {/* Keyed per thread, as the chat shell is. */}
        <MessageList key={shown.name} messages={shown.messages} status="ready" />
      </div>
    </aside>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<Fixture />)
const frames = (count: number) => new Promise<void>((done) => {
  const step = (left: number) => (left <= 0 ? done() : requestAnimationFrame(() => step(left - 1)))
  step(count)
})

;(window as unknown as { qa: unknown }).qa = {
  thread,
  show: (next: Partial<Shown> & { prompts?: number; replyChars?: number }) => {
    const { prompts, replyChars, ...rest } = next
    show(prompts === undefined ? rest : { ...rest, messages: thread(rest.name ?? 't', prompts, replyChars ?? 200) })
  },
  frames,
  rail: () => {
    const list = document.querySelector<HTMLElement>('.an-message-list')!
    const column = list.firstElementChild as HTMLElement
    const ticks = document.querySelector<HTMLElement>('.chat-prompt-ticks')
    return {
      ticks: document.querySelectorAll('.chat-prompt-tick').length,
      // Where the transcript's text starts, and where the rail ends (viewport px).
      textLeft: Math.round(column.getBoundingClientRect().left + parseFloat(getComputedStyle(column).paddingLeft)),
      railRight: ticks ? Math.round(ticks.getBoundingClientRect().right) : null,
      // Where the pane starts, and where the rail starts (viewport px).
      paneLeft: Math.round((list.parentElement ?? list).getBoundingClientRect().left),
      railLeft: ticks ? Math.round(ticks.getBoundingClientRect().left) : null,
      scrolls: list.scrollHeight > list.clientHeight,
    }
  },
}
