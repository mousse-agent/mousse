import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appletHostBlocked,
  subscribeAppletHostVisibility
} from '../src/renderer/components/applets/hostVisibility'

afterEach(() => vi.unstubAllGlobals())
describe('native applet host overlay visibility', () => {
  it('shares one observer and re-checks hosts on page changes, including a menu opening and closing', () => {
    let changed: () => void = () => {}
    const disconnect = vi.fn()
    const observe = vi.fn()
    const constructor = vi.fn(function (this: object, callback: () => void) {
      changed = callback
      Object.assign(this, { observe, disconnect })
    })
    const frames: Array<() => void> = []
    let menuOpen = false
    vi.stubGlobal('MutationObserver', constructor)
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => {
      frames.push(fn)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('document', {
      body: {},
      querySelectorAll: () =>
        menuOpen ? [{ getClientRects: () => [1], getAttribute: () => null }] : []
    })
    const seen: boolean[] = []
    const unsub = subscribeAppletHostVisibility(() => seen.push(appletHostBlocked()))
    const other = subscribeAppletHostVisibility(() => {})
    frames.shift()!()
    expect(seen).toEqual([false])
    // Every batch of page changes re-checks the hosts, once per frame however many changes arrive.
    changed()
    changed()
    expect(frames).toHaveLength(1)
    frames.shift()!()
    expect(seen).toEqual([false, false])
    menuOpen = true
    changed()
    frames.shift()!()
    menuOpen = false
    changed()
    frames.shift()!()
    expect(seen).toEqual([false, false, true, false])
    // Pages and panes show and hide through these attributes.
    expect(observe.mock.calls[0][1].attributeFilter).toEqual(expect.arrayContaining(['hidden', 'inert', 'style', 'class']))
    expect(constructor).toHaveBeenCalledTimes(1)
    unsub()
    expect(disconnect).not.toHaveBeenCalled()
    other()
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(appletHostBlocked()).toBe(false)
  })
})
