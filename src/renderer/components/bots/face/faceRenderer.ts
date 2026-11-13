import { BOT_ACCESSORIES, BOT_ACCESSORY_HEX, BOT_COLOUR_HEX, BOT_COLOURS, BOT_EYES, BOT_KINDS, type KnownBotLook } from '../../../../shared/bots/personal/look'
import type { BotFaceState } from './BotFace'
import { browserFrameCodec, hashText, indexedDbFrameBackend, SavedFaceFrames, type FaceFrameStore } from './faceFrameStore'
import { FaceMotion, faceUniforms, stillPose, WHISKER_MIN_SIZE, type FaceUniforms } from './facePoses'
import { MICE_FRAGMENT_SHADER, MICE_UNIFORMS, MICE_VERTEX_SHADER, type MiceUniform } from './miceShader'
import { noteWebGlContext } from '../../../lib/webglCount'

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
 * - Still faces (reduced motion, `still`, settled faces) draw once, with 2×2 samples for clean
 *   edges (counted four times against the budget). Their frame is cached per look, state, view
 *   and pixel size, so a long list of the same still face costs one draw. Live faces take one
 *   sample; the shader softens their edges by how near each ray passes to the surface.
 * - A live face settles into its still pose a few seconds after its state last changed when it is
 *   idle or paused, and a few seconds after the window lost focus in any state; a busy face moves
 *   again when the window has focus.
 *
 * Ready from launch, and never blank:
 * - Each window starts the renderer right after its first paint (`warmFaceRendererAfterPaint`,
 *   from `main.tsx`), so the shader compiles before any face shows: ANGLE's Direct3D 11 backend on
 *   Windows takes seconds. Once compiled it stays for the life of the window; with no face shown
 *   for `IDLE_SHRINK_MS`, only the shared drawing buffer shrinks to 1×1.
 * - Every still frame drawn is also saved between runs (`faceFrameStore.ts`), under its exact spec
 *   and the art version (`faceArtVersion`). A face that can't draw live (compiling, context lost,
 *   WebGL failed) shows the saved frame of its spec; a moving face shows the saved still pose of its
 *   spec. Only a face with no saved frame draws the flat `BotFaceStill`. When live, a still face
 *   saved in an earlier run is copied in rather than drawn again. The saved frames start loading as
 *   the window starts (`startFaceFrameStore`); a face that mounts before they have, or whose
 *   picture is still decoding, holds an empty box for at most `SAVED_HOLD_MS`.
 * - While the shader compiles, the renderer checks it every `READY_POLL_MS`, so faces go live
 *   within that of it being ready. With no `KHR_parallel_shader_compile` the check waits for the
 *   compile, so it is then made only when a face is due to draw.
 * - A refused or software context, a failed compile and a first frame that reads back empty make
 *   the faces show their saved frame or the flat drawing.
 *
 * To measure: `faceRendererStats()` (also `window.__mousseFaceStats(measureGpu?)`) reports the
 * time per drawing tick, and `compileMs`, the time from the renderer's creation to the shader being
 * found ready (logged once as `[bot faces] shader ready in … ms`). With `measureGpu`, `gpuMs` is the
 * GPU time of each tick's draws, from a timer query (`EXT_disjoint_timer_query`) where there is
 * one. Without it, each drawing tick waits for the GPU before and after drawing and subtracts the
 * time an empty wait takes; that stalls the pipeline, so leave it off otherwise. On the development
 * machine (AMD Renoir integrated graphics) a sample costs 40 to 80 ns, so the budget keeps a tick
 * near 2 to 4 ms.
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

/** What a face hears from the renderer about its canvas. */
export interface FaceSlotEvents {
  /** The face can't draw live and has no saved frame for its spec: it should draw the flat fallback. */
  onNoPicture?(): void
  /** The renderer drew into the canvas while live, for the first time. */
  onDrawn?(): void
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
  /** Called when the context is lost. */
  onLost?(listener: () => void): void
  /** Shrinks the drawing buffer to 1×1; the next draw grows it again. */
  shrink?(): void
  /**
   * `status()` waits for the compile to end instead of answering at once (no
   * `KHR_parallel_shader_compile`). Then it is read only when a face is due to draw, not polled.
   */
  readonly statusWaits?: boolean
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
  /** Whether the window has focus; without it the window counts as focused. */
  hasFocus?(): boolean
  /** Calls `listener` when the window gains or loses focus; returns a function that stops it. */
  onFocusChange?(listener: () => void): () => void
  /** Calls `listener` when `pixelRatio()` changes (a zoom, another screen); returns a function that stops it. */
  onPixelRatioChange?(listener: () => void): () => void
  document?: Document
  IntersectionObserver?: typeof IntersectionObserver
  random?: () => number
  /** Calls `callback` after `ms`; returns a function that cancels it. Without it a lost context waits for its restore. */
  setTimer?(callback: () => void, ms: number): () => void
  /** Still frames saved between runs. Without it, a face that can't draw live draws the flat fallback. */
  frames?: FaceFrameStore
  /** Debug logging (the console in the app). */
  log?(message: string): void
}

