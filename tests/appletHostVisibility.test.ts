import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appletHostBlocked,
  subscribeAppletHostVisibility
} from '../src/renderer/components/applets/hostVisibility'

afterEach(() => vi.unstubAllGlobals())
describe('native applet host overlay visibility', () => {
  it('shares one observer and notifies hide/remount when a host menu opens/closes', () => {
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
    const transitions: boolean[] = []
    const unsub = subscribeAppletHostVisibility(() => transitions.push(appletHostBlocked()))
    const other = subscribeAppletHostVisibility(() => {})
    frames.shift()!()
    changed()
    frames.shift()!()
    expect(transitions).toEqual([false])
    menuOpen = true
    changed()
    frames.shift()!()
    menuOpen = false
    changed()
    frames.shift()!()
    expect(transitions).toEqual([false, true, false])
    expect(constructor).toHaveBeenCalledTimes(1)
    unsub()
    expect(disconnect).not.toHaveBeenCalled()
    other()
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(appletHostBlocked()).toBe(false)
  })
})
