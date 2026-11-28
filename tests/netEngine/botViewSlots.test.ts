/**
 * A bot's browser view shown and hidden over and over keeps no bot place (`docs/plans/remote-bots.md`, live view):
 * both sides end their half of its `mousse.botview` stream, so the stream's place is given back in each app's
 * connection (`ConnectionSlots`), and a bot chat opens at once after more views than the connection has bot places.
 */
import { describe, expect, it } from 'vitest'
import { AppChannel, creditFrame, dataFrame, FRAME_DATA, FRAME_JSON, FrameReader, jsonFrame, type AppPipe } from '../../src/mms/netEngine/helper/appChannel'
import { EngineHelper } from '../../src/mms/netEngine/helper/connections'
import { engineLimits } from '../../src/mms/netEngine/limits'
import type { EngineConnection } from '../../src/mms/netEngine/session/transport'
import { RemoteBotBrowsers, type RemoteBrowsersPort } from '../../src/mms/bridge/remote/RemoteBotBrowsers'
import { RemoteBotViews } from '../../src/mms/bridge/routed/remoteBotViews'
import type { BotBrowserView } from '../../src/shared/bots/personal/browser'
import type { NodeId } from '../../src/shared/net'

const VIEW = { open: true, control: 'bot', holder: 'bot', activations: [] } as unknown as BotBrowserView

/** One app's pipe to its helper: the frames it wrote, and a way to hand it frames. */
function pipe() {
  const written: Array<{ type: number; body: Buffer }> = []
  const reader = new FrameReader()
  let data: (bytes: Uint8Array) => void = () => undefined
  const app: AppPipe = {
    write: (bytes) => {
      for (const frame of reader.push(bytes)) written.push({ type: frame.type, body: Buffer.from(frame.body) })
      return true
    },
    onDrain: () => undefined,
    onData: (listener) => void (data = listener),
    onClose: () => undefined,
    close: () => undefined
  }
  return { app, written, push: (bytes: Uint8Array) => data(bytes) }
}

/**
 * Two apps over a strict pair of helpers: a stream keeps its place there until both sides sent FIN, or either reset.
 * `pump` moves what each app wrote to the other, as the helpers would.
 */
