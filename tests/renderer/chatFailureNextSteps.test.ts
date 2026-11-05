// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { ToolRenderer } from '../../src/renderer/chat/components/agent-elements/tools/tool-renderer'
import { ToolCallsGroup } from '../../src/renderer/chat/components/agent-elements/tools/tool-calls-group'
import { BashToolTerminalCard } from '../../src/renderer/chat/components/agent-elements/tools/bash-tool'
import { ErrorMessage } from '../../src/renderer/chat/components/agent-elements/error-message'
import { createTurnActions, TurnActionsContext, type TurnActions } from '../../src/renderer/chat/components/agent-elements/turn-actions'
import { chatStatusFromPhase, mousseToUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
import type { ChatImageAttachment, ChatMessage } from '../../src/shared/types'
import { RunInterruptedNotice } from '../../src/renderer/chat/components/MousseAgentChatShell'
import type { TimelineStep } from '../../src/renderer/chat/components/agent-elements/types/timeline'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const render = (element: ReactElement) => act(() => root.render(element))
const text = () => host.textContent?.replace(/\s+/g, ' ') ?? ''
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

describe('a failed tool', () => {
  it('reads "Failed <tool>" for a generic tool', () => {
    render(createElement(ToolRenderer, { part: { type: 'tool-Read', toolCallId: 'r1', state: 'output-error', input: { file_path: 'src/app.ts' } } }))
    expect(text()).toContain('Failed Read')
    expect(text()).toContain('app.ts')
  })

  it('reads "Failed <tool>" for an MCP tool', () => {
    render(createElement(ToolRenderer, { part: { type: 'tool-mcp__tracker__search_issues', toolCallId: 'm1', state: 'output-error', input: { query: 'crash' } } }))
    expect(text()).toContain('Failed Search Issues')
  })

  it('keeps a title that already says the call failed', () => {
    render(createElement(ToolRenderer, { part: { type: 'tool-Subagent', subagentTool: 'delegate_task', toolCallId: 's1', state: 'output-error', input: {} } }))
    expect(text()).toContain("Couldn't start subagent")
    expect(text()).not.toContain('Failed')
  })

  it('does not say failed for a successful call', () => {
    render(createElement(ToolRenderer, { part: { type: 'tool-Read', toolCallId: 'r1', state: 'output-available', input: { file_path: 'a.ts' }, output: 'x' } }))
    expect(text()).not.toContain('Failed')
  })
})

describe('a tool call group with failures', () => {
  const group = (failed: number, live: boolean) =>
    createElement(ToolCallsGroup, { count: 3, failed, live, children: createElement('div', { 'data-testid': 'rows' }, 'rows') })
  const open = () => host.querySelector('[data-testid="rows"]') !== null && !host.querySelector('[hidden] [data-testid="rows"]')

  it('names the failures in the collapsed header', () => {
    render(group(1, false))
    expect(text()).toMatch(/Tool calls\s*3\s*· 1 failed/)
    expect(open()).toBe(false)
  })

  it('opens itself the first time a failure lands while the turn runs', () => {
    render(group(0, true))
    expect(open()).toBe(false)
    render(group(1, true))
    expect(open()).toBe(true)
  })

  it('stays closed when an old turn loads with a failure', () => {
    render(group(2, false))
    expect(open()).toBe(false)
  })
})

describe('the command card', () => {
  const step = (patch: Partial<Extract<TimelineStep, { type: 'tool-call' }>>) =>
    ({ id: 'b1', type: 'tool-call', toolName: 'Bash', bashCommand: 'npm test', ...patch }) as Extract<TimelineStep, { type: 'tool-call' }>
  const card = (patch: Partial<Extract<TimelineStep, { type: 'tool-call' }>>, isError = false) =>
    createElement(BashToolTerminalCard, { step: step(patch), state: 'complete', onComplete: () => {}, isError })

  it('shows no status for a successful command', () => {
    render(card({ bashExitCode: 0 }))
    expect(host.querySelectorAll('svg')).toHaveLength(2) // terminal icon and chevron only
    expect(text()).not.toContain('exit')
  })

  it('shows the exit code of a failed command without expanding', () => {
    render(card({ bashExitCode: 2 }, true))
    expect(text()).toContain('Failed npm')
    expect(text()).toContain('exit 2')
  })

  it('copies the command and the output from the expanded card', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(card({ bashExitCode: 0, bashOutput: 'all passed' }))
    act(() => button('Expand command details')!.click())
    await act(async () => button('Copy command')!.click())
    await act(async () => button('Copy output')!.click())
    expect(writeText.mock.calls).toEqual([['npm test'], ['all passed']])
  })
})

