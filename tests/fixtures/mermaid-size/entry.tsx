import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { UIMessage } from 'ai'
import { MessageList } from '../../../src/renderer/chat/components/agent-elements/message-list'
import '../../../src/renderer/styles/app.css'
// The interface font, as main.tsx loads it.
import '../../../src/renderer/styles/geist-fonts.css'

/** The reported reply: a top-down flowchart of six steps with two-line labels. */
const TALL = [
  'flowchart TD',
  '  A["1. Find the busiest spot<br/>a row, column or box with only 1-2 empty cells"] --> B["Row 8 had just 2 empty cells"]',
  '  B --> C["2. Read the pencil marks there<br/>both cells could only be the same 2 numbers, A and B"]',
  '  C --> D["3. Follow where they sit<br/>both cells are in the bottom-right box"]',
  '  D --> E["So A and B are taken in that box<br/>cross them off every other cell"]',
  '  E --> F["4. Check what is left"]',
].join('\n')

/** A left-to-right chain wider than the message column. */
const WIDE = [
  'flowchart LR',
  '  A[Read the request] --> B[Find the files] --> C[Plan the change] --> D[Write the code]',
  '  D --> E[Run the tests] --> F[Take screenshots] --> G[Open the pull request] --> H[Merge it]',
].join('\n')

/** A short diagram that fits as drawn: it must not be stretched to the column. */
const SMALL = 'flowchart LR\n  A[Plan] --> B[Ship]'

const DIAGRAMS: Record<string, string> = { tall: TALL, wide: WIDE, small: SMALL }

const messages = (name: string): UIMessage[] => [
  { id: `u-${name}`, role: 'user', parts: [{ type: 'text', text: 'how did you solve it?' }] },
  { id: `a-${name}`, role: 'assistant', parts: [{ type: 'text', text: `I went through the same few checks every time:\n\n\`\`\`mermaid\n${DIAGRAMS[name]}\n\`\`\`\n\nThat is the whole method.` }] },
] as UIMessage[]

const root = createRoot(document.getElementById('root')!)
const errors: string[] = []
window.addEventListener('error', (event) => errors.push(event.message))
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)))

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))

/** The alpha of a computed colour: `rgba(…, a)`, `color(srgb … / a)`, or 1. */
function alphaOf(color: string): number {
  const slash = /\/\s*([\d.]+%?)\s*\)$/.exec(color)
  if (slash) return slash[1]!.endsWith('%') ? parseFloat(slash[1]!) / 100 : parseFloat(slash[1]!)
  const rgba = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/.exec(color)
  if (rgba) return parseFloat(rgba[1]!)
  return color === 'transparent' || color === 'none' ? 0 : 1
}

function measure() {
  const body = document.querySelector<HTMLElement>('.an-md-diagram-body')!
  const svg = body.querySelector('svg')!
  const [, , naturalWidth, naturalHeight] = (svg.getAttribute('viewBox') ?? '').split(/\s+/).map(Number)
  const text = svg.querySelector('text')!
  const node = svg.querySelector('rect[fill]')!
  const reply = document.querySelector<HTMLElement>('.an-markdown p')!
  const style = getComputedStyle(body)
  const box = svg.getBoundingClientRect()
  const nodeFill = getComputedStyle(node).fill
  return {
    natural: { width: naturalWidth!, height: naturalHeight! },
    drawn: { width: box.width, height: box.height },
    body: {
      width: body.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      height: body.getBoundingClientRect().height,
    },
    textSize: parseFloat(getComputedStyle(text).fontSize),
    replySize: parseFloat(getComputedStyle(reply).fontSize),
    textFont: getComputedStyle(text).fontFamily,
    replyFont: getComputedStyle(reply).fontFamily,
    nodeFill,
    nodeFillAlpha: alphaOf(nodeFill),
    expand: Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Expand'),
  }
}

;(window as unknown as { qa: unknown }).qa = {
  show: (name: string, theme: 'dark' | 'light' | 'acrylic') => {
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark'
    document.documentElement.dataset.acrylic = theme === 'acrylic' ? 'true' : 'false'
    // Something behind the acrylic window, so see-through fills show in a capture.
    document.documentElement.style.background = theme === 'acrylic' ? 'linear-gradient(135deg, #36506a, #6a4a2c)' : ''
    flushSync(() => root.render(
      <div style={{ height: 760, width: 900, display: 'flex', flexDirection: 'column' }}>
        <MessageList key={`${name}-${theme}`} messages={messages(name)} status="ready" />
      </div>,
    ))
  },
  ready: () => Boolean(document.querySelector('.an-md-diagram[data-mermaid-state="ready"] .an-md-diagram-body svg')),
  frames: async (count: number) => { for (let index = 0; index < count; index++) await frame() },
  measure,
  expand: () => {
    Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Expand')!.click()
  },
  errors: () => errors,
  unmount: () => root.unmount(),
}
