import { afterEach, expect, it, vi } from 'vitest'
import { subscribeAppletScroll } from '../src/renderer/components/applets/scrollPresentation'
class ElementStub {
  parentElement: ElementStub | null = null
  scrollHeight = 1000
  clientHeight = 300
  scrollTop = 0
  overflowY = 'auto'
  listeners = new Map<string, EventListener>()
  options = new Map<string, AddEventListenerOptions>()
  addEventListener(type: string, fn: EventListener, options: AddEventListenerOptions) {
    this.listeners.set(type, fn)
    this.options.set(type, options)
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
it('keeps wheel scrolling passive while guest suspension is still pending', async () => {
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
  expect(scroller.options.get('wheel')).toEqual({ passive: true })
  expect(wheel().preventDefault).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(160)
  expect(wheel({ deltaY: -4 }).preventDefault).not.toHaveBeenCalled()
  expect(a.suspend).toHaveBeenCalledOnce()
  expect(b.suspend).toHaveBeenCalledOnce()
  expect(scroller.scrollBy).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(299)
  expect(a.resume).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(a.resume).toHaveBeenCalledOnce()
  ready()
  await Promise.resolve()
  expect(a.resume).toHaveBeenCalledOnce()
  expect(scroller.scrollBy).not.toHaveBeenCalled()
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
it('cancels idle resumption after thread teardown', async () => {
  const { scroller, wheel } = setup()
  let ready!: () => void
  const resume = vi.fn()
  const unsub = subscribeAppletScroll(scroller as unknown as HTMLElement, {
    active: () => true,
    suspend: () =>
      new Promise<void>((resolve) => {
        ready = resolve
      }),
    resume
  })
  wheel()
  unsub()
  ready()
  await Promise.resolve()
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(1000)
  expect(resume).not.toHaveBeenCalled()
  expect(scroller.scrollBy).not.toHaveBeenCalled()
})

it('skips nested layout reads when no guest is active', () => {
  const { scroller, wheel } = setup()
  const style = vi.fn(() => ({ overflowY: 'auto' }))
  vi.stubGlobal('getComputedStyle', style)
  const preview = { active: () => false, suspend: vi.fn(), resume: vi.fn() }
  const unsub = subscribeAppletScroll(scroller as unknown as HTMLElement, preview)
  wheel()
  expect(style).not.toHaveBeenCalled()
  expect(preview.suspend).not.toHaveBeenCalled()
  unsub()
})
it('continues suspending other guests after one throws or rejects', async () => {
  const { scroller, wheel } = setup()
  const a = subscribeAppletScroll(scroller as unknown as HTMLElement, {
    active: () => true,
    suspend: () => {
      throw new Error('Gone')
    },
    resume: vi.fn()
  })
  const b = subscribeAppletScroll(scroller as unknown as HTMLElement, {
    active: () => true,
    suspend: () => Promise.reject(new Error('Gone')),
    resume: vi.fn()
  })
  const suspend = vi.fn(async () => {})
  const c = subscribeAppletScroll(scroller as unknown as HTMLElement, {
    active: () => true,
    suspend,
    resume: vi.fn()
  })
  expect(wheel().preventDefault).not.toHaveBeenCalled()
  expect(suspend).toHaveBeenCalledOnce()
  await Promise.resolve()
  a()
  b()
  c()
})
