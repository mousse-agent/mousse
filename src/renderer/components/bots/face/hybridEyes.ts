import { botEyeColourOf, botKindOf, type BotEyes, type KnownBotLook } from '../../../../shared/bots/personal/look'
import type { BotFaceState } from './BotFace'
import { EYE_HALF_HEIGHT, EYE_RADIUS, EYE_SCALE, eyeFit, eyeShapeOf, eyeSpread, faceUniforms, LENS, stillPose, type FacePose } from './facePoses'

export { eyeShapeOf, eyeSpread } from './facePoses'

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
  /** The pose's eye values: scale (with the lens fit), how open, closed (0 or 1), the closed arc's way up, worried. */
  es: number
  open: number
  closed: number
  arc: number
  worried: number
  /** CSS pixels per world unit at the body, for hops. */
  unit: number
  /**
   * The transform that moves eye `index` from its place to where it is when the face looks (x, y) (units of look,
   * x right, y up): round the face's curve as the 3D eyes go, narrowing towards the edges, and never past the face's
   * outline or, with glasses on, the lens.
   */
  move(index: number, x: number, y: number): string
  /** CSS pixels from the face's left edge to its nose: the mouse's nose and whiskers picture is moved in two halves split here. */
  seam: number
  /**
   * The transforms (from the face's top-left corner) of the left and right halves of the mouse's nose and whiskers
   * picture when the face looks (x, y): turned round the head by the eyes' own turn, no further than keeps them well
   * inside the face. Each half takes its whiskers' tip where turning puts it, so the near side's whiskers squeeze
   * towards the edge as the far side's spread, and both keep the nose. `none` on the Mousse, and with glasses on,
   * whose frames stay put.
   */
  features(x: number, y: number): [string, string]
}

type V3 = [number, number, number]

const HR: V3 = [1.05, 0.92, 0.88]
const HEAD_Y = 0.55
const MS = 0.7
/** The Mousse's eyes lie on a cylinder this far round its glass's axis (the shader's `eyesM`), at height 2.2. */
const GLASS_R = 1.465
const EYE_Y = 2.2
/** Eye units per logo unit on the Mousse (the mouse's eye units are head units). */
const MOUSSE_EYE = 1.35

/** The shader's `R(a) * (x, y)`. */
function rot(a: number, x: number, y: number): [number, number] {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [c * x - s * y, s * x + c * y]
}

function headDepth(x: number, y: number): number {
  return HR[2] * Math.sqrt(Math.max(0, 1 - (x * x) / (HR[0] * HR[0]) - ((y - HEAD_Y) * (y - HEAD_Y)) / (HR[1] * HR[1])))
}

