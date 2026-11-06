import type { KnownBotLook } from '../../../../shared/bots/personal/look'
import type { BotFaceState } from './BotFace'
import { FaceMotion, faceUniforms, stillPose, WHISKER_MIN_SIZE, type FaceUniforms } from './facePoses'
import { MICE_FRAGMENT_SHADER, MICE_UNIFORMS, MICE_VERTEX_SHADER, type MiceUniform } from './miceShader'

/**
 * The shared face renderer (Bot Phase 1 §5.12, bot-ui §4.3). One WebGL context serves every face:
 * each tick, the faces due for a frame are packed into viewports of one offscreen drawing buffer,
 * drawn with one draw call each, then copied into each face's own small 2D canvas. Each face owns
 * its canvas, so it stacks, clips and scrolls with the page like any element.
 *
 * Cost control, for a budget of 4 ms per tick with 20 faces:
 * - Only faces on screen in a visible document are drawn (an IntersectionObserver and
 *   `visibilitychange`). With none due, the loop stops.
 * - The pixel ratio is capped at 2. Small faces (below 56 px) are drawn at 2x whatever the ratio
 *   and scaled down into their canvas, so their edges stay smooth; this is cheaper than taking
 *   2×2 samples in the shader, whose loop slows every pixel.
 * - Each face has its own frame rate (30 fps for the busy states, 20 for idle, 15 for paused),
 *   staggered so the faces don't all draw on the same tick. Ticks draw at most 60 times a second.
 * - A tick draws at most `SAMPLE_BUDGET` shader samples (drawn pixels), blank faces first,
 *   then the most overdue; the rest wait for the next tick. Many faces then lower the frame rate,
 *   not the frame time.
 * - Still faces (reduced motion, `still`) draw once. Their frame is cached per look, state, view
 *   and pixel size, so a long list of the same still face costs one draw.
 *
 * To measure: `faceRendererStats()` (in development also `window.__mousseFaceStats(measureGpu?)`)
 * reports the time per drawing tick. With `measureGpu`, `gpuMs` is the GPU time of each tick's
 * draws, from a timer query (`EXT_disjoint_timer_query`) where there is one. Without it, each
 * drawing tick waits for the GPU before and after drawing and subtracts the time an empty wait
 * takes; that stalls the pipeline, so leave it off otherwise. On the development machine (AMD
 * Renoir integrated graphics) a sample costs 40 to 80 ns, so the budget keeps a tick near 2 to 4 ms.
 */

export interface FaceSpec {
  look: KnownBotLook
  state: BotFaceState
  /** CSS pixels, square. */
  size: number
  view: 'head' | 'full'
  /** Draw the settled pose once, with no motion. */
  still: boolean
}

export interface FaceHandle {
  update(spec: FaceSpec): void
  dispose(): void
}

/** The GPU side, behind an interface so the scheduling can be tested without WebGL. */
export interface FaceGpu {
  /** The shared drawing buffer, read with `drawImage` (top-left origin). */
  readonly canvas: CanvasImageSource
  /** `pending` while the shader compiles, `lost` while the context is lost. */
  status(): 'pending' | 'ready' | 'lost' | 'failed'
  /** Grows the drawing buffer to at least this size (device pixels). */
  ensureSize(width: number, height: number): void
  /** Draws one face into the square with top-left corner (x, y), in device pixels. */
  draw(x: number, y: number, side: number, uniforms: FaceUniforms): void
  /** Blocks until the GPU is done, for timing. */
  finish(): void
  /** GPU timer queries around a tick's draws, where the driver has them; `poll` returns finished times in ms. */
  readonly timer?: { begin(): void; end(): void; poll(): number[] }
  /** Called once the context is back after a loss. */
  onRestored(listener: () => void): void
  dispose(): void
}

export interface FaceRendererEnv {
  /** Null when WebGL is missing or context creation fails. */
  createGpu(): FaceGpu | null
  createCanvas(): HTMLCanvasElement
  requestFrame(callback: (now: number) => void): number
  cancelFrame(id: number): void
  /** Milliseconds, on the same clock as `requestFrame`'s argument. */
  now(): number
  pixelRatio(): number
  document?: Document
  IntersectionObserver?: typeof IntersectionObserver
  random?: () => number
}

export type FaceRendererStatus = 'pending' | 'ready' | 'failed'

