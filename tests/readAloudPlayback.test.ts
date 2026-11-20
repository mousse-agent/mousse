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
import { FIRST_SEGMENT_CHARS, MAX_SEGMENT_CHARS, splitSentences, splitSpeechSegments, type SpeechSegment } from '../src/renderer/readAloud/speechText'

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

const texts = (segments: readonly SpeechSegment[]): string[] => segments.map((segment) => segment.text)
/** The text with the commas taken out, so a comma added at a cut does not count as a change. */
const words = (text: string): string => text.replace(/,/g, '')

describe('splitSpeechSegments', () => {
  it('turns paragraph breaks inside a segment into sentence ends', () => {
    expect(texts(splitSpeechSegments('Done\n\nNext step.'))).toEqual(['Done. Next step.'])
  })

  it('never ends the cut part of a sentence with a period, and marks where it goes on', () => {
    const text =
      'Sure. The engine that was still voicing the old text is shut down and replaced right away so the next read does not wait behind it and starts within seconds. ' +
      'Later segments grow to the largest size, which keeps synthesis well ahead of playback for the rest of the reply, even when a sentence runs on for much longer than any segment could hold, as this one does on purpose.'
    const segments = splitSpeechSegments(text)
    const cuts = segments.filter((segment) => segment.endsMidSentence)
    expect(cuts.length).toBeGreaterThan(1)
    for (const cut of cuts) expect(cut.text).not.toMatch(/[.!?]$/)
    // Nothing but a comma at the cuts is added or lost.
    expect(words(texts(segments).join(' '))).toBe(words(text))
    segments.forEach((segment, index) => expect(segment.startsMidSentence).toBe(index > 0 && segments[index - 1].endsMidSentence))
  })

  it('keeps a sentence of up to the largest segment size whole once the ramp is over', () => {
    const opening = 'This sentence is about forty characters. '.repeat(10).trim()
    const long =
      'This sentence is longer than one hundred characters, which used to be where every sentence was cut in two even after the segments had grown.'
    expect(long.length).toBeGreaterThan(100)
    expect(long.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS)
    const segments = splitSpeechSegments(`${opening} ${long} That is all.`)
    expect(segments.some((segment) => segment.text.includes(long))).toBe(true)
  })

  it('cuts a sentence longer than the largest segment at its commas', () => {
    const clause = 'the engine reads one more clause of this sentence aloud'
    const sentence = `${Array.from({ length: 8 }, (_, index) => `${clause} ${index + 1}`).join(', ')}.`
    const segments = splitSpeechSegments(`Here it goes. ${sentence}`).slice(1)
    expect(segments.length).toBeGreaterThan(1)
    for (const segment of segments) expect(sentence).toContain(segment.text)
  })

  it('takes a whole short first sentence instead of cutting it mid-phrase', () => {
    expect(texts(splitSpeechSegments('The voice model keeps running in its own process until it exits. Then more.'))).toEqual([
      'The voice model keeps running in its own process until it exits.',
      'Then more.'
    ])
  })

  it('cuts a long first sentence at a clause, or joins a short opener to the clause after it', () => {
    expect(splitSpeechSegments('When the model is ready, the first part plays at once. Then more.')).toEqual([
      { text: 'When the model is ready,', startsMidSentence: false, endsMidSentence: true },
      { text: 'the first part plays at once. Then more.', startsMidSentence: true, endsMidSentence: false }
    ])
    expect(
      texts(splitSpeechSegments('Sure. The read aloud button now starts speaking much sooner, because the voice model runs natively instead of in WebAssembly.'))
    ).toEqual(['Sure. The read aloud button now starts speaking much sooner,', 'because the voice model runs natively instead of in WebAssembly.'])
  })

  it('drops a dash at a cut, so no part ends on a dangling dash', () => {
    expect(texts(splitSpeechSegments('Loading the model takes a little while - about a second on most computers - and then the first part plays.'))).toEqual([
      'Loading the model takes a little while,',
      'about a second on most computers,',
      'and then the first part plays.'
    ])
  })

  it('joins short sentences into the first segment', () => {
    expect(texts(splitSpeechSegments('Hi there. This is short. And so on. But this last one is too long for the first.'))).toEqual([
      'Hi there. This is short. And so on.',
      'But this last one is too long for the first.'
    ])
  })

  it('starts short and grows to the largest segment', () => {
    const sentence = 'This sentence is about forty characters. '
    const segments = texts(splitSpeechSegments(sentence.repeat(40).trim()))
    expect(segments[0].length).toBeLessThanOrEqual(FIRST_SEGMENT_CHARS)
    expect(Math.max(...segments.map((segment) => segment.length))).toBeLessThanOrEqual(MAX_SEGMENT_CHARS)
    expect(segments.at(-2)!.length).toBeGreaterThan(segments[0].length)
    expect(segments.join(' ')).toBe(sentence.repeat(40).trim())
  })

  it('keeps the segment after a 30-character first sentence within 1.5 times its length', () => {
    const text =
      'So here is what changed today. ' +
      'The engine that was still voicing the old text is now shut down at once, so a new read never waits. ' +
      'The replacement loads in the background, which takes about a second, and is ready before you click again. Everything else stays the same as before.'
    const segments = texts(splitSpeechSegments(text))
    expect(segments[0]).toBe('So here is what changed today.')
    expect(segments[1].length).toBeLessThanOrEqual(45)
    // Even sized from a 30-character first segment, the ramp keeps every segment in time.
    const { hold, stall } = modelledStart(segments)
    expect(hold).toBeLessThanOrEqual(0.5)
    expect(stall).toBe(0)
  })

  const TYPICAL_REPLY = [
    'Sure. The read aloud button now starts speaking much sooner, because the voice model runs natively instead of in WebAssembly.',
    'When you stop a read, the old engine is replaced right away, so the next read does not wait behind it. The replacement loads the model in the background, which takes about a second.',
    'The first segment is kept short so the first sound arrives in about two seconds. Later segments grow, and synthesis stays ahead of playback for the rest of the reply.'
  ].join('\n\n')
  it.each([
    // The first sound in seconds, modelled: the native engine on two slots.
    ['a typical three-paragraph reply', TYPICAL_REPLY, 3.5],
    ['a short opener before a sentence without a clause break', 'Good question. The short answer is that the queue drains before the next turn starts. Nothing else waits.', 2.5],
    [
      'a long first sentence without a clause break',
      'The read aloud engine now keeps every part of a long opening sentence together for the listener to follow. More follows here.',
      2.6
    ]
  ])('starts %s soon, without stalling later', (_name, reply, seconds) => {
    const segments = texts(splitSpeechSegments(reply))
    const { firstAudio, hold, stall } = modelledStart(segments)
    expect(firstAudio).toBeLessThan(seconds)
    expect(hold).toBeLessThanOrEqual(0.5)
    expect(stall).toBe(0)
  })})

