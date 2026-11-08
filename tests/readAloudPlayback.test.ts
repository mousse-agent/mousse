import { describe, expect, it } from 'vitest'
import {
  CLIP_GAP_SECONDS,
  LEAD_SECONDS,
  MAX_START_DELAY_SECONDS,
  TRAIL_SECONDS,
  startDelaySeconds,
  trimSilence,
  type SegmentTiming
} from '../src/renderer/readAloud/localPlayback'
import { PauseGate } from '../src/renderer/readAloud/playback'
import { FIRST_SEGMENT_CHARS, MAX_SEGMENT_CHARS, splitSpeechChunks, splitSpeechSegments } from '../src/renderer/readAloud/speechText'

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

  it('joins short sentences into the first segment', () => {
    expect(
      splitSpeechSegments(
        'Hi there. This is short. And so is this one, mostly. But this last sentence is long enough that it does not fit in the first segment at all.'
      )
    ).toEqual([
      'Hi there. This is short. And so is this one, mostly.',
      'But this last sentence is long enough that it does not fit in the first segment at all.'
    ])
  })

  it('joins a "Sure." opener to the long sentence after it and cuts that sentence', () => {
    const text =
      'Sure. The engine that was still voicing the old text is shut down and replaced right away, so the next read does not wait behind it and starts within seconds. ' +
      'The replacement loads the model in the background while you read. After that, every read starts quickly.'
    const segments = splitSpeechSegments(text)
    expect(segments).toEqual([
      'Sure. The engine that was still voicing the old text is,',
      'shut down and replaced right away, so the next read does not wait behind it and starts within seconds.',
      'The replacement loads the model in the background while you read. After that, every read starts quickly.'
    ])
    expect(segments.map((segment) => segment.length)).toEqual([56, 102, 104])
    expect(modelledStart(segments).hold).toBeLessThanOrEqual(0.5)
  })

  it('cuts a long first sentence at a clause break, else at a word', () => {
    expect(
      splitSpeechSegments('When the voice model has finished loading in the background, the first segment is voiced at once and playback starts. Then the rest follows.')
    ).toEqual(['When the voice model has finished loading in the background,', 'the first segment is voiced at once and playback starts. Then the rest follows.'])
    // A cut between words ends with a comma, so the voice does not close the sentence there.
    expect(
      splitSpeechSegments('The voice model keeps running in its own process for five minutes after the last read ends and then exits. Then the rest follows.')
    ).toEqual(['The voice model keeps running in its own process for five,', 'minutes after the last read ends and then exits. Then the rest follows.'])
  })

  it('counts a paragraph break as a sentence end, so a short opening paragraph is joined too', () => {
    expect(
      splitSpeechSegments(
        'Summary.\n\nThe engine that was still voicing the old text is shut down and replaced right away, so the next read does not wait behind it. That is all.'
      )
    ).toEqual([
      'Summary. The engine that was still voicing the old text is,',
      'shut down and replaced right away, so the next read does not wait behind it. That is all.'
    ])
  })

  it('keeps the segment after a 30-character first sentence within twice its length', () => {
    const text =
      'So here is what changed today. ' +
      'The engine that was still voicing the old text is now shut down at once, so a new read never waits. ' +
      'The replacement loads in the background, which takes about a second, and is ready before you click again. Everything else stays the same as before.'
    const segments = splitSpeechSegments(text)
    expect(segments.map((segment) => segment.length)).toEqual([30, 59, 40, 147])
    expect(segments[1].length).toBeLessThanOrEqual(60)
    // The estimate made after only the short first segment overstates the cost per character, so
    // the first clip is held a little under a second (0.97 s with these constants) although every
    // segment would arrive in time. With the measured two-thread engine the hold is 0.
    const { hold, stall } = modelledStart(segments)
    expect(hold).toBeLessThan(1)
    expect(stall).toBe(0)
  })

  it('splits the rest after the ramp as before, without cutting sentences of 80 to 99 characters', () => {
    const sentences = [
      'When the model has finished loading in the background, the first segment plays right away.',
      'Nothing else about the voices changes for you.',
      'The engine that was still voicing the old text is shut down and replaced at once.',
      'A replacement is started straight away, so it has already loaded the model when you click again.'
    ]
    const tail = 'Later segments grow to the largest size, which keeps synthesis well ahead of playback for the rest of the reply. That is all.'
    const text = `${sentences.join(' ')}\n\n${tail}`
    const segments = splitSpeechSegments(text)
    expect(segments).toEqual([
      'When the model has finished loading in the background,',
      'the first segment plays right away. Nothing else about the voices changes for you.',
      sentences[2],
      sentences[3],
      tail
    ])
    expect(sentences[2].length).toBe(81)
    expect(sentences[3].length).toBe(96)
    // From the third segment on, the limits and the output are the ones the old 100-character start gave.
    const before = splitSpeechChunks(text, (index) => Math.min(MAX_SEGMENT_CHARS, 100 * 1.25 ** index))
    expect(segments.slice(2)).toEqual(before.slice(2))
  })

  it('starts a typical three-paragraph reply without holding the first clip', () => {
    const reply = [
      'Sure. The read aloud button now starts speaking much sooner, because the voice model runs natively instead of in WebAssembly.',
      'When you stop a read, the engine that was still voicing the old text is shut down and replaced right away, so the next read does not wait behind it. The replacement loads the model in the background, which takes about a second.',
      'The first segment is kept short so the first sound arrives in about two seconds. Later segments grow, and synthesis stays ahead of playback for the rest of the reply.'
    ].join('\n\n')
    const segments = splitSpeechSegments(reply)
    expect(segments).toEqual([
      'Sure. The read aloud button now starts speaking much sooner,',
      'because the voice model runs natively instead of in WebAssembly.',
      'When you stop a read, the engine that was still voicing the old text is shut down and replaced right away, so the next read does not wait behind it.',
      'The replacement loads the model in the background, which takes about a second. The first segment is kept short so the first sound arrives in about two seconds.',
      'Later segments grow, and synthesis stays ahead of playback for the rest of the reply.'
    ])
    const { firstAudio, hold, stall } = modelledStart(segments)
    expect(firstAudio).toBeLessThan(3.1)
    expect(hold).toBeLessThanOrEqual(0.5)
    expect(stall).toBe(0)
  })
})

