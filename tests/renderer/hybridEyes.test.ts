import { describe, expect, it } from 'vitest'
import { eyeGeometry, FOLLOW_X, FOLLOW_Y, pointerLook } from '../../src/renderer/components/bots/face/hybridEyes'

/** A 96 px face whose middle is at (500, 400). */
const box = { left: 452, top: 352, width: 96, height: 96 }

describe('eyes that follow the pointer', () => {
  it.each([
    ['on the face', 500, 400, 0, 0],
    ['far to the left', -5000, 400, -FOLLOW_X, 0],
    ['far to the right', 5000, 400, FOLLOW_X, 0],
    ['far above', 500, -5000, 0, FOLLOW_Y],
    ['far below', 500, 5000, 0, -FOLLOW_Y]
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
    expect(Math.hypot(pointerLook(box, 9000, 9000).x / FOLLOW_X, pointerLook(box, 9000, 9000).y / FOLLOW_Y)).toBeLessThanOrEqual(1.0001)
  })

  it('stay in the middle for a face with no size yet', () => {
    expect(pointerLook({ left: 0, top: 0, width: 0, height: 0 }, 300, 300)).toEqual({ x: 0, y: 0 })
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

  it('a mouse whose head leans, asleep, has its eyes turned with the head', () => {
    const { eyes } = eyeGeometry({ colour: 'coral', accessory: 'none' }, 'paused', 'full', 96)
    expect(Math.abs(eyes[0].angle)).toBeGreaterThan(0.1)
    expect(eyes[0].y).not.toBeCloseTo(eyes[1].y, 1)
  })
})
