// @vitest-environment jsdom
import type { UIMessage } from 'ai'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Each Markdown body parse goes through Streamdown: count its renders.
const counts = vi.hoisted(() => ({ parses: 0 }))
vi.mock('streamdown', async (load) => {
  const real = await load<typeof import('streamdown')>()
  const { createElement: h } = await import('react')
  return {
    ...real,
    Streamdown: (props: Parameters<typeof real.Streamdown>[0]) => {
      counts.parses += 1
      return h(real.Streamdown, props)
    },
  }
})

import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'

const turns = (n: number): UIMessage[] =>
  Array.from({ length: n }, (_, index) => [
    { id: `u${index}`, role: 'user', parts: [{ type: 'text', text: `Prompt ${index}` }] },
    { id: `a${index}`, role: 'assistant', parts: [{ type: 'text', text: `## Reply ${index}\n\n- one\n- two\n\n\`\`\`ts\nconst x = ${index}\n\`\`\`` }] },
  ]).flat() as unknown as UIMessage[]

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  counts.parses = 0
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('scrolling the transcript', () => {
  it('does not parse any Markdown again', async () => {
    const messages = turns(12)
    await act(async () => {
      root.render(createElement(MessageList, { messages, status: 'ready' }))
    })
    const afterMount = counts.parses
    expect(afterMount).toBeGreaterThan(0)
    const list = host.querySelector('.an-message-list') as HTMLElement
    // A person scrolling: wheel and scroll events, the scrollbar shown and hidden again, follow mode left.
    for (let step = 0; step < 20; step += 1) {
      await act(async () => {
        list.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }))
        list.scrollTop = Math.max(0, 2000 - step * 100)
        list.dispatchEvent(new Event('scroll'))
        vi.advanceTimersByTime(16)
      })
    }
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    expect(counts.parses).toBe(afterMount)
  })
})