export interface FaceRendererStats {
  /** Ticks that drew at least one face. */
  ticks: number
  /** Faces drawn on the last drawing tick. */
  lastFaces: number
  /** Time per drawing tick, in milliseconds: a moving average, and the worst since the last reset. */
  averageMs: number
  maxMs: number
  /** With `measureGpu`: the GPU time per drawing tick, a moving average and the worst. */
  gpuMs: number
  gpuMaxMs: number
  /** Faces registered, and how many of them are on screen. */
  faces: number
  visible: number
}

const MAX_PIXEL_RATIO = 2
/** Width of the shared buffer, in device pixels; rows of viewports fill it. */
const ATLAS_WIDTH = 1024
/** Height past which a tick copies its faces out and reuses the buffer. */
const ATLAS_MAX_HEIGHT = 1024
const STILL_CACHE_LIMIT = 96
/** Shader samples one tick may draw: seven 40 px faces drawn at 2x. */
export const SAMPLE_BUDGET = 48_000
/** Seconds between drawing ticks at least. */
const MIN_TICK = 1 / 62

/** Seconds between frames, by state. */
const FRAME_INTERVAL: Record<BotFaceState, number> = {
  working: 1 / 30,
  needs_you: 1 / 30,
  stuck: 1 / 30,
  happy: 1 / 30,
  idle: 1 / 20,
  paused: 1 / 15
}
/** Ticks come at the display rate; a frame due within this much of a tick draws on it. */
const FRAME_SLACK = 1 / 240

export function facePixelRatio(raw: number): number {
  return Math.min(MAX_PIXEL_RATIO, Number.isFinite(raw) && raw > 0 ? raw : 1)
}

/** The side, in pixels of the shared buffer, a face is drawn at: small faces at 2x, others at the canvas's ratio. */
export function faceDrawSide(size: number, pixelRatio: number): number {
  return Math.max(1, Math.round(size * (size < WHISKER_MIN_SIZE ? MAX_PIXEL_RATIO : pixelRatio)))
}

interface Slot {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  spec: FaceSpec
  motion: FaceMotion
  visible: boolean
  /** Wants a frame whatever its timing: new or changed. */
  dirty: boolean
  nextAt: number
  lastT: number | null
  /** Side of the face's canvas, in device pixels. */
  px: number
  /** Side it is drawn at in the shared buffer. */
  drawPx: number
}

interface Job {
  slot: Slot
  uniforms: FaceUniforms
  cacheKey?: string
  x: number
  y: number
}

export class FaceRenderer {
  private readonly env: FaceRendererEnv
  private gpu: FaceGpu | null
  private readonly slots = new Map<HTMLCanvasElement, Slot>()
  private readonly cache = new Map<string, HTMLCanvasElement>()
  private readonly observer: IntersectionObserver | null
  private readonly listeners = new Set<() => void>()
  private readonly random: () => number
  private frameId: number | null = null
  private failed = false
  private ready = false
  private readonly onVisibility = () => this.schedule()
  private stat = { ticks: 0, lastFaces: 0, averageMs: 0, maxMs: 0, gpuMs: 0, gpuMaxMs: 0 }
  private lastDraw = -Infinity
  /** Wait for the GPU at the end of each tick, so the stats include the shader time. */
  measureGpu = false

  constructor(env: FaceRendererEnv) {
    this.env = env
    this.random = env.random ?? Math.random
    this.gpu = env.createGpu()
    if (!this.gpu) this.failed = true
    this.gpu?.onRestored(() => {
      for (const slot of this.slots.values()) slot.dirty = true
      this.schedule()
    })
    const Observer = env.IntersectionObserver
    this.observer = Observer && this.gpu
      ? new Observer((entries) => {
          for (const entry of entries) {
            const slot = this.slots.get(entry.target as HTMLCanvasElement)
            if (slot) slot.visible = entry.isIntersecting
          }
          this.schedule()
        })
      : null
    env.document?.addEventListener('visibilitychange', this.onVisibility)
  }

  status(): FaceRendererStatus {
    if (this.failed) return 'failed'
    return this.ready ? 'ready' : 'pending'
  }