function pair() {
  const viewerPipe = pipe()
  const ownerPipe = pipe()
  let outbound!: EngineConnection
  let inbound!: EngineConnection
  new EngineHelper(new AppChannel(viewerPipe.app), {
    peers: { byIdentity: () => ({ node: 'owner' as NodeId, grant: '1', endpoint: 'owner' }) },
    attach: async (connection) => void (outbound = connection),
    name: () => 'Viewer'
  })
  new EngineHelper(new AppChannel(ownerPipe.app), {
    peers: { byIdentity: () => ({ node: 'viewer' as NodeId, grant: '1', endpoint: 'viewer' }) },
    attach: async (connection) => void (inbound = connection),
    name: () => 'Owner'
  })
  viewerPipe.push(jsonFrame({ ev: 'conn.up', conn: 1, identity: 'owner', dir: 'out' }))
  ownerPipe.push(jsonFrame({ ev: 'conn.up', conn: 1, identity: 'viewer', dir: 'in', grant: 1 }))
  const open = new Map<number, { viewerFin: boolean; ownerFin: boolean }>()
  const labels: string[] = []
  let next = 1
  let viewerRead = 0
  let ownerRead = 0
  const settle = (handle: number) => {
    const s = open.get(handle)
    if (s?.viewerFin && s.ownerFin) open.delete(handle)
  }
  const pump = () => {
    let moved = true
    while (moved) {
      moved = false
      while (viewerRead < viewerPipe.written.length) {
        moved = true
        const frame = viewerPipe.written[viewerRead++]!
        if (frame.type === FRAME_JSON) {
          const message = JSON.parse(frame.body.toString('utf8')) as { id: number; op: string; label?: string; class?: string; handle?: number }
          if (message.op === 'stream.open') {
            const handle = next++
            labels.push(message.label!)
            open.set(handle, { viewerFin: false, ownerFin: false })
            viewerPipe.push(Buffer.concat([jsonFrame({ re: message.id, handle }), creditFrame(handle, 1024 * 1024)]))
            ownerPipe.push(jsonFrame({ ev: 'stream.incoming', conn: 1, handle, label: message.label, class: message.class }))
          } else if (message.op === 'stream.reset' && typeof message.handle === 'number' && open.delete(message.handle)) {
            ownerPipe.push(jsonFrame({ ev: 'stream.reset', handle: message.handle, code: 'cancelled' }))
          }
        } else if (frame.type === FRAME_DATA) {
          const handle = frame.body.readUInt32BE(0)
          const fin = (frame.body.readUInt8(4) & 1) === 1
          const s = open.get(handle)
          if (!s) continue
          if (fin) s.viewerFin = true
          ownerPipe.push(dataFrame(handle, frame.body.subarray(5), fin))
          settle(handle)
        }
      }
      while (ownerRead < ownerPipe.written.length) {
        moved = true
        const frame = ownerPipe.written[ownerRead++]!
        if (frame.type === FRAME_JSON) {
          const message = JSON.parse(frame.body.toString('utf8')) as { id: number; op: string; handle?: number }
          if (message.op === 'stream.accept' && typeof message.handle === 'number') {
            ownerPipe.push(Buffer.concat([jsonFrame({ re: message.id }), creditFrame(message.handle, 1024 * 1024)]))
          } else if (message.op === 'stream.reset' && typeof message.handle === 'number' && open.delete(message.handle)) {
            viewerPipe.push(jsonFrame({ ev: 'stream.reset', handle: message.handle, code: 'cancelled' }))
          }
        } else if (frame.type === FRAME_DATA) {
          const handle = frame.body.readUInt32BE(0)
          const fin = (frame.body.readUInt8(4) & 1) === 1
          const s = open.get(handle)
          if (!s) continue
          if (fin) s.ownerFin = true
          viewerPipe.push(dataFrame(handle, frame.body.subarray(5), fin))
          settle(handle)
        }
      }
    }
  }
  return { outbound: () => outbound, inbound: () => inbound, pump, open, labels }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('a bot browser view shown and hidden', () => {
  it('gives its bot place back on both sides each time, so a bot chat opens after more views than there are places', async () => {
    const places = engineLimits().botStreamsPerConnection
    const link = pair()
    link.pump()
    const port = {
      view: async () => VIEW,
      watch: async () => VIEW,
      unwatch: () => undefined,
      hold: async () => ({ browser: VIEW }),
      send: async () => ({ acks: [], lastSeq: 0 }),
      open: async () => ({ browser: VIEW }),
      endHoldsOf: async () => undefined
    } as unknown as RemoteBrowsersPort
    const host = new RemoteBotBrowsers({ browsers: () => port, bot: () => undefined })
    link.inbound().onStream((stream) => host.accept('viewer', stream))
    // Lingering is not what this checks: a view whose other side never ends its half would be reset only after it.
    const viewer = new RemoteBotViews({ open: () => link.outbound().open('mousse.botview'), online: () => true, computer: (node) => ({ node, name: 'Owner' }), lingerMs: 60_000 })
    const window = { id: 'window-1', emit: () => undefined }

    for (let shown = 0; shown < places + 4; shown += 1) {
      const answer = viewer.watch(window, 'owner' as NodeId, 'bot-0123456789ab', { watchId: `w${shown}`, width: 480, fps: 5 })
      for (let step = 0; step < 20 && link.open.size === 0; step += 1) {
        link.pump()
        await tick()
      }
      for (let step = 0; step < 10; step += 1) {
        link.pump()
        await tick()
      }
      await expect(answer, `view ${shown + 1}`).resolves.toMatchObject({ browser: { open: true } })
      viewer.unwatch(window.id, 'owner' as NodeId, 'bot-0123456789ab', `w${shown}`)
      for (let step = 0; step < 10 && link.open.size > 0; step += 1) {
        link.pump()
        await tick()
      }
      expect(link.open.size, `view ${shown + 1} closed`).toBe(0)
    }
    expect(host.viewCount).toBe(0)

    // A bot chat now: its open goes out at once.
    const before = link.labels.length
    link.outbound().open('mousse.botsub')
    link.pump()
    expect(link.labels.slice(before)).toEqual(['mousse.botsub'])
  })
})