/**
 * When local playback would start and how long it would stall, for the native engine measured
 * with one thread: 0.4 s + 0.043 s per character of compute and 0.066 s of audio per character, on
 * two slots. The first clip is held as `localEngine` does: `startDelaySeconds` is checked whenever
 * a segment arrives, until it allows playing or its timer runs out.
 */
function modelledStart(segments: readonly string[], slots = 2): { firstAudio: number; hold: number; stall: number } {
  const states = segments.map((segment) => ({ chars: segment.length, startedAt: 0, finishedAt: 0, seconds: 0 }))
  const free = Array.from({ length: slots }, () => 0)
  for (const state of states) {
    free.sort((a, b) => a - b)
    state.startedAt = free[0]
    state.finishedAt = free[0] + 0.4 + 0.043 * state.chars
    state.seconds = 0.066 * state.chars + CLIP_GAP_SECONDS
    free[0] = state.finishedAt
  }
  const firstAudio = states[0].finishedAt
  const arrivals = [...new Set(states.map((state) => state.finishedAt))].filter((at) => at >= firstAudio).sort((a, b) => a - b)
  let start: number | null = null
  let timer: number | null = null
  for (const at of arrivals) {
    if (timer !== null && at >= timer) break
    const known: SegmentTiming[] = states.map((state) => ({
      chars: state.chars,
      startedAt: state.startedAt <= at ? state.startedAt : undefined,
      finishedAt: state.finishedAt <= at ? state.finishedAt : undefined,
      seconds: state.finishedAt <= at ? state.seconds : undefined
    }))
    const delay = Math.min(startDelaySeconds(known, slots, at), MAX_START_DELAY_SECONDS - (at - firstAudio))
    if (delay <= 0.05) {
      start = at
      break
    }
    timer ??= at + delay
  }
  start ??= timer ?? firstAudio
  let playAt = start
  let stall = 0
  for (const state of states) {
    if (state.finishedAt > playAt) {
      stall += state.finishedAt - playAt
      playAt = state.finishedAt
    }
    playAt += state.seconds
  }
  return { firstAudio, hold: start - firstAudio, stall }
}

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
