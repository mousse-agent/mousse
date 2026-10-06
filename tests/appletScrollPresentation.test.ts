import { afterEach, expect, it, vi } from 'vitest'
import { subscribeAppletScroll } from '../src/renderer/components/applets/scrollPresentation'
class ElementStub {
  parentElement: ElementStub | null = null
  scrollHeight = 1000
  clientHeight = 300
  scrollTop = 0
  overflowY = 'auto'
  listeners = new Map<string, EventListener>()
  addEventListener(type: string, fn: EventListener) {
    this.listeners.set(type, fn)
  }
  removeEventListener(type: string) {
    this.listeners.delete(type)
  }
  scrollBy = vi.fn()
}
function setup() {
  vi.useFakeTimers()
  vi.stubGlobal('Element', ElementStub)
  vi.stubGlobal('getComputedStyle', (node: ElementStub) => ({ overflowY: node.overflowY }))
  const scroller = new ElementStub()
  const header = new ElementStub()
  header.parentElement = scroller
  header.overflowY = 'visible'
  const wheel = (extra: Record<string, unknown> = {}) => {
    const event = {
      target: header,
      deltaX: 0,
      deltaY: 12,
      deltaMode: 0,
      ctrlKey: false,
      defaultPrevented: false,
      preventDefault: vi.fn(),
      ...extra
    }
    scroller.listeners.get('wheel')!(event as unknown as Event)
    return event
  }
  return { scroller, wheel, header }
}
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it('queues the first wheel deltas until all visible guest snapshots are ready', async () => {
  const { scroller, wheel } = setup()
  let ready!: () => void
  const a = {
    active: () => true,
    suspend: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve
        })
    ),
    resume: vi.fn()
  }
  const b = { active: () => false, suspend: vi.fn(), resume: vi.fn() }
  const unsub = subscribeAppletScroll(scroller as unknown as HTMLElement, a)
  const other = subscribeAppletScroll(scroller as unknown as HTMLElement, b)
  expect(wheel().preventDefault).toHaveBeenCalledOnce()
  expect(wheel({ deltaY: -4 }).preventDefault).toHaveBeenCalledOnce()
  expect(scroller.scrollBy).not.toHaveBeenCalled()
  expect(b.suspend).not.toHaveBeenCalled()
  ready()
  await Promise.resolve()
  await Promise.resolve()
  expect(scroller.scrollBy).toHaveBeenCalledWith({ left: 0, top: 8, behavior: 'instant' })
  expect(wheel().preventDefault).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(140)
  expect(a.resume).toHaveBeenCalledOnce()
  unsub()
  other()
  expect(scroller.listeners.size).toBe(0)
})
it('preserves source-panel scrolling and control-wheel zoom', () => {
  const { scroller, wheel, header } = setup()
  const preview = { active: () => true, suspend: vi.fn(async () => {}), resume: vi.fn() }
  const unsub = subscribeAppletScroll(scroller as unknown as HTMLElement, preview)
  expect(wheel({ ctrlKey: true }).preventDefault).not.toHaveBeenCalled()
  const source = new ElementStub()
  source.parentElement = header
  expect(wheel({ target: source }).preventDefault).not.toHaveBeenCalled()
  expect(preview.suspend).not.toHaveBeenCalled()
  unsub()
})
it('discards queued motion after thread teardown', async () => {
  const { scroller, wheel } = setup()
  let ready!: () => void
  const unsub = subscribeAppletScroll(scroller as unknown as HTMLElement, {
    active: () => true,
    suspend: () =>
      new Promise<void>((resolve) => {
        ready = resolve
      }),
    resume: vi.fn()
  })
  wheel()
  unsub()
  ready()
  await Promise.resolve()
  await Promise.resolve()
  expect(scroller.scrollBy).not.toHaveBeenCalled()
})
