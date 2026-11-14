// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BotFace, BotFaceStill, normalizeFaceProps, type BotFaceState } from '../../src/renderer/components/bots/face/BotFace'
import { FaceMotion, faceUniforms, hop, stillPose, type FaceUniforms } from '../../src/renderer/components/bots/face/facePoses'
import {
  createWebGlGpu,
  faceArtVersion,
  FaceRenderer,
  faceDrawSide,
  faceRendererStats,
  IDLE_LIVE_SECONDS,
  IDLE_SHRINK_MS,
  LOST_CONTEXT_TIMEOUT_MS,
  READY_POLL_MS,
  resetSharedFaceRenderer,
  SAMPLE_BUDGET,
  SAVED_HOLD_MS,
  sharedFaceRendererStatus,
  stillFrameKey,
  UNFOCUSED_LIVE_SECONDS,
  WAKE_LEAD_MS,
  softwareWebGl,
  warmFaceRenderer,
  warmFaceRendererAfterPaint,
  type FaceGpu,
  type FaceRendererEnv
} from '../../src/renderer/components/bots/face/faceRenderer'
import { SavedFaceFrames, type FaceFrameBackend, type FaceFrameCodec, type SavedFrameImage, type SavedFrameRecord } from '../../src/renderer/components/bots/face/faceFrameStore'
import { setAnimationSpeed } from '../../src/renderer/lib/motion'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let webgl: 'none' | 'throws' | 'software' = 'none'
/** A WebGL context that Chromium hands out in software (its unsafe SwiftShader). */
const softwareContext = {
  getExtension: (name: string) => (name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : null),
  getParameter: () => 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'
}
let reducedMotion = false

const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>()
function fake2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  let ctx = contexts.get(canvas)
  if (!ctx) contexts.set(canvas, (ctx = { clearRect: vi.fn(), drawImage: vi.fn(), imageSmoothingQuality: 'low' } as unknown as CanvasRenderingContext2D))
  return ctx
}

beforeEach(() => {
  webgl = 'none'
  reducedMotion = false
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, kind: string) {
    if (kind === '2d') return fake2d(this)
    if (webgl === 'throws') throw new Error('no GPU process')
    if (webgl === 'software') return softwareContext as unknown as WebGLRenderingContext
    return null
  } as typeof HTMLCanvasElement.prototype.getContext)
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reducedMotion && query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} }))
  setAnimationSpeed('normal')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  resetSharedFaceRenderer()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setVisibility('visible')
})

function render(element: ReactElement) {
  act(() => root.render(element))
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

class FakeObserver {
  static last: FakeObserver | null = null
  readonly targets = new Set<Element>()
  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeObserver.last = this
  }
  observe(target: Element) {
    this.targets.add(target)
  }
  unobserve(target: Element) {
    this.targets.delete(target)
  }
  disconnect() {
    this.targets.clear()
  }
  fire(isIntersecting: boolean, only?: Element) {
    const entries = [...this.targets].filter((target) => !only || target === only).map((target) => ({ target, isIntersecting }))
    act(() => this.callback(entries as unknown as IntersectionObserverEntry[], this as unknown as IntersectionObserver))
  }
}