export type FaceRendererStatus = 'pending' | 'ready' | 'failed'

/** Whether a face that can't draw live has a picture: in memory or saved, none, or not known until the saved frames load. */
export type FacePicture = 'saved' | 'none' | 'unknown'

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
  /** Milliseconds from the renderer's creation to the shader being found ready; null until it is. */
  compileMs: number | null
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
/** Seconds an idle or paused face moves after its state changed, and any face after the window lost focus. */
export const IDLE_LIVE_SECONDS = 6
export const UNFOCUSED_LIVE_SECONDS = 3
/** A lost context not back within this long fails: the faces show their saved frame or the flat fallback. */
export const LOST_CONTEXT_TIMEOUT_MS = 5_000
/** How often a compile in progress is checked, so faces go live within this of the shader being ready. */
export const READY_POLL_MS = 100
/**
 * With no face on screen for this long, the shared drawing buffer shrinks to 1×1. The context and the
 * compiled shader stay, so the next face draws live at once.
 */
export const IDLE_SHRINK_MS = 30_000
/** The longest a face holds an empty box while its saved frame loads, before it draws the flat fallback. */
export const SAVED_HOLD_MS = 60
/** Changes when the way a frame is drawn or copied out changes, outside the shader and the poses. */
const FRAME_FORMAT = 1

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

/** The key of a face's still frame, in memory and saved: its look, state, view and size, and its canvas's side in device pixels. */
export function stillFrameKey(spec: Pick<FaceSpec, 'look' | 'state' | 'view' | 'size'>, px: number): string {
  const { look } = spec
  return `${look.colour}|${look.accessory}|${look.kind ?? 'mouse'}|${look.eyes ?? 'pill'}|${spec.state}|${spec.view}|${spec.size}|${px}`
}

const ART_STATES: readonly BotFaceState[] = ['idle', 'working', 'needs_you', 'stuck', 'paused', 'happy']

/**
 * Names the art a saved frame was drawn with: the shader source, the still-pose uniforms of every
 * state, colour, accessory, character and eye shape, the drawing sizes and `FRAME_FORMAT`. A change
 * to any of them makes a new version, and frames saved under another are deleted.
 */
