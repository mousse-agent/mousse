import { describe, expect, it } from 'vitest'
import { downmixToMono, findQuietCut, splitIntoSegments } from '../src/renderer/dictation/audio'

const RATE = 16000

/** A tone with a short silent gap of `gapSeconds` starting at `gapAt` seconds. */
function tone(seconds: number, gaps: ReadonlyArray<readonly [at: number, length: number]> = []): Float32Array {
  const samples = new Float32Array(Math.round(seconds * RATE))
  for (let index = 0; index < samples.length; index += 1) samples[index] = 0.5 * Math.sin((index / RATE) * 2 * Math.PI * 220)
  for (const [at, length] of gaps) samples.fill(0, Math.round(at * RATE), Math.round((at + length) * RATE))
  return samples
}

describe('downmixToMono', () => {
  it('averages the channels', () => {
    const mono = downmixToMono([Float32Array.of(1, 0.5, -1), Float32Array.of(0, 0.5, 1)])
    expect(Array.from(mono)).toEqual([0.5, 0.5, 0])
  })

  it('returns a single channel unchanged and handles no channels', () => {
    const channel = Float32Array.of(0.1, 0.2)
    expect(downmixToMono([channel])).toBe(channel)
    expect(downmixToMono([]).length).toBe(0)
  })

  it('uses the shortest channel length', () => {
    expect(downmixToMono([new Float32Array(4), new Float32Array(3)]).length).toBe(3)
  })
})

describe('findQuietCut', () => {
  it('lands inside the quietest window', () => {
    const samples = tone(10, [[7.2, 0.3]])
    const cut = findQuietCut(samples, 7 * RATE, 10 * RATE, 0.1 * RATE)
    expect(cut).toBeGreaterThanOrEqual(7.2 * RATE)
    expect(cut).toBeLessThanOrEqual(7.5 * RATE)
  })
})

describe('splitIntoSegments', () => {
  it('returns one segment when the audio fits', () => {
    const samples = tone(20)
    const segments = splitIntoSegments(samples, RATE, 30)
    expect(segments).toHaveLength(1)
    expect(segments[0].length).toBe(samples.length)
  })

  it('returns nothing for empty audio', () => {
    expect(splitIntoSegments(new Float32Array(0), RATE, 30)).toEqual([])
  })

  it('keeps every segment within the limit and loses no samples', () => {
    const samples = tone(95.3)
    const segments = splitIntoSegments(samples, RATE, 30)
    expect(segments.length).toBeGreaterThanOrEqual(4)
    for (const segment of segments) expect(segment.length).toBeLessThanOrEqual(30 * RATE)
    expect(segments.reduce((total, segment) => total + segment.length, 0)).toBe(samples.length)
    const joined = new Float32Array(samples.length)
    let offset = 0
    for (const segment of segments) {
      joined.set(segment, offset)
      offset += segment.length
    }
    expect(joined).toEqual(samples)
  })

  it('cuts in the quiet gap near the end of a segment', () => {
    const samples = tone(45, [[28.0, 0.4]])
    const [first, second] = splitIntoSegments(samples, RATE, 30)
    expect(first.length).toBeGreaterThanOrEqual(28.0 * RATE)
    expect(first.length).toBeLessThanOrEqual(28.4 * RATE)
    expect(first.length + second.length).toBe(samples.length)
  })

  it('cuts at the limit when the limit is shorter than the search span', () => {
    const segments = splitIntoSegments(tone(5), RATE, 2)
    for (const segment of segments) expect(segment.length).toBeLessThanOrEqual(2 * RATE)
    expect(segments.reduce((total, segment) => total + segment.length, 0)).toBe(5 * RATE)
  })
})
