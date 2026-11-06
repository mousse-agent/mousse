import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { UIMessage } from 'ai'
import { expect, it, vi } from 'vitest'

// The button reads its text only when pressed: a stand-in shows what it was given.
vi.mock('../src/renderer/readAloud/ReadAloudButton', () => ({
  useIsReadingAloud: () => false,
  ReadAloudButton: ({ markdown }: { markdown: string }) => createElement('span', { 'data-speech': markdown })
}))

const { MessageList } = await import('../src/renderer/chat/components/agent-elements/message-list')

it('reads only the answer of a turn, not the notes the agent wrote while it worked', () => {
  const html = renderToStaticMarkup(
    createElement(MessageList, {
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Start the app' }] },
        { id: 'n1', role: 'assistant', parts: [{ type: 'text', text: 'Checking the start script first.' }] },
        {
          id: 'c1',
          role: 'assistant',
          parts: [{ type: 'tool-Bash', toolCallId: 'c1', state: 'output-available', input: { command: 'npm start' }, output: { stdout: '', exitCode: 0 } }]
        },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'The app starts on port 3000.' }] }
      ] as unknown as UIMessage[],
      status: 'ready'
    })
  )
  const spoken = [...html.matchAll(/data-speech="([^"]*)"/g)].map((match) => match[1])
  // The prompt reads itself; the turn reads its answer.
  expect(spoken).toEqual(['Start the app', 'The app starts on port 3000.'])
})
