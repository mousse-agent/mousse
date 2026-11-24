// @vitest-environment jsdom
/**
 * A composer for a chat on another computer reads that computer's models, and asks again while it does not answer.
 * A computer that refused this device gives the same answer every time, so it is asked again only when the window
 * comes back into focus. Counted at the request the window sends.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRemoteComposerOptions } from '../../src/renderer/hooks/useRunOnDevices'

const NODE = 'nod_cccccccccccccccccccccccccccccccc'

describe('asking another computer for its models again', () => {
  let host: HTMLDivElement
  let root: Root
  let calls: number

  const answerWith = (code: string) => {
    calls = 0
    ;(window as unknown as { mousse: unknown }).mousse = {
      platformRequest: { request: async () => { calls += 1; throw { code } } }
    }
  }
  const mount = async () => {
    function Probe() { useRemoteComposerOptions(NODE as never); return null }
    await act(async () => { root.render(createElement(Probe)) })
  }
  const wait = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

  beforeEach(() => {
    vi.useFakeTimers()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
  })

  // Codes as the bridge returns them: refusals of this device, then failures that pass.
  it.each(['forbidden', 'revoked', 'not_member', 'not_enrolled'])('stops after %s, until the window is focused again', async (code) => {
    answerWith(code)
    await mount()
    await wait(60_000)
    expect(calls).toBe(1)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await wait(60_000)
    expect(calls).toBe(2)
  })

  it.each(['peer_offline', 'deadline_exceeded', 'rate_limited', 'not_connected'])('keeps asking after %s', async (code) => {
    answerWith(code)
    await mount()
    // 1 s, 2 s, 4 s, 8 s after the first read.
    await wait(16_000)
    expect(calls).toBe(5)
  })
})
