import { describe, expect, it } from 'vitest'
import {
  LEAD_SECONDS,
  TRAIL_SECONDS,
  startDelaySeconds,
  trimSilence,
  type SegmentTiming
} from '../src/renderer/readAloud/localPlayback'
import { PauseGate } from '../src/renderer/readAloud/playback'
import { FIRST_SEGMENT_CHARS, MAX_SEGMENT_CHARS, splitSpeechSegments } from '../src/renderer/readAloud/speechText'

const RATE = 1000

function clip(silentBefore: number, loud: number, silentAfter: number): Float32Array {
  const samples = new Float32Array(silentBefore + loud + silentAfter)
  samples.fill(0.0005, 0, silentBefore)
  samples.fill(0.3, silentBefore, silentBefore + loud)
  samples.fill(-0.0005, silentBefore + loud)
  return samples
}

describe('trimSilence', () => {
  it('cuts the padding around the speech and keeps a short lead and tail', () => {
    const trimmed = trimSilence(clip(300, 500, 450), RATE)
    expect(trimmed.length).toBe(500 + LEAD_SECONDS * RATE + TRAIL_SECONDS * RATE)
    expect(trimmed[LEAD_SECONDS * RATE]).toBeCloseTo(0.3)
  })

  it('keeps everything when the speech fills the clip', () => {
    expect(trimSilence(clip(0, 200, 0), RATE).length).toBe(200)
  })

  it('returns nothing for a silent clip', () => {
    expect(trimSilence(clip(100, 0, 100), RATE).length).toBe(0)
  })
})

describe('startDelaySeconds', () => {
  it('waits for nothing before any segment has finished', () => {
    expect(startDelaySeconds([{ chars: 50, startedAt: 0 }, { chars: 50, startedAt: 0 }], 2, 1)).toBe(0)
  })

  it('plays at once when synthesis keeps ahead of playback', () => {
    // 10 chars per second of audio, made at twice real time by each worker.
    const segments: SegmentTiming[] = [
      { chars: 100, startedAt: 0, finishedAt: 5, seconds: 10 },
      { chars: 100, startedAt: 0 },
      { chars: 100 }
    ]
    expect(startDelaySeconds(segments, 2, 5)).toBe(0)
  })

  it('holds the first clip when a long second segment would arrive late', () => {
    // Real time synthesis: the 4 s first clip is ready at 4 s, the 12 s second one only at 12 s.
    const segments: SegmentTiming[] = [
      { chars: 40, startedAt: 0, finishedAt: 4, seconds: 4 },
      { chars: 120, startedAt: 0 }
    ]
    expect(startDelaySeconds(segments, 2, 4)).toBeCloseTo(4)
  })

  it('counts segments that wait for a free worker', () => {
    // One worker, real time: the second segment starts only after the first and ends at 8 s.
    const segments: SegmentTiming[] = [{ chars: 40, startedAt: 0, finishedAt: 4, seconds: 4 }, { chars: 40 }]
    expect(startDelaySeconds(segments, 1, 4)).toBeCloseTo(0)
    expect(startDelaySeconds([...segments, { chars: 80 }], 1, 4)).toBeCloseTo(4)
  })
})

describe('splitSpeechSegments', () => {
  it('turns paragraph breaks inside a segment into sentence ends', () => {
    expect(splitSpeechSegments('Done\n\nNext step.')).toEqual(['Done. Next step.'])
  })

  it('starts short and grows to the largest segment', () => {
    const sentence = 'This sentence is about forty characters. '
    const segments = splitSpeechSegments(sentence.repeat(40).trim())
    expect(segments[0].length).toBeLessThanOrEqual(FIRST_SEGMENT_CHARS)
    expect(Math.max(...segments.map((segment) => segment.length))).toBeLessThanOrEqual(MAX_SEGMENT_CHARS)
    expect(segments.at(-2)!.length).toBeGreaterThan(segments[0].length)
    expect(segments.join(' ')).toBe(sentence.repeat(40).trim())
  })
})

describe('PauseGate', () => {
  it('notifies listeners and releases waiters on resume', async () => {
    const gate = new PauseGate()
    const seen: boolean[] = []
    gate.subscribe((paused) => seen.push(paused))
    gate.set(true)
    gate.set(true)
    let released = false
    const waiting = gate.whenPlaying(new AbortController().signal).then(() => {
      released = true
    })
    await Promise.resolve()
    expect(released).toBe(false)
    gate.set(false)
    await waiting
    expect(released).toBe(true)
    expect(seen).toEqual([true, false])
  })

  it('releases waiters when playback is aborted', async () => {
    const gate = new PauseGate()
    gate.set(true)
    const controller = new AbortController()
    const waiting = gate.whenPlaying(controller.signal)
    controller.abort()
    await expect(waiting).resolves.toBeUndefined()
  })
})
