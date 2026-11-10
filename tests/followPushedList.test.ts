import { describe, expect, it } from 'vitest'
import { followPushedList } from '../src/renderer/lib/followPushedList'

function setup(options: { withPush?: boolean } = {}) {
  const win = new EventTarget() as unknown as Window
  const state = { visibility: 'visible' as DocumentVisibilityState }
  const doc = Object.defineProperties(new EventTarget(), { visibilityState: { get: () => state.visibility } }) as unknown as Document
  let tick: (() => void) | undefined
  let interval = 0
  let cleared = false
  let changed: (() => void) | undefined
  let reads = 0
  const stop = followPushedList({
    refresh: () => { reads += 1 },
    fallbackMs: 60_000,
    ...(options.withPush ? { onChanged: (listener) => { changed = listener; return () => { changed = undefined } } } : {}),
    window: win,
    document: doc,
    setInterval: (run, ms) => { tick = run; interval = ms; return 1 },
    clearInterval: () => { cleared = true }
  })
  return {
    win, doc, state, stop,
    reads: () => reads, tick: () => tick?.(), push: () => changed?.(), interval: () => interval, cleared: () => cleared, subscribed: () => changed !== undefined
  }
}

describe('a pushed list is read again only when it may have changed', () => {
  it('waits for the slow fallback instead of polling', () => {
    const list = setup()
    expect(list.interval()).toBe(60_000)
    expect(list.reads()).toBe(0)
    list.tick()
    expect(list.reads()).toBe(1)
  })

  it('reads when the service says the list changed', () => {
    const list = setup({ withPush: true })
    list.push()
    list.push()
    expect(list.reads()).toBe(2)
  })

  it('reads when the window comes back, since pushes to a sleeping or hidden window may be missed', () => {
    const list = setup()
    list.win.dispatchEvent(new Event('focus'))
    list.state.visibility = 'hidden'
    list.doc.dispatchEvent(new Event('visibilitychange'))
    expect(list.reads()).toBe(1)
    list.state.visibility = 'visible'
    list.doc.dispatchEvent(new Event('visibilitychange'))
    expect(list.reads()).toBe(2)
  })

  it('reads nothing while the window is hidden', () => {
    const list = setup({ withPush: true })
    list.state.visibility = 'hidden'
    list.tick()
    list.push()
    list.win.dispatchEvent(new Event('focus'))
    expect(list.reads()).toBe(0)
  })

  it('stops listening and its timer when stopped', () => {
    const list = setup({ withPush: true })
    list.stop()
    expect(list.cleared()).toBe(true)
    expect(list.subscribed()).toBe(false)
    list.win.dispatchEvent(new Event('focus'))
    expect(list.reads()).toBe(0)
  })
})