/** A renderer environment with a fake GPU and a manual frame clock. */
function fakeEnv(options: {
  observer?: boolean
  status?: () => ReturnType<FaceGpu['status']>
  pixelRatio?: number
  focus?: boolean
  saved?: FakeSaved
  /** The clock's start, in ms. */
  start?: number
  /** No `setTimer`: the renderer asks for a frame every display frame, as it did before shared ticks. */
  noTimers?: boolean
  /** Milliseconds each timer runs late (negative: early). */
  timerLate?: () => number
} = {}) {
  const frames = new Map<number, (now: number) => void>()
  let id = 0
  let now = options.start ?? 1000
  /** Each face drawn, with the time of the frame that drew it. */
  const draws: { side: number; uniforms: FaceUniforms; at: number }[] = []
  const lost = new Set<() => void>()
  const restored = new Set<() => void>()
  const timers = new Map<number, { at: number; callback: () => void }>()
  let ratio = options.pixelRatio ?? 1
  const ratioListeners = new Set<() => void>()
  let focused = true
  const focusListeners = new Set<() => void>()
  /** The shared drawing buffer's size, as the WebGL side keeps it: grown by draws, shrunk to 1×1. */
  const buffer = { width: 1, height: 1 }
  const gpu: FaceGpu = {
    canvas: document.createElement('canvas'),
    status: options.status ?? (() => 'ready'),
    ensureSize: vi.fn((width: number, height: number) => {
      buffer.width = Math.max(buffer.width, width)
      buffer.height = Math.max(buffer.height, height)
    }),
    draw: (_x, _y, side, uniforms) => draws.push({ side, uniforms, at: now }),
    finish: vi.fn(),
    onRestored: (listener) => restored.add(listener),
    onLost: (listener) => lost.add(listener),
    shrink: vi.fn(() => {
      buffer.width = buffer.height = 1
    }),
    dispose: vi.fn()
  }
  const log = vi.fn()
  const env: FaceRendererEnv = {
    createGpu: () => gpu,
    createCanvas: () => document.createElement('canvas'),
    requestFrame: (callback) => {
      frames.set(++id, callback)
      return id
    },
    cancelFrame: (frame) => frames.delete(frame),
    now: () => now,
    pixelRatio: () => ratio,
    ...(options.focus
      ? {
          hasFocus: () => focused,
          onFocusChange: (listener: () => void) => {
            focusListeners.add(listener)
            return () => focusListeners.delete(listener)
          }
        }
      : {}),
    onPixelRatioChange: (listener) => {
      ratioListeners.add(listener)
      return () => ratioListeners.delete(listener)
    },
    document,
    IntersectionObserver: options.observer ? (FakeObserver as unknown as typeof IntersectionObserver) : undefined,
    random: () => 0.5,
    ...(options.noTimers
      ? {}
      : {
          setTimer: (callback: () => void, ms: number) => {
            const timer = ++id
            timers.set(timer, { at: now + ms + (options.timerLate?.() ?? 0), callback })
            return () => timers.delete(timer)
          }
        }),
    frames: options.saved?.store,
    log
  }
  /** Runs the timers due before `end` at their own times, in order, as the event loop does between display frames. */
  const runTimers = (end: number) => {
    for (;;) {
      let next: [number, { at: number; callback: () => void }] | undefined
      for (const entry of timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry
      if (!next) return
      timers.delete(next[0])
      now = Math.max(now, next[1].at)
      next[1].callback()
    }
  }
  /** Advances the clock by `ms`, running the timers due on the way, then one display frame at the end. */
  const tick = (ms = 1000 / 30) => {
    const end = now + ms
    act(() => {
      runTimers(end)
      now = end
      const due = [...frames.values()]
      frames.clear()
      for (const callback of due) callback(now)
    })
  }
  /** Runs a display at `hz` for `ms`: timers at their own times, a frame every display frame. Returns the frame times that ran a frame callback. */
  const display = (ms: number, hz: number) => {
    const period = 1000 / hz
    const woke: number[] = []
    const frameCount = Math.round(ms / period)
    for (let i = 0; i < frameCount; i++) {
      const end = now + period
      act(() => {
        runTimers(end)
        now = end
        const due = [...frames.values()]
        frames.clear()
        if (due.length > 0) woke.push(now)
        for (const callback of due) callback(now)
      })
    }
    return woke
  }
  const lose = () => act(() => lost.forEach((listener) => listener()))
  const restore = () => act(() => restored.forEach((listener) => listener()))
  const setRatio = (next: number) => {
    ratio = next
    act(() => ratioListeners.forEach((listener) => listener()))
  }
  const setFocus = (next: boolean) => {
    focused = next
    act(() => focusListeners.forEach((listener) => listener()))
  }
  return {
    env, gpu, draws, buffer, log, tick, display, lose, restore, setRatio, setFocus,
    now: () => now,
    pending: () => frames.size,
    timers: () => timers.size
  }
}

/** Lets promise callbacks run (the saved frames' loads, decodes and writes). */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

/** A saved picture, as the fake codec decodes it. */
interface FakePicture extends SavedFrameImage {
  readonly id: number
}

/**
 * Saved frames kept between "runs" of a test: one backend (as IndexedDB keeps it across launches)
 * and a store opened on it per run. The codec keeps each saved canvas's size, so a decoded picture
 * is a distinct object of that size.
 */
function fakeSaved(options: { version?: string; maxFrames?: number; maxBytes?: number; bytes?: number } = {}) {
  const records = new Map<string, SavedFrameRecord>()
  const sizes = new WeakMap<Blob, { width: number; height: number; id: number }>()
  let nextId = 0
  let clock = 0
  const fail = { all: false, put: false, decode: false }
  /** Resolves the next `all()` only when released; null lists at once. */
  let held: (() => void) | null = null
  let holdNext = false
  const backend: FaceFrameBackend = {
    all: vi.fn(async () => {
      if (holdNext) {
        holdNext = false
        await new Promise<void>((resolve) => (held = resolve))
      }
      if (fail.all) throw new Error('no IndexedDB')
      return [...records.values()].map((record) => ({ ...record }))
    }),
    put: vi.fn(async (list: SavedFrameRecord[]) => {
      if (fail.put) throw new Error('QuotaExceededError')
      for (const record of list) records.set(record.key, { ...record })
    }),
    remove: vi.fn(async (keys: string[]) => {
      for (const key of keys) records.delete(key)
    })
  }
  const codec: FaceFrameCodec = {
    encode: async (canvas) => {
      const blob = new Blob(['x'.repeat(options.bytes ?? 100)])
      sizes.set(blob, { width: canvas.width, height: canvas.height, id: ++nextId })
      return blob
    },
    decode: async (data) => {
      if (fail.decode) throw new Error('corrupt')
      const size = sizes.get(data)
      return size ? ({ ...size } as unknown as FakePicture) : null
    }
  }
  const saved = {
    records,
    backend,
    fail,
    store: null as unknown as SavedFaceFrames,
    /** Opens the store as a new launch does; `hold` keeps it listing until `release()`. */
    open(launch: { hold?: boolean; version?: string } = {}) {
      holdNext = launch.hold ?? false
      saved.store = new SavedFaceFrames(backend, launch.version ?? options.version ?? faceArtVersion(), codec, {
        now: () => ++clock,
        maxFrames: options.maxFrames,
        maxBytes: options.maxBytes
      })
      return saved.store
    },
    /** Lets a held `all()` answer. */
    release() {
      held?.()
      held = null
    }
  }
  saved.open()
  return saved
}
type FakeSaved = ReturnType<typeof fakeSaved>

/** Draws a still face in one run with a ready shader, so its frame is saved for the next run. */
async function drawAndSave(saved: FakeSaved, face: Partial<Parameters<FaceRenderer['register']>[1]> = {}) {
  await settle()
  const fake = fakeEnv({ saved })
  const renderer = new FaceRenderer(fake.env)
  renderer.register(document.createElement('canvas'), spec({ still: true, ...face }))
  fake.tick()
  expect(fake.draws).toHaveLength(1)
  await settle()
  renderer.dispose()
}

/** The canvas of a face, and what was last drawn into it. */
function lastDrawn(canvas: HTMLCanvasElement) {
  const calls = vi.mocked(fake2d(canvas).drawImage).mock.calls
  return calls.at(-1)?.[0]
}

const coral = { colour: 'coral', accessory: 'none' } as const
const spec =(overrides: Partial<Parameters<FaceRenderer['register']>[1]> = {}) => ({
  look: { colour: 'teal', accessory: 'crown' } as const,
  state: 'idle' as const,
  size: 40,
  view: 'head' as const,
  still: false,
  ...overrides
})

describe('BotFace fallback', () => {
  it('draws the still face when there is no WebGL, without throwing', () => {
    render(createElement(BotFace, { look: { colour: 'blue', accessory: 'glasses' }, state: 'working', size: 40, view: 'head', label: 'Inbox helper' }))
    const svg = host.querySelector('svg.bot-face-still')!
    expect(svg).not.toBeNull()
    expect(svg.getAttribute('data-colour')).toBe('blue')
    expect(svg.getAttribute('data-accessory')).toBe('glasses')
    expect(svg.getAttribute('aria-label')).toBe('Inbox helper')
    expect(sharedFaceRendererStatus()).toBe('unavailable')
  })

  it('draws the still face when context creation throws', () => {
    webgl = 'throws'
    render(createElement(BotFace, { look: coral, state: 'idle', size: 34, view: 'head' }))
    expect(host.querySelector('svg.bot-face-still')?.getAttribute('aria-hidden')).toBe('true')
    expect(host.querySelector('canvas')).toBeNull()
  })

  it('is not ready while the context is lost, and a face with no still frame draws flat when it does not come back', () => {
    let status: ReturnType<FaceGpu['status']> = 'ready'
    const fake = fakeEnv({ status: () => status })
    resetSharedFaceRenderer(() => fake.env)
    render(createElement(BotFace, { look: coral, state: 'working', size: 40, view: 'head' }))
    fake.tick()
    expect(sharedFaceRendererStatus()).toBe('ready')
    status = 'lost'
    fake.lose()
    expect(sharedFaceRendererStatus()).toBe('pending')
    expect(host.querySelector('canvas.bot-face-canvas')).not.toBeNull()
    fake.tick(LOST_CONTEXT_TIMEOUT_MS)
    expect(sharedFaceRendererStatus()).toBe('failed')
    expect(host.querySelector('canvas')).toBeNull()
    expect(host.querySelector('svg.bot-face-still')).not.toBeNull()
  })

  it('draws again when a lost context comes back in time', () => {
    let status: ReturnType<FaceGpu['status']> = 'ready'
    const fake = fakeEnv({ status: () => status })
    const renderer = new FaceRenderer(fake.env)
    renderer.register(document.createElement('canvas'), spec())
    fake.tick()
    expect(fake.draws).toHaveLength(1)
    status = 'lost'
    fake.lose()
    expect(renderer.status()).toBe('pending')
    fake.tick()
    expect(fake.draws).toHaveLength(1)
    status = 'ready'
    fake.restore()
    fake.tick(LOST_CONTEXT_TIMEOUT_MS)
    expect(renderer.status()).toBe('ready')
    expect(fake.draws).toHaveLength(2)
    // The wait for a lost context is gone; the one timer left asks for the next tick.
    expect(fake.timers()).toBe(1)
    expect(fake.pending()).toBe(0)
    renderer.dispose()
  })

  it('keeps the picture a face shows while its context is lost, and its saved frame once it fails', async () => {
    const saved = fakeSaved()
    await drawAndSave(saved, { look: { colour: 'coral', accessory: 'none' }, size: 40 })
    saved.open()
    await settle()
    let status: ReturnType<FaceGpu['status']> = 'ready'
    const fake = fakeEnv({ status: () => status, saved })
    resetSharedFaceRenderer(() => fake.env)
    // A still face saved in an earlier run, and a moving one whose still pose is drawn this run.
    render(createElement('div', null,
      createElement(BotFace, { look: coral, state: 'idle', size: 40, view: 'head', still: true }),
      createElement(BotFace, { look: coral, state: 'working', size: 40, view: 'head' })
    ))
    fake.tick()
    await settle()
    fake.tick()
    const [still, moving] = [...host.querySelectorAll('canvas')]
    const liveFrame = lastDrawn(moving!)
    expect(liveFrame).toBe(fake.gpu.canvas)
    status = 'lost'
    fake.lose()
    // A brief loss: both keep their canvas and what it shows.
    expect(host.querySelectorAll('canvas')).toHaveLength(2)
    expect(host.querySelector('svg.bot-face-still')).toBeNull()
    expect(lastDrawn(moving!)).toBe(liveFrame)
    fake.tick(LOST_CONTEXT_TIMEOUT_MS)
    await settle()
    expect(sharedFaceRendererStatus()).toBe('failed')
    // Failed: each shows the still frame of its spec, the moving one its still pose.
    expect([...host.querySelectorAll('canvas')]).toEqual([still, moving])
    expect(lastDrawn(still!)).toMatchObject({ width: 40, height: 40 })
    expect(lastDrawn(moving!)).not.toBe(fake.gpu.canvas)
    expect(lastDrawn(moving!)).toBeInstanceOf(HTMLCanvasElement)
    expect(host.querySelector('svg.bot-face-still')).toBeNull()
  })

  it('draws the still face when WebGL is refused as software', () => {
    webgl = 'software'
    render(createElement(BotFace, { look: coral, state: 'idle', size: 40, view: 'head' }))
    expect(sharedFaceRendererStatus()).toBe('unavailable')
    expect(host.querySelector('svg.bot-face-still')).not.toBeNull()
    expect(host.querySelector('canvas')).toBeNull()
  })

  it('draws the still face when a compile in progress then fails', () => {
    let status: ReturnType<FaceGpu['status']> = 'pending'
    const fake = fakeEnv({ status: () => status })
    resetSharedFaceRenderer(() => fake.env)
    render(createElement(BotFace, { look: coral, state: 'idle', size: 40, view: 'head' }))
    expect(host.querySelector('svg.bot-face-still')).not.toBeNull()
    status = 'failed'
    fake.tick(READY_POLL_MS)
    expect(sharedFaceRendererStatus()).toBe('failed')
    expect(fake.timers()).toBe(0)
    expect(host.querySelector('svg.bot-face-still')).not.toBeNull()
  })

  it('draws the still face when the first frame reads back empty', () => {
    const fake = fakeEnv()
    resetSharedFaceRenderer(() => fake.env)
    const readBack = vi.fn((_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }))
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(function (this: HTMLCanvasElement, kind: string) {
      if (kind !== '2d') return null
      const ctx = fake2d(this) as unknown as Record<string, unknown>
      ctx.getImageData = readBack
      return ctx as unknown as CanvasRenderingContext2D
    } as typeof HTMLCanvasElement.prototype.getContext)
    render(createElement(BotFace, { look: coral, state: 'idle', size: 40, view: 'head' }))
    fake.tick()
    expect(fake.draws).toHaveLength(1)
    expect(readBack).toHaveBeenCalledTimes(1)
    expect(sharedFaceRendererStatus()).toBe('failed')
    expect(host.querySelector('svg.bot-face-still')).not.toBeNull()
  })

  it('reads back only the first frame, and keeps a face that has pixels', () => {
    const fake = fakeEnv()
    const renderer = new FaceRenderer(fake.env)
    const canvas = document.createElement('canvas')
    const readBack = vi.fn((_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }))
    ;(fake2d(canvas) as unknown as Record<string, unknown>).getImageData = readBack
    renderer.register(canvas, spec({ state: 'working' }))
    fake.tick()
    fake.tick()
    expect(fake.draws.length).toBeGreaterThan(1)
    expect(readBack).toHaveBeenCalledTimes(1)
    expect(renderer.status()).toBe('ready')
    renderer.dispose()
  })

  it('draws the still face when a canvas has no 2D context', () => {
    const fake = fakeEnv()
    resetSharedFaceRenderer(() => fake.env)
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null)
    render(createElement(BotFace, { look: coral, state: 'idle', size: 40, view: 'head' }))
    expect(host.querySelector('svg.bot-face-still')).not.toBeNull()
  })
})

