import { describe, expect, it } from 'vitest'
import { BOT_EYES } from '../../src/shared/bots/personal/look'
import { FEATURES_ONLY, FRONT_ONLY, faceUniforms, stillPose } from '../../src/renderer/components/bots/face/facePoses'
import { eyeGeometry, FOLLOW_DOWN, FOLLOW_UP, FOLLOW_X, mouseArcPath, mouseEyePath, pointerLook } from '../../src/renderer/components/bots/face/hybridEyes'

/** A 96 px face whose middle is at (500, 400). */
const box = { left: 452, top: 352, width: 96, height: 96 }

describe('eyes that follow the pointer', () => {
  it.each([
    ['on the face', 500, 400, 0, 0],
    ['far to the left', -5000, 400, -FOLLOW_X, 0],
    ['far to the right', 5000, 400, FOLLOW_X, 0],
    ['far above', 500, -5000, 0, FOLLOW_UP],
    ['far below', 500, 5000, 0, -FOLLOW_DOWN]
  ])('look %s', (_where, x, y, lookX, lookY) => {
    const look = pointerLook(box, x, y)
    expect(look.x).toBeCloseTo(lookX, 5)
    expect(look.y).toBeCloseTo(lookY, 5)
  })

  it('turn further the further the pointer is, and never past the limit', () => {
    const near = pointerLook(box, 560, 400).x
    const further = pointerLook(box, 700, 400).x
    expect(near).toBeGreaterThan(0)
    expect(further).toBeGreaterThan(near)
    expect(Math.hypot(pointerLook(box, 9000, 9000).x / FOLLOW_X, pointerLook(box, 9000, 9000).y / FOLLOW_DOWN)).toBeLessThanOrEqual(1.0001)
  })

  it('stay in the middle for a face with no size yet', () => {
    expect(pointerLook({ left: 0, top: 0, width: 0, height: 0 }, 300, 300)).toEqual({ x: 0, y: 0 })
  })
})

/** The left and right ends of a path of rows (`M x y h w ...`), in eye units. */
function ends(path: string): { left: number; right: number } {
  const spans = [...path.matchAll(/M(-?[\d.]+) -?[\d.]+h(-?[\d.]+)/g)].map((match) => [Number(match[1]), Number(match[1]) + Number(match[2])])
  return { left: Math.min(...spans.map(([from]) => from!)), right: Math.max(...spans.map(([, to]) => to!)) }
}

describe("a mouse's flat eye, drawn as the part the head leaves showing", () => {
  it.each(BOT_EYES)('%s eyes are drawn for both sides, each the mirror of the other', (eyes) => {
    const look = { colour: 'teal', accessory: 'none', eyes } as const
    const left = ends(mouseEyePath(look, -1, 1)!)
    const right = ends(mouseEyePath(look, 1, 1)!)
    expect(left.right).toBeGreaterThan(left.left)
    expect(right.left).toBeCloseTo(-left.right, 2)
    expect(right.right).toBeCloseTo(-left.left, 2)
  })

  it('a round eye loses its inner side to the head and keeps its outer side', () => {
    const left = ends(mouseEyePath({ colour: 'teal', accessory: 'none', eyes: 'round' }, -1, 1)!)
    // A whole round eye would reach 0.2 each way; the left eye's inner side is its right.
    expect(left.left).toBeCloseTo(-0.2, 1)
    expect(left.right).toBeLessThan(0.17)
  })

  it('a closed arc is cut the same way', () => {
    const left = ends(mouseArcPath({ colour: 'teal', accessory: 'none' }, -1, 1, 1)!)
    expect(left.left).toBeLessThan(-0.15)
    expect(left.right).toBeLessThan(0.13)
  })

  it("the Mousse's eyes are painted whole, so it has no cut shape", () => {
    expect(mouseEyePath({ colour: 'coral', accessory: 'none', kind: 'mousse' }, -1, 1)).toBeUndefined()
    expect(mouseArcPath({ colour: 'coral', accessory: 'none', kind: 'mousse' }, -1, 1, 1)).toBeUndefined()
  })
})

