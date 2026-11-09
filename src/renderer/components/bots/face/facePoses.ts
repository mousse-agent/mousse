import { BOT_ACCESSORIES, BOT_ACCESSORY_HEX, BOT_COLOUR_HEX, BOT_EYES, BOT_KINDS, botEyesOf, botKindOf, type KnownBotLook } from '../../../../shared/bots/personal/look'
import type { BotFaceState } from './BotFace'

/**
 * The clay mouse's poses (bot-ui §4.3): where each feeling settles, the easing towards it, and the
 * moves on top that carry it. A port of the `Mouse` class in
 * `docs/plans/mockups/bot-ui/source/mice3d/mice.html` (lines 166 to 235); keep the two in step. The
 * reference's feelings map to the app's states: waiting is `needs_you`, blocked is `stuck`,
 * sleeping is `paused`.
 */

export const FACE_POSE_KEYS = [
  'hop', 'sq', 'roll', 'tail', 'yaw', 'pitch', 'hroll', 'earL', 'earR', 'armL', 'armR', 'laptop',
  'open', 'closed', 'arc', 'worried', 'lookX', 'lookY', 'es', 'sweat'
] as const
export type FacePoseKey = (typeof FACE_POSE_KEYS)[number]
export type FacePose = Record<FacePoseKey, number>

export const REST_POSE: Readonly<FacePose> = {
  hop: 0, sq: 1, roll: 0, tail: 0, yaw: 0, pitch: 0, hroll: 0, earL: 0, earR: 0, armL: 0, armR: 0, laptop: 0,
  open: 1, closed: 0, arc: 1, worried: 0, lookX: 0, lookY: 0, es: 1, sweat: 0
}

/** One hop: a crouch, a stretched flight and a landing squash. Returns [height 0..1, vertical scale]. */
export function hop(u: number): [number, number] {
  if (u < 0 || u > 1.3) return [0, 1]
  if (u < 0.18) return [0, 1 - 0.13 * Math.sin((Math.PI * u) / 0.18)]
  if (u < 1) {
    const v = (u - 0.18) / 0.82
    return [Math.sin(Math.PI * v), 1 + 0.07 * Math.sin(Math.PI * v)]
  }
  return [0, 1 - 0.11 * Math.sin((Math.PI * (u - 1)) / 0.3)]
}

/** States whose eyes are open, so they blink. */
const BLINKS: ReadonlySet<BotFaceState> = new Set(['idle', 'working', 'needs_you', 'stuck'])

/**
 * One mouse's motion. `frame(t, dt)` eases the pose towards the state's targets and adds the
 * state's moves; with `still` it returns the settled pose alone (reduced motion). Each mouse starts
 * at its own phase so a list doesn't move in step. `random` is injectable for tests and baking.
 */
export class FaceMotion {
  state: BotFaceState
  private readonly random: () => number
  private readonly t0: number
  private p: FacePose = { ...REST_POSE }
  private gaze = 0
  private gazeY = 0
  private nextGaze = 0
  private blinkAt: number
  private twitchAt: number
  private since = 0
  private first = true

  constructor(state: BotFaceState, random: () => number = Math.random, t0?: number) {
    this.random = random
    this.state = state
    this.t0 = t0 ?? this.rnd(0, 40)
    this.blinkAt = this.rnd(0.5, 3)
    this.twitchAt = this.rnd(2, 6)
  }

  private rnd(a: number, b: number): number {
    return a + this.random() * (b - a)
  }

  set(state: BotFaceState, t: number): void {
    if (state === this.state) return
    this.state = state
    this.since = t
  }

  /** Where the state settles, at time `t`. Motion on top of this is added in `frame()`. */
  targets(t: number, still = false): FacePose {
    const T: FacePose = { ...REST_POSE }
    const s = this.state
    const tt = t + this.t0
    if (s === 'idle') {
      if (!still && t > this.nextGaze) {
        this.gaze = this.random() < 0.35 ? 0 : this.rnd(-0.5, 0.5)
        this.gazeY = this.rnd(-0.03, 0.04)
        this.nextGaze = t + this.rnd(1.6, 3.6)
      }
      const gaze = still ? 0 : this.gaze
      T.yaw = gaze * 0.5
      T.lookX = gaze
      T.lookY = still ? 0 : this.gazeY
      T.hroll = Math.sin(tt * 0.7) * 0.04
      T.tail = Math.sin(tt * 1.3) * 0.18
    } else if (s === 'working') {
      const ph = (tt % 1.9) / 1.9
      T.laptop = 1
      T.pitch = 0.1
      T.lookY = -0.045
      T.open = 0.8
      T.earL = T.earR = 0.12
      T.lookX = ph < 0.85 ? -0.55 + (1.1 * ph) / 0.85 : 0.55 - (1.1 * (ph - 0.85)) / 0.15
      T.yaw = T.lookX * 0.08
    } else if (s === 'needs_you') {
      T.es = 1.2
      T.open = 1.05
      T.pitch = -0.14
      T.earL = T.earR = -0.24
      T.armR = 2.5
      T.lookY = 0.02
      T.tail = Math.sin(tt * 4) * 0.3
    } else if (s === 'stuck') {
      T.worried = 0.85
      T.open = 0.92
      T.pitch = 0.1
      T.hroll = 0.16
      T.earL = 0.6
      T.earR = 0.5
      T.sweat = 1
      T.armL = 0.3
      T.lookX = Math.sin(tt * 0.8) > 0 ? 0.3 : -0.3
      T.yaw = T.lookX * 0.2
      T.tail = -0.25
      T.sq = 0.97
    } else if (s === 'paused') {
      T.closed = 1
      T.arc = -1
      T.pitch = 0.22
      T.hroll = 0.22
      T.earL = 0.42
      T.earR = 0.36
      T.lookY = -0.03
    } else if (s === 'happy') {
      T.closed = 1
      T.arc = 1
      T.earL = T.earR = -0.2
      T.armL = T.armR = 1.9
      T.yaw = Math.sin(tt * 1.7) * 0.14
    }
    return T
  }