  /** Called when the status changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Starts drawing into `canvas`. Null when the canvas has no 2D context or WebGL failed. */
  register(canvas: HTMLCanvasElement, spec: FaceSpec): FaceHandle | null {
    if (this.failed) return null
    let ctx: CanvasRenderingContext2D | null = null
    try {
      ctx = canvas.getContext('2d')
    } catch {
      ctx = null
    }
    if (!ctx) return null
    const t = this.env.now() / 1000
    const slot: Slot = {
      canvas,
      ctx,
      spec,
      motion: new FaceMotion(spec.state, this.random),
      visible: !this.observer,
      dirty: true,
      nextAt: t + this.random() * FRAME_INTERVAL[spec.state],
      lastT: null,
      px: 0,
      drawPx: 0
    }
    this.slots.set(canvas, slot)
    this.sizeCanvas(slot)
    this.observer?.observe(canvas)
    this.schedule()
    return {
      update: (next) => this.update(slot, next),
      dispose: () => {
        if (this.slots.get(canvas) !== slot) return
        this.slots.delete(canvas)
        this.observer?.unobserve(canvas)
        if (!this.wanted()) this.stop()
      }
    }
  }

  stats(): FaceRendererStats {
    let visible = 0
    for (const slot of this.slots.values()) if (slot.visible) visible++
    return { ...this.stat, faces: this.slots.size, visible }
  }

  resetStats(): void {
    this.stat = { ticks: 0, lastFaces: 0, averageMs: 0, maxMs: 0, gpuMs: 0, gpuMaxMs: 0 }
  }

  /** Whether a frame is scheduled. */
  get running(): boolean {
    return this.frameId !== null
  }

  dispose(): void {
    this.stop()
    this.observer?.disconnect()
    this.env.document?.removeEventListener('visibilitychange', this.onVisibility)
    this.slots.clear()
    this.cache.clear()
    this.gpu?.dispose()
    this.gpu = null
    this.listeners.clear()
  }

  private update(slot: Slot, next: FaceSpec): void {
    const prev = slot.spec
    if (
      prev.look.colour === next.look.colour && prev.look.accessory === next.look.accessory && prev.state === next.state &&
      prev.size === next.size && prev.view === next.view && prev.still === next.still
    ) return
    slot.spec = next
    if (prev.state !== next.state) slot.motion.set(next.state, this.env.now() / 1000)
    slot.dirty = true
    this.sizeCanvas(slot)
    this.schedule()
  }

  private sizeCanvas(slot: Slot): void {
    const ratio = facePixelRatio(this.env.pixelRatio())
    const px = Math.max(1, Math.round(slot.spec.size * ratio))
    slot.drawPx = faceDrawSide(slot.spec.size, ratio)
    if (px === slot.px) return
    slot.px = px
    slot.canvas.width = px
    slot.canvas.height = px
    slot.dirty = true
  }

  private hidden(): boolean {
    return this.env.document?.visibilityState === 'hidden'
  }

  /** Whether any face wants a frame, now or later. */
  private wanted(): boolean {
    if (this.failed || this.hidden()) return false
    for (const slot of this.slots.values()) if (slot.visible && (slot.dirty || !slot.spec.still)) return true
    return false
  }

  private schedule(): void {
    if (this.frameId !== null || !this.wanted()) return
    this.frameId = this.env.requestFrame((now) => this.tick(now))
  }

  private stop(): void {
    if (this.frameId === null) return
    this.env.cancelFrame(this.frameId)
    this.frameId = null
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }

  private tick(nowMs: number): void {
    this.frameId = null
    const gpu = this.gpu
    if (!gpu || this.failed || this.hidden()) return
    const gpuStatus = gpu.status()
    if (gpuStatus === 'failed') {
      this.failed = true
      this.notify()
      return
    }
    if (gpuStatus !== 'ready') {
      // Compiling: check again next frame. Lost: wait for onRestored.
      if (gpuStatus === 'pending') this.schedule()
      return
    }
    if (!this.ready) {
      this.ready = true
      this.notify()
    }
    const t = nowMs / 1000
    if (t - this.lastDraw < MIN_TICK) {
      this.schedule()
      return
    }
    const due: { slot: Slot; at: number }[] = []
    for (const slot of this.slots.values()) {
      if (!slot.visible) continue
      this.sizeCanvas(slot)
      if (slot.spec.still ? slot.dirty : slot.dirty || t + FRAME_SLACK >= slot.nextAt) due.push({ slot, at: slot.dirty ? -Infinity : slot.nextAt })
    }
    if (due.length === 0) return this.schedule()
    due.sort((a, b) => a.at - b.at)
    const jobs: Job[] = []
    let spent = 0
    for (const { slot } of due) {
      const { spec } = slot
      const view = { view: spec.view, size: spec.size, samples: 1 as const }
      const cacheKey = spec.still ? `${spec.look.colour}|${spec.look.accessory}|${spec.state}|${spec.view}|${spec.size}|${slot.px}` : undefined
      if (cacheKey) {
        const cached = this.cache.get(cacheKey)
        if (cached) {
          // Most recently used last, so the oldest goes first.
          this.cache.delete(cacheKey)
          this.cache.set(cacheKey, cached)
          slot.ctx.clearRect(0, 0, slot.px, slot.px)
          slot.ctx.drawImage(cached, 0, 0)
          slot.dirty = false
          continue
        }
        // Two still faces alike on one tick: the second copies the first's frame next tick.
        if (jobs.some((job) => job.cacheKey === cacheKey)) continue
      }
      const cost = slot.drawPx * slot.drawPx
      if (spent > 0 && spent + cost > SAMPLE_BUDGET) continue
      spent += cost
      if (cacheKey) {
        jobs.push({ slot, uniforms: faceUniforms(spec.look, stillPose(spec.state), view), cacheKey, x: 0, y: 0 })
        continue
      }
      const dt = slot.lastT === null ? 1 / 30 : Math.min(0.1, Math.max(0, t - slot.lastT))
      const interval = FRAME_INTERVAL[spec.state]
      slot.lastT = t
      // Keep each face's phase, unless it fell a whole frame behind.
      slot.nextAt = slot.nextAt + interval < t ? t + interval : slot.nextAt + interval
      jobs.push({ slot, uniforms: faceUniforms(spec.look, slot.motion.frame(t, dt), view), x: 0, y: 0 })
    }
    if (jobs.length > 0) {
      this.lastDraw = t
      const started = this.env.now()
      if (this.measureGpu) this.measure(gpu, () => this.drawJobs(gpu, jobs))
      else this.drawJobs(gpu, jobs)
      const ms = this.env.now() - started
      this.stat.ticks++
      this.stat.lastFaces = jobs.length
      this.stat.averageMs = this.stat.ticks === 1 ? ms : this.stat.averageMs * 0.9 + ms * 0.1
      this.stat.maxMs = Math.max(this.stat.maxMs, ms)
    }
    this.schedule()
  }

  private measure(gpu: FaceGpu, draw: () => void): void {
    const record = (ms: number) => {
      this.stat.gpuMs = this.stat.gpuMs === 0 ? ms : this.stat.gpuMs * 0.9 + ms * 0.1
      this.stat.gpuMaxMs = Math.max(this.stat.gpuMaxMs, ms)
    }
    if (gpu.timer) {
      gpu.timer.begin()
      draw()
      gpu.timer.end()
      for (const ms of gpu.timer.poll()) record(ms)
      return
    }
    gpu.finish()
    const drawing = this.env.now()
    draw()
    gpu.finish()
    const drawn = this.env.now()
    gpu.finish()
    record(Math.max(0, drawn - drawing - (this.env.now() - drawn)))
  }

  /** Packs the jobs into rows of the shared buffer, draws them, then copies each out. */
  private drawJobs(gpu: FaceGpu, jobs: Job[]): void {
    let batch: Job[] = []
    let x = 0
    let y = 0
    let rowHeight = 0
    let width = 0
    const flush = () => {
      if (batch.length === 0) return
      gpu.ensureSize(width, y + rowHeight)
      for (const job of batch) gpu.draw(job.x, job.y, job.slot.drawPx, job.uniforms)
      for (const job of batch) this.copyOut(gpu, job)
      batch = []
      x = y = rowHeight = width = 0
    }
    for (const job of jobs) {
      const side = job.slot.drawPx
      if (x > 0 && x + side > ATLAS_WIDTH) {
        x = 0
        y += rowHeight
        rowHeight = 0
      }
      if (y > 0 && y + side > ATLAS_MAX_HEIGHT) flush()
      job.x = x
      job.y = y
      batch.push(job)
      x += side
      width = Math.max(width, x)
      rowHeight = Math.max(rowHeight, side)
    }
    flush()
  }

  private copyOut(gpu: FaceGpu, job: Job): void {
    const { slot } = job
    const px = slot.px
    slot.dirty = false
    slot.ctx.clearRect(0, 0, px, px)
    // Small faces are scaled down from 2x; a better filter than bilinear keeps them smooth. Set
    // here, as resizing a canvas resets it.
    slot.ctx.imageSmoothingQuality = 'high'
    slot.ctx.drawImage(gpu.canvas, job.x, job.y, slot.drawPx, slot.drawPx, 0, 0, px, px)
    if (!job.cacheKey) return
    const copy = this.env.createCanvas()
    copy.width = copy.height = px
    const ctx = copy.getContext('2d')
    if (!ctx) return
    ctx.drawImage(slot.canvas, 0, 0)
    this.cache.set(job.cacheKey, copy)
    while (this.cache.size > STILL_CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!)
  }
}

