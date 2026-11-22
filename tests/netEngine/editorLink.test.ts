/**
 * The engine's tunnel link (Phase 1b §9.2): v1's tunnel messages over one `mousse.tunnel` stream per tunnel. A host
 * link hands each message it reads to the tunnels as v1's session would, with the bytes of a `tunnel.data`; anything
 * v1's wire schema refuses, or a message for another tunnel on that stream, ends that tunnel (`protocol`) and resets
 * the stream.
 */
import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { newId, type NodeId } from '../../src/shared/net'
import type { TunnelMessage } from '../../src/shared/net/wire'
import { EngineTunnelLink } from '../../src/mms/netEngine/editor'
import { ENGINE_LIMIT_DEFAULTS } from '../../src/mms/netEngine/limits'
import { Channel } from '../../src/mms/netEngine/session/transport'
import { fakeLink } from './fakeLink'

function bed() {
  const node = newId('node') as NodeId
  const { outbound, inbound } = fakeLink({ ownerOnCaller: newId('node') as NodeId, callerOnOwner: node, grant: '1', endpoint: 'e' })
  const heard: Array<{ message: TunnelMessage; bytes?: string }> = []
  const port = { receive: (_link: unknown, message: TunnelMessage, bytes?: Uint8Array) => heard.push({ message, ...(bytes ? { bytes: Buffer.from(bytes).toString() } : {}) }) }
  const host = new EngineTunnelLink(node, { isOpen: () => inbound.isOpen(), onClosed: () => () => undefined }, port, '1')
  /** How each tunnel stream ended on the host: `fin` once the other side ended its half, else the reset's reason. */
  const hostEnds: string[] = []
  inbound.onStream((stream) => {
    stream.onEnd((reason) => hostEnds.push(reason ?? 'fin'))
    host.accept(stream)
  })
  const id = randomBytes(16).toString('hex')
  const stream = () => {
    const channel = new Channel(outbound.open('mousse.tunnel'))
    const ended = new Promise<string | undefined>((resolve) => channel.onEnd(resolve))
    return { channel, ended }
  }
  /** A few turns of the event loop: the link delivers on setImmediate (not a timer, so fake timers leave it be). */
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
  }
  return { heard, id, stream, settle, host, hostEnds }
}

describe('the engine tunnel link', () => {
  it('hands the tunnels each message, with the bytes of a piece', async () => {
    const t = bed()
    const { channel } = t.stream()
    channel.send({ t: 'tunnel.open', tunnel: t.id, kind: 'ssh' })
    channel.send({ t: 'tunnel.data', tunnel: t.id }, [Buffer.from('hi')])
    channel.send({ t: 'tunnel.credit', tunnel: t.id, bytes: 2 })
    await t.settle()
    expect(t.heard).toEqual([
      { message: { t: 'tunnel.open', tunnel: t.id, kind: 'ssh' } },
      { message: { t: 'tunnel.data', tunnel: t.id, parts: [2] }, bytes: 'hi' },
      { message: { t: 'tunnel.credit', tunnel: t.id, bytes: 2 } }
    ])
  })

  it('lets a stream go once its tunnel is closed: a close from the other side ends this side too', async () => {
    const t = bed()
    const { channel, ended } = t.stream()
    channel.send({ t: 'tunnel.open', tunnel: t.id, kind: 'ssh' })
    channel.send({ t: 'tunnel.close', tunnel: t.id, reason: 'closed' })
    // A FIN, not a reset: the stream and the credit it holds are released on both computers.
    expect(await ended).toBeUndefined()
    expect(t.heard.map(({ message }) => message.t)).toEqual(['tunnel.open', 'tunnel.close'])
  })

  it('resets a closed tunnel\'s stream the other side keeps open, after the linger, so it frees its slot', async () => {
    // Only the timers: the link delivers on setImmediate.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const t = bed()
      const { channel } = t.stream()
      const heard: string[] = []
      channel.onMessage((message) => heard.push(`${message.header.t}:${String(message.header.reason)}`))
      channel.send({ t: 'tunnel.open', tunnel: t.id, kind: 'ssh' })
      await t.settle()
      // The host refuses (as the editor switch being off does); the other side reads it and never ends its half.
      await t.host.sendTunnel({ t: 'tunnel.close', tunnel: t.id, reason: 'editor_off' })
      await t.settle()
      expect(heard).toEqual(['tunnel.close:editor_off'])
      vi.advanceTimersByTime(ENGINE_LIMIT_DEFAULTS.tunnelCloseLingerMs - 1)
      await t.settle()
      expect(t.hostEnds).toEqual([])
      vi.advanceTimersByTime(1)
      await t.settle()
      // Reset: the host's stream is over, and its slot on the connection with it.
      expect(t.hostEnds).toEqual(['closed'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops what the other side sends after a tunnel is closed', async () => {
    const t = bed()
    const { channel } = t.stream()
    channel.send({ t: 'tunnel.open', tunnel: t.id, kind: 'ssh' })
    channel.send({ t: 'tunnel.close', tunnel: t.id, reason: 'closed' })
    channel.send({ t: 'tunnel.data', tunnel: t.id }, [Buffer.from('late')])
    channel.send({ t: 'tunnel.credit', tunnel: t.id, bytes: 4 })
    await t.settle()
    expect(t.heard.map(({ message }) => message.t)).toEqual(['tunnel.open', 'tunnel.close'])
  })

  it.each([
    ['a host and a port in the open', (id: string) => ({ t: 'tunnel.open', tunnel: id, kind: 'ssh', host: '10.0.0.1', port: 22 }), false],
    ['a first message that is not an open', (id: string) => ({ t: 'tunnel.credit', tunnel: id, bytes: 1 }), false],
    ['another tunnel\'s id', () => ({ t: 'tunnel.credit', tunnel: randomBytes(16).toString('hex'), bytes: 1 }), true],
    ['a second open', (id: string) => ({ t: 'tunnel.open', tunnel: id, kind: 'ssh' }), true],
    ['a field v1 does not know', (id: string) => ({ t: 'tunnel.credit', tunnel: id, bytes: 1, extra: true }), true]
  ] as const)('%s ends the tunnel and resets the stream', async (_what, bad, afterOpen) => {
    const t = bed()
    const { channel, ended } = t.stream()
    if (afterOpen) channel.send({ t: 'tunnel.open', tunnel: t.id, kind: 'ssh' })
    channel.send(bad(t.id))
    expect(await ended).toBe('bad_message')
    // The open (if any) reached the tunnels; what broke the protocol did not, and the tunnel ended with it.
    expect(t.heard.map(({ message }) => message.t)).toEqual(afterOpen ? ['tunnel.open', 'tunnel.close'] : [])
    if (afterOpen) expect(t.heard[1]!.message).toMatchObject({ reason: 'protocol' })
  })
})
