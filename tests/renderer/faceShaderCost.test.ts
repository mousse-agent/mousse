import { describe, expect, it } from 'vitest'
import { MICE_FRAGMENT_SHADER } from '../../src/renderer/components/bots/face/miceShader'
import { shaderCost } from '../../scripts/face-shader-cost.mjs'

// On Windows the face shader compiles through FXC, which inlines every call; until it finishes every face
// shows the flat fallback. Compile time grows faster than linearly with the inlined size, so these count
// it (each call site in full, each loop body once). A Mac compile cannot show this.
describe('bot face shader compile cost', () => {
  const cost = shaderCost(MICE_FRAGMENT_SHADER)

  it('inlines each heavy function once', () => {
    // map was 7 copies (11,019 statements), then 3 (2,332); now one loop runs the march, normal and occlusion.
    expect(cost.copies.map).toBe(1)
    expect(cost.copies.accD).toBe(1)
    // The head's knot table, read in one loop.
    expect(cost.copies.hk).toBe(1)
    // One for the scene, one for the colour, eyes and glass.
    expect(cost.copies.toP).toBeLessThanOrEqual(2)
    // The mouse's eyes in the scene and the Mousse's painted eyes.
    expect(cost.copies.eye2).toBeLessThanOrEqual(2)
  })

  it('stays near its inlined size', () => {
    // Now 708 statements.
    expect(cost.total.statements).toBeLessThan(720)
  })

  it('counts a loop body once and every call site in full', () => {
    const src = 'float f(float x){return x*x;}\nfloat g(float x){return f(x)+f(x+1.);}\nvoid main(){float s=0.;for(int i=0;i<9;i++){s+=g(float(i));}gl_FragColor=vec4(s);}'
    const c = shaderCost(src)
    expect(c.copies).toEqual({ main: 1, g: 1, f: 2 })
    // main: the declaration, the loop, its one statement and the output (4), plus g with f twice (1 + 2).
    expect(c.total.statements).toBe(4 + 3)
  })
})