/** The glass bowl's radius at height y (the shader's `gR`). */
function bowl(y: number): number {
  if (y < 2.85) return 1.52 * Math.pow(Math.max(0, 1 - Math.pow(Math.max(0, (2.85 - y) / 1.49), 2.6)), 0.385)
  const v = Math.sin(Math.min(1, Math.max(0, (y - 2.85) / 1.26)) * 1.5708)
  return 1.52 - 0.16 * v * v
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

/**
 * How far the live face's head turns per unit of look in each state (`targets` in facePoses.ts). The Mousse's glass
 * looks the same turned, so its eyes go round by the eye's own turn and the head's; the mouse's head picture stays
 * put, nose and ears with it, so its eyes take half the head's turn.
 */
const HEAD_TURN: Partial<Record<BotFaceState, number>> = { idle: 0.5, working: 0.08, stuck: 0.2 }

const inGlasses = (look: KnownBotLook): boolean => look.accessory === 'glasses'

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

/**
 * How far the mouse's nose and whiskers turn round its head at most (radians, across and up or down): the whiskers'
 * tips start 1.07 round, so they stay on the face's front.
 */
const FEATURES_TURN = 0.33
const FEATURES_TILT = 0.22

/** The mouse's nose, in its head frame (the shader's `map`). */
const NOSE: V3 = [0, 0.39, 0.855]

/** A head point (mouse head frame) turned round the head's ellipsoid by `yaw` across and `tilt` up. */
function roundHead(p: V3, yaw: number, tilt: number): V3 {
  const s: V3 = [p[0] / HR[0], (p[1] - HEAD_Y) / HR[1], p[2] / HR[2]]
  const r = Math.hypot(s[0], s[1], s[2])
  const across = Math.atan2(s[0], s[2]) + yaw
  const up = Math.asin(clamp(s[1] / r, -1, 1)) + tilt
  return [HR[0] * r * Math.sin(across) * Math.cos(up), HEAD_Y + HR[1] * r * Math.sin(up), HR[2] * r * Math.cos(across) * Math.cos(up)]
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
  const es = pose.es * EYE_SCALE * eyeFit(look)
  const shape = eyeShapeOf(look)
  const spread = eyeSpread(look)
  const glasses = inGlasses(look)
  const unit = mousse ? MOUSSE_EYE : 1
  /** The eye's radius and half height, in head (mouse) or logo (Mousse) units. */
  const radius = (EYE_RADIUS[shape] * es) / unit
  const halfHeight = (EYE_HALF_HEIGHT[shape] * es) / unit
  const turn = (mousse ? 0.22 : 0.0916) + (HEAD_TURN[state] ?? 0) * (mousse ? 1 : 0.5)

  /** The eye's middle and its across and up axes (one eye unit long), in the head frame, looking (lx, ly). */
  const frame = (side: -1 | 1, lx: number, ly: number): [V3, V3, V3] => {
    if (glasses) {
      // In the lens: the shader's flat look, as far as the lens leaves room.
      const lens = LENS[mousse ? 'mousse' : 'mouse']
      let [ox, oy] = mousse ? [lx * 0.2387, ly * 0.8889] : [lx * 0.09, ly]
      const reach = Math.hypot(ox, oy)
      const room = Math.max(0, lens.room - EYE_RADIUS[shape] * es)
      if (reach > room) [ox, oy] = [(ox * room) / reach, (oy * room) / reach]
      if (mousse) {
        const a = side * spread.mousse + ox * (MOUSSE_EYE / GLASS_R)
        return [[Math.sin(a) * GLASS_R, EYE_Y + oy * MOUSSE_EYE, Math.cos(a) * GLASS_R], [Math.cos(a) * MOUSSE_EYE, 0, -Math.sin(a) * MOUSSE_EYE], [0, MOUSSE_EYE, 0]]
      }
      const x = side * spread.mouse + ox
      return [[x, HEAD_Y + oy, headDepth(x, HEAD_Y + oy) + 0.03], [1, 0, 0], [0, 1, 0]]
    }
    if (mousse) {
      // Round the glass (the eye's turn and the head's), no further than keeps the eye on the bowl's front.
      const y = clamp(EYE_Y + ly * 1.2, Math.min(EYE_Y, 1.85 + halfHeight), Math.max(EYE_Y, 3.4 - halfHeight))
      const half = Math.asin(Math.min(1, radius / GLASS_R))
      const edge = Math.min(1.2 - half, Math.asin(clamp((0.94 * bowl(y - halfHeight) - radius) / GLASS_R, 0, 1)))
      const limit = Math.max(0, edge - spread.mousse)
      const a = side * spread.mousse + clamp(lx * turn, -limit, limit)
      return [[Math.sin(a) * GLASS_R, y, Math.cos(a) * GLASS_R], [Math.cos(a) * MOUSSE_EYE, 0, -Math.sin(a) * MOUSSE_EYE], [0, MOUSSE_EYE, 0]]
    }
    // Round the head: the eye's place on the head's ellipsoid as a point of the unit sphere, turned across by the
    // look and tilted up or down, then put back on the ellipsoid. Its axes turn with it, so it narrows towards the edges.
    const u = spread.mouse / HR[0]
    const rest = Math.atan2(u, Math.sqrt(1 - u * u))
    const limit = Math.max(0, 1.2 - radius / HR[0] - rest)
    const yaw = clamp(lx * turn, -limit, limit)
    const t = side * rest + yaw
    const tilt = clamp(ly / HR[1], -0.6 + halfHeight / HR[1], 0.75 - halfHeight / HR[1])
    const centre: V3 = [HR[0] * Math.sin(t) * Math.cos(tilt), HEAD_Y + HR[1] * Math.sin(tilt), HR[2] * Math.cos(t) * Math.cos(tilt) + 0.03]
    return [centre, [Math.cos(yaw), 0, -Math.sin(yaw)], [-Math.sin(tilt) * Math.sin(yaw), Math.cos(tilt), -Math.sin(tilt) * Math.cos(yaw)]]
  }

  const place = (side: -1 | 1, lx = 0, ly = 0): EyePlace => {
    const [centre, across, upward] = frame(side, lx, ly)
    const step = 0.1
    const at = (axis: V3): [number, number] =>
      project(toWorld([centre[0] + axis[0] * step, centre[1] + axis[1] * step, centre[2] + axis[2] * step], pose))
    const [x, y] = project(toWorld(centre, pose))
    const [ax, ay] = at(across)
    const [bx, by] = at(upward)
    return { x, y, angle: Math.atan2(ay - y, ax - x), sx: Math.hypot(ax - x, ay - y) / step, sy: Math.hypot(bx - x, by - y) / step }
  }
  const eyes: [EyePlace, EyePlace] = [place(-1), place(1)]
  const [x0] = project(bodyToWorld([0, -0.66, 0], pose))
  const [x1] = project(bodyToWorld([1, -0.66, 0], pose))
  return {
    eyes,
    es,
    open: pose.open,
    closed: pose.closed,
    arc: pose.arc,
    worried: pose.worried,
    unit: Math.abs(x1 - x0),
    seam: project(toWorld(NOSE, pose))[0],
    features(lx, ly) {
      if (mousse || glasses || (lx === 0 && ly === 0)) return ['none', 'none']
      const yaw = clamp(lx * turn, -FEATURES_TURN, FEATURES_TURN)
      const tilt = clamp(ly / HR[1], -FEATURES_TILT, FEATURES_TILT)
      const head = (x: number, y: number): V3 => [x, y, headDepth(x, y)]
      // The nose, a point above it, and each side's middle whisker tip.
      const points: V3[] = [NOSE, head(0, 0.5), head(-0.9, 0.35), head(0.9, 0.35)]
      const from = points.map((p) => project(toWorld(p, pose)))
      const to = points.map((p) => project(toWorld(roundHead(p, yaw, tilt), pose)))
      const half = (tip: number): string => {
        // The flat transform taking the nose, the point above it and the tip where turning takes them.
        const [[x1, y1], [x2, y2], [x3, y3]] = [from[0]!, from[1]!, from[tip]!]
        const det = x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2)
        if (Math.abs(det) < 1e-6) return 'none'
        /** The row (p, q, r) with p x + q y + r = each point's `value`. */
        const solve = (axis: 0 | 1): [number, number, number] => {
          const [v1, v2, v3] = [to[0]![axis], to[1]![axis], to[tip]![axis]]
          return [
            (v1 * (y2 - y3) + v2 * (y3 - y1) + v3 * (y1 - y2)) / det,
            (x1 * (v2 - v3) + x2 * (v3 - v1) + x3 * (v1 - v2)) / det,
            (x1 * (y2 * v3 - y3 * v2) + x2 * (y3 * v1 - y1 * v3) + x3 * (y1 * v2 - y2 * v1)) / det
          ]
        }
        const [a, c, e] = solve(0)
        const [b, d, f] = solve(1)
        const n = (value: number): string => value.toFixed(4)
        return `matrix(${n(a)}, ${n(b)}, ${n(c)}, ${n(d)}, ${e.toFixed(2)}, ${f.toFixed(2)})`
      }
      return [half(2), half(3)]
    },
    move(index, lx, ly) {
      const from = eyes[index]!
      if (lx === 0 && ly === 0) return 'none'
      const to = place(index === 0 ? -1 : 1, lx, ly)
      // The eye is already at its place, turned and scaled by `es`: this is the step from there, in its own frame.
      const [dx, dy] = rot(-from.angle, to.x - from.x, to.y - from.y)
      const n = (value: number, digits = 2): string => value.toFixed(digits)
      return `translate(${n(dx / es)}px, ${n(dy / es)}px) rotate(${n(to.angle - from.angle, 4)}rad) scale(${n(to.sx / from.sx, 3)}, ${n(to.sy / from.sy, 3)})`
    }
  }
}