const face = (overrides: Partial<Parameters<typeof BotFace>[0]> = {}) =>
  createElement(BotFace, { look: coral, state: 'idle', size: 40, view: 'head', ...overrides })
const flat = () => host.querySelector('svg.bot-face-still')
const faceCanvas = () => host.querySelector<HTMLCanvasElement>('canvas.bot-face-canvas')

describe('ready from launch', () => {
  it('starts the renderer only once the first frame has painted', () => {
    const fake = fakeEnv()
    const createGpu = vi.spyOn(fake.env, 'createGpu')
    resetSharedFaceRenderer(() => fake.env)
    let frame: FrameRequestCallback | null = null
    let timeout: (() => void) | null = null
    warmFaceRendererAfterPaint({
      requestAnimationFrame: (callback) => {
        frame = callback
        return 1
      },
      setTimeout: ((callback: () => void) => {
        timeout = callback
        return 1
      }) as unknown as Window['setTimeout']
    })
    expect(createGpu).not.toHaveBeenCalled()
    frame!(0)
    // The frame callback runs before that frame is painted: still nothing.
    expect(createGpu).not.toHaveBeenCalled()
    timeout!()
    expect(createGpu).toHaveBeenCalledTimes(1)
  })

  it('compiles with no face mounted, reports how long it took, keeps the shader while no face shows, and draws the first face live at once', () => {
    let status: ReturnType<FaceGpu['status']> = 'pending'
    const fake = fakeEnv({ status: () => status })
    const createGpu = vi.spyOn(fake.env, 'createGpu')
    resetSharedFaceRenderer(() => fake.env)
    warmFaceRenderer()
    expect(createGpu).toHaveBeenCalledTimes(1)
    expect(faceRendererStats()?.compileMs).toBeNull()
    fake.tick(1000)
    status = 'ready'
    fake.tick(READY_POLL_MS)
    expect(sharedFaceRendererStatus()).toBe('ready')
    expect(faceRendererStats()?.compileMs).toBe(1000 + READY_POLL_MS)
    expect(fake.log).toHaveBeenCalledWith(`[bot faces] shader ready in ${1000 + READY_POLL_MS} ms`)

    fake.tick(IDLE_SHRINK_MS * 3)
    expect(fake.gpu.dispose).not.toHaveBeenCalled()
    render(face())
    expect(flat()).toBeNull()
    expect(faceCanvas()).not.toBeNull()
    fake.tick()
    expect(fake.draws).toHaveLength(1)
    expect(createGpu).toHaveBeenCalledTimes(1)
    expect(fake.log).toHaveBeenCalledTimes(1)
  })

  it('shrinks the drawing buffer once no face has shown for 30 s, and grows it again on the next draw', () => {
    const fake = fakeEnv()
    resetSharedFaceRenderer(() => fake.env)
    render(face({ state: 'working' }))
    fake.tick()
    expect(fake.buffer.width).toBeGreaterThan(1)
    // A face back within the idle time keeps the buffer.
    render(null)
    fake.tick(IDLE_SHRINK_MS - 1)
    render(face({ state: 'working' }))
    fake.tick(IDLE_SHRINK_MS * 2)
    expect(fake.gpu.shrink).not.toHaveBeenCalled()

    render(null)
    fake.tick(IDLE_SHRINK_MS - 1)
    expect(fake.gpu.shrink).not.toHaveBeenCalled()
    fake.tick(1)
    expect(fake.buffer).toEqual({ width: 1, height: 1 })
    expect(fake.gpu.dispose).not.toHaveBeenCalled()
    expect(sharedFaceRendererStatus()).toBe('ready')

    const drawn = fake.draws.length
    render(face({ state: 'working' }))
    expect(flat()).toBeNull()
    fake.tick()
    expect(fake.draws).toHaveLength(drawn + 1)
    expect(fake.buffer.width).toBeGreaterThan(1)
  })

  it('has nothing to keep without WebGL', () => {
    warmFaceRenderer()
    render(face())
    render(null)
    expect(sharedFaceRendererStatus()).toBe('unavailable')
  })
})

