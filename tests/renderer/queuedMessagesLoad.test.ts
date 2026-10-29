// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueuedMessages } from '../../src/renderer/components/QueuedMessages'
import { readableError } from '../../src/renderer/lib/errorText'
import type { QueuedMessage } from '../../src/shared/types'

const OVERLOAD = new Error("Error invoking remote method 'queue:list': Error: Too many pending requests")
const item = { id: 'q1', content: 'Run the tests next', createdAt: 1 } as unknown as QueuedMessage

describe('loading the queue', () => {
  let host: HTMLDivElement
  let root: Root
  let list: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    list = vi.fn()
    ;(window as unknown as { mousse: unknown }).mousse = { queue: { list, onUpdated: () => () => undefined } }
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
  })

  const mount = async () => {
    act(() => root.render(createElement(QueuedMessages, { threadId: 't1' })))
    // The 120 ms fallback load, then every retry.
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
  }
  const banner = () => host.querySelector('.queued-messages-error')

  it('shows no banner when a failed load recovers on a retry', async () => {
    list.mockRejectedValueOnce(OVERLOAD).mockRejectedValueOnce(OVERLOAD).mockResolvedValue([item])
    await mount()
    expect(list).toHaveBeenCalledTimes(3)
    expect(banner()).toBeNull()
    expect(host.textContent).toContain('Run the tests next')
  })

  it('shows a readable banner, without the IPC prefix, only when every try fails', async () => {
    list.mockRejectedValue(OVERLOAD)
    await mount()
    expect(list).toHaveBeenCalledTimes(3)
    expect(banner()?.textContent).toContain('Mousse is busy. Try again in a moment.')
    expect(host.textContent).not.toContain('Error invoking remote method')
  })
})

describe('readableError', () => {
  it('drops the IPC prefix and the error label', () => {
    expect(readableError(new Error("Error invoking remote method 'queue:list': MmsProtocolError: Thread not found"), 'x')).toBe('Thread not found')
    expect(readableError(new Error("Error invoking remote method 'queue:list': Error: Too many pending requests"), 'x')).toBe('Mousse is busy. Try again in a moment.')
    expect(readableError(new Error(''), 'Could not load the queue.')).toBe('Could not load the queue.')
  })
})