describe('an error in the transcript', () => {
  it('offers Retry when given one', () => {
    const onRetry = vi.fn()
    render(createElement(ErrorMessage, { title: 'Request failed', message: 'Rate limited', onRetry }))
    expect(text()).toContain('Request failed')
    act(() => button('Retry')!.click())
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('has no box and no button without a retry', () => {
    render(createElement(ErrorMessage, { message: 'Rate limited' }))
    expect(host.querySelector('button')).toBeNull()
    expect(host.innerHTML).not.toMatch(/bg-red|border-red/)
  })

  const turn = (id: string, prompt: string): UIMessage[] => [
    { id: `${id}-u`, role: 'user', parts: [{ type: 'text', text: prompt }] },
    { id: `${id}-a`, role: 'assistant', parts: [{ type: 'error', title: 'Request failed', message: 'Overloaded' }] } as unknown as UIMessage
  ]
  const actions = (): TurnActions => ({ retryTitle: () => 'Retry', retry: vi.fn(), continueRun: vi.fn() })
  const list = (value: TurnActions, status: 'ready' | 'streaming') =>
    createElement(TurnActionsContext.Provider, { value }, createElement(MessageList, { messages: [...turn('t1', 'First'), ...turn('t2', 'Second')], status }))

  it('retries the last turn only', () => {
    const value = actions()
    render(list(value, 'ready'))
    expect(host.querySelectorAll('button[aria-label="Retry"]')).toHaveLength(1)
    act(() => button('Retry')!.click())
    expect(value.retry).toHaveBeenCalledWith('t2-u')
  })

  it('offers no Retry while a run streams', () => {
    render(list(actions(), 'streaming'))
    expect(button('Retry')).toBeNull()
  })
})

describe('a failed turn', () => {
  const failedThread: ChatMessage[] = [
    { id: 'u1', role: 'user', content: 'Fix the staging deploy', timestamp: '2026-11-05T10:00:00.000Z' },
    {
      id: 's1',
      role: 'system',
      content: '[provider_request_invalid] The provider could not accept this request.',
      timestamp: '2026-11-05T10:00:01.000Z',
      error: { code: 'provider_request_invalid', message: 'The provider could not accept this request.' }
    }
  ]
  const shown = (messages: ChatMessage[], send: (content: string, images?: ChatImageAttachment[]) => void) =>
    createElement(
      TurnActionsContext.Provider,
      { value: createTurnActions({ prompt: (id) => messages.find((message) => message.id === id && message.role === 'user'), send }) },
      createElement(MessageList, { messages: mousseToUIMessages(messages), status: chatStatusFromPhase('failed') })
    )

  it('shows its error in the transcript with Retry', () => {
    render(shown(failedThread, vi.fn()))
    expect(text()).toContain('Request failed')
    expect(text()).toContain('The provider could not accept this request.')
    expect(button('Retry')?.disabled).toBe(false)
  })

  it('sends the prompt again through the send path on Retry', () => {
    const send = vi.fn()
    render(shown(failedThread, send))
    act(() => button('Retry')!.click())
    expect(send).toHaveBeenCalledExactlyOnceWith('Fix the staging deploy', undefined)
  })

  it('resends the images it still has and says when some are missing', () => {
    const send = vi.fn()
    const withImages: ChatMessage[] = [
      { ...failedThread[0], images: [{ name: 'a.png', mimeType: 'image/png', data: 'AAAA' }, { name: 'b.png', mimeType: 'image/png', data: '' }] },
      failedThread[1]
    ]
    render(shown(withImages, send))
    act(() => button('Retry (images not resent)')!.click())
    expect(send).toHaveBeenCalledWith('Fix the staging deploy', [{ name: 'a.png', mimeType: 'image/png', data: 'AAAA' }])
  })

  it('keeps other lines from Mousse out of the transcript', () => {
    expect(mousseToUIMessages([{ id: 's2', role: 'system', content: 'Turn stopped.', timestamp: '2026-11-05T10:00:02.000Z' }])
      .flatMap((message) => message.parts).some((part) => (part as { type: string }).type === 'error')).toBe(false)
  })
})

describe('a stopped run', () => {
  const continueButton = () => [...host.querySelectorAll('button')].find((entry) => entry.textContent === 'Continue')

  it('offers Continue on the interrupted notice', () => {
    const onContinue = vi.fn()
    render(createElement(RunInterruptedNotice, { onContinue }))
    expect(text()).toContain('Run interrupted')
    act(() => continueButton()!.click())
    expect(onContinue).toHaveBeenCalledOnce()
  })

  it('shows no Continue without one, as while a run is going', () => {
    render(createElement(RunInterruptedNotice, {}))
    expect(continueButton()).toBeUndefined()
  })
})