describe('where the flat eyes sit', () => {
  it.each([
    ['mouse', 'full'], ['mouse', 'head'], ['mousse', 'full'], ['mousse', 'head']
  ] as const)('a %s in the %s view has its two eyes side by side, inside the picture and level', (kind, view) => {
    const { eyes } = eyeGeometry({ colour: 'coral', accessory: 'none', kind }, 'idle', view, 96)
    const [left, right] = eyes
    expect(left.x).toBeLessThan(48)
    expect(right.x).toBeGreaterThan(48)
    // The idle head sways a little, so the eyes are level and centred to within a pixel or two, not exactly.
    expect(Math.abs(left.x + right.x - 96)).toBeLessThan(2)
    expect(Math.abs(left.y - right.y)).toBeLessThan(2)
    expect(left.y).toBeGreaterThan(0)
    expect(left.y).toBeLessThan(96)
    expect(left.sx).toBeGreaterThan(0)
    expect(Math.abs(left.angle)).toBeLessThan(0.06)
  })

  /** Each open eye's half width at scale 1, in eye units, as `EyeShape` draws it (the star and the code with their strokes). */
  const HALF_WIDTH = { pill: 0.155, round: 0.2, dot: 0.105, tall: 0.115, square: 0.175, heart: 0.2, star: 0.272, code: 0.16 } as const

  it.each(BOT_EYES.flatMap((eyes) => [['mouse', eyes], ['mousse', eyes]] as const))('a %s with %s eyes keeps a gap between them at their biggest', (kind, eyes) => {
    const look = { colour: 'coral', accessory: 'none', kind, eyes } as const
    // Needs you draws the eyes biggest.
    const { eyes: [left, right], es } = eyeGeometry(look, 'needs_you', 'full', 200)
    // A mouse's eye is the part its head leaves showing; the Mousse's is drawn whole.
    const leftEdge = kind === 'mouse' ? ends(mouseEyePath(look, -1, es)!).right : HALF_WIDTH[eyes]
    const rightEdge = kind === 'mouse' ? -ends(mouseEyePath(look, 1, es)!).left : HALF_WIDTH[eyes]
    const gap = right.x - right.sx * es * rightEdge - (left.x + left.sx * es * leftEdge)
    expect(gap).toBeGreaterThan(1)
  })

  it('a mouse whose head leans, asleep, has its eyes turned with the head', () => {
    const { eyes } = eyeGeometry({ colour: 'coral', accessory: 'none' }, 'paused', 'full', 96)
    expect(Math.abs(eyes[0].angle)).toBeGreaterThan(0.1)
    expect(eyes[0].y).not.toBeCloseTo(eyes[1].y, 1)
  })
})

