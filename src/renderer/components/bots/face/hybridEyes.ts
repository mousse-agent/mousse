import { BOT_COLOUR_HEX, BOT_EYES, botEyesOf, botKindOf, type BotEyes, type KnownBotLook } from '../../../../shared/bots/personal/look'
import type { BotFaceState } from './BotFace'
import { faceUniforms, mousseEyesWhite, stillPose, type FacePose } from './facePoses'

/**
 * Where the flat eyes of a hybrid face go (`HybridFace.tsx`): the shader's own eye positions, put
 * through its head, body and camera transforms for the still pose of a state, so the 2D eyes sit
 * where the 3D ones were drawn. Keep in step with `map`, `toP`, `toQ`, `eyesM` and `shade` in
 * `miceShader.ts`.
 */

/** Half the side of the square every eye is drawn in, in eye units (the shader's `eye2` space). */
export const EYE_BOX = 0.32

export interface EyePlace {
  /** The eye's middle, in CSS pixels from the face's top-left corner. */
  x: number
  y: number
  /** How the head's roll turns it, in radians (clockwise on screen). */
  angle: number
  /** CSS pixels per eye unit, across and down. */
  sx: number
  sy: number
}

export interface EyeGeometry {
  eyes: [EyePlace, EyePlace]
  /** The pose's eye values: scale, how open, closed (0 or 1), the closed arc's way up, worried. */
  es: number
  open: number
  closed: number
  arc: number
  worried: number
  /** Eye units the eyes move per unit of look, across and up. */
  lookX: number
  lookY: number
  /** CSS pixels per world unit at the body, for hops. */
  unit: number
}

type V3 = [number, number, number]

const HR: V3 = [1.05, 0.92, 0.88]
const HEAD_Y = 0.55
const MS = 0.7

/** The shader's `R(a) * (x, y)`. */
function rot(a: number, x: number, y: number): [number, number] {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [c * x - s * y, s * x + c * y]
}

function headDepth(x: number, y: number): number {
  return HR[2] * Math.sqrt(Math.max(0, 1 - (x * x) / (HR[0] * HR[0]) - ((y - HEAD_Y) * (y - HEAD_Y)) / (HR[1] * HR[1])))
}

/** A point of the posed body frame, in the world: the shader's hop, squash and roll, undone. */
function bodyToWorld(b: V3, pose: FacePose): V3 {
  const [x, y] = rot(pose.roll, b[0], b[1] + 1.47)
  const root = Math.sqrt(pose.sq)
  return [x / root, y * pose.sq - 1.47 + pose.hop, b[2] / root]
}

/** A point of the mouse's head frame, in the world. */
function mouseHeadToWorld(q: V3, pose: FacePose): V3 {
  let [x, y, z] = [q[0], q[1] + 0.05, q[2]]
  ;[x, y] = rot(pose.hroll, x, y)
  ;[y, z] = rot(pose.pitch, y, z)
  ;[x, z] = rot(-pose.yaw, x, z)
  return bodyToWorld([x, y - 0.05, z], pose)
}

/** A point of the Mousse's head frame (logo units), in the world. */
function mousseHeadToWorld(q: V3, pose: FacePose): V3 {
  let [x, y, z] = [q[0], q[1] - 2.6, q[2]]
  ;[y, z] = rot(pose.pitch * 0.5, y, z)
  ;[x, z] = rot(-pose.yaw, x, z)
  return bodyToWorld([x * MS, (y + 2.6) * MS - 1.48, z * MS], pose)
}

