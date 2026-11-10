import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { UIMessage } from 'ai'
import { MessageList } from '../../../src/renderer/chat/components/agent-elements/message-list'
import '../../../src/renderer/styles/app.css'

const html = ['```html', '<!doctype html>', '<html lang="en">', '<head><title>Equations</title></head>', '<body></body>', '</html>', '```'].join('\n')
const ts = (name: string) => ['```ts', `const ${name} = 1`, `console.log(${name})`, '```'].join('\n')

/** Each case is one prompt and one reply; the copy button of every code block in the reply is measured. */
const CASES: Record<string, { reply: string; streaming?: boolean }> = {
  // The reported reply: nothing but one fenced block, right under the prompt.
  only: { reply: html },
  sequence: { reply: [ts('first'), 'Some prose between the blocks.', ts('middle'), 'More prose.', ts('last')].join('\n\n') },
  list: { reply: ['1. Step one:', '', '   ```ts', '   const listed = 1', '   ```', '', '2. Step two.'].join('\n') },
  quote: { reply: ['> Quoted:', '>', '> ```ts', '> const quoted = 1', '> ```'].join('\n') },
  // A reply still streaming: one finished block and one still open at the end.
  streaming: { reply: [ts('done'), 'Now the page:', '```html', '<!doctype html>', '<html lang="en">'].join('\n'), streaming: true },
}

const messages = (name: string): UIMessage[] => [
  { id: `u-${name}`, role: 'user', parts: [{ type: 'text', text: 'render in html' }] },
  { id: `a-${name}`, role: 'assistant', parts: [{ type: 'text', text: CASES[name]!.reply }] },
] as UIMessage[]

const root = createRoot(document.getElementById('root')!)
const errors: string[] = []
window.addEventListener('error', (event) => errors.push(event.message))
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)))

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))

type Measured = {
  /** The copy button's wrapper is laid out against its own code block. */
  ownBlock: boolean
  /** The element it is laid out against, for the failure message. */
  against: string | null
  /** The button's box lies inside its own block's header row. */
  inHeader: boolean
  button: { top: number; right: number }
  header: { top: number; bottom: number; right: number }
}

const box = (element: Element) => element.getBoundingClientRect()

function measure(): Measured[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-streamdown="code-block"]')).map((block) => {
    const header = block.querySelector('[data-streamdown="code-block-header"]')!
    const actions = block.querySelector('[data-streamdown="code-block-actions"]')
    const button = actions?.querySelector('button')
    const wrapper = actions?.parentElement as HTMLElement | undefined
    const h = box(header)
    const b = button ? box(button) : null
    const against = wrapper?.offsetParent as HTMLElement | null | undefined
    return {
      ownBlock: against === block,
      against: against ? `${against.tagName.toLowerCase()}.${against.className}`.slice(0, 120) : null,
      inHeader: !!b && b.top >= h.top - 0.5 && b.bottom <= h.bottom + 0.5 && b.left >= h.left && b.right <= h.right + 0.5,
      button: { top: b?.top ?? -1, right: b?.right ?? -1 },
      header: { top: h.top, bottom: h.bottom, right: h.right },
    }
  })
}

;(window as unknown as { qa: unknown }).qa = {
  cases: () => Object.keys(CASES),
  show: (name: string) => flushSync(() => root.render(
    <div style={{ height: 760, width: 900, display: 'flex', flexDirection: 'column' }}>
      <MessageList key={name} messages={messages(name)} status={CASES[name]!.streaming ? 'streaming' : 'ready'} />
    </div>,
  )),
  /** Every block of the shown reply has its header and copy button. */
  ready: (count: number) => {
    const blocks = document.querySelectorAll('[data-streamdown="code-block"]')
    return blocks.length === count && Array.from(blocks).every((block) => block.querySelector('[data-streamdown="code-block-actions"] button'))
  },
  frames: async (count: number) => { for (let index = 0; index < count; index++) await frame() },
  measure,
  errors: () => errors,
  unmount: () => root.unmount(),
}