/**
 * How far eyes that follow the pointer go, in units of look: cartoon-far across, and well up or down, still on
 * the face (the idle glance reaches 0.7 across and 0.12 up or down).
 */
export const FOLLOW_X = 1.3
export const FOLLOW_UP = 0.34
export const FOLLOW_DOWN = 0.22
/** The pointer's distance, in face sizes, at which the eyes are fully turned. */
export const FOLLOW_REACH = 1.8

/**
 * Where eyes that follow the pointer look, in units of look (x right, y up), for a face in `box` and a pointer
 * at (x, y), all in window pixels. The turn eases out with distance, so even a near pointer gets a clear look,
 * and a far one goes no further than the limits.
 */
export function pointerLook(box: { left: number; top: number; width: number; height: number }, x: number, y: number): { x: number; y: number } {
  if (!(box.width > 0)) return { x: 0, y: 0 }
  const reach = box.width * FOLLOW_REACH
  const dx = (x - (box.left + box.width / 2)) / reach
  const dy = (y - (box.top + box.height / 2)) / reach
  const far = Math.hypot(dx, dy)
  const pull = far > 0 ? Math.pow(Math.min(1, far), 0.6) / far : 0
  // `+ 0` keeps a pointer straight above or beside the face from giving -0.
  return { x: dx * pull * FOLLOW_X + 0, y: -dy * pull * (dy < 0 ? FOLLOW_UP : FOLLOW_DOWN) + 0 }
}

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
  const white = botEyeColourOf(look) === 'white'
  // The mouse's eyes are lit clay: near-black that shows as dark grey under the shader's light, or white as light grey.
  if (botKindOf(look) !== 'mousse') return white ? '#e4e4e2' : '#2c2c2e'
  return white ? '#ffffff' : '#050505'
}