export function eyeGeometry(look: KnownBotLook, state: BotFaceState, view: 'head' | 'full', size: number): EyeGeometry {
  const pose: FacePose = { ...stillPose(state), lookX: 0, lookY: 0 }
  const uniforms = faceUniforms(look, pose, { view, size, samples: 1 })
  const mousse = botKindOf(look) === 'mousse'
  const close = uniforms.uV[0] > 0.5
  const target = mousse && close ? 0.6 : uniforms.uV[0]
  const th = (uniforms.uV[1] / 9) * (mousse && close ? 1.16 : 1)
  const length = Math.hypot(0.9, 9)
  const fw: V3 = [0, -0.9 / length, -9 / length]
  const up: V3 = [0, -fw[2], fw[1]]
  const project = (p: V3): [number, number] => {
    const v: V3 = [p[0], p[1] - (target + 0.9), p[2] - 9]
    const depth = v[1] * fw[1] + v[2] * fw[2]
    const ux = v[0] / (depth * th)
    const uy = (v[1] * up[1] + v[2] * up[2]) / (depth * th)
    return [(ux * 0.5 + 0.5 + uniforms.pan[0]) * size, (0.5 - uy * 0.5 - uniforms.pan[1]) * size]
  }
  const toWorld = mousse ? mousseHeadToWorld : mouseHeadToWorld
  const place = (side: -1 | 1): EyePlace => {
    let centre: V3
    let across: V3
    let upward: V3
    if (mousse) {
      const a = side * 0.255
      centre = [Math.sin(a) * 1.465, 2.2, Math.cos(a) * 1.465]
      across = [Math.cos(a) * 1.35, 0, -Math.sin(a) * 1.35]
      upward = [0, 1.35, 0]
    } else {
      const x = side * 0.37
      centre = [x, HEAD_Y, headDepth(x, HEAD_Y) + 0.03]
      across = [1, 0, 0]
      upward = [0, 1, 0]
    }
    const step = 0.1
    const at = (axis: V3): [number, number] =>
      project(toWorld([centre[0] + axis[0] * step, centre[1] + axis[1] * step, centre[2] + axis[2] * step], pose))
    const [x, y] = project(toWorld(centre, pose))
    const [ax, ay] = at(across)
    const [bx, by] = at(upward)
    return { x, y, angle: Math.atan2(ay - y, ax - x), sx: Math.hypot(ax - x, ay - y) / step, sy: Math.hypot(bx - x, by - y) / step }
  }
  const [x0] = project(bodyToWorld([0, -0.66, 0], pose))
  const [x1] = project(bodyToWorld([1, -0.66, 0], pose))
  return {
    eyes: [place(-1), place(1)],
    es: pose.es,
    open: pose.open,
    closed: pose.closed,
    arc: pose.arc,
    worried: pose.worried,
    // The mouse's eyes move 0.09 a unit of look and its head turns with them; the head stays put here, so the eyes go further.
    lookX: mousse ? (1.465 * 0.22) / 1.35 : 0.145,
    lookY: mousse ? 1.2 / 1.35 : 1,
    unit: Math.abs(x1 - x0)
  }
}

/** How far eyes that follow the pointer go, in units of look (the idle glance reaches 0.5 across and 0.04 up). */
export const FOLLOW_X = 0.6
export const FOLLOW_Y = 0.07
/** The pointer's distance, in face sizes, at which the eyes are fully turned. */
export const FOLLOW_REACH = 3

/**
 * Where eyes that follow the pointer look, in units of look (x right, y up), for a face in `box` and a pointer
 * at (x, y), all in window pixels. A near pointer turns the eyes a little; a far one no further than the limit.
 */
export function pointerLook(box: { left: number; top: number; width: number; height: number }, x: number, y: number): { x: number; y: number } {
  if (!(box.width > 0)) return { x: 0, y: 0 }
  const reach = box.width * FOLLOW_REACH
  const dx = (x - (box.left + box.width / 2)) / reach
  const dy = (y - (box.top + box.height / 2)) / reach
  const far = Math.hypot(dx, dy)
  const pull = far > 0 ? Math.min(1, far) / far : 0
  // `+ 0` keeps a pointer straight above or beside the face from giving -0.
  return { x: dx * pull * FOLLOW_X + 0, y: -dy * pull * FOLLOW_Y + 0 }
}

/** Half the height of each open eye shape (the shader's `eyeHH`), for the worried lid. */
const EYE_HALF_HEIGHT: Record<BotEyes, number> = { pill: 0.225, round: 0.2, dot: 0.105, tall: 0.3, square: 0.175, heart: 0.3, star: 0.3, code: 0.2 }

/**
 * The worried lid as a CSS polygon over the eye's square: it cuts the eye's top on a slope that is
 * lower on the outside. With no worry it is the whole square and more, so nothing is cut.
 */
export function lidClip(eyes: BotEyes, side: -1 | 1, open: number, worried: number): string {
  const topAt = (x: number): number => {
    const top = worried < 0.01 ? EYE_BOX * 2 : Math.max(EYE_HALF_HEIGHT[eyes] * open, 0.012) * (1 - 0.3 * worried) - worried * 0.6 * x * side
    return ((EYE_BOX - top) / (2 * EYE_BOX)) * 100
  }
  return `polygon(-50% ${topAt(-2 * EYE_BOX).toFixed(1)}%, 150% ${topAt(2 * EYE_BOX).toFixed(1)}%, 150% 150%, -50% 150%)`
}

export function eyeColour(look: KnownBotLook): string {
  if (botKindOf(look) !== 'mousse') return '#0c0c0e'
  return mousseEyesWhite(BOT_COLOUR_HEX[look.colour]) ? '#ffffff' : '#050505'
}

export function eyeShapeOf(look: KnownBotLook): BotEyes {
  const eyes = botEyesOf(look)
  return BOT_EYES.includes(eyes) ? eyes : 'pill'
}