describe('splitSentences', () => {
  it.each([
    ['Pi is 3.14 today. Next.', ['Pi is 3.14 today.', 'Next.']],
    ['Open speechText.ts and v1.2 now. Next.', ['Open speechText.ts and v1.2 now.', 'Next.']],
    ['Fruit, e.g. apples, i.e. food. Next.', ['Fruit, e.g. apples, i.e. food.', 'Next.']],
    ['Ask Dr. Smith or Ms. Jones. Next.', ['Ask Dr. Smith or Ms. Jones.', 'Next.']],
    ['It took 30 ms. The next one.', ['It took 30 ms.', 'The next one.']],
    ['Apples, pears, etc. are fine. Next.', ['Apples, pears, etc. are fine.', 'Next.']],
    ['Apples, pears, etc. Then more.', ['Apples, pears, etc.', 'Then more.']],
    ['Wait... Really? Yes! (Done.) Next', ['Wait...', 'Really?', 'Yes!', '(Done.)', 'Next']]
  ])('splits %j only at sentence ends', (text, sentences) => {
    expect(splitSentences(text)).toEqual(sentences)
  })
})

/**
 * When local playback would start and how long it would stall, for the native engine measured in
 * the app with both slots busy: 0.4 s + 0.05 s per character of compute and 0.055 s of audio per
 * character (after trimming silence), on two slots. The first clip is held as `localEngine` does: `startDelaySeconds` is checked whenever
 * a segment arrives, until it allows playing or its timer runs out.
 */
function modelledStart(segments: readonly string[], slots = 2): { firstAudio: number; hold: number; stall: number } {
  const states = segments.map((segment) => ({ chars: segment.length, startedAt: 0, finishedAt: 0, seconds: 0 }))
  const free = Array.from({ length: slots }, () => 0)
  for (const state of states) {
    free.sort((a, b) => a - b)
    state.startedAt = free[0]
    state.finishedAt = free[0] + 0.4 + 0.05 * state.chars
    state.seconds = 0.055 * state.chars + CLIP_GAP_SECONDS
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