/** The shader's `heart2`: negative inside. */
function heart(px: number, py: number): number {
  const x = Math.abs(px)
  const y = py + 0.55
  if (x + y > 1) return Math.hypot(x - 0.25, y - 0.75) - 0.3536
  const m = 0.5 * Math.max(x + y, 0)
  return Math.sqrt(Math.min(x * x + (y - 1) * (y - 1), (x - m) * (x - m) + (y - m) * (y - m))) * Math.sign(x - y)
}

const STAR_POINTS: [number, number][] = Array.from({ length: 10 }, (_, index) => {
  const radius = index % 2 === 0 ? 0.26 : 0.117
  const angle = Math.PI / 2 + (index * Math.PI) / 5
  return [Math.cos(angle) * radius, Math.sin(angle) * radius]
})

function segment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)))
  return Math.hypot(px - ax - (bx - ax) * t, py - ay - (by - ay) * t)
}

/** Whether (x, y), in eye units with y up and the eye fully open at scale 1, is inside the shape: the shader's `eye2`. */
function inShape(shape: BotEyes, side: -1 | 1, x: number, y: number): boolean {
  switch (shape) {
    case 'pill': return (x / 0.155) ** 2 + (y / 0.225) ** 2 < 1
    case 'round': return x * x + y * y < 0.04
    case 'dot': return x * x + y * y < 0.105 * 0.105
    case 'tall': return (x / 0.115) ** 2 + (y / 0.3) ** 2 < 1
    case 'square': return Math.hypot(Math.max(Math.abs(x) - 0.115, 0), Math.max(Math.abs(y) - 0.115, 0)) < 0.06
    case 'heart': return heart(x / 0.33, y / 0.33) < 0
    case 'star': {
      let inside = false
      let near = Infinity
      for (let i = 0, j = STAR_POINTS.length - 1; i < STAR_POINTS.length; j = i++) {
        const [ax, ay] = STAR_POINTS[i]!
        const [bx, by] = STAR_POINTS[j]!
        if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside
        near = Math.min(near, segment(x, y, ax, ay, bx, by))
      }
      return inside || near < 0.025
    }
    case 'code': return segment(x, Math.abs(y), side * 0.11, 0, -side * 0.09, 0.15) < 0.048
  }
}

const OUTLINE_ROWS = 80
const OUTLINE_COLUMNS = 160
const outlines = new Map<string, string>()