  /** The pose at time `t` (seconds), `dt` after the last frame. */
  frame(t: number, dt: number, still = false): FacePose {
    const T = this.targets(t, still)
    const p = this.p
    const k = 1 - Math.exp(-dt * 9)
    const kc = 1 - Math.exp(-dt * 13)
    for (const key of FACE_POSE_KEYS) p[key] = this.first || still ? T[key] : p[key] + (T[key] - p[key]) * (key === 'closed' ? kc : k)
    p.arc = T.arc
    this.first = false
    const o: FacePose = { ...p }
    if (still) return o
    const tt = t + this.t0
    const a = t - this.since
    const s = this.state
    // Breathing, and the moves that carry each feeling.
    o.sq *= 1 + (s === 'paused' ? 0.035 * Math.sin(tt * 1.6) : 0.012 * Math.sin(tt * 2.1))
    if (s === 'idle' && t > this.twitchAt - 0.25) {
      const u = (t - (this.twitchAt - 0.25)) / 0.25
      if (u >= 1) this.twitchAt = t + this.rnd(3, 7)
      else o.earR -= 0.3 * Math.sin(Math.PI * u)
    }
    if (s === 'working') {
      o.armL += 0.12 * Math.max(0, Math.sin(tt * 15))
      o.armR += 0.12 * Math.max(0, Math.sin(tt * 15 + Math.PI))
      o.pitch += 0.02 * Math.sin(tt * 7)
    }
    if (s === 'needs_you') {
      o.armR += 0.35 * Math.sin(tt * 9)
      const c = a % 3
      for (const start of [0, 0.5]) {
        const [h, q] = hop((c - start) / 0.42)
        o.hop += h * 0.32
        o.sq *= q
      }
      o.roll += 0.04 * Math.sin(tt * 2)
    }
    if (s === 'stuck') {
      const c = tt % 4.5
      if (c < 0.45) o.roll += 0.035 * Math.sin(tt * 45) * Math.sin((Math.PI * c) / 0.45)
    }
    if (s === 'happy') {
      const [h, q] = hop((a % 1.5) / 0.4)
      o.hop += h * 0.2
      o.sq *= q
      o.roll += 0.1 * Math.sin(tt * 3.4)
      o.armL += 0.25 * Math.sin(tt * 6.8)
      o.armR += 0.25 * Math.sin(tt * 6.8 + 1)
      o.tail = Math.sin(tt * 11) * 0.45
    }
    // Timed blinks while the eyes are open.
    if (BLINKS.has(s)) {
      if (t > this.blinkAt + 0.17) this.blinkAt = t + (this.random() < 0.2 ? 0.25 : this.rnd(2.2, 5))
      const u = (t - this.blinkAt) / 0.17
      if (u > 0 && u < 1) o.open *= 1 - 0.95 * Math.sin(Math.PI * u)
    }
    return o
  }
}

/** The settled pose of a state with no motion, as reduced motion and cached stills draw it. */
export function stillPose(state: BotFaceState): FacePose {
  // A fixed phase, so every still of a state is the same picture (the bake's still frame).
  return new FaceMotion(state, () => 0.5, 3).frame(0.6, 0, true)
}

/** Below this size (CSS pixels) the whiskers turn to noise and are dropped. */
export const WHISKER_MIN_SIZE = 56

export interface FaceView {
  view: 'head' | 'full'
  /** CSS pixels. */
  size: number
  /** Samples per axis: 1 or 2. */
  samples: 1 | 2
}

/** The per-face shader uniforms, in `miceShader.ts` order. */
export interface FaceUniforms {
  uCol: [number, number, number]
  uAC: [number, number, number, number]
  uAcc: number
  uB: [number, number, number, number]
  uH: [number, number, number, number]
  uH2: [number, number, number, number]
  uE: [number, number, number, number]
  uE2: [number, number, number, number]
  uV: [number, number, number, number]
  /** Kind (`BOT_KINDS` index) and eye shape (`BOT_EYES` index). */
  uK: [number, number]
}

/** Metal accessories get the bright specular. */
const METAL: ReadonlySet<string> = new Set(['crown'])

export function hexToRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
}

export function faceUniforms(look: KnownBotLook, pose: FacePose, view: FaceView): FaceUniforms {
  const head = view.view === 'head'
  const accessory = BOT_ACCESSORY_HEX[look.accessory]
  return {
    uCol: hexToRgb(BOT_COLOUR_HEX[look.colour]),
    uAC: [...hexToRgb(accessory ?? '#000000'), METAL.has(look.accessory) ? 1 : 0],
    uAcc: BOT_ACCESSORIES.indexOf(look.accessory),
    uB: [pose.hop, pose.sq, pose.roll, pose.tail],
    uH: [pose.yaw, pose.pitch, pose.hroll, pose.earL],
    uH2: [pose.earR, pose.armL, pose.armR, pose.laptop],
    uE: [pose.open, pose.closed, pose.arc, pose.worried],
    uE2: [pose.lookX, pose.lookY, pose.es, pose.sweat],
    uV: [head ? 0.8 : 0.32, head ? 1.45 : 2.1, view.samples, view.size < WHISKER_MIN_SIZE ? 1 : 0],
    uK: [BOT_KINDS.indexOf(botKindOf(look)), BOT_EYES.indexOf(botEyesOf(look))]
  }
}
