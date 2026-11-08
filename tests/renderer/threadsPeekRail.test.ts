// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PEEK_CLOSE_GRACE_MS, RAIL_PEEK_INTENT_MS, useThreadsPeek } from '../../src/renderer/hooks/useThreadsPeek'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Peek = ReturnType<typeof useThreadsPeek>

describe('threads sidebar peek from the rail', () => {
  let host: HTMLDivElement
  let root: Root
  let peek: Peek

  const Probe = ({ enabled }: { enabled: boolean }) => {
    peek = useThreadsPeek(enabled)
    return null
  }
  const render = (enabled = true) => act(() => root.render(createElement(Probe, { enabled })))
  const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })

  beforeEach(() => {
    vi.useFakeTimers()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    render()
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
  })

  it('opens after resting on the rail for the intent delay', () => {
    act(() => peek.enterRail())
    wait(RAIL_PEEK_INTENT_MS - 1)
    expect(peek.open).toBe(false)
    wait(1)
    expect(peek.open).toBe(true)
  })

  it('stays closed when the pointer only passes over the rail', () => {
    act(() => peek.enterRail())
    wait(RAIL_PEEK_INTENT_MS / 2)
    act(() => peek.leaveRail())
    wait(RAIL_PEEK_INTENT_MS * 2)
    expect(peek.open).toBe(false)
  })

  it('stays closed when the pointer presses a rail icon', () => {
    act(() => peek.enterRail())
    act(() => peek.cancelIntent())
    wait(RAIL_PEEK_INTENT_MS * 2)
    expect(peek.open).toBe(false)
  })

  it('stays open moving from the rail into the panel, and closes after leaving both', () => {
    act(() => peek.enterRail())
    wait(RAIL_PEEK_INTENT_MS)
    act(() => peek.leaveRail())
    act(() => peek.show())
    wait(1000)
    expect(peek.open).toBe(true)
    act(() => peek.scheduleClose())
    act(() => peek.enterRail())
    wait(1000)
    expect(peek.open).toBe(true)
    act(() => peek.leaveRail())
    wait(PEEK_CLOSE_GRACE_MS)
    expect(peek.open).toBe(false)
  })

  it('does nothing while the sidebar is expanded', () => {
    render(false)
    act(() => peek.enterRail())
    act(() => peek.show())
    wait(RAIL_PEEK_INTENT_MS * 2)
    expect(peek.open).toBe(false)
  })
})