/**
 * A mouse's open eye as the 3D face shows it, as one SVG path over the eye's square (y down, before its scale
 * `es`). The shader's eye is set a little into the head, so the head's curve covers its inner side: a round eye
 * shows as a crescent, narrower and further out than its shape. The path is that visible part itself, in thin
 * rows, so nothing of the eye is drawn where the head would hide it. The Mousse's eyes are painted whole, so it
 * has none.
 */
export function mouseEyePath(look: KnownBotLook, side: -1 | 1, es: number): string | undefined {
  if (botKindOf(look) === 'mousse' || !(es > 0)) return undefined
  const shape = eyeShapeOf(look)
  const x0 = side * eyeSpread(look).mouse
  const key = `${shape}|${x0}|${es.toFixed(3)}`
  const known = outlines.get(key)
  if (known !== undefined) return known
  const centre = headDepth(x0, HEAD_Y) - 0.035
  /** Whether the eye's front at (x, y), in head units from the eye's middle, is in front of the head. */
  const seen = (x: number, y: number): boolean => {
    // The pill is an ellipsoid; the rest are their flat shape, 0.06 thick each way.
    const front = shape === 'pill' ? centre + 0.075 * es * Math.sqrt(Math.max(0, 1 - (x / (0.155 * es)) ** 2 - (y / (0.225 * es)) ** 2)) : centre + 0.06 * es
    return front >= headDepth(x0 + x, HEAD_Y + y)
  }
  // Local units: the box is scaled by `es` afterwards, so a local point is `es` times as far in head units.
  const path = rows((x, y) => inShape(shape, side, x, y) && seen(x * es, y * es))
  outlines.set(key, path)
  return path
}

/**
 * A mouse's closed eye (the arc of a happy or sleeping face) as the 3D face shows it: the same kind of path as
 * `mouseEyePath`, cut where the head covers its inner end. `up` is the pose's `arc`: which way the arc bends.
 */
export function mouseArcPath(look: KnownBotLook, side: -1 | 1, es: number, up: number): string | undefined {
  if (botKindOf(look) === 'mousse' || !(es > 0)) return undefined
  const spread = eyeSpread(look).mouse
  const key = `arc|${side}|${es.toFixed(3)}|${up > 0 ? 1 : -1}|${spread}`
  const known = outlines.get(key)
  if (known !== undefined) return known
  const x0 = side * spread
  const front = headDepth(x0, HEAD_Y) - 0.035 + 0.05
  const [sin, cos] = [Math.sin(1.1), Math.cos(1.1)]
  const path = rows((lx, ly) => {
    const x = lx * es
    const y = ly * es
    // The shader's `arc(vec2(x, py + .13), 1.1, .17) - .045 * es`.
    const px = Math.abs(x)
    const py = (up > 0 ? y : -y) + 0.13
    const far = cos * px > sin * py ? Math.hypot(px - sin * 0.17, py - cos * 0.17) : Math.abs(Math.hypot(px, py) - 0.17)
    // A little thicker than the shader's 0.045: the 3D arc is a raised ridge, and its sides show too.
    return far < 0.056 * es && front >= headDepth(x0 + x, HEAD_Y + y)
  })
  outlines.set(key, path)
  return path
}

/** The points of the eye's square (eye units, y up) that `inside` accepts, as an SVG path of thin rows (y down). */
function rows(inside: (x: number, y: number) => boolean): string {
  const row = (2 * EYE_BOX) / OUTLINE_ROWS
  const column = (2 * EYE_BOX) / OUTLINE_COLUMNS
  const n = (value: number): string => value.toFixed(4)
  let path = ''
  for (let r = 0; r < OUTLINE_ROWS; r++) {
    const y = EYE_BOX - (r + 0.5) * row
    let from = -1
    for (let c = 0; c <= OUTLINE_COLUMNS; c++) {
      const is = c < OUTLINE_COLUMNS && inside(-EYE_BOX + (c + 0.5) * column, y)
      if (is && from < 0) from = c
      else if (!is && from >= 0) {
        // Rows overlap a little so no line shows between them.
        path += `M${n(-EYE_BOX + from * column)} ${n(-y - row * 0.6)}h${n((c - from) * column)}v${n(row * 1.2)}h${n(-(c - from) * column)}z`
        from = -1
      }
    }
  }
  return path
}