describe('a face while the shader compiles', () => {
  it('draws flat at once when no frame is saved, and goes live within READY_POLL_MS of the shader being ready, never blank', async () => {
    let status: ReturnType<FaceGpu['status']> = 'pending'
    const saved = fakeSaved()
    await settle()
    const fake = fakeEnv({ status: () => status, saved })
    resetSharedFaceRenderer(() => fake.env)
    render(face())
    expect(flat()).not.toBeNull()
    expect(host.querySelector('canvas')).toBeNull()
    fake.tick(5000)
    expect(flat()).not.toBeNull()
    status = 'ready'
    fake.tick(READY_POLL_MS)
    // Live: the canvas is in, under the flat drawing until the renderer has drawn into it.
    expect(faceCanvas()).not.toBeNull()
    expect(host.querySelector('.bot-face-live > svg.bot-face-still')).not.toBeNull()
    fake.tick()
    expect(fake.draws.length).toBeGreaterThan(0)
    expect(flat()).toBeNull()
  })

  it('shows the saved frame of its spec at once, never flat, then goes live; a moving face shows its saved still pose', async () => {
    const saved = fakeSaved()
    await drawAndSave(saved, { look: coral })
    // The next launch.
    saved.open()
    await settle()
    let status: ReturnType<FaceGpu['status']> = 'pending'
    const fake = fakeEnv({ status: () => status, saved })
    resetSharedFaceRenderer(() => fake.env)
    render(face())
    const canvas = faceCanvas()!
    expect(canvas).not.toBeNull()
    expect(flat()).toBeNull()
    // Decoded as the saved frames loaded: painted in the same commit, never an empty box.
    expect(lastDrawn(canvas)).toMatchObject({ width: 40, height: 40 })
    await settle()
    fake.tick(SAVED_HOLD_MS * 10)
    expect(flat()).toBeNull()
    expect(fake.draws).toHaveLength(0)

    status = 'ready'
    fake.tick(READY_POLL_MS)
    fake.tick()
    expect(faceCanvas()).toBe(canvas)
    expect(fake.draws.length).toBeGreaterThan(0)
    expect(lastDrawn(canvas)).toBe(fake.gpu.canvas)
  })

  it('holds an empty box at most SAVED_HOLD_MS while the saved frames load, then draws flat', () => {
    const saved = fakeSaved()
    saved.open({ hold: true })
    const fake = fakeEnv({ status: () => 'pending', saved })
    resetSharedFaceRenderer(() => fake.env)
    render(face())
    expect(faceCanvas()).not.toBeNull()
    expect(flat()).toBeNull()
    fake.tick(SAVED_HOLD_MS - 1)
    expect(flat()).toBeNull()
    fake.tick(1)
    expect(flat()).not.toBeNull()
    expect(host.querySelector('canvas')).toBeNull()
  })

  it('shows the saved frame when the saved frames load within the hold', async () => {
    const saved = fakeSaved()
    await drawAndSave(saved, { look: coral })
    saved.open({ hold: true })
    const fake = fakeEnv({ status: () => 'pending', saved })
    resetSharedFaceRenderer(() => fake.env)
    render(face({ still: true }))
    const canvas = faceCanvas()!
    fake.tick(SAVED_HOLD_MS / 2)
    saved.release()
    await settle()
    expect(lastDrawn(canvas)).toMatchObject({ width: 40, height: 40 })
    fake.tick(SAVED_HOLD_MS)
    expect(flat()).toBeNull()
  })

  it('fills a moving face mounted while live with its still frame until its first live frame', async () => {
    const saved = fakeSaved()
    await drawAndSave(saved, { look: coral })
    saved.open()
    await settle()
    const fake = fakeEnv({ saved })
    resetSharedFaceRenderer(() => fake.env)
    render(face())
    const canvas = faceCanvas()!
    expect(lastDrawn(canvas)).toMatchObject({ width: 40, height: 40 })
    fake.tick()
    expect(lastDrawn(canvas)).toBe(fake.gpu.canvas)
  })

  it('fills a moving face mounted while live from its saved still frame when none is in memory', async () => {
    const saved = fakeSaved()
    await drawAndSave(saved, { look: coral })
    saved.open()
    await settle()
    const key = stillFrameKey({ look: coral, state: 'idle', view: 'head', size: 40 }, 40)
    // Decoded as the store opened, then handed to another window's face: only the saved record is left.
    expect(saved.store.take(key)).not.toBeNull()
    const fake = fakeEnv({ saved, observer: true })
    resetSharedFaceRenderer(() => fake.env)
    render(face())
    const canvas = faceCanvas()!
    await settle()
    expect(lastDrawn(canvas)).toMatchObject({ width: 40, height: 40 })
    expect(fake.draws).toHaveLength(0)
  })

  it('copies a still face saved in an earlier run in once live, instead of drawing it again', async () => {
    const saved = fakeSaved()
    await drawAndSave(saved, { look: coral })
    saved.open()
    await settle()
    const fake = fakeEnv({ saved })
    const renderer = new FaceRenderer(fake.env)
    const canvas = document.createElement('canvas')
    renderer.register(canvas, spec({ look: coral, still: true }))
    fake.tick()
    await settle()
    fake.tick()
    expect(fake.draws).toHaveLength(0)
    expect(lastDrawn(canvas)).toMatchObject({ width: 40, height: 40 })
    renderer.dispose()
  })
})

