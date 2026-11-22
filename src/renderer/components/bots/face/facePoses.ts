import { BOT_ACCESSORIES, BOT_ACCESSORY_HEX, BOT_COLOUR_HEX, BOT_EYES, BOT_KINDS, botEyeColourOf, botEyesOf, botKindOf, type BotEyes, type KnownBotLook } from '../../../../shared/bots/personal/look'
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

/**
 * Every eye is drawn this much bigger than the reference's: bold cartoon eyes. The shader gets the pose's `es`
 * times this, and the hybrid face's flat eyes (`hybridEyes.ts`) the same.
 */
export const EYE_SCALE = 1.18

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
        this.gaze = this.random() < 0.3 ? 0 : this.rnd(-0.7, 0.7)
        this.gazeY = this.rnd(-0.1, 0.12)
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

/**
 * A head that rolls past its idle sway (`HEAD_ROLL_SWAY`), asleep or stuck, leans out of the head view's frame: the
 * view follows it, panning `HEAD_ROLL_PAN` of the side per radian of roll the way it leans and widening by
 * `HEAD_ROLL_ROOM` of the field of view per radian, so both ears stay in. An upright head keeps `HEAD_FOV`, centred.
 */
export const HEAD_FOV = 1.45
export const HEAD_ROLL_SWAY = 0.05
export const HEAD_ROLL_PAN = 0.45
export const HEAD_ROLL_ROOM = 1.4

function rollPast(hroll: number): number {
  return Math.sign(hroll) * Math.max(0, Math.abs(hroll) - HEAD_ROLL_SWAY)
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
  /** Kind (`BOT_KINDS` index), eye shape (`BOT_EYES` index), 1 for white eyes, and the eyes' spread (`eyeSpread`). */
  uK: [number, number, number, number]
  /** How far the picture moves in its square, as a share of the side (x right, y up): the view following a leaning head. */
  pan: [number, number]
}

/** Metal accessories get the bright specular. */
const METAL: ReadonlySet<string> = new Set(['crown'])

export function hexToRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
}

/**
 * The `eyes` value of a look drawn with no eyes: the body picture of a hybrid face (`HybridFace.tsx`), whose eyes are
 * flat shapes over it. The shader has no switch for it; the eyes are moved far out of the picture instead.
 */
export const EYELESS = 'none'

/** The look's eye shape, with the default for the hybrid face's sentinels (`EYELESS`, `FRONT_ONLY`, `FEATURES_ONLY`). */
export function eyeShapeOf(look: KnownBotLook): BotEyes {
  const eyes = botEyesOf(look)
  return BOT_EYES.includes(eyes) ? eyes : 'pill'
}

/**
 * How far each eye shape sits from the middle, so the two eyes never touch even at their biggest (needs you, eye
 * scale 1.2 times `EYE_SCALE`): the mouse's eye x in its head, and the angle (radians) of the Mousse's eye round its
 * glass. The shader gets the look's own as `uK.w`; with glasses on, `eyeSpread` puts them in the lenses.
 */
export const EYE_SPREAD: Record<BotEyes, { mouse: number; mousse: number }> = {
  pill: { mouse: 0.37, mousse: 0.255 },
  round: { mouse: 0.4, mousse: 0.335 },
  dot: { mouse: 0.37, mousse: 0.255 },
  tall: { mouse: 0.37, mousse: 0.255 },
  square: { mouse: 0.4, mousse: 0.315 },
  heart: { mouse: 0.4, mousse: 0.335 },
  star: { mouse: 0.46, mousse: 0.43 },
  code: { mouse: 0.37, mousse: 0.255 }
}

/** Eye units (the shader's `eye2` space): the radius of a circle round each open eye shape at scale 1. */
export const EYE_RADIUS: Record<BotEyes, number> = { pill: 0.225, round: 0.2, dot: 0.105, tall: 0.3, square: 0.223, heart: 0.21, star: 0.285, code: 0.223 }

/** Half the height of each open eye shape (the shader's `eyeHH`), for the worried lid. */
export const EYE_HALF_HEIGHT: Record<BotEyes, number> = { pill: 0.225, round: 0.2, dot: 0.105, tall: 0.3, square: 0.175, heart: 0.3, star: 0.3, code: 0.2 }

