import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { UIMessage } from 'ai'
import { MessageList } from '../../../src/renderer/chat/components/agent-elements/message-list'
import { useAppStore } from '../../../src/renderer/stores/appStore'
import '../../../src/renderer/styles/app.css'
import { setReplyPacing } from '../../../src/renderer/lib/replyPacingSetting'

// Streamed text shows as it arrives: the reply's line is read on the first frames.
setReplyPacing(false)

useAppStore.setState({ activeThreadId: 'fixture', profileId: 'profile' })

const tool = (id: string, step: number) => ({
  type: 'tool-Bash',
  toolCallId: `${id}-${step}`,
  state: 'output-available',
  input: { command: `npm run step-${step}`, label: `Run step ${step}` },
  output: { stdout: `step ${step} finished`, exitCode: 0 },
})

/**
 * A finished turn that did a lot of work: many tool calls, folded behind its Worked line, and a short answer. Its
 * height estimate counts every call, so it sits far above what the folded row measures.
 */
function turn(thread: string, index: number): UIMessage[] {
  return [
    { id: `${thread}-u-${index}`, role: 'user', parts: [{ type: 'text', text: `Prompt ${index}` }] },
    ...Array.from({ length: 4 }, (_, message) => ({
      id: `${thread}-w-${index}-${message}`,
      role: 'assistant',
      parts: Array.from({ length: 6 }, (_, step) => tool(`${thread}-${index}-${message}`, step)),
    })),
    { id: `${thread}-a-${index}`, role: 'assistant', parts: [{ type: 'text', text: `Answer ${index}: done.` }] },
  ] as UIMessage[]
}

/** A thread of `count` turns whose last turn is still running: its prompt and the start of its reply. */
function thread(name: string, count: number): UIMessage[] {
  const finished = Array.from({ length: count - 1 }, (_, index) => turn(name, index)).flat()
  return [
    ...finished,
    { id: `${name}-u-live`, role: 'user', parts: [{ type: 'text', text: 'Keep going' }] },
    { id: `${name}-a-live`, role: 'assistant', parts: [{ type: 'text', text: 'Working on it: live-reply-sentinel' }] },
  ] as UIMessage[]
}

const root = createRoot(document.getElementById('root')!)
const errors: string[] = []
window.addEventListener('error', (event) => errors.push(event.message))
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)))
const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
const container = () => document.querySelector<HTMLElement>('.an-message-list')!

/** What the transcript shows: rows that reach into its viewport, the space under the content, the live reply's place. */
function view() {
  const box = container().getBoundingClientRect()
  const rows = [...container().querySelectorAll<HTMLElement>('[data-turn-key]')].filter((row) => {
    const rect = row.getBoundingClientRect()
    return rect.bottom > box.top && rect.top < box.bottom
  })
  const reserve = container().querySelector<HTMLElement>('[data-end-reserve]')?.getBoundingClientRect().height ?? 0
  let live: number | null = null
  const walker = document.createTreeWalker(container(), NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.includes('live-reply-sentinel')) live = node.parentElement!.getBoundingClientRect().bottom - box.top
  }
  return { rowsInView: rows.length, reserve: Math.round(reserve), live, clientHeight: container().clientHeight, windowed: container().dataset.windowed === 'true' }
}

;(window as unknown as { qa: unknown }).qa = {
  /** Opens thread `name` the way a switch does: a new transcript for it, mounted with its turns. Samples every frame. */
  open: async (name: string, count: number, frames: number) => {
    flushSync(() =>
      root.render(
        <div style={{ height: 760, width: 900, display: 'flex', flexDirection: 'column' }}>
          <MessageList key={name} messages={thread(name, count)} status="streaming" threadId={name} />
        </div>,
      ),
    )
    const samples = [view()]
    for (let index = 0; index < frames; index++) {
      await frame()
      samples.push(view())
    }
    return samples
  },
  errors: () => errors,
  unmount: () => root.unmount(),
}