export function faceArtVersion(): string {
  const view = { view: 'full', size: 104, samples: 2 } as const
  const looks: KnownBotLook[] = [
    ...BOT_COLOURS.map((colour) => ({ colour, accessory: 'none' as const })),
    ...BOT_ACCESSORIES.map((accessory) => ({ colour: 'teal' as const, accessory })),
    ...BOT_KINDS.flatMap((kind) => BOT_EYES.map((eyes) => ({ colour: 'purple' as const, accessory: 'none' as const, kind, eyes })))
  ]
  const samples = [
    ...ART_STATES.map((state) => faceUniforms(looks[0]!, stillPose(state), view)),
    ...ART_STATES.map((state) => faceUniforms(looks[0]!, stillPose(state), { view: 'head', size: 40, samples: 2 })),
    ...looks.map((look) => faceUniforms(look, stillPose('idle'), view))
  ]
  return hashText(
    [FRAME_FORMAT, MAX_PIXEL_RATIO, WHISKER_MIN_SIZE, JSON.stringify(BOT_COLOUR_HEX), JSON.stringify(BOT_ACCESSORY_HEX), MICE_VERTEX_SHADER, MICE_FRAGMENT_SHADER, JSON.stringify(samples)].join('\n')
  )
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
  /** When its state last changed, in seconds. */
  changedAt: number
  /** Whether its last frame was the still pose. */
  drawnStill: boolean
  /** The key of the still frame shown while the face can't draw live; null once drawn live, or empty. */
  picture: string | null
  /** Whether the renderer has drawn into the canvas while live. */
  drawn: boolean
  /** Counts saved-frame loads, so a stale one is dropped. */
  load: number
  /** Ends the empty-box wait for a saved frame. */
  cancelHold: (() => void) | null
  events: FaceSlotEvents
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
  /** Still frames by `stillFrameKey`, drawn this run or loaded from the saved ones. */
  private readonly cache = new Map<string, CanvasImageSource>()
  /** Saved frames being loaded, by key. */
  private readonly loads = new Map<string, Promise<CanvasImageSource | null>>()
  private readonly observer: IntersectionObserver | null
  private readonly listeners = new Set<() => void>()
  private readonly random: () => number
  private frameId: number | null = null
  private failed = false
  private ready = false
  private readonly createdAt: number
  private compileMs: number | null = null
  /** Cancels the wait for a lost context to come back. */
  private cancelLostTimer: (() => void) | null = null
  /** Cancels the next check of a compile in progress. */
  private cancelReadyPoll: (() => void) | null = null
  /** Whether the first drawn face has been read back to check that it is not empty. */
  private verified = false
  private readonly onVisibility = () => this.schedule()
  private readonly stopRatioWatch: (() => void) | null
  private readonly stopFocusWatch: (() => void) | null
  private focused: boolean
  /** When the window last lost focus, in seconds. */
  private blurredAt = -Infinity
  private stat = { ticks: 0, lastFaces: 0, averageMs: 0, maxMs: 0, gpuMs: 0, gpuMaxMs: 0 }
  private lastDraw = -Infinity
  /** Wait for the GPU at the end of each tick, so the stats include the shader time. */
  measureGpu = false

  constructor(env: FaceRendererEnv) {
    this.env = env
    this.random = env.random ?? Math.random
    this.createdAt = env.now()
    this.gpu = env.createGpu()
    if (!this.gpu) this.failed = true
    this.gpu?.onLost?.(() => this.lost())
    this.gpu?.onRestored(() => {
      this.cancelLostTimer?.()
      this.cancelLostTimer = null
      for (const slot of this.slots.values()) slot.dirty = true
      // The restored context compiles the shader again, which may take as long as the first compile.
      this.startReadyPoll()
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
    this.focused = env.hasFocus?.() ?? true
    this.stopFocusWatch = env.onFocusChange?.(() => {
      const focused = env.hasFocus?.() ?? true
      if (focused === this.focused) return
      this.focused = focused
      if (!focused) this.blurredAt = env.now() / 1000
      this.schedule()
    }) ?? null
    // Faces off screen are sized when they next draw; a still face on screen draws again at the new ratio.
    this.stopRatioWatch = env.onPixelRatioChange?.(() => {
      for (const slot of this.slots.values()) {
        if (!slot.visible) continue
        this.sizeCanvas(slot)
        if (!this.live()) this.showSaved(slot)
      }
      this.schedule()
    }) ?? null
    // A first check now, where it is free, then every `READY_POLL_MS`.
    if (this.gpu && !this.gpu.statusWaits) this.checkReady()
  }

  status(): FaceRendererStatus {
    if (this.failed) return 'failed'
    return this.ready ? 'ready' : 'pending'
  }

  /** Failed for good (no context, a failed compile, a lost context that did not come back), not just still compiling. */
  get broken(): boolean {
    return this.failed
  }

  /** Called when the status changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Whether a face of this spec has a picture to show while it can't draw live. */
  pictureFor(spec: Pick<FaceSpec, 'look' | 'state' | 'view' | 'size'>): FacePicture {
    const key = stillFrameKey(spec, this.canvasSide(spec.size))
    if (this.cache.has(key)) return 'saved'
    const frames = this.env.frames
    if (!frames) return 'none'
    if (!frames.settled()) return 'unknown'
    return frames.has(key) ? 'saved' : 'none'
  }

  /**
   * Starts drawing into `canvas`: live once the shader is ready, its saved frame until then. Null
   * when the canvas has no 2D context.
   */
  register(canvas: HTMLCanvasElement, spec: FaceSpec, events: FaceSlotEvents = {}): FaceHandle | null {
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
      drawPx: 0,
      changedAt: t,
      drawnStill: spec.still,
      picture: null,
      drawn: false,
      load: 0,
      cancelHold: null,
      events
    }
    this.slots.set(canvas, slot)
    this.sizeCanvas(slot)
    this.observer?.observe(canvas)
    if (!this.live()) this.showSaved(slot)
    this.schedule()
    return {
      update: (next) => this.update(slot, next),
      dispose: () => {
        if (this.slots.get(canvas) !== slot) return
        this.slots.delete(canvas)
        slot.load++
        slot.cancelHold?.()
        slot.cancelHold = null
        this.observer?.unobserve(canvas)
        if (!this.wanted()) this.stop()
      }
    }
  }

  stats(): FaceRendererStats {
    let visible = 0
    for (const slot of this.slots.values()) if (slot.visible) visible++
    return { ...this.stat, faces: this.slots.size, visible, compileMs: this.compileMs }
  }

  resetStats(): void {
    this.stat = { ticks: 0, lastFaces: 0, averageMs: 0, maxMs: 0, gpuMs: 0, gpuMaxMs: 0 }
  }

  /** Whether a frame is scheduled. */
  get running(): boolean {
    return this.frameId !== null
  }

  /** Shrinks the shared drawing buffer while no face shows; the context and the compiled shader stay. */
  shrink(): void {
    this.gpu?.shrink?.()
  }

  dispose(): void {
    this.stop()
    this.cancelLostTimer?.()
    this.cancelLostTimer = null
    this.cancelReadyPoll?.()
    this.cancelReadyPoll = null
    for (const slot of this.slots.values()) slot.cancelHold?.()
    this.observer?.disconnect()
    this.env.document?.removeEventListener('visibilitychange', this.onVisibility)
    this.stopRatioWatch?.()
    this.stopFocusWatch?.()
    this.slots.clear()
    this.cache.clear()
    this.gpu?.dispose()
    this.gpu = null
    this.listeners.clear()
  }

  private update(slot: Slot, next: FaceSpec): void {
    const prev = slot.spec
    if (
      prev.look.colour === next.look.colour && prev.look.accessory === next.look.accessory && prev.look.kind === next.look.kind &&
      prev.look.eyes === next.look.eyes && prev.state === next.state &&
      prev.size === next.size && prev.view === next.view && prev.still === next.still
    ) return
    slot.spec = next
    if (prev.state !== next.state || prev.still !== next.still) slot.changedAt = this.env.now() / 1000
    if (prev.state !== next.state) slot.motion.set(next.state, slot.changedAt)
    slot.dirty = true
    this.sizeCanvas(slot)
    if (!this.live()) this.showSaved(slot)
    this.schedule()
  }

  private canvasSide(size: number): number {
    return Math.max(1, Math.round(size * facePixelRatio(this.env.pixelRatio())))
  }

  private sizeCanvas(slot: Slot): void {
    const ratio = facePixelRatio(this.env.pixelRatio())
    const px = this.canvasSide(slot.spec.size)
    slot.drawPx = faceDrawSide(slot.spec.size, ratio)
    if (px === slot.px) return
    slot.px = px
    // Setting a canvas's size clears it, even to the size it has, so only a new size is set.
    if (slot.canvas.width !== px || slot.canvas.height !== px) {
      slot.canvas.width = px
      slot.canvas.height = px
      slot.picture = null
      slot.drawn = false
    }
    slot.dirty = true
  }

  /** Whether the faces draw live: the shader is ready and nothing failed. */
  private live(): boolean {
    return this.ready && !this.failed
  }

  private hidden(): boolean {
    return this.env.document?.visibilityState === 'hidden'
  }

  /** Whether the face draws its still pose at `t`: asked to, or settled (see the cost notes above). */
  private still(slot: Slot, t: number): boolean {
    const { spec } = slot
    if (spec.still) return true
    if ((spec.state === 'idle' || spec.state === 'paused') && t - slot.changedAt >= IDLE_LIVE_SECONDS) return true
    return !this.focused && t - Math.max(slot.changedAt, this.blurredAt) >= UNFOCUSED_LIVE_SECONDS
  }

  /** Whether any face wants a frame, now or later. */
  private wanted(): boolean {
    if (this.failed || this.hidden()) return false
    const t = this.env.now() / 1000
    for (const slot of this.slots.values()) if (slot.visible && (slot.dirty || !slot.drawnStill || !this.still(slot, t))) return true
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

  /** Keeps a still frame in memory, most recently used last, so the oldest goes first. */
  private remember(key: string, frame: CanvasImageSource): void {
    this.cache.delete(key)
    this.cache.set(key, frame)
    while (this.cache.size > STILL_CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!)
  }

  /** A saved still frame, decoded and kept in memory; null when there is none. Waits for the saved frames to load. */
  private savedImage(key: string, px: number): Promise<CanvasImageSource | null> {
    const cached = this.cache.get(key)
    if (cached) return Promise.resolve(cached)
    const frames = this.env.frames
    if (!frames) return Promise.resolve(null)
    let loading = this.loads.get(key)
    if (!loading) {
      loading = new Promise<void>((resolve) => frames.onSettled(resolve))
        .then(() => (frames.has(key) ? frames.image(key) : null))
        .then((image) => {
          if (!image) return null
          // A frame of the wrong size is not this spec's: drop it, and draw the face anew.
          if (image.width !== px || image.height !== px) {
            frames.forget(key)
            return null
          }
          this.remember(key, image)
          return image
        })
        .catch(() => {
          frames.forget(key)
          return null
        })
        .finally(() => this.loads.delete(key))
      this.loads.set(key, loading)
    }
    return loading
  }

  /** Draws a still frame into a face that can't draw live. */
  private paint(slot: Slot, frame: CanvasImageSource, key: string): void {
    slot.ctx.clearRect(0, 0, slot.px, slot.px)
    slot.ctx.imageSmoothingQuality = 'high'
    slot.ctx.drawImage(frame, 0, 0, slot.px, slot.px)
    slot.picture = key
  }

  /**
   * Shows the still frame of the face's spec while it can't draw live: from memory at once, or saved,
   * holding the empty box for at most `SAVED_HOLD_MS`. With none, the face draws the flat fallback.
   */
  private showSaved(slot: Slot): void {
    const key = stillFrameKey(slot.spec, slot.px)
    if (slot.picture === key) return
    const load = ++slot.load
    slot.cancelHold?.()
    slot.cancelHold = null
    const cached = this.cache.get(key)
    if (cached) return this.paint(slot, cached, key)
    const frames = this.env.frames
    if (!frames || (frames.settled() && !frames.has(key))) return slot.events.onNoPicture?.()
    slot.cancelHold = this.env.setTimer?.(() => {
      slot.cancelHold = null
      if (slot.load === load && !this.live()) slot.events.onNoPicture?.()
    }, SAVED_HOLD_MS) ?? null
    void this.savedImage(key, slot.px).then((frame) => {
      if (slot.load !== load || this.slots.get(slot.canvas) !== slot) return
      slot.cancelHold?.()
      slot.cancelHold = null
      // Live by now and already drawn: the live frame stays.
      if (this.live() && slot.drawn) return
      if (frame) this.paint(slot, frame, key)
      else if (!this.live()) slot.events.onNoPicture?.()
    })
  }

  /** Fails for good: each face shows its saved frame, or draws the flat fallback. */
  private fail(): void {
    if (this.failed) return
    this.failed = true
    this.cancelReadyPoll?.()
    this.cancelReadyPoll = null
    this.stop()
    for (const slot of [...this.slots.values()]) this.showSaved(slot)
    this.notify()
  }

  /** The shader is ready. From a tick, that tick draws. */
  private becomeReady(fromTick = false): void {
    this.cancelReadyPoll?.()
    this.cancelReadyPoll = null
    if (this.ready) return
    this.ready = true
    if (this.compileMs === null) {
      this.compileMs = Math.round(this.env.now() - this.createdAt)
      this.env.log?.(`[bot faces] shader ready in ${this.compileMs} ms`)
    }
    this.notify()
    if (!fromTick) this.schedule()
  }

  /** Checks a compile in progress every `READY_POLL_MS`, whether or not any face shows. */
  private startReadyPoll(): void {
    if (this.failed || this.ready || !this.gpu || this.gpu.statusWaits || !this.env.setTimer || this.cancelReadyPoll) return
    this.cancelReadyPoll = this.env.setTimer(this.checkReady, READY_POLL_MS)
  }

  private readonly checkReady = (): void => {
    this.cancelReadyPoll = null
    const gpu = this.gpu
    if (!gpu || this.failed || this.ready) return
    const status = gpu.status()
    if (status === 'ready') return this.becomeReady()
    if (status === 'failed') return this.fail()
    // Lost: the poll starts again when the context is back.
    if (status === 'lost') return this.lost()
    this.startReadyPoll()
  }

  /**
   * Reads back the first face drawn: a face with no visible pixel means the GPU draws nothing here
   * (it reports ready but its frames come out empty), so the faces show saved frames or the flat fallback.
   */
  private verifyDrawn(slot: Slot): void {
    this.verified = true
    if (typeof slot.ctx.getImageData !== 'function') return
    let data: Uint8ClampedArray
    try {
      data = slot.ctx.getImageData(0, 0, slot.px, slot.px).data
    } catch {
      return
    }
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return
    this.fail()
  }

  /** The context is lost: not ready until it is back, and failed when it does not come back in time. Faces keep what they show. */
  private lost(): void {
    if (this.failed) return
    if (this.ready) {
      this.ready = false
      this.notify()
    }
    if (this.cancelLostTimer || !this.env.setTimer) return
    this.cancelLostTimer = this.env.setTimer(() => {
      this.cancelLostTimer = null
      if (this.gpu?.status() === 'lost') this.fail()
    }, LOST_CONTEXT_TIMEOUT_MS)
  }

  private markDrawn(slot: Slot): void {
    slot.picture = null
    if (slot.drawn) return
    slot.drawn = true
    slot.events.onDrawn?.()
  }

  private tick(nowMs: number): void {
    this.frameId = null
    const gpu = this.gpu
    if (!gpu || this.failed || this.hidden()) return
    const gpuStatus = gpu.status()
    if (gpuStatus === 'failed') return this.fail()
    if (gpuStatus !== 'ready') {
      // Compiling: check again next frame. Lost: wait for onRestored.
      if (gpuStatus === 'pending') this.schedule()
      else this.lost()
      return
    }
    if (!this.ready) this.becomeReady(true)
    const t = nowMs / 1000
    if (t - this.lastDraw < MIN_TICK) {
      this.schedule()
      return
    }
    const due: { slot: Slot; at: number }[] = []
    for (const slot of this.slots.values()) {
      if (!slot.visible) continue
      this.sizeCanvas(slot)
      const still = this.still(slot, t)
      // A face that settles draws its still pose once.
      if (still && !slot.drawnStill) slot.dirty = true
      slot.drawnStill = still
      if (still ? slot.dirty : slot.dirty || t + FRAME_SLACK >= slot.nextAt) due.push({ slot, at: slot.dirty ? -Infinity : slot.nextAt })
    }
    if (due.length === 0) return this.schedule()
    due.sort((a, b) => a.at - b.at)
    const jobs: Job[] = []
    let spent = 0
    for (const { slot } of due) {
      const { spec } = slot
      // Still frames are drawn once and cached, so they take 2×2 samples for clean edges.
      const samples: 1 | 2 = slot.drawnStill ? 2 : 1
      const view = { view: spec.view, size: spec.size, samples }
      const cacheKey = slot.drawnStill ? stillFrameKey(spec, slot.px) : undefined
      if (cacheKey) {
        const cached = this.cache.get(cacheKey)
        if (cached) {
          this.remember(cacheKey, cached)
          slot.ctx.clearRect(0, 0, slot.px, slot.px)
          slot.ctx.drawImage(cached, 0, 0, slot.px, slot.px)
          slot.dirty = false
          this.markDrawn(slot)
          continue
        }
        // Two still faces alike on one tick: the second copies the first's frame next tick.
        if (jobs.some((job) => job.cacheKey === cacheKey)) continue
        // Saved in an earlier run: copied in once loaded, instead of drawn again.
        if (this.env.frames?.has(cacheKey)) {
          if (!this.loads.has(cacheKey)) void this.savedImage(cacheKey, slot.px).then(() => this.schedule())
          continue
        }
      }
      const cost = slot.drawPx * slot.drawPx * samples * samples
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
      const copies: [string, HTMLCanvasElement][] = []
      if (this.measureGpu) this.measure(gpu, () => this.drawJobs(gpu, jobs, copies))
      else this.drawJobs(gpu, jobs, copies)
      if (!this.verified) this.verifyDrawn(jobs[0]!.slot)
      // Kept and saved only once the first frame is known not to be empty.
      if (!this.failed) {
        for (const [key, copy] of copies) {
          this.remember(key, copy)
          this.env.frames?.save(key, copy)
        }
      }
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

  /** Packs the jobs into rows of the shared buffer, draws them, then copies each out; still frames' copies go in `copies`. */
  private drawJobs(gpu: FaceGpu, jobs: Job[], copies: [string, HTMLCanvasElement][]): void {
    let batch: Job[] = []
    let x = 0
    let y = 0
    let rowHeight = 0
    let width = 0
    const flush = () => {
      if (batch.length === 0) return
      gpu.ensureSize(width, y + rowHeight)
      for (const job of batch) gpu.draw(job.x, job.y, job.slot.drawPx, job.uniforms)
      for (const job of batch) {
        const copy = this.copyOut(gpu, job)
        if (copy) copies.push([job.cacheKey!, copy])
      }
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

  /** Copies a drawn face into its canvas; for a still frame, also returns a copy to keep. */
  private copyOut(gpu: FaceGpu, job: Job): HTMLCanvasElement | null {
    const { slot } = job
    const px = slot.px
    slot.dirty = false
    slot.ctx.clearRect(0, 0, px, px)
    // Small faces are scaled down from 2x; a better filter than bilinear keeps them smooth. Set
    // here, as resizing a canvas resets it.
    slot.ctx.imageSmoothingQuality = 'high'
    slot.ctx.drawImage(gpu.canvas, job.x, job.y, slot.drawPx, slot.drawPx, 0, 0, px, px)
    this.markDrawn(slot)
    if (!job.cacheKey) return null
    const copy = this.env.createCanvas()
    copy.width = copy.height = px
    const ctx = copy.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(slot.canvas, 0, 0)
    return copy
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

/**
 * Whether the context renders in software (SwiftShader, llvmpipe), which `failIfMajorPerformanceCaveat`
 * does not always refuse (Chromium's unsafe SwiftShader): ray-marching faces there burns the CPU.
 */
export function softwareWebGl(gl: Pick<WebGLRenderingContext, 'getExtension' | 'getParameter'>): boolean {
  const info = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null
  const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : undefined
  return typeof renderer === 'string' && /swiftshader|llvmpipe|softpipe|software/i.test(renderer)
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
  if (!gl || softwareWebGl(gl)) return null
  const context = gl
  const releaseCount = noteWebGlContext(doc)
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
      // Send the compile to the GPU process now; a detached canvas is never composited, which would flush it.
      context.flush()
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

  const lost = new Set<() => void>()
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault()
    state = 'lost'
    for (const listener of lost) listener()
  })
  canvas.addEventListener('webglcontextrestored', () => {
    // The restored context may be a software one (Chromium falls back to SwiftShader): refused as at the start.
    if (softwareWebGl(context)) state = 'failed'
    else setUp()
    for (const listener of restored) listener()
  })
  setUp()

  return {
    canvas,
    status() {
      checkLinked()
      return state
    },
    get statusWaits() {
      return !parallel
    },
    ensureSize(width, height) {
      // Grow only, in steps, so the buffer isn't reallocated every tick.
      const w = Math.max(canvas.width, Math.ceil(width / 128) * 128)
      const h = Math.max(canvas.height, Math.ceil(height / 128) * 128)
      if (w !== canvas.width) canvas.width = w
      if (h !== canvas.height) canvas.height = h
    },
    shrink() {
      if (canvas.width !== 1 || canvas.height !== 1) canvas.width = canvas.height = 1
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
      context.uniform3fv(uniforms.uK, u.uK)
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
    onLost(listener) {
      lost.add(listener)
    },
    dispose() {
      restored.clear()
      lost.clear()
      context.getExtension('WEBGL_lose_context')?.loseContext()
      releaseCount()
    }
  }
}

let browserFrames: FaceFrameStore | undefined

/**
 * The saved face frames of this window, loading from IndexedDB. Called as the window starts
 * (`main.tsx`), so they are in before the first face; reading them doesn't wait on the shader.
 */
export function startFaceFrameStore(): FaceFrameStore {
  if (browserFrames) return browserFrames
  let backend = null
  try {
    backend = typeof indexedDB === 'undefined' ? null : indexedDbFrameBackend(indexedDB)
  } catch {
    backend = null
  }
  browserFrames = new SavedFaceFrames(backend, faceArtVersion(), browserFrameCodec)
  return browserFrames
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
    hasFocus: () => document.hasFocus(),
    onFocusChange: (listener) => {
      window.addEventListener('focus', listener)
      window.addEventListener('blur', listener)
      return () => {
        window.removeEventListener('focus', listener)
        window.removeEventListener('blur', listener)
      }
    },
    // A resolution query matches the ratio it was made for only; each change makes the next one.
    onPixelRatioChange: (listener) => {
      let query: MediaQueryList | undefined
      const changed = () => {
        watch()
        listener()
      }
      const watch = () => {
        query?.removeEventListener('change', changed)
        query = window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`)
        query?.addEventListener('change', changed)
      }
      watch()
      return () => query?.removeEventListener('change', changed)
    },
    setTimer: (callback, ms) => {
      const handle = window.setTimeout(callback, ms)
      return () => window.clearTimeout(handle)
    },
    frames: startFaceFrameStore(),
    log: (message) => console.info(message),
    document,
    IntersectionObserver: typeof IntersectionObserver === 'undefined' ? undefined : IntersectionObserver
  }
}

let shared: FaceRenderer | null | undefined
let sharedEnv: () => FaceRendererEnv | null = browserEnv
let unsubscribeShared: (() => void) | null = null
const sharedListeners = new Set<() => void>()
/** The timer for `IDLE_SHRINK_MS` is set on the environment the shared renderer was made from. */
let sharedTimerEnv: FaceRendererEnv | null = null
let cancelIdleShrink: (() => void) | null = null

function notifyShared(): void {
  for (const listener of [...sharedListeners]) listener()
}

/** The window's one face renderer, made at launch (`warmFaceRenderer`) or on first use. Null when WebGL is missing or failed to start. */
export function sharedFaceRenderer(): FaceRenderer | null {
  if (shared !== undefined) return shared
  const env = sharedEnv()
  const renderer = env ? new FaceRenderer(env) : null
  if (!renderer || renderer.broken) {
    renderer?.dispose()
    shared = null
    return shared
  }
  shared = renderer
  sharedTimerEnv = env
  unsubscribeShared = renderer.subscribe(notifyShared)
  if (sharedListeners.size === 0) scheduleIdleShrink()
  // Read-only numbers, kept in packaged builds too so a slow compile can be checked on any machine.
  ;(globalThis as { __mousseFaceStats?: (measureGpu?: boolean) => FaceRendererStats }).__mousseFaceStats = (measureGpu) => {
    if (measureGpu !== undefined && measureGpu !== renderer.measureGpu) {
      renderer.measureGpu = measureGpu
      renderer.resetStats()
    }
    return renderer.stats()
  }
  return shared
}

/** Makes the shared renderer now, so the shader compiles before any face shows. */
export function warmFaceRenderer(): void {
  sharedFaceRenderer()
}

/** Makes the shared renderer right after the window's next frame is painted, so it never delays that paint. */
export function warmFaceRendererAfterPaint(win: Pick<Window, 'requestAnimationFrame' | 'setTimeout'> = window): void {
  // A timeout set from a frame callback runs once that frame has been painted.
  win.requestAnimationFrame(() => {
    win.setTimeout(warmFaceRenderer, 0)
  })
}

/** `unavailable` when there is no WebGL at all. Faces draw live when it is `ready`, and their saved frame or the flat fallback otherwise. */
export function sharedFaceRendererStatus(): FaceRendererStatus | 'unavailable' {
  const renderer = sharedFaceRenderer()
  return renderer ? renderer.status() : 'unavailable'
}

/** Each face mounted subscribes; with none for `IDLE_SHRINK_MS`, the shared drawing buffer shrinks. */
export function subscribeSharedFaceRenderer(listener: () => void): () => void {
  sharedListeners.add(listener)
  cancelIdleShrink?.()
  cancelIdleShrink = null
  return () => {
    sharedListeners.delete(listener)
    if (sharedListeners.size === 0) scheduleIdleShrink()
  }
}

function scheduleIdleShrink(): void {
  cancelIdleShrink?.()
  cancelIdleShrink = shared && sharedTimerEnv?.setTimer ? sharedTimerEnv.setTimer(shrinkIdleRenderer, IDLE_SHRINK_MS) : null
}

function shrinkIdleRenderer(): void {
  cancelIdleShrink = null
  if (sharedListeners.size > 0 || !shared) return
  shared.shrink()
}

export function faceRendererStats(): FaceRendererStats | null {
  return shared ? shared.stats() : null
}

/** Drops the shared renderer; the next use makes a new one from `env` (the browser by default). */
export function resetSharedFaceRenderer(env?: () => FaceRendererEnv | null): void {
  cancelIdleShrink?.()
  cancelIdleShrink = null
  unsubscribeShared?.()
  unsubscribeShared = null
  shared?.dispose()
  shared = undefined
  sharedTimerEnv = null
  sharedEnv = env ?? browserEnv
  notifyShared()
}
