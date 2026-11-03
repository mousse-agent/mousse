import { describe, expect, it } from 'vitest'
import { MAX_SPEECH_THREADS, speechModelThreads } from '../src/renderer/speechModels/threads'

describe('threads for a local speech model', () => {
  it('uses half the logical cores, up to four', () => {
    expect(speechModelThreads(2, true)).toBe(1)
    expect(speechModelThreads(4, true)).toBe(2)
    expect(speechModelThreads(6, true)).toBe(3)
    expect(speechModelThreads(8, true)).toBe(MAX_SPEECH_THREADS)
    expect(speechModelThreads(24, true)).toBe(MAX_SPEECH_THREADS)
  })

  it('uses one thread on one core or an unknown core count', () => {
    expect(speechModelThreads(1, true)).toBe(1)
    expect(speechModelThreads(undefined, true)).toBe(1)
    expect(speechModelThreads(0, true)).toBe(1)
  })

  it('uses one thread when the window has no shared memory', () => {
    expect(speechModelThreads(24, false)).toBe(1)
  })
})