/** `EXT_disjoint_timer_query`, which lib.dom doesn't type for WebGL 1. */
interface TimerQueryExt {
  readonly TIME_ELAPSED_EXT: number
  readonly GPU_DISJOINT_EXT: number
  readonly QUERY_RESULT_EXT: number
  readonly QUERY_RESULT_AVAILABLE_EXT: number
  createQueryEXT(): object | null
  deleteQueryEXT(query: object): void
  beginQueryEXT(target: number, query: object): void
  endQueryEXT(target: number): void
  getQueryObjectEXT(query: object, pname: number): unknown
}

/** The WebGL side: one context on a detached canvas. Where the driver can, the shader compiles in the background. */
export function createWebGlGpu(doc: Document): FaceGpu | null {
  let canvas: HTMLCanvasElement
  let gl: WebGLRenderingContext | null
  try {
    canvas = doc.createElement('canvas')
    canvas.width = canvas.height = 1
    gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
      // Software WebGL can't ray-march 20 faces a frame; the still fallback is better there.
      failIfMajorPerformanceCaveat: true
    })
  } catch {
    return null
  }
  if (!gl) return null
  const context = gl
  let state: 'pending' | 'ready' | 'lost' | 'failed' = 'pending'
  let program: WebGLProgram | null = null
  let uniforms = {} as Record<MiceUniform, WebGLUniformLocation | null>
  let parallel: { COMPLETION_STATUS_KHR: number } | null = null
  const restored = new Set<() => void>()
  const pixel = new Uint8Array(4)
  const timerExt = context.getExtension('EXT_disjoint_timer_query') as TimerQueryExt | null
  const queries: object[] = []

  const setUp = () => {
    try {
      parallel = context.getExtension('KHR_parallel_shader_compile') as { COMPLETION_STATUS_KHR: number } | null
      const shader = (type: number, source: string) => {
        const s = context.createShader(type)
        if (!s) throw new Error('no shader')
        context.shaderSource(s, source)
        context.compileShader(s)
        return s
      }
      program = context.createProgram()
      if (!program) throw new Error('no program')
      context.attachShader(program, shader(context.VERTEX_SHADER, MICE_VERTEX_SHADER))
      context.attachShader(program, shader(context.FRAGMENT_SHADER, MICE_FRAGMENT_SHADER))
      context.bindAttribLocation(program, 0, 'a')
      context.linkProgram(program)
      const buffer = context.createBuffer()
      context.bindBuffer(context.ARRAY_BUFFER, buffer)
      context.bufferData(context.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), context.STATIC_DRAW)
      context.enableVertexAttribArray(0)
      context.vertexAttribPointer(0, 2, context.FLOAT, false, 0, 0)
      context.disable(context.BLEND)
      state = 'pending'
    } catch {
      state = 'failed'
    }
  }

  // Reading the link status waits for the compile, so with the extension it waits until it is done.
  const checkLinked = () => {
    if (state !== 'pending' || !program) return
    if (parallel && !context.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR)) return
    if (!context.getProgramParameter(program, context.LINK_STATUS)) {
      state = context.isContextLost() ? 'lost' : 'failed'
      return
    }
    context.useProgram(program)
    const linked = program
    uniforms = Object.fromEntries(MICE_UNIFORMS.map((name) => [name, context.getUniformLocation(linked, name)])) as typeof uniforms
    state = 'ready'
  }

  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault()
    state = 'lost'
  })
  canvas.addEventListener('webglcontextrestored', () => {
    setUp()
    for (const listener of restored) listener()
  })
  setUp()

  return {
    canvas,
    status() {
      checkLinked()
      return state
    },
    ensureSize(width, height) {
      // Grow only, in steps, so the buffer isn't reallocated every tick.
      const w = Math.max(canvas.width, Math.ceil(width / 128) * 128)
      const h = Math.max(canvas.height, Math.ceil(height / 128) * 128)
      if (w !== canvas.width) canvas.width = w
      if (h !== canvas.height) canvas.height = h
    },
    draw(x, y, side, u) {
      const glY = canvas.height - y - side
      context.viewport(x, glY, side, side)
      context.uniform2f(uniforms.uRes, side, side)
      context.uniform2f(uniforms.uOrg, x, glY)
      context.uniform3fv(uniforms.uCol, u.uCol)
      context.uniform4fv(uniforms.uAC, u.uAC)
      context.uniform1f(uniforms.uAcc, u.uAcc)
      context.uniform4fv(uniforms.uB, u.uB)
      context.uniform4fv(uniforms.uH, u.uH)
      context.uniform4fv(uniforms.uH2, u.uH2)
      context.uniform4fv(uniforms.uE, u.uE)
      context.uniform4fv(uniforms.uE2, u.uE2)
      context.uniform4fv(uniforms.uV, u.uV)
      context.drawArrays(context.TRIANGLES, 0, 3)
    },
    timer: timerExt
      ? {
          begin() {
            const query = timerExt.createQueryEXT()
            if (!query) return
            timerExt.beginQueryEXT(timerExt.TIME_ELAPSED_EXT, query)
            queries.push(query)
          },
          end() {
            timerExt.endQueryEXT(timerExt.TIME_ELAPSED_EXT)
          },
          poll() {
            const done: number[] = []
            const disjoint = context.getParameter(timerExt.GPU_DISJOINT_EXT) as boolean
            while (queries.length > 0 && timerExt.getQueryObjectEXT(queries[0]!, timerExt.QUERY_RESULT_AVAILABLE_EXT)) {
              const query = queries.shift()!
              if (!disjoint) done.push((timerExt.getQueryObjectEXT(query, timerExt.QUERY_RESULT_EXT) as number) / 1e6)
              timerExt.deleteQueryEXT(query)
            }
            return done
          }
        }
      : undefined,
    finish() {
      // finish() doesn't wait in every browser; reading a pixel does.
      context.readPixels(0, 0, 1, 1, context.RGBA, context.UNSIGNED_BYTE, pixel)
    },
    onRestored(listener) {
      restored.add(listener)
    },
    dispose() {
      restored.clear()
      context.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }
}

