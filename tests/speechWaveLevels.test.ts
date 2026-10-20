import { describe, expect, it } from 'vitest'
import { WAVE_BARS, bandEdges, bandLevels } from '../src/renderer/speech/audioLevels'

describe('sound wave levels', () => {
  it('splits the speech range into increasing FFT bin bands', () => {
    const edges = bandEdges(48000, 1024, WAVE_BARS)
    expect(edges).toHaveLength(WAVE_BARS + 1)
    expect(edges[0]).toBe(Math.round(100 / (48000 / 1024)))
    expect(edges.at(-1)).toBe(Math.round(4000 / (48000 / 1024)))
    for (let index = 1; index < edges.length; index += 1) expect(edges[index]).toBeGreaterThan(edges[index - 1])
  })

  it('maps band loudness to 0..1 and treats silence as 0', () => {
    const spectrum = new Float32Array(32).fill(-Infinity)
    spectrum.fill(-25, 8, 16)
    spectrum.fill(-55, 16, 24)
    expect(bandLevels(spectrum, [0, 8, 16, 24, 32])).toEqual([0, 1, 0.5, 0])
  })
})
