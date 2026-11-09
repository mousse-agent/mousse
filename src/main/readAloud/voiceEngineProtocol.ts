/**
 * Frames between main and the native voice engine (`native/voice-engine`, see its `protocol.rs`),
 * over the engine's standard input and output. A frame is a little-endian `u32` body length, then
 * the body; the body's first byte is its kind.
 */

export const STYLE_VALUES = 256
/** Larger events mean the stream is out of step; the longest segment is a few MB of audio. */
const MAX_EVENT_BYTES = 256 * 1024 * 1024

export type VoiceEngineEvent =
  | { type: 'ready' }
  | { type: 'load-error'; message: string }
  | { type: 'audio'; id: number; sampleRate: number; samples: Float32Array }
  | { type: 'error'; id: number; message: string }
  | { type: 'cancelled'; id: number }

function frame(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + body.length)
  new DataView(out.buffer).setUint32(0, body.length, true)
  out.set(body, 4)
  return out
}

const utf8 = new TextEncoder()

export function loadFrame(modelPath: string): Uint8Array {
  const path = utf8.encode(modelPath)
  const body = new Uint8Array(1 + path.length)
  body[0] = 1
  body.set(path, 1)
  return frame(body)
}

export function runFrame(id: number, inputIds: readonly number[], style: Float32Array, speed: number): Uint8Array {
  if (style.length !== STYLE_VALUES) throw new Error(`A style has ${STYLE_VALUES} values`)
  const body = new Uint8Array(9 + STYLE_VALUES * 4 + inputIds.length * 8)
  const view = new DataView(body.buffer)
  body[0] = 2
  view.setUint32(1, id, true)
  view.setFloat32(5, speed, true)
  style.forEach((value, index) => view.setFloat32(9 + index * 4, value, true))
  const ids = 9 + STYLE_VALUES * 4
  inputIds.forEach((value, index) => view.setBigInt64(ids + index * 8, BigInt(value), true))
  return frame(body)
}

export function cancelFrame(id: number): Uint8Array {
  const body = new Uint8Array(5)
  body[0] = 3
  new DataView(body.buffer).setUint32(1, id, true)
  return frame(body)
}

export const shutdownFrame = (): Uint8Array => frame(new Uint8Array([4]))

const utf8Decoder = new TextDecoder()

function decodeEvent(body: Uint8Array): VoiceEngineEvent {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const id = (): number => {
    if (body.length < 5) throw new Error('The voice engine sent an event without its request')
    return view.getUint32(1, true)
  }
  switch (body[0]) {
    case 1:
      return { type: 'ready' }
    case 2:
      return { type: 'load-error', message: utf8Decoder.decode(body.subarray(1)) }
    case 3: {
      if (body.length < 9 || (body.length - 9) % 4 !== 0) throw new Error('The voice engine sent damaged audio')
      // Copied, so the samples are aligned and do not hold on to the stream's buffer.
      const samples = new Float32Array((body.length - 9) / 4)
      for (let index = 0; index < samples.length; index++) samples[index] = view.getFloat32(9 + index * 4, true)
      return { type: 'audio', id: id(), sampleRate: view.getUint32(5, true), samples }
    }
    case 4:
      return { type: 'error', id: id(), message: utf8Decoder.decode(body.subarray(5)) }
    case 5:
      return { type: 'cancelled', id: id() }
    default:
      throw new Error(`The voice engine sent an unknown event (${body[0]})`)
  }
}

/** Splits the engine's output into events. Throws when the output is not frames. */
export class VoiceEngineReader {
  private chunks: Uint8Array[] = []
  private buffered = 0

  push(chunk: Uint8Array): VoiceEngineEvent[] {
    this.chunks.push(chunk)
    this.buffered += chunk.length
    const events: VoiceEngineEvent[] = []
    while (this.buffered >= 4) {
      const head = this.peek(4)
      const length = new DataView(head.buffer, head.byteOffset, 4).getUint32(0, true)
      if (length === 0 || length > MAX_EVENT_BYTES) throw new Error(`The voice engine sent a frame of ${length} bytes`)
      if (this.buffered < 4 + length) break
      events.push(decodeEvent(this.take(4 + length).subarray(4)))
    }
    return events
  }

  /** The first `count` buffered bytes, joining chunks only when needed. */
  private peek(count: number): Uint8Array {
    if (this.chunks[0].length < count) this.chunks = [concat(this.chunks)]
    return this.chunks[0].subarray(0, count)
  }

  private take(count: number): Uint8Array {
    const taken = this.peek(count)
    const first = this.chunks[0]
    if (first.length === count) this.chunks.shift()
    else this.chunks[0] = first.subarray(count)
    this.buffered -= count
    return taken
  }
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}
