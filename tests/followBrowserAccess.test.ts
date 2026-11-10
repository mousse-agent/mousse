import { describe, expect, it } from 'vitest'
import { followBrowserAccess } from '../src/renderer/lib/followBrowserAccess'

function setup(start: { shown?: boolean; visibility?: DocumentVisibilityState } = {}) {
  const state = { shown: start.shown ?? true, visibility: start.visibility ?? ('visible' as DocumentVisibilityState) }
  const doc = Object.defineProperties(new EventTarget(), { visibilityState: { get: () => state.visibility } }) as unknown as Document
  const timers: Array<{ run: () => void; ms: number } | null> = []
  let pushed: (() => void) | undefined
  let reads = 0
  let release: (() => void) | undefined
  let hold = false
  const stop = followBrowserAccess({
    read: async () => {
      reads += 1
      if (hold) await new Promise<void>((resolve) => { release = resolve })
    },
    shown: () => state.shown,
    onChanged: (listener) => { pushed = listener; return () => { pushed = undefined } },
    document: doc,
    setTimer: (run, ms) => timers.push({ run, ms }) - 1,
    clearTimer: (index) => { timers[index as number] = null }
  })
  const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve() }
  const next = () => timers.filter(Boolean).at(-1)
  return {
    state, doc, stop, flush, next,
    reads: () => reads,
    push: () => pushed?.(),
    subscribed: () => pushed !== undefined,
    pending: () => timers.filter(Boolean).length,
    hold: (on: boolean) => { hold = on },
    release: () => release?.()
  }
}

describe('the Browser panel follows the agents browser access', () => {
  it('polls every 750 ms while the panel is shown, and every 30 seconds while it is hidden', async () => {
    const shown = setup()
    await shown.flush()
    expect(shown.reads()).toBe(1)
    expect(shown.next()?.ms).toBe(750)
    const hidden = setup({ shown: false })
    await hidden.flush()
    expect(hidden.next()?.ms).toBe(30_000)
    const minimised = setup({ visibility: 'hidden' })
    await minimised.flush()
    expect(minimised.next()?.ms).toBe(30_000)
  })

  it('reads at once when the service says the state changed, even while hidden, so an agent gets its tab', async () => {
    const panel = setup({ shown: false })
    await panel.flush()
    panel.push()
    await panel.flush()
    expect(panel.reads()).toBe(2)
    // The push replaced the pending tick: one timer, never two.
    expect(panel.pending()).toBe(1)
  })

  it('reads once more after a read that a push arrived during', async () => {
    const panel = setup()
    await panel.flush()
    panel.hold(true)
    panel.next()!.run()
    await panel.flush()
    expect(panel.reads()).toBe(2)
    panel.push()
    panel.push()
    panel.hold(false)
    panel.release()
    await panel.flush()
    expect(panel.reads()).toBe(3)
  })

  it('reads when the window shows again, and stops listening when stopped', async () => {
    const panel = setup({ visibility: 'hidden' })
    await panel.flush()
    panel.state.visibility = 'visible'
    panel.doc.dispatchEvent(new Event('visibilitychange'))
    await panel.flush()
    expect(panel.reads()).toBe(2)
    panel.stop()
    expect(panel.subscribed()).toBe(false)
    expect(panel.pending()).toBe(0)
    panel.doc.dispatchEvent(new Event('visibilitychange'))
    await panel.flush()
    expect(panel.reads()).toBe(2)
  })
})