describe('saved frames', () => {
  const key = stillFrameKey({ look: coral, state: 'idle', view: 'head', size: 40 }, 40)
  const canvasOf = (side: number) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = side
    return canvas
  }

  it('saves each still frame drawn under its spec and art version', async () => {
    const saved = fakeSaved()
    await drawAndSave(saved, { look: coral })
    expect([...saved.records.values()]).toEqual([expect.objectContaining({ key, version: faceArtVersion() })])
  })

  it("saves a moving face's still pose once, without drawing it into the face", async () => {
    const saved = fakeSaved()
    await settle()
    const fake = fakeEnv({ saved })
    const renderer = new FaceRenderer(fake.env)
    const canvas = document.createElement('canvas')
    renderer.register(canvas, spec({ look: coral, state: 'working' }))
    for (let i = 0; i < 5; i++) fake.tick()
    await settle()
    const stillUniforms = faceUniforms(coral, stillPose('working'), { view: 'head', size: 40, samples: 2 })
    expect(fake.draws.filter((draw) => JSON.stringify(draw.uniforms) === JSON.stringify(stillUniforms))).toHaveLength(1)
    expect(saved.records.has(stillFrameKey({ look: coral, state: 'working', view: 'head', size: 40 }, 40))).toBe(true)
    // The face's canvas only ever got its live frames, each from the shared buffer.
    const sources = vi.mocked(fake2d(canvas).drawImage).mock.calls.map((call) => call[0])
    expect(sources).toHaveLength(5)
    expect(sources.every((source) => source === fake.gpu.canvas)).toBe(true)
    renderer.dispose()
  })

  it('ignores and deletes a frame saved under another art version', async () => {
    const saved = fakeSaved({ version: 'older-art' })
    await drawAndSave(saved, { look: coral })
    expect(saved.records.has(key)).toBe(true)
    // The next launch, with new art.
    saved.open({ version: faceArtVersion() })
    await settle()
    expect(saved.store.has(key)).toBe(false)
    expect(saved.records.size).toBe(0)
    const fake = fakeEnv({ status: () => 'pending', saved })
    resetSharedFaceRenderer(() => fake.env)
    render(face())
    expect(flat()).not.toBeNull()
  })

  it('keeps the least recently used frames within the count and byte bounds, across launches', async () => {
    const saved = fakeSaved({ maxFrames: 3 })
    await settle()
    for (const name of ['a', 'b', 'c']) {
      saved.store.save(name, canvasOf(40))
      await settle()
    }
    // Shown again, `a` becomes the most recently used.
    expect(await saved.store.image('a')).not.toBeNull()
    saved.store.save('d', canvasOf(40))
    await settle()
    expect(['a', 'b', 'c', 'd'].filter((name) => saved.store.has(name))).toEqual(['a', 'c', 'd'])
    expect([...saved.records.keys()].sort()).toEqual(['a', 'c', 'd'])
    saved.open()
    await settle()
    expect(saved.store.has('a')).toBe(true)
    expect(saved.store.has('b')).toBe(false)

    const bySize = fakeSaved({ maxBytes: 250, bytes: 100 })
    await settle()
    for (const name of ['a', 'b', 'c']) {
      bySize.store.save(name, canvasOf(40))
      await settle()
    }
    expect([...bySize.records.keys()].sort()).toEqual(['b', 'c'])
  })

  it('draws as before when the saved frames cannot be read', async () => {
    const saved = fakeSaved()
    saved.fail.all = true
    saved.open()
    await settle()
    expect(saved.store.settled()).toBe(true)
    const fake = fakeEnv({ status: () => 'pending', saved })
    resetSharedFaceRenderer(() => fake.env)
    render(face())
    expect(flat()).not.toBeNull()
  })

  it('stops saving when a write fails, and keeps the frame for this run', async () => {
    const saved = fakeSaved()
    saved.fail.put = true
    await settle()
    const fake = fakeEnv({ saved })
    const renderer = new FaceRenderer(fake.env)
    renderer.register(document.createElement('canvas'), spec({ look: coral, still: true }))
    fake.tick()
    await settle()
    expect(saved.records.size).toBe(0)
    expect(saved.backend.put).toHaveBeenCalledTimes(1)
    renderer.register(document.createElement('canvas'), spec({ look: coral, state: 'stuck', still: true }))
    fake.tick()
    await settle()
    expect(saved.backend.put).toHaveBeenCalledTimes(1)
    // The first frame is still in memory: a third face like it is copied, not drawn.
    renderer.register(document.createElement('canvas'), spec({ look: coral, still: true }))
    fake.tick()
    expect(fake.draws).toHaveLength(2)
    renderer.dispose()
  })

  it('forgets a saved frame that cannot be decoded, and the face draws flat', async () => {
    const saved = fakeSaved()
    await drawAndSave(saved, { look: coral })
    saved.fail.decode = true
    saved.open()
    await settle()
    const fake = fakeEnv({ status: () => 'pending', saved })
    resetSharedFaceRenderer(() => fake.env)
    render(face())
    await settle()
    expect(flat()).not.toBeNull()
    expect(saved.records.size).toBe(0)
  })

  it('saves nothing when the first frame reads back empty', async () => {
    const saved = fakeSaved()
    await settle()
    const fake = fakeEnv({ saved })
    const renderer = new FaceRenderer(fake.env)
    const canvas = document.createElement('canvas')
    ;(fake2d(canvas) as unknown as Record<string, unknown>).getImageData = (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) })
    renderer.register(canvas, spec({ look: coral, still: true }))
    fake.tick()
    await settle()
    expect(renderer.status()).toBe('failed')
    expect(saved.records.size).toBe(0)
    renderer.dispose()
  })
})

describe('BotFace props', () => {
  it('reads unknown looks, states, sizes and views as the defaults', () => {
    expect(normalizeFaceProps({ look: { colour: 'mauve', accessory: 'monocle' }, state: 'dancing' as never, size: Number.NaN, view: 'side' as never })).toEqual({
      look: { colour: 'coral', accessory: 'none' },
      state: 'idle',
      size: 40,
      view: 'head'
    })
    expect(normalizeFaceProps({ look: { colour: 'pink', accessory: 'hood' }, state: 'happy', size: 103.6, view: 'full' })).toEqual({
      look: { colour: 'pink', accessory: 'hood' },
      state: 'happy',
      size: 104,
      view: 'full'
    })
    expect(normalizeFaceProps({ look: coral, state: 'idle', size: 4000, view: 'head' }).size).toBe(256)
    expect(normalizeFaceProps({ look: coral, state: 'idle', size: -3, view: 'head' }).size).toBe(40)
  })

  it('draws a Mousse in the fallback and passes its kind and eyes to the shader', () => {
    render(createElement(BotFaceStill, { look: { colour: 'purple', accessory: 'none', kind: 'mousse', eyes: 'star' }, state: 'idle', size: 48, view: 'head' }))
    expect(host.querySelector('svg')!.getAttribute('data-kind')).toBe('mousse')
    expect(faceUniforms({ colour: 'purple', accessory: 'none', kind: 'mousse', eyes: 'star' }, stillPose('idle'), { view: 'head', size: 40, samples: 1 }).uK).toEqual([1, 6, 1])
    expect(faceUniforms({ colour: 'purple', accessory: 'none' }, stillPose('idle'), { view: 'head', size: 40, samples: 1 }).uK).toEqual([0, 0, 1])
    expect(faceUniforms({ colour: 'yellow', accessory: 'none', kind: 'mousse' }, stillPose('idle'), { view: 'head', size: 40, samples: 1 }).uK).toEqual([1, 0, 0])
  })

  it('keeps unknown stored values drawable in the fallback', () => {
    render(createElement(BotFaceStill, { look: { colour: 'mauve', accessory: 'monocle' }, state: 'dancing' as never, size: 48, view: 'head' }))
    const svg = host.querySelector('svg')!
    expect(svg.getAttribute('data-colour')).toBe('coral')
    expect(svg.getAttribute('data-accessory')).toBe('none')
    expect(svg.getAttribute('data-state')).toBe('idle')
  })

  it('sizes the live face, shows the z when paused and is decorative without a label', () => {
    const fake = fakeEnv()
    resetSharedFaceRenderer(() => fake.env)
    render(createElement(BotFace, { look: { colour: 'green', accessory: 'cap' }, state: 'paused', size: 48, view: 'head' }))
    const face = host.querySelector<HTMLElement>('.bot-face-live')!
    expect(face.style.width).toBe('48px')
    expect(face.getAttribute('aria-hidden')).toBe('true')
    expect(face.getAttribute('data-still')).toBeNull()
    expect(host.querySelector('.bot-face-z')?.textContent).toBe('z')
    expect(host.querySelector('canvas')!.width).toBe(48)
  })
})