describe('flat eyes that look about', () => {
  /** The scale a `move` transform gives across and up, and its translation in pixels. */
  const parse = (transform: string) => {
    const [tx, ty] = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(transform)!.slice(1).map(Number)
    const [sx, sy] = /scale\(([-\d.]+), ([-\d.]+)\)/.exec(transform)!.slice(1).map(Number)
    return { tx: tx!, ty: ty!, sx: sx!, sy: sy! }
  }

  it('fit into the glasses lenses: centred on both, smaller than without', () => {
    for (const kind of ['mouse', 'mousse'] as const) {
      const bare = eyeGeometry({ colour: 'coral', accessory: 'none', kind, eyes: 'star' }, 'needs_you', 'full', 200)
      const glasses = eyeGeometry({ colour: 'coral', accessory: 'glasses', kind, eyes: 'star' }, 'needs_you', 'full', 200)
      expect(glasses.es).toBeLessThan(bare.es * 0.6)
      // Both eyes sit the same distance either side of the middle, nearer it than the bare star eyes.
      expect(glasses.eyes[0].x + glasses.eyes[1].x).toBeCloseTo(200, 0)
      expect(glasses.eyes[1].x - glasses.eyes[0].x).toBeLessThan(bare.eyes[1].x - bare.eyes[0].x)
    }
  })

  it('go round the face and narrow towards its edge, and never past its outline or the lens', () => {
    for (const accessory of ['none', 'glasses'] as const) {
      for (const kind of ['mouse', 'mousse'] as const) {
        const g = eyeGeometry({ colour: 'coral', accessory, kind, eyes: 'round' }, 'idle', 'full', 200)
        expect(g.move(1, 0, 0)).toBe('none')
        // A far look goes no further than a farther one: the eyes stop at the edge.
        expect(g.move(1, 4, 2)).toBe(g.move(1, 40, 20))
        expect(g.move(0, -4, -2)).toBe(g.move(0, -40, -20))
      }
    }
    const mousse = eyeGeometry({ colour: 'coral', accessory: 'none', kind: 'mousse', eyes: 'round' }, 'idle', 'full', 200)
    const right = parse(mousse.move(1, 0.7, 0))
    expect(right.tx).toBeGreaterThan(0)
    expect(right.sx).toBeLessThan(0.9)
    expect(right.sy).toBeCloseTo(1, 1)
  })

  it('wearing glasses, the 3D eyes fit the lenses too, and a far look stays inside them', () => {
    const at = (look: Parameters<typeof faceUniforms>[0], pose = stillPose('needs_you')) => faceUniforms(look, pose, { view: 'full', size: 120, samples: 1 })
    const lens = at({ colour: 'coral', accessory: 'glasses', eyes: 'star' })
    expect(lens.uK[3]).toBe(at({ colour: 'coral', accessory: 'glasses' }).uK[3])
    expect(lens.uE2[2]).toBeLessThan(at({ colour: 'coral', accessory: 'none', eyes: 'star' }).uE2[2] * 0.6)
    // A far look stays in the lens: no further than a nearer one that already reaches its edge.
    const far = at({ colour: 'coral', accessory: 'glasses', kind: 'mousse' }, { ...stillPose('idle'), lookX: 9, lookY: 9 })
    const farther = at({ colour: 'coral', accessory: 'glasses', kind: 'mousse' }, { ...stillPose('idle'), lookX: 90, lookY: 90 })
    expect(far.uE2.slice(0, 2)).toEqual(farther.uE2.slice(0, 2))
    expect(Math.abs(far.uE2[0])).toBeLessThan(1)
  })
})

describe('the pictures laid with the flat eyes', () => {
  it('an accessory-only picture has no eyes and no whiskers', () => {
    const u = faceUniforms({ colour: 'coral', accessory: 'goggles', eyes: FRONT_ONLY as never }, stillPose('idle'), { view: 'full', size: 120, samples: 1 })
    expect(u.uV[3]).toBe(2)
    expect(u.uE2[1]).toBe(40)
  })

  it("the mouse's nose and whiskers are drawn on their own, keeping the whiskers' size rule", () => {
    const look = { colour: 'coral', accessory: 'none', eyes: FEATURES_ONLY as never } as const
    expect(faceUniforms(look, stillPose('idle'), { view: 'full', size: 120, samples: 1 }).uE2[1]).toBe(60)
    expect(faceUniforms(look, stillPose('idle'), { view: 'full', size: 120, samples: 1 }).uV[3]).toBe(0)
    expect(faceUniforms(look, stillPose('idle'), { view: 'full', size: 40, samples: 1 }).uV[3]).toBe(1)
  })

  it("the mouse's nose and whiskers turn with the eyes: the near side squeezes, the far side spreads, up to a cap", () => {
    const g = eyeGeometry({ colour: 'coral', accessory: 'none' }, 'idle', 'head', 200)
    expect(g.features(0, 0)).toEqual(['none', 'none'])
    const matrix = (text: string): number[] => text.slice(7, -1).split(',').map(Number)
    const [left, right] = g.features(0.7, 0).map(matrix) as [number[], number[]]
    // Looking right, the right half is the near side.
    expect(right[0]).toBeLessThan(1)
    expect(left[0]).toBeGreaterThan(right[0]!)
    // The nose goes right: both halves move the seam's top edge right.
    expect(left[0]! * g.seam + left[4]!).toBeGreaterThan(g.seam)
    expect(g.features(5, 0)).toEqual(g.features(20, 0))
    expect(eyeGeometry({ colour: 'coral', accessory: 'none', kind: 'mousse' }, 'idle', 'head', 200).features(0.7, 0)).toEqual(['none', 'none'])
    expect(eyeGeometry({ colour: 'coral', accessory: 'glasses' }, 'idle', 'head', 200).features(0.7, 0)).toEqual(['none', 'none'])
  })
})
