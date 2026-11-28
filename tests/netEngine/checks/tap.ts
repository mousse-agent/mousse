/**
 * What an app sends its helper, read off the app channel (design §2): every engine message the app writes on a
 * stream, with the stream's label and, on `mousse.rpc`, the method of its call. The checks read it the same with the
 * fake helper and the real one, and may drop a message on its way to the helper, as a lost reply.
 */
import {
  dataFrame,
  DATA_FIN,
  FRAME_DATA,
  FRAME_JSON,
  FrameReader,
  type AppPipe
} from '../../../src/mms/netEngine/helper/appChannel'
import { engineLimits } from '../../../src/mms/netEngine/limits'
import { encodeMessage, MessageReader, type EngineMessage } from '../../../src/mms/netEngine/session/frame'

export interface Crossed {
  /** The helper identity of the computer whose app sent the message. */
  from: string
  label: string
  /** The method of the call the stream carries (`mousse.rpc`), from its first message either way. */
  method?: string
  header: EngineMessage['header']
  parts: Uint8Array[]
}

export interface Tap {
  crossed: Crossed[]
  /** Decides each message an app sends; `drop` loses it before its helper. */
  decide?: (message: Crossed) => 'drop' | void
  /** Decides each event or reply a helper sends its app; `drop` loses it before the app. */
  hold?: (message: Record<string, unknown>, to: string) => 'drop' | void
  /** Sees each event or reply a helper sends its app (`to` is the app's endpoint), before any hold. */
  watch?: (message: Record<string, unknown>, to: string) => void
}

interface Stream {
  label?: string
  method?: string
  out: MessageReader
  in: MessageReader
}

/** `pipe`, with what its app writes read (and maybe dropped) as `from`'s messages. */
export function tapPipe(pipe: AppPipe, from: () => string, tap: Tap): AppPipe {
  const streams = new Map<number, Stream>()
  const opening = new Map<number, string>()
  const stream = (handle: number): Stream => {
    let found = streams.get(handle)
    if (!found) streams.set(handle, (found = { out: new MessageReader(), in: new MessageReader() }))
    return found
  }
  const learn = (s: Stream, message: EngineMessage) => {
    if ((s.label === 'mousse.rpc' || s.label === 'mousse.botrpc') && s.method === undefined && typeof message.header.method === 'string')
      s.method = message.header.method
  }
  const outFrames = new FrameReader()
  const inFrames = new FrameReader()
  pipe.onData((bytes) => {
    // What the helper sends: the handles of streams and the method of a call that came in.
    for (const frame of inFrames.push(bytes)) {
      const body = Buffer.from(frame.body)
      if (frame.type === FRAME_JSON) {
        const message = JSON.parse(body.toString('utf8')) as Record<string, unknown>
        tap.watch?.(message, from())
        if (typeof message.re === 'number' && typeof message.handle === 'number' && opening.has(message.re)) {
          stream(message.handle).label = opening.get(message.re)
          opening.delete(message.re)
        }
        if (message.ev === 'stream.incoming' && typeof message.handle === 'number' && typeof message.label === 'string')
          stream(message.handle).label = message.label
      } else if (frame.type === FRAME_DATA) {
        const s = stream(body.readUInt32BE(0))
        try {
          for (const message of s.in.push(body.subarray(5))) learn(s, message)
        } catch {
          // Not engine messages; nothing to learn.
        }
      }
    }
  })
  return {
    ...pipe,
    onData: (listener) => {
      // What the helper says, its JSON messages maybe held back. Frames are read even with no hold set, so a
      // hold set later starts at a frame's start.
      const frames = new FrameReader()
      pipe.onData((bytes) => {
        const read = frames.push(bytes)
        if (!tap.hold) return listener(bytes)
        const kept: Buffer[] = []
        for (const frame of read) {
          const body = Buffer.from(frame.body)
          if (frame.type === FRAME_JSON) {
            const message = JSON.parse(body.toString('utf8')) as Record<string, unknown>
            if (tap.hold(message, from()) === 'drop') continue
          }
          kept.push(Buffer.concat([lengthOf(body.byteLength + 1), Buffer.from([frame.type]), body]))
        }
        if (kept.length) listener(Buffer.concat(kept))
      })
    },
    write: (bytes) => {
      let wants = true
      for (const frame of outFrames.push(bytes)) {
        const body = Buffer.from(frame.body)
        if (frame.type === FRAME_JSON) {
          const message = JSON.parse(body.toString('utf8')) as Record<string, unknown>
          if (message.op === 'stream.open' && typeof message.id === 'number' && typeof message.label === 'string')
            opening.set(message.id, message.label)
        }
        if (frame.type !== FRAME_DATA) {
          wants = pipe.write(Buffer.concat([lengthOf(frame.body.byteLength + 1), Buffer.from([frame.type]), body])) && wants
          continue
        }
        const handle = body.readUInt32BE(0)
        const fin = (body[4]! & DATA_FIN) !== 0
        const s = stream(handle)
        let messages: EngineMessage[]
        try {
          messages = s.out.push(body.subarray(5))
        } catch {
          wants = pipe.write(dataFrame(handle, body.subarray(5), fin)) && wants
          continue
        }
        const kept: Uint8Array[] = []
        for (const message of messages) {
          learn(s, message)
          const row: Crossed = {
            from: from(),
            label: s.label ?? '?',
            ...(s.method ? { method: s.method } : {}),
            header: message.header,
            parts: message.parts
          }
          tap.crossed.push(row)
          if (tap.decide?.(row) === 'drop') continue
          kept.push(encodeMessage(message.header, message.parts))
        }
        // Whole messages may span frames: what is let through goes in frames no larger than the channel takes.
        const out = Buffer.concat(kept)
        const max = engineLimits().appDataMaxBytes
        for (let at = 0; at < out.byteLength; at += max) {
          const last = at + max >= out.byteLength
          wants = pipe.write(dataFrame(handle, out.subarray(at, at + max), fin && last)) && wants
        }
        if (!out.byteLength && fin) wants = pipe.write(dataFrame(handle, out, true)) && wants
      }
      return wants
    }
  }
}

function lengthOf(length: number): Buffer {
  const out = Buffer.alloc(4)
  out.writeUInt32BE(length, 0)
  return out
}
