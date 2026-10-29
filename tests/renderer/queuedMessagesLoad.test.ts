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

  const mount = async (threadId = 't1') => {
    act(() => root.render(createElement(QueuedMessages, { threadId })))
    // The 120 ms fallback load.
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
  }
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  const banner = () => host.querySelector('.queued-messages-error')

  it('shows no banner or error text while loads keep failing, and retries with backoff then every 5 s', async () => {
    list.mockRejectedValue(OVERLOAD)
    await mount()
    expect(list).toHaveBeenCalledTimes(1)
    await advance(500)
    expect(list).toHaveBeenCalledTimes(2)
    await advance(1000)
    expect(list).toHaveBeenCalledTimes(3)
    await advance(2000)
    expect(list).toHaveBeenCalledTimes(4)
    await advance(5000)
    expect(list).toHaveBeenCalledTimes(5)
    await advance(5000)
    expect(list).toHaveBeenCalledTimes(6)
    expect(banner()).toBeNull()
    expect(host.textContent).not.toMatch(/busy|Error|Could not/)
  })

  it('logs once per failure streak', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    list.mockRejectedValue(OVERLOAD)
    await mount()
    await advance(20_000)
    expect(list.mock.calls.length).toBeGreaterThan(3)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('shows the list once a retry succeeds', async () => {
    list.mockRejectedValueOnce(OVERLOAD).mockRejectedValueOnce(OVERLOAD).mockResolvedValue([item])
    await mount()
    expect(host.textContent).not.toContain('Run the tests next')
    await advance(1500)
    expect(list).toHaveBeenCalledTimes(3)
    expect(banner()).toBeNull()
    expect(host.textContent).toContain('Run the tests next')
    await advance(20_000)
    expect(list).toHaveBeenCalledTimes(3)
  })

  it('stops retrying when the component unmounts', async () => {
    list.mockRejectedValue(OVERLOAD)
    await mount()
    act(() => root.unmount())
    const calls = list.mock.calls.length
    await advance(30_000)
    expect(list).toHaveBeenCalledTimes(calls)
    root = createRoot(host)
  })

  it('stops retrying the old thread when the thread changes', async () => {
    list.mockRejectedValue(OVERLOAD)
    await mount('t1')
    act(() => root.render(createElement(QueuedMessages, { threadId: null })))
    const calls = list.mock.calls.length
    await advance(30_000)
    expect(list).toHaveBeenCalledTimes(calls)
    expect(banner()).toBeNull()
  })
})

describe('readableError', () => {
  it('drops the IPC prefix and the error label', () => {
    expect(readableError(new Error("Error invoking remote method 'queue:list': MmsProtocolError: Thread not found"), 'x')).toBe('Thread not found')
    expect(readableError(new Error("Error invoking remote method 'queue:list': Error: Too many pending requests"), 'x')).toBe('Mousse is busy. Try again in a moment.')
    expect(readableError(new Error(''), 'Could not load the queue.')).toBe('Could not load the queue.')
  })
})
