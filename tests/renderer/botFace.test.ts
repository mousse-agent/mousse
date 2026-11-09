// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BotFace, BotFaceStill, normalizeFaceProps } from '../../src/renderer/components/bots/face/BotFace'
import { FaceMotion, faceUniforms, hop, stillPose, type FaceUniforms } from '../../src/renderer/components/bots/face/facePoses'
import {
  createWebGlGpu,
  FaceRenderer,
  faceDrawSide,
  IDLE_LIVE_SECONDS,
  LOST_CONTEXT_TIMEOUT_MS,
  resetSharedFaceRenderer,
  SAMPLE_BUDGET,
  sharedFaceRendererStatus,
  UNFOCUSED_LIVE_SECONDS,
  softwareWebGl,
  type FaceGpu,
  type FaceRendererEnv
} from '../../src/renderer/components/bots/face/faceRenderer'
import { setAnimationSpeed } from '../../src/renderer/lib/motion'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let webgl: 'none' | 'throws' = 'none'
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
function fakeEnv(options: { observer?: boolean; status?: () => ReturnType<FaceGpu['status']>; pixelRatio?: number; focus?: boolean } = {}) {
  const frames = new Map<number, (now: number) => void>()
  let id = 0
  let now = 1000
  const draws: { side: number; uniforms: FaceUniforms }[] = []
  const lost = new Set<() => void>()
  const restored = new Set<() => void>()
  const timers = new Map<number, { at: number; callback: () => void }>()
  let ratio = options.pixelRatio ?? 1
  const ratioListeners = new Set<() => void>()
  let focused = true
  const focusListeners = new Set<() => void>()
  const gpu: FaceGpu = {
    canvas: document.createElement('canvas'),
    status: options.status ?? (() => 'ready'),
    ensureSize: vi.fn(),
    draw: (_x, _y, side, uniforms) => draws.push({ side, uniforms }),
    finish: vi.fn(),
    onRestored: (listener) => restored.add(listener),
    onLost: (listener) => lost.add(listener),
    dispose: vi.fn()
  }
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
    setTimer: (callback, ms) => {
      const timer = ++id
      timers.set(timer, { at: now + ms, callback })
      return () => timers.delete(timer)
    }
  }
  const tick = (ms = 1000 / 30) => {
    now += ms
    const due = [...frames.values()]
    frames.clear()
    act(() => {
      for (const callback of due) callback(now)
      for (const [timer, { at, callback }] of [...timers]) {
        if (at > now) continue
        timers.delete(timer)
        callback()
      }
    })
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
  return { env, gpu, draws, tick, lose, restore, setRatio, setFocus, pending: () => frames.size, timers: () => timers.size }
}

const coral = { colour: 'coral', accessory: 'none' }
const spec = (overrides: Partial<Parameters<FaceRenderer['register']>[1]> = {}) => ({
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

  it('switches to the still face when the shader fails to compile', () => {
    let status: ReturnType<FaceGpu['status']> = 'pending'
    const fake = fakeEnv({ status: () => status })
    resetSharedFaceRenderer(() => fake.env)
    render(createElement(BotFace, { look: coral, state: 'idle', size: 40, view: 'head' }))
    expect(host.querySelector('canvas.bot-face-canvas')).not.toBeNull()
    status = 'failed'
    fake.tick()
    expect(host.querySelector('canvas')).toBeNull()
    expect(host.querySelector('svg.bot-face-still')).not.toBeNull()
  })

  it('is not ready while the context is lost, and switches to the still face when it does not come back', () => {
    let status: ReturnType<FaceGpu['status']> = 'ready'
    const fake = fakeEnv({ status: () => status })
    resetSharedFaceRenderer(() => fake.env)
    render(createElement(BotFace, { look: coral, state: 'idle', size: 40, view: 'head', still: true }))
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
    expect(fake.timers()).toBe(0)
    fake.tick(LOST_CONTEXT_TIMEOUT_MS)
    expect(renderer.status()).toBe('ready')
    expect(fake.draws).toHaveLength(2)
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
    expect(faceUniforms({ colour: 'purple', accessory: 'none', kind: 'mousse', eyes: 'star' }, stillPose('idle'), { view: 'head', size: 40, samples: 1 }).uK).toEqual([1, 6])
    expect(faceUniforms({ colour: 'purple', accessory: 'none' }, stillPose('idle'), { view: 'head', size: 40, samples: 1 }).uK).toEqual([0, 0])
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
    // The two alike faces share one cached frame.
    expect(fake.draws).toHaveLength(2)
    expect(fake.draws[0]!.uniforms).toEqual(faceUniforms({ colour: 'yellow', accessory: 'beret' }, stillPose('stuck'), { view: 'head', size: 40, samples: 1 }))
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
    expect(renderer.running).toBe(false)
    expect(fake.draws.at(-1)!.uniforms).toEqual(faceUniforms(spec().look, stillPose('idle'), { view: 'head', size: 40, samples: 1 }))
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
    expect(fake.draws.at(-1)!.uniforms).toEqual(faceUniforms(spec().look, stillPose('working'), { view: 'head', size: 40, samples: 1 }))
    const drawn = fake.draws.length
    fake.setFocus(true)
    expect(renderer.running).toBe(true)
    for (let i = 0; i < 5; i++) fake.tick(50)
    expect(fake.draws.length).toBeGreaterThan(drawn + 3)
    renderer.dispose()
  })

  it('keeps each tick within the sample budget, blank faces first', () => {
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
    const counts: number[] = []
    for (let i = 0; i < 4; i++) {
      const before = fake.draws.length
      fake.tick()
      counts.push(fake.draws.length - before)
    }
    expect(Math.max(...counts)).toBe(perTick)
    expect(drawnTo.size).toBe(20)
    for (const draw of fake.draws) expect(draw.side).toBe(80)
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