function browserEnv(): FaceRendererEnv | null {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null
  return {
    createGpu: () => createWebGlGpu(document),
    createCanvas: () => document.createElement('canvas'),
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (id) => window.cancelAnimationFrame(id),
    now: () => performance.now(),
    pixelRatio: () => window.devicePixelRatio,
    document,
    IntersectionObserver: typeof IntersectionObserver === 'undefined' ? undefined : IntersectionObserver
  }
}

let shared: FaceRenderer | null | undefined
let sharedEnv: () => FaceRendererEnv | null = browserEnv
let unsubscribeShared: (() => void) | null = null
const sharedListeners = new Set<() => void>()

function notifyShared(): void {
  for (const listener of [...sharedListeners]) listener()
}

/** The app's one face renderer, made on first use. Null when WebGL is missing or failed to start. */
export function sharedFaceRenderer(): FaceRenderer | null {
  if (shared !== undefined) return shared
  const env = sharedEnv()
  const renderer = env ? new FaceRenderer(env) : null
  if (!renderer || renderer.status() === 'failed') {
    renderer?.dispose()
    shared = null
    return shared
  }
  shared = renderer
  unsubscribeShared = renderer.subscribe(notifyShared)
  if (import.meta.env?.DEV) {
    ;(globalThis as { __mousseFaceStats?: (measureGpu?: boolean) => FaceRendererStats }).__mousseFaceStats = (measureGpu) => {
      if (measureGpu !== undefined && measureGpu !== renderer.measureGpu) {
        renderer.measureGpu = measureGpu
        renderer.resetStats()
      }
      return renderer.stats()
    }
  }
  return shared
}

/** `unavailable` when there is no WebGL at all. Faces draw the still fallback unless it is `pending` or `ready`. */
export function sharedFaceRendererStatus(): FaceRendererStatus | 'unavailable' {
  const renderer = sharedFaceRenderer()
  return renderer ? renderer.status() : 'unavailable'
}

export function subscribeSharedFaceRenderer(listener: () => void): () => void {
  sharedListeners.add(listener)
  return () => sharedListeners.delete(listener)
}

export function faceRendererStats(): FaceRendererStats | null {
  return shared ? shared.stats() : null
}

/** Drops the shared renderer; the next face makes a new one from `env` (the browser by default). */
export function resetSharedFaceRenderer(env?: () => FaceRendererEnv | null): void {
  unsubscribeShared?.()
  unsubscribeShared = null
  shared?.dispose()
  shared = undefined
  sharedEnv = env ?? browserEnv
  notifyShared()
}
