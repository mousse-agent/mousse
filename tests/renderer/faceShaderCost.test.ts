import { describe, expect, it } from 'vitest'
import { MICE_FRAGMENT_SHADER } from '../../src/renderer/components/bots/face/miceShader'
import { shaderCost } from '../../scripts/face-shader-cost.mjs'

// On Windows the face shader compiles through FXC, which inlines every call; until it finishes every face
// shows the flat fallback. Compile time grows faster than linearly with the inlined size, so these count
// it (each call site in full, each loop body once). A Mac compile cannot show this.
describe('bot face shader compile cost', () => {
  const cost = shaderCost(MICE_FRAGMENT_SHADER)

  it('inlines each heavy function only a few times', () => {
    // Was 7 copies of map and 35 of accD before the call sites were folded into loops.
    expect(cost.copies.map).toBeLessThanOrEqual(3)
    expect(cost.copies.accD).toBeLessThanOrEqual(3)
    expect(cost.copies.headM).toBeLessThanOrEqual(3)
  })

  it('stays far below the old inlined size', () => {
    // Was 11,019 statements; now about 2,330.
    expect(cost.total.statements).toBeLessThan(2600)
  })

  it('counts a loop body once and every call site in full', () => {
    const src = 'float f(float x){return x*x;}\nfloat g(float x){return f(x)+f(x+1.);}\nvoid main(){float s=0.;for(int i=0;i<9;i++){s+=g(float(i));}gl_FragColor=vec4(s);}'
    const c = shaderCost(src)
    expect(c.copies).toEqual({ main: 1, g: 1, f: 2 })
    // main: the declaration, the loop, its one statement and the output (4), plus g with f twice (1 + 2).
    expect(c.total.statements).toBe(4 + 3)
  })
})