/**
 * With glasses on, the eyes sit in the middle of the lenses (`spread`), each shape scaled so its radius is `fit` eye
 * units at scale 1, and look about only as far as keeps the eye's edge within `room` of the lens's middle. `look`
 * is the eye units one unit of look moves an eye, across and up (the shader's `map` and `eyesM`).
 */
export const LENS = {
  mouse: { fit: 0.127, room: 0.215, spread: 0.37, look: [0.09, 1] },
  mousse: { fit: 0.1, room: 0.17, spread: 0.2694, look: [0.2387, 0.8889] }
} as const

/** Where each eye sits from the middle for this look: the mouse's eye x in its head, the Mousse's angle round its glass. */
export function eyeSpread(look: KnownBotLook): { mouse: number; mousse: number } {
  return look.accessory === 'glasses' ? { mouse: LENS.mouse.spread, mousse: LENS.mousse.spread } : EYE_SPREAD[eyeShapeOf(look)]
}

/** How much the eyes are scaled to fit the glasses' lenses: 1 without glasses. */
export function eyeFit(look: KnownBotLook): number {
  if (look.accessory !== 'glasses') return 1
  return Math.min(1, LENS[botKindOf(look)].fit / EYE_RADIUS[eyeShapeOf(look)])
}

/**
 * The `eyes` value of a hybrid face's accessory picture: only the parts of its accessory in front of the eyes, on
 * nothing, laid over the flat eyes so they never show over glasses' frames, goggles, a hood or a brim.
 */
export const FRONT_ONLY = 'front'

/**
 * The `eyes` value of a hybrid mouse's nose and whiskers picture: only them, on nothing, so they can turn with the
 * flat eyes. The body picture (`EYELESS`) leaves them out.
 */
export const FEATURES_ONLY = 'features'

export function faceUniforms(look: KnownBotLook, pose: FacePose, view: FaceView): FaceUniforms {
  const front = (look.eyes as string | undefined) === FRONT_ONLY
  const features = (look.eyes as string | undefined) === FEATURES_ONLY
  const eyeless = (look.eyes as string | undefined) === EYELESS || front || features
  const head = view.view === 'head'
  const lean = head ? rollPast(pose.hroll) : 0
  const accessory = BOT_ACCESSORY_HEX[look.accessory]
  const kind = botKindOf(look)
  const es = pose.es * EYE_SCALE * eyeFit(look)
  let [lookX, lookY] = [pose.lookX, pose.lookY]
  if (look.accessory === 'glasses') {
    // In the lens: the eyes look about only as far as the lens leaves room.
    const lens = LENS[kind]
    const reach = Math.hypot(lookX * lens.look[0], lookY * lens.look[1])
    const room = Math.max(0, lens.room - EYE_RADIUS[eyeShapeOf(look)] * es)
    if (reach > room) [lookX, lookY] = [(lookX * room) / reach, (lookY * room) / reach]
  }
  return {
    uCol: hexToRgb(BOT_COLOUR_HEX[look.colour]),
    uAC: [...hexToRgb(accessory ?? '#000000'), METAL.has(look.accessory) ? 1 : 0],
    uAcc: BOT_ACCESSORIES.indexOf(look.accessory),
    uB: [pose.hop, pose.sq, pose.roll, pose.tail],
    uH: [pose.yaw, pose.pitch, pose.hroll, pose.earL],
    uH2: [pose.earR, pose.armL, pose.armR, pose.laptop],
    uE: [pose.open, pose.closed, pose.arc, pose.worried],
    uE2: [lookX, features ? 60 : eyeless ? 40 : lookY, es, pose.sweat],
    uV: [head ? 0.8 : 0.32, head ? HEAD_FOV * (1 + HEAD_ROLL_ROOM * Math.abs(lean)) : 2.1, view.samples, front ? 2 : view.size < WHISKER_MIN_SIZE ? 1 : 0],
    uK: [
      BOT_KINDS.indexOf(botKindOf(look)),
      eyeless ? 0 : BOT_EYES.indexOf(botEyesOf(look)),
      botEyeColourOf(look) === 'white' ? 1 : 0,
      eyeSpread(look)[kind]
    ],
    pan: [HEAD_ROLL_PAN * lean, 0]
  }
}
