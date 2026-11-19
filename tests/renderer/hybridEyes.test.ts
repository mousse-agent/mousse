import { describe, expect, it } from 'vitest'
import { BOT_EYES } from '../../src/shared/bots/personal/look'
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