describe('reduced motion', () => {
  it('draws each pose once, still, and stops the loop', () => {
    reducedMotion = true
    setAnimationSpeed('normal')
    const fake = fakeEnv()
    resetSharedFaceRenderer(() => fake.env)
    const look = { colour: 'yellow', accessory: 'beret' }
    render(createElement('div', null,
      createElement(BotFace, { look, state: 'stuck', size: 40, view: 'head' }),
      createElement(BotFace, { look, state: 'stuck', size: 40, view: 'head' }),
      createElement(BotFace, { look, state: 'happy', size: 40, view: 'head' })
    ))
    expect(host.querySelectorAll('.bot-face-live[data-still="true"]')).toHaveLength(2 + 1)
    for (let i = 0; i < 5; i++) fake.tick()
    // The two alike faces share one cached frame (past the budget the third first shows a one-sample draft).
    expect(fake.draws.filter((draw) => draw.uniforms.uV[2] === 2)).toHaveLength(2)
    expect(fake.draws[0]!.uniforms).toEqual(faceUniforms({ colour: 'yellow', accessory: 'beret' }, stillPose('stuck'), { view: 'head', size: 40, samples: 2 }))
    expect(fake.pending()).toBe(0)
  })

  it('draws a still face again at a new pixel ratio', () => {
    const fake = fakeEnv()
    const renderer = new FaceRenderer(fake.env)
    const canvas = document.createElement('canvas')
    renderer.register(canvas, spec({ size: 104, view: 'full', still: true }))
    fake.tick()
    expect(fake.draws.map((draw) => draw.side)).toEqual([104])
    expect(renderer.running).toBe(false)
    fake.setRatio(2)
    expect(canvas.width).toBe(208)
    fake.tick()
    expect(fake.draws.map((draw) => draw.side)).toEqual([104, 208])
    // Past the cap of 2 nothing changes, so nothing is drawn.
    fake.setRatio(3)
    fake.tick()
    expect(fake.draws).toHaveLength(2)
    renderer.dispose()
  })

  it('draws a still face again when its state changes', () => {
    const fake = fakeEnv()
    resetSharedFaceRenderer(() => fake.env)
    render(createElement(BotFace, { look: coral, state: 'idle', size: 40, view: 'head', still: true }))
    fake.tick()
    fake.tick()
    expect(fake.draws).toHaveLength(1)
    render(createElement(BotFace, { look: coral, state: 'needs_you', size: 40, view: 'head', still: true }))
    fake.tick()
    expect(fake.draws).toHaveLength(2)
    expect(fake.draws[1]!.uniforms.uE2[2]).toBe(1.2)
    expect(fake.pending()).toBe(0)
  })
})

