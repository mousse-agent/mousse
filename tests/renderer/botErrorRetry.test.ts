// @vitest-environment jsdom
/**
 * A bot's failed chat turn shows its reason on the failed message with Retry there and the app's Report button: Retry
 * sends the owner's words of that turn again, and only while nothing the owner wrote came after it.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BotErrorLine } from '../../src/renderer/components/bots/BotChatView'
import { botRetryOf } from '../../src/renderer/components/bots/botRetry'
import { useBugReportStore } from '../../src/renderer/stores/bugReportStore'
import type { BotChatMessage, BotError } from '../../src/shared/bots/personal/chat'

vi.mock('../../src/renderer/dictation/microphone', () => ({}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const row = (seq: number, author: 'owner' | 'bot', extra: Partial<BotChatMessage> = {}): BotChatMessage =>
  ({ seq, id: `m${seq}`, at: '2026-11-19T10:00:00.000Z', author, kind: 'text', text: '', chips: [], ...extra }) as BotChatMessage
const failed = (seq: number, activationId: string, error: BotError = { text: 'I hit an error, so I stopped: Codex exited.' }) =>
  row(seq, 'bot', { kind: 'error', text: error.text, error, activationId })

describe('Retry on a failed bot turn', () => {
  it("sends the turn's own words and files again, joined in order, with the first one's reply", () => {
    const messages = [
      row(1, 'owner', { text: 'before', activationId: 'a0' }),
      row(2, 'owner', { text: 'fix the build', activationId: 'a1', replyTo: { id: 'm0' } as never, attachments: [{ name: 'log.txt', path: 'C:/log.txt' }] }),
      row(3, 'owner', { text: 'and the tests', activationId: 'a1' }),
      failed(4, 'a1')
    ]
    expect(botRetryOf(messages, messages[3]!)).toEqual({ text: 'fix the build\n\nand the tests', attachments: [{ name: 'log.txt', path: 'C:/log.txt' }], replyTo: 'm0' })
  })

  it('offers none once the owner wrote after it, for a line with its own way out, or for work with no message of the owner', () => {
    const asked = row(1, 'owner', { text: 'hi', activationId: 'a1' })
    expect(botRetryOf([asked, failed(2, 'a1'), row(3, 'owner', { text: 'never mind' })], failed(2, 'a1'))).toBeNull()
    const signIn = failed(2, 'a1', { text: 'Sign in again.', action: { kind: 'sign_in', label: 'Sign in' } })
    expect(botRetryOf([asked, signIn], signIn)).toBeNull()
    expect(botRetryOf([asked, failed(2, 'work')], failed(2, 'work'))).toBeNull()
  })
})

describe('the bot error line', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => useBugReportStore.getState().setSettings({ enabled: true }))
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
  })
  const buttons = () => [...host.querySelectorAll('button')].map((button) => button.textContent)

  it('shows the real reason with Retry and Report; Retry sends again', () => {
    const onRetry = vi.fn()
    act(() => root.render(createElement(BotErrorLine, { error: { text: 'I hit an error, so I stopped: spawn codex ENOENT' }, onAction: () => {}, onRetry })))
    expect(host.textContent).toContain('spawn codex ENOENT')
    expect(buttons()).toEqual(['Retry', 'Report'])
    act(() => host.querySelector<HTMLButtonElement>('button')!.click())
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('a settled line has neither, and a usage pause keeps only its own Resume', () => {
    act(() => root.render(createElement(BotErrorLine, { error: { text: 'Stopped.' }, onAction: () => {}, onRetry: () => {}, settled: true })))
    expect(buttons()).toEqual([])
    act(() => root.render(createElement(BotErrorLine, { error: { text: 'Paused until 14:00.', action: { kind: 'resume', label: 'Resume' } }, onAction: () => {} })))
    expect(buttons()).toEqual(['Resume'])
  })
})
