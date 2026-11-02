import { describe, expect, it } from 'vitest'
import { LiveChunker } from '../src/renderer/dictation/liveChunker'

const RATE = 16_000
const OPTIONS = { sampleRate: RATE, minSeconds: 3, pauseSeconds: 0.3, maxSeconds: 12 }

/** Speech-like sound: a loud tone. */
const speech = (seconds: number): Float32Array => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => 0.3 * Math.sin(i * 0.2))
const silence = (seconds: number): Float32Array => new Float32Array(Math.round(seconds * RATE))
const join = (...parts: Float32Array[]): Float32Array => {
  const out = new Float32Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Feeds `audio` in 64 ms blocks, as the capture worklet sends it. */
function feed(chunker: LiveChunker, audio: Float32Array): Float32Array[] {
  const pieces: Float32Array[] = []
  for (let offset = 0; offset < audio.length; offset += 1024) pieces.push(...chunker.push(audio.subarray(offset, offset + 1024)))
  return pieces
}

const seconds = (piece: Float32Array): number => piece.length / RATE

describe('cutting live dictation audio at pauses', () => {
  it('ends a piece in the middle of the first pause after three seconds', () => {
    const chunker = new LiveChunker(OPTIONS)
    const pieces = feed(chunker, join(speech(4), silence(0.5), speech(2)))
    expect(pieces).toHaveLength(1)
    // The pause runs from 4.0 s; it counts once 0.3 s long, and the cut goes in its middle.
    expect(seconds(pieces[0])).toBeCloseTo(4.16, 1)
    expect(seconds(chunker.finish()) + seconds(pieces[0])).toBeCloseTo(6.5, 2)
  })

  it('keeps a pause before three seconds inside the piece', () => {
    const chunker = new LiveChunker(OPTIONS)
    const pieces = feed(chunker, join(speech(1), silence(0.5), speech(1)))
    expect(pieces).toEqual([])
    expect(seconds(chunker.finish())).toBeCloseTo(2.5, 2)
  })

  it('does not count a short gap between words as a pause', () => {
    const chunker = new LiveChunker(OPTIONS)
    expect(feed(chunker, join(speech(4), silence(0.15), speech(4)))).toEqual([])
  })

  it('cuts twelve seconds of speech without a pause at its quietest moment', () => {
    const chunker = new LiveChunker(OPTIONS)
    const quiet = join(speech(10), silence(0.1), speech(4))
    const pieces = feed(chunker, quiet)
    expect(pieces).toHaveLength(1)
    expect(seconds(pieces[0])).toBeGreaterThan(10)
    expect(seconds(pieces[0])).toBeLessThan(10.1)
  })

  it('never makes a piece longer than twelve seconds', () => {
    const chunker = new LiveChunker(OPTIONS)
    const pieces = feed(chunker, speech(40))
    for (const piece of pieces) expect(seconds(piece)).toBeLessThanOrEqual(12)
    const total = pieces.reduce((sum, piece) => sum + piece.length, 0) + chunker.finish().length
    expect(total).toBe(40 * RATE)
  })

  it('waits for speech before cutting at silence', () => {
    const chunker = new LiveChunker(OPTIONS)
    expect(feed(chunker, silence(5))).toEqual([])
    expect(seconds(chunker.finish())).toBeCloseTo(5, 2)
  })

  it('treats quiet noise between louder words as a pause', () => {
    const chunker = new LiveChunker(OPTIONS)
    const hum = Float32Array.from({ length: RATE }, (_, i) => 0.01 * Math.sin(i * 0.05))
    expect(feed(chunker, join(speech(4), hum, speech(1)))).toHaveLength(1)
  })
})
