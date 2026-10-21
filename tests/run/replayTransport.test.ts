import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VOLATILE_KEYS,
  dropKeys,
  formatTranscript,
  parseTranscript,
  ReplayMismatchError,
  ReplayTransport,
  TranscriptRecorder,
  type Transcript,
  type TranscriptFrame
} from '../../src/mms/run/testkit/ReplayTransport'

function transcript(frames: TranscriptFrame[]): Transcript {
  return {
    header: {
      kind: 'transcript',
      adapter: 'probe',
      scenario: 'unit',
      boundary: 'test boundary',
      recordedAt: 'hand-authored',
      version: 1
    },
    frames
  }
}

describe('ReplayTransport', () => {
  it('round-trips NDJSON and rejects a missing header or a malformed frame', () => {
    const original = transcript([
      { dir: 'out', frame: { kind: 'call' } },
      { dir: 'in', frame: { kind: 'reply' } }
    ])
    expect(parseTranscript(formatTranscript(original))).toEqual(original)
    expect(() => parseTranscript('{"dir":"out","frame":{}}\n')).toThrow(/header/)
    expect(() => parseTranscript(formatTranscript(original) + '{"dir":"sideways"}\n', 'probe.ndjson')).toThrow(
      /probe\.ndjson:4/
    )
  })

  it('matches outbound frames after normalisation and plays inbound frames in order', async () => {
    const replay = new ReplayTransport(
      transcript([
        { dir: 'out', frame: { kind: 'call', timestamp: 1, args: [1, 2] } },
        { dir: 'in', frame: 'first' },
        { dir: 'in', frame: 'second' }
      ])
    )
    replay.send({ kind: 'call', timestamp: 99, args: [1, 2], ignored: undefined })
    expect(await replay.receive()).toBe('first')
    expect(await replay.receive()).toBe('second')
    expect(await replay.receive()).toBeUndefined()
    expect(() => replay.assertDone()).not.toThrow()
  })

  it('drops a parent.key entry only under that parent, so the announced client version is ignored', () => {
    const normalize = dropKeys(DEFAULT_VOLATILE_KEYS)
    expect(normalize({ at: 1, params: { clientInfo: { name: 'mousse', version: '0.1.2' }, version: 2 } }))
      .toEqual({ params: { clientInfo: { name: 'mousse' }, version: 2 } })
  })

  it('fails a differing outbound frame with a line diff, and keeps failing', () => {
    const replay = new ReplayTransport(transcript([{ dir: 'out', frame: { kind: 'call', text: 'hello' } }]))
    expect(() => replay.send({ kind: 'call', text: 'hi' })).toThrow(ReplayMismatchError)
    expect(replay.error?.message).toContain('Frame 1: outbound frame differs')
    expect(replay.error?.message).toContain('-   "text": "hello"')
    expect(replay.error?.message).toContain('+   "text": "hi"')
    expect(() => replay.assertDone()).toThrow(/Frame 1/)
  })

  it('fails a send where the provider was due to speak, and reports unconsumed frames', async () => {
    const early = new ReplayTransport(transcript([{ dir: 'in', frame: 'reply' }]))
    expect(() => early.send({ kind: 'call' })).toThrow(/where the transcript has an in frame/)

    const short = new ReplayTransport(
      transcript([
        { dir: 'in', frame: 'reply' },
        { dir: 'out', frame: { kind: 'never' } }
      ])
    )
    await short.receive()
    expect(() => short.assertDone()).toThrow(/1 transcript frame\(s\) were not consumed[\s\S]*out \{"kind":"never"\}/)
  })

  it('runs cues in order, ends an exchange at a boundary and waits for another sender', async () => {
    const actions: string[] = []
    const replay = new ReplayTransport(
      transcript([
        { dir: 'in', frame: 'a' },
        { dir: 'cue', frame: { action: 'steer' } },
        { dir: 'out', frame: { kind: 'interrupt' } },
        { dir: 'in', frame: 'b' },
        { dir: 'out', frame: { kind: 'query' } }
      ]),
      {
        onCue: async (cue) => {
          actions.push(`cue:${(cue as { action: string }).action}`)
          // The interrupt is sent by another caller while the reader waits on it.
          setTimeout(() => {
            actions.push('interrupt')
            replay.send({ kind: 'interrupt' })
          }, 5)
        }
      }
    )
    const isQuery = (frame: unknown): boolean => (frame as { kind?: string }).kind === 'query'
    expect(await replay.receive(isQuery)).toBe('a')
    expect(await replay.receive(isQuery)).toBe('b')
    expect(actions).toEqual(['cue:steer', 'interrupt'])
    expect(await replay.receive(isQuery)).toBeUndefined()
    replay.send({ kind: 'query' })
    await replay.idle()
    replay.assertDone()
  })

  describe('sendInOrder', () => {
    const frames = (): TranscriptFrame[] => [
      { dir: 'out', frame: { call: 'parent' } },
      { dir: 'in', frame: { reply: 'parent' } },
      { dir: 'out', frame: { call: 'child' } },
      { dir: 'in', frame: { reply: 'child' } }
    ]

    it('sends a frame that is due at once', async () => {
      const replay = new ReplayTransport(transcript(frames()))
      await replay.sendInOrder({ call: 'parent' })
      expect(await replay.receive()).toEqual({ reply: 'parent' })
    })

    it('holds a frame that lies ahead until the transcript reaches it', async () => {
      const replay = new ReplayTransport(transcript(frames()), { stallMs: 1_000 })
      const order: string[] = []
      const child = replay.sendInOrder({ call: 'child' }).then(() => order.push('child sent'))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(order).toEqual([])
      replay.send({ call: 'parent' })
      await replay.receive((frame) => (frame as { call?: string }).call === 'child')
      await child
      expect(order).toEqual(['child sent'])
      expect(await replay.receive()).toEqual({ reply: 'child' })
      replay.assertDone()
    })

    it('sends a frame the transcript never expects at once, so it fails like send', async () => {
      const replay = new ReplayTransport(transcript(frames()))
      await expect(replay.sendInOrder({ call: 'stranger' })).rejects.toBeInstanceOf(ReplayMismatchError)
      expect(replay.error).toBeInstanceOf(ReplayMismatchError)
      await expect(replay.sendInOrder({ call: 'parent' })).rejects.toBeInstanceOf(ReplayMismatchError)
    })

    it('fails with a stall report when the frames before it are never sent', async () => {
      const replay = new ReplayTransport(transcript(frames()), { stallMs: 30 })
      await expect(replay.sendInOrder({ call: 'child' })).rejects.toThrow(/Stalled at frame 1: a concurrent caller waits to send/)
    })
  })

  it('fails a reader stalled on an outbound frame nobody sends', async () => {
    const replay = new ReplayTransport(transcript([{ dir: 'out', frame: { kind: 'interrupt' } }]), { stallMs: 20 })
    await expect(replay.receive()).rejects.toThrow(/Stalled at frame 1/)
  })

  it('records frames with offsets into a transcript', () => {
    const recorder = new TranscriptRecorder({ adapter: 'probe', scenario: 'unit', boundary: 'test boundary' })
    const live = { kind: 'call', value: 1 }
    recorder.out(live)
    live.value = 2
    recorder.cue({ action: 'stop' })
    recorder.in({ kind: 'reply', skipped: undefined })
    const recorded = recorder.transcript()
    expect(recorded.header).toMatchObject({ kind: 'transcript', adapter: 'probe', version: 1 })
    expect(recorded.frames.map(({ dir, frame }) => ({ dir, frame }))).toEqual([
      { dir: 'out', frame: { kind: 'call', value: 1 } },
      { dir: 'cue', frame: { action: 'stop' } },
      { dir: 'in', frame: { kind: 'reply' } }
    ])
    expect(recorded.frames.every((frame) => typeof frame.at === 'number')).toBe(true)
    expect(parseTranscript(formatTranscript(recorded)).frames).toHaveLength(3)
  })
})