describe('the shared renderer', () => {
  it('animates only faces on screen, and stops when none are', () => {
    const fake = fakeEnv({ observer: true })
    const renderer = new FaceRenderer(fake.env)
    const a = document.createElement('canvas')
    const b = document.createElement('canvas')
    renderer.register(a, spec())
    renderer.register(b, spec({ state: 'working' }))
    // Nothing is known to be on screen yet.
    expect(renderer.running).toBe(false)
    FakeObserver.last!.fire(true, a)
    expect(renderer.running).toBe(true)
    fake.tick()
    expect(fake.draws).toHaveLength(1)
    for (let i = 0; i < 10; i++) fake.tick()
    expect(fake.draws.length).toBeGreaterThan(5)
    FakeObserver.last!.fire(false, a)
    const drawn = fake.draws.length
    fake.tick()
    expect(fake.draws).toHaveLength(drawn)
    expect(renderer.running).toBe(false)
    renderer.dispose()
  })

  it('stops while the document is hidden and resumes when shown', () => {
    const fake = fakeEnv()
    const renderer = new FaceRenderer(fake.env)
    renderer.register(document.createElement('canvas'), spec({ state: 'happy' }))
    fake.tick()
    expect(fake.draws).toHaveLength(1)
    setVisibility('hidden')
    fake.tick()
    fake.tick()
    expect(fake.draws).toHaveLength(1)
    expect(renderer.running).toBe(false)
    setVisibility('visible')
    expect(renderer.running).toBe(true)
    fake.tick()
    expect(fake.draws).toHaveLength(2)
    renderer.dispose()
  })

  it('stops when the last face goes away', () => {
    const fake = fakeEnv()
    const renderer = new FaceRenderer(fake.env)
    const handle = renderer.register(document.createElement('canvas'), spec())!
    expect(renderer.running).toBe(true)
    handle.dispose()
    expect(renderer.running).toBe(false)
    expect(fake.pending()).toBe(0)
    renderer.dispose()
  })

  it('waits while the shader compiles', () => {
    let status: ReturnType<FaceGpu['status']> = 'pending'
    const fake = fakeEnv({ status: () => status })
    const renderer = new FaceRenderer(fake.env)
    renderer.register(document.createElement('canvas'), spec())
    fake.tick()
    expect(fake.draws).toHaveLength(0)
    expect(renderer.status()).toBe('pending')
    status = 'ready'
    fake.tick()
    expect(fake.draws).toHaveLength(1)
    expect(renderer.status()).toBe('ready')
    renderer.dispose()
  })

  it('settles an idle face into its still pose a few seconds after its state changed, and moves it on a new state', () => {
    const fake = fakeEnv()
    const renderer = new FaceRenderer(fake.env)
    const handle = renderer.register(document.createElement('canvas'), spec())!
    const ticks = Math.ceil((IDLE_LIVE_SECONDS * 1000) / 50) + 1
    for (let i = 0; i < ticks; i++) fake.tick(50)
    // Stopped completely: no frame asked for and no timer to ask for one.
    expect(renderer.running).toBe(false)
    expect(fake.pending()).toBe(0)
    expect(fake.timers()).toBe(0)
    expect(fake.draws.at(-1)!.uniforms).toEqual(faceUniforms(spec().look, stillPose('idle'), { view: 'head', size: 40, samples: 2 }))
    const drawn = fake.draws.length
    fake.tick(1000)
    expect(fake.draws).toHaveLength(drawn)
    handle.update(spec({ state: 'working' }))
    expect(renderer.running).toBe(true)
    for (let i = 0; i < 5; i++) fake.tick(50)
    expect(fake.draws.length).toBeGreaterThan(drawn + 3)
    renderer.dispose()
  })

  it('settles a busy face while the window has no focus, and moves it again with focus', () => {
    const fake = fakeEnv({ focus: true })
    const renderer = new FaceRenderer(fake.env)
    renderer.register(document.createElement('canvas'), spec({ state: 'working' }))
    fake.tick()
    fake.setFocus(false)
    const ticks = Math.ceil((UNFOCUSED_LIVE_SECONDS * 1000) / 50) + 1
    for (let i = 0; i < ticks; i++) fake.tick(50)
    expect(renderer.running).toBe(false)
    expect(fake.pending()).toBe(0)
    expect(fake.timers()).toBe(0)
    expect(fake.draws.at(-1)!.uniforms).toEqual(faceUniforms(spec().look, stillPose('working'), { view: 'head', size: 40, samples: 2 }))
    const drawn = fake.draws.length
    fake.setFocus(true)
    expect(renderer.running).toBe(true)
    for (let i = 0; i < 5; i++) fake.tick(50)
    expect(fake.draws.length).toBeGreaterThan(drawn + 3)
    renderer.dispose()
  })

  it('draws every blank face on its first tick, then keeps each tick within the sample budget', () => {
    const fake = fakeEnv()
    const renderer = new FaceRenderer(fake.env)
    const canvases = Array.from({ length: 20 }, () => document.createElement('canvas'))
    const drawnTo = new Set<HTMLCanvasElement>()
    for (const canvas of canvases) {
      renderer.register(canvas, spec({ state: 'working' }))
      vi.mocked(canvas.getContext('2d')!.drawImage).mockImplementation(() => drawnTo.add(canvas))
    }
    const side = faceDrawSide(40, 1)
    expect(side).toBe(80)
    const perTick = Math.floor(SAMPLE_BUDGET / (side * side))
    expect(perTick).toBeLessThan(20)
    fake.tick()
    expect(drawnTo.size).toBe(20)
    const counts: number[] = []
    for (let i = 0; i < 4; i++) {
      const before = fake.draws.length
      fake.tick()
      counts.push(fake.draws.length - before)
    }
    expect(Math.max(...counts)).toBe(perTick)
    for (const draw of fake.draws) expect(draw.side).toBe(80)
    renderer.dispose()
  })

  it('draws still faces with 2×2 samples, counted four times; past the budget a blank one gets a one-sample draft, drawn clean later', () => {
    const fake = fakeEnv()
    const renderer = new FaceRenderer(fake.env)
    const looks = ['coral', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const
    for (const colour of looks) renderer.register(document.createElement('canvas'), spec({ look: { colour, accessory: 'none' }, still: true }))
    const perTick = Math.max(1, Math.floor(SAMPLE_BUDGET / (80 * 80 * 4)))
    const clean = () => fake.draws.filter((draw) => draw.uniforms.uV[2] === 2)
    fake.tick()
    // All eight show at once: the first within the budget clean, the rest as drafts.
    expect(fake.draws).toHaveLength(looks.length)
    expect(clean()).toHaveLength(perTick)
    while (clean().length < looks.length) fake.tick()
    expect(new Set(clean().map((draw) => draw.uniforms.uCol.join()))).toHaveProperty('size', looks.length)
    // Then nothing more: each clean frame is drawn once.
    const drawn = fake.draws.length
    fake.tick()
    expect(fake.draws).toHaveLength(drawn)
    renderer.dispose()
  })

  it('draws live faces with one sample', () => {
    const fake = fakeEnv()
    const renderer = new FaceRenderer(fake.env)
    renderer.register(document.createElement('canvas'), spec({ state: 'working' }))
    fake.tick()
    expect(fake.draws[0]!.uniforms.uV[2]).toBe(1)
    renderer.dispose()
  })

  it('draws small faces at 2x and large ones at the pixel ratio, capped at 2', () => {
    expect(faceDrawSide(40, 1)).toBe(80)
    expect(faceDrawSide(48, 3)).toBe(96)
    expect(faceDrawSide(104, 1)).toBe(104)
    expect(faceDrawSide(104, 1.5)).toBe(156)
    const fake = fakeEnv({ pixelRatio: 3 })
    const renderer = new FaceRenderer(fake.env)
    const canvas = document.createElement('canvas')
    renderer.register(canvas, spec({ size: 104, view: 'full' }))
    expect(canvas.width).toBe(208)
    fake.tick()
    expect(fake.draws[0]!.side).toBe(208)
    // Whiskers show from 56 px up.
    expect(fake.draws[0]!.uniforms.uV[3]).toBe(0)
    renderer.dispose()
  })
})

describe('shared ticks', () => {
  const colours = ['coral', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const
  const face = (i: number, state: BotFaceState) => spec({ look: { colour: colours[i]!, accessory: 'none' }, state })
  const colourOf = (i: number) => faceUniforms({ colour: colours[i]!, accessory: 'none' }, stillPose('idle'), { view: 'head', size: 40, samples: 1 }).uCol.join()
  /** The frame times face `i` was drawn at, from draw `from` on. */
  const drawnAt = (fake: ReturnType<typeof fakeEnv>, i: number, from = 0) =>
    fake.draws.slice(from).filter((draw) => draw.uniforms.uCol.join() === colourOf(i)).map((draw) => draw.at)
  const gaps = (times: number[]) => times.slice(1).map((at, i) => Math.round(at - times[i]!))

  it('draws faces registered at different times on the same ticks, and every face due on a tick', () => {
    const fake = fakeEnv()
    const renderer = new FaceRenderer(fake.env)
    renderer.register(document.createElement('canvas'), face(0, 'working'))
    fake.display(37, 100)
    renderer.register(document.createElement('canvas'), face(1, 'working'))
    fake.display(53, 100)
    renderer.register(document.createElement('canvas'), face(2, 'idle'))
    fake.display(21, 100)
    renderer.register(document.createElement('canvas'), face(3, 'paused'))
    fake.display(100, 100)
    const from = fake.draws.length
    fake.display(1000, 100)
    const busy = drawnAt(fake, 0, from)
    expect(drawnAt(fake, 1, from)).toEqual(busy)
    expect(drawnAt(fake, 3, from)).toEqual(drawnAt(fake, 2, from))
    for (const at of drawnAt(fake, 2, from)) expect(busy).toContain(at)
    // No frame of its own between ticks: every frame that drew is a busy tick, 30 or 40 ms apart on a 100 Hz display.
    expect(new Set(fake.draws.slice(from).map((draw) => draw.at))).toEqual(new Set(busy))
    expect(new Set(gaps(busy))).toEqual(new Set([30, 40]))
    renderer.dispose()
  })

  it('moves the busy states 30 times a second, idle and paused 15', () => {
    const states: BotFaceState[] = ['working', 'needs_you', 'stuck', 'happy', 'idle', 'paused']
    const fake = fakeEnv()
    const renderer = new FaceRenderer(fake.env)
    states.forEach((state, i) => {
      renderer.register(document.createElement('canvas'), face(i, state))
      fake.display(13, 100)
    })
    const from = fake.draws.length
    fake.display(3000, 100)
    // Within the seconds an idle or paused face moves before it settles (`IDLE_LIVE_SECONDS`).
    expect(states.map((_, i) => drawnAt(fake, i, from).length)).toEqual([90, 90, 90, 90, 45, 45])
    renderer.dispose()
  })

  it('sleeps between ticks: no frame is asked for while nothing is due, and a timer asks for the next tick', () => {
    const fake = fakeEnv()
    const renderer = new FaceRenderer(fake.env)
    renderer.register(document.createElement('canvas'), face(0, 'working'))
    renderer.register(document.createElement('canvas'), face(1, 'idle'))
    fake.display(100, 100)
    const from = fake.draws.length
    const woke: number[] = []
    for (let i = 0; i < 100; i++) {
      const drawn = fake.draws.length
      woke.push(...fake.display(10, 100))
      if (fake.draws.length === drawn) continue
      // Right after a drawing tick: asleep until the next.
      expect(fake.pending()).toBe(0)
      expect(fake.timers()).toBe(1)
      expect(renderer.running).toBe(true)
    }
    const ticks = [...new Set(fake.draws.slice(from).map((draw) => draw.at))]
    expect(ticks).toHaveLength(30)
    // A frame that draws nothing is asked for at most one display frame before a tick, never every frame.
    for (const at of woke) expect(ticks.includes(at) || ticks.includes(at + 10)).toBe(true)
    expect(woke.length).toBeLessThanOrEqual(40)
    renderer.dispose()
  })

  it('asks for a frame at once for a face that is new on screen, changed or resized', () => {
    const fake = fakeEnv({ observer: true })
    const renderer = new FaceRenderer(fake.env)
    const a = document.createElement('canvas')
    const handle = renderer.register(a, face(0, 'working'))!
    FakeObserver.last!.fire(true, a)
    // Asleep, and far enough from the last tick that the next may draw (ticks are `MIN_TICK` apart).
    const asleep = () => {
      const ready = () => fake.pending() === 0 && fake.timers() === 1 && fake.now() - fake.draws.at(-1)!.at >= 20
      for (let i = 0; i < 10 && !ready(); i++) fake.display(10, 100)
      expect(ready()).toBe(true)
    }
    const drawsNextFrame = (i: number) => {
      expect(fake.pending()).toBe(1)
      expect(fake.timers()).toBe(0)
      const before = drawnAt(fake, i).length
      fake.display(10, 100)
      expect(drawnAt(fake, i)).toHaveLength(before + 1)
      expect(drawnAt(fake, i).at(-1)).toBe(fake.now())
    }
    asleep()
    const b = document.createElement('canvas')
    renderer.register(b, face(1, 'working'))
    // Not known to be on screen yet.
    expect(fake.pending()).toBe(0)
    FakeObserver.last!.fire(true, b)
    drawsNextFrame(1)
    asleep()
    handle.update(face(0, 'happy'))
    drawsNextFrame(0)
    asleep()
    handle.update({ ...face(0, 'happy'), size: 48 })
    drawsNextFrame(0)
    renderer.dispose()
  })

  it('defers faces past the sample budget to the next shared tick, most overdue first, never to a frame of their own', () => {
    const fake = fakeEnv()
    const renderer = new FaceRenderer(fake.env)
    const canvases = Array.from({ length: 20 }, () => document.createElement('canvas'))
    const drawnIn = new Map<number, Set<HTMLCanvasElement>>()
    for (const canvas of canvases) {
      renderer.register(canvas, face(0, 'working'))
      vi.mocked(canvas.getContext('2d')!.drawImage).mockImplementation(() => {
        const set = drawnIn.get(fake.now()) ?? new Set()
        drawnIn.set(fake.now(), set.add(canvas))
      })
    }
    const perTick = Math.floor(SAMPLE_BUDGET / (faceDrawSide(40, 1) ** 2))
    fake.display(1000, 100)
    const ticks = [...drawnIn.keys()]
    // The first frame draws every blank face at once; then each tick its budget, on the shared ticks only.
    expect(drawnIn.get(ticks[0]!)!.size).toBe(20)
    expect(new Set(gaps(ticks.slice(1)))).toEqual(new Set([30, 40]))
    const later = ticks.slice(1).map((at) => drawnIn.get(at)!)
    for (const set of later) expect(set.size).toBe(perTick)
    // Those the budget deferred draw on the next tick: no face draws on two ticks running.
    for (let i = 1; i < later.length; i++) for (const canvas of later[i]!) expect(later[i - 1]!.has(canvas)).toBe(false)
    for (let i = 2; i < later.length; i++) expect(new Set([...later[i - 2]!, ...later[i - 1]!, ...later[i]!]).size).toBe(Math.min(20, perTick * 3))
    renderer.dispose()
  })

  it('draws on the same display frames as asking for a frame every display frame, at 60 and 100 Hz, with timers early or late within WAKE_LEAD_MS', () => {
    const late = [-0.9, 0, WAKE_LEAD_MS - 0.1, 0.7, -0.4, 1.5]
    for (const hz of [60, 100]) {
      for (let offset = 0; offset < 1000 / hz; offset += 0.5) {
        const run = (options: Parameters<typeof fakeEnv>[0]) => {
          const fake = fakeEnv({ start: 1000 + offset, ...options })
          const renderer = new FaceRenderer(fake.env)
          renderer.register(document.createElement('canvas'), face(0, 'working'))
          fake.display(17, hz)
          renderer.register(document.createElement('canvas'), face(1, 'idle'))
          fake.display(1000, hz)
          renderer.dispose()
          return fake.draws.map((draw) => `${draw.at} ${draw.uniforms.uCol.join()}`)
        }
        let n = 0
        const asleep = run({ timerLate: () => late[n++ % late.length]! })
        const everyFrame = run({ noTimers: true })
        expect(asleep, `${hz} Hz, offset ${offset} ms`).toEqual(everyFrame)
      }
    }
  })

  it('asks for a frame every display frame without timers', () => {
    const fake = fakeEnv({ noTimers: true })
    const renderer = new FaceRenderer(fake.env)
    renderer.register(document.createElement('canvas'), face(0, 'working'))
    expect(fake.display(500, 100)).toHaveLength(50)
    expect(new Set(fake.draws.map((draw) => draw.at)).size).toBe(16)
    renderer.dispose()
  })
})

describe('software WebGL', () => {
  const gl = (renderer: string | null) => ({
    getExtension: (name: string) => (name === 'WEBGL_debug_renderer_info' && renderer !== null ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : null),
    getParameter: () => renderer
  }) as unknown as WebGLRenderingContext
  it('fails a context that comes back from a loss in software', () => {
    let renderer = 'ANGLE (Intel, Mesa Intel(R) Graphics, OpenGL 4.6)'
    const listeners = new Map<string, (event: Event) => void>()
    const context = new Proxy({} as Record<string | symbol, unknown>, {
      get: (target, key) => {
        if (key === 'getExtension') return (name: string) => (name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : null)
        if (key === 'getParameter') return (name: number) => (name === 0x9246 ? renderer : true)
        if (key === 'getProgramParameter') return () => true
        if (key === 'isContextLost') return () => false
        if (typeof key === 'string' && /^[A-Z_]+$/.test(key)) return 1
        return (target[key] ??= vi.fn(() => ({})))
      }
    })
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => context,
      addEventListener: (type: string, listener: (event: Event) => void) => listeners.set(type, listener)
    }
    const gpu = createWebGlGpu({ createElement: () => canvas } as unknown as Document)!
    expect(gpu.status()).toBe('ready')
    listeners.get('webglcontextlost')!({ preventDefault() {} } as Event)
    expect(gpu.status()).toBe('lost')
    renderer = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'
    listeners.get('webglcontextrestored')!(new Event('webglcontextrestored'))
    expect(gpu.status()).toBe('failed')
  })

  it('counts as no WebGL, so faces stay still instead of burning the CPU', () => {
    expect(softwareWebGl(gl('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'))).toBe(true)
    expect(softwareWebGl(gl('llvmpipe (LLVM 17.0.6, 256 bits)'))).toBe(true)
    expect(softwareWebGl(gl('ANGLE (Intel, Mesa Intel(R) Graphics, OpenGL 4.6)'))).toBe(false)
    expect(softwareWebGl(gl(null))).toBe(false)
  })
})

describe('face poses', () => {
  it('settles each state in its pose', () => {
    expect(stillPose('paused')).toMatchObject({ closed: 1, arc: -1 })
    expect(stillPose('happy')).toMatchObject({ closed: 1, arc: 1, armL: 1.9, armR: 1.9 })
    expect(stillPose('working')).toMatchObject({ laptop: 1, open: 0.8 })
    expect(stillPose('needs_you')).toMatchObject({ es: 1.2, armR: 2.5 })
    expect(stillPose('stuck')).toMatchObject({ worried: 0.85, sweat: 1 })
    expect(stillPose('idle')).toMatchObject({ lookX: 0, closed: 0, open: 1 })
    expect(stillPose('stuck')).toEqual(stillPose('stuck'))
  })

  it('eases towards a new state instead of jumping', () => {
    const motion = new FaceMotion('idle', () => 0.5, 0)
    motion.frame(0, 1 / 30)
    motion.set('working', 0.04)
    const pose = motion.frame(1 / 15, 1 / 30)
    expect(pose.laptop).toBeGreaterThan(0)
    expect(pose.laptop).toBeLessThan(1)
  })

  it('hops when it needs you', () => {
    expect(hop(-0.1)).toEqual([0, 1])
    expect(hop(0.59)[0]).toBeCloseTo(1, 1)
    const motion = new FaceMotion('needs_you', () => 0.5, 0)
    motion.frame(0, 0)
    const heights = Array.from({ length: 40 }, (_, i) => motion.frame(i / 30, 1 / 30).hop)
    expect(Math.max(...heights)).toBeGreaterThan(0.25)
  })
})
