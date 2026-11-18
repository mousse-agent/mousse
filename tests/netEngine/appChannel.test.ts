/**
 * The app's end of the helper channel (design §2): what it writes under the helper's credit, in what order, and
 * what closes it.
 */
import { describe, expect, it } from 'vitest'
import {
  AppChannel,
  creditFrame,
  dataFrame,
  FRAME_CREDIT,
  FRAME_DATA,
  FRAME_JSON,
  FrameReader,
  jsonFrame,
  type AppPipe,
  type HandleSink
} from '../../src/mms/netEngine/helper/appChannel'
import { EngineHelper } from '../../src/mms/netEngine/helper/connections'

/** A pipe whose helper side is the test: frames the app wrote, and frames pushed to the app. */
function pipe() {
  const written: Array<{ type: number; body: Buffer }> = []
  const reader = new FrameReader()
  let data: (bytes: Uint8Array) => void = () => undefined
  let closed = false
  const app: AppPipe = {
    write: (bytes) => {
      for (const frame of reader.push(bytes)) written.push({ type: frame.type, body: Buffer.from(frame.body) })
      return true
    },
    onDrain: () => undefined,
    onData: (listener) => void (data = listener),
    onClose: () => undefined,
    close: () => void (closed = true)
  }
  const data_ = (handle: number) =>
    written
      .filter((frame) => frame.type === FRAME_DATA && frame.body.readUInt32BE(0) === handle)
      .map((frame) => ({ bytes: frame.body.byteLength - 5, fin: (frame.body[4]! & 1) === 1 }))
  return { app, written, push: (bytes: Uint8Array) => data(bytes), data: data_, closed: () => closed }
}

const sink = (): HandleSink & { got: number; ended?: string } => {
  const out = {
    got: 0,
    ended: undefined as string | undefined,
    data: (bytes: Uint8Array) => void (out.got += bytes.byteLength),
    reset: (code: string) => void (out.ended = code)
  }
  return out
}

describe('the app channel', () => {
  it('sends a stream only as far as the helper’s credit, with FIN after every queued byte', () => {
    const p = pipe()
    const channel = new AppChannel(p.app)
    channel.bind(7, 'bulk', sink())
    channel.send(7, new Uint8Array(100 * 1024), true)
    expect(p.data(7)).toEqual([])
    p.push(creditFrame(7, 64 * 1024))
    expect(p.data(7)).toEqual([{ bytes: 64 * 1024, fin: false }])
    p.push(creditFrame(7, 36 * 1024))
    expect(p.data(7)).toEqual([
      { bytes: 64 * 1024, fin: false },
      { bytes: 36 * 1024, fin: true }
    ])
  })

  it('writes control first, then interactive data, then bulk', () => {
    const p = pipe()
    // A pipe that takes one frame and then wants a drain: each drain shows the writer's next choice.
    let drain: () => void = () => undefined
    const order: string[] = []
    const slow: AppPipe = {
      ...p.app,
      onDrain: (listener) => void (drain = listener),
      write: (bytes) => {
        p.app.write(bytes)
        const frame = p.written[p.written.length - 1]!
        order.push(frame.type === FRAME_DATA ? `data ${frame.body.readUInt32BE(0)}` : frame.type === FRAME_JSON ? 'json' : 'credit')
        return false
      }
    }
    const channel = new AppChannel(slow)
    channel.bind(1, 'bulk', sink())
    channel.bind(2, 'interactive', sink())
    p.push(Buffer.concat([creditFrame(1, 1024), creditFrame(2, 1024)]))
    channel.send(1, new Uint8Array(10))
    channel.send(2, new Uint8Array(10))
    void channel.request('stats').catch(() => undefined)
    for (let i = 0; i < 4; i += 1) drain()
    // The first bind's credit went at once; then the second's, the request, interactive data, bulk data.
    expect(order).toEqual(['credit', 'credit', 'json', 'data 2', 'data 1'])
  })

  it('closes on a malformed frame', () => {
    for (const malformed of [
      // A CREDIT of 0 bytes.
      Buffer.concat([Buffer.from([0, 0, 0, 9, FRAME_CREDIT]), Buffer.alloc(8)]),
      // DATA with a flag other than FIN.
      Buffer.concat([Buffer.from([0, 0, 0, 6, FRAME_DATA, 0, 0, 0, 1, 0x02])]),
      // An unknown frame type.
      Buffer.from([0, 0, 0, 1, 0x09])
    ]) {
      const p = pipe()
      const channel = new AppChannel(p.app)
      const one = sink()
      channel.bind(1, 'interactive', one)
      p.push(malformed)
      expect(channel.isOpen()).toBe(false)
      expect(p.closed()).toBe(true)
      expect(one.ended).toBeDefined()
    }
  })

  it('drops a frame for a handle it does not know, and counts it', () => {
    const p = pipe()
    const channel = new AppChannel(p.app)
    p.push(dataFrame(42, new Uint8Array(3), false))
    p.push(jsonFrame({ ev: 'stream.reset', handle: 42, code: 'cancelled' }))
    expect(channel.dropped).toBe(1)
    expect(channel.isOpen()).toBe(true)
  })
})

describe('the helper, as the app sees it', () => {
  it('says its name and profile in hello, and keeps whether networking is paused', async () => {
    const p = pipe()
    const helper = new EngineHelper(new AppChannel(p.app), {
      peers: { byIdentity: () => undefined },
      attach: async () => undefined,
      name: () => 'Desk',
      profile: () => 'profile-1'
    })
    const seen: Array<string | undefined> = []
    helper.onPaused((reason) => seen.push(reason))
    const hello = helper.hello()
    const asked = JSON.parse(p.written[0]!.body.toString('utf8'))
    expect(asked).toMatchObject({ op: 'hello', proto: [1, 0], name: 'Desk', profile: 'profile-1' })
    p.push(jsonFrame({ re: asked.id, proto: [1, 0], identity: 'ab', paused: 'journal' }))
    await hello
    expect(helper.paused).toBe('journal')
    p.push(jsonFrame({ ev: 'net.resumed' }))
    p.push(jsonFrame({ ev: 'net.paused', reason: 'disk' }))
    expect(helper.paused).toBe('disk')
    expect(seen).toEqual(['journal', undefined, 'disk'])
  })
})
