import { createCipheriv, randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { afterEach, expect, it, vi } from 'vitest'
import { LanDiscovery } from '../../../src/mms/net/transports/lan'
import { systemClock } from '../../../src/mms/net/clock'
import { newId } from '../../../src/shared/net'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
// Boundary inputs: malformed, forged, reflected, stale/future, valid, address/port change,
// expiry and roster removal. These are hand-authored wire packets, sent through a real UDP socket.
it('only fresh pairwise authenticated beacons become temporary routes', async () => {
  let tick: (() => void) | undefined
  let now = Date.now(),
    allowed = true
  const node = newId('node'),
    sendKey = randomBytes(32),
    receiveKey = randomBytes(32)
  const changed = vi.fn()
  const lan = new LanDiscovery({
    clock: {
      ...systemClock,
      now: () => now,
      setTimeout: (callback) => {
        tick = callback
        return {
          cancel: () => {
            tick = undefined
          }
        }
      }
    },
    peers: () => (allowed ? [{ node, sendKey, receiveKey }] : []),
    changed
  })
  cleanup.push(() => lan.teardown())
  await lan.start((raw) => raw.destroy())
  const udp = createSocket('udp4')
  cleanup.push(() => udp.close())
  const send = (packet: Buffer) =>
    new Promise<void>((resolve, reject) =>
      udp.send(packet, 47777, '127.0.0.1', (error) => (error ? reject(error) : resolve()))
    )
  const packet = (key: Buffer, issued: number, port = 12345) => {
    const nonce = randomBytes(12),
      plain = randomBytes(16),
      magic = Buffer.from('MLN1')
    plain.writeDoubleBE(issued)
    plain.writeUInt16BE(port, 8)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(magic)
    return Buffer.concat([magic, nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()])
  }
  for (const invalid of [
    Buffer.from('bad'),
    packet(randomBytes(32), now),
    packet(sendKey, now),
    packet(receiveKey, now - 31_000),
    packet(receiveKey, now + 31_000)
  ])
    await send(invalid)
  // A valid packet after all invalid packets is the processing barrier.
  await send(packet(receiveKey, now))
  await vi.waitFor(() =>
    expect(lan.routes(node)[0]?.address).toBe('ws://127.0.0.1:12345/mousse-net')
  )
  expect(changed).toHaveBeenCalledTimes(1)
  const replay = packet(receiveKey, now, 12346)
  await send(replay)
  await vi.waitFor(() => expect(lan.routes(node)[0]?.address).toContain(':12346/'))
  // Linux routes the full 127/8 block locally; macOS requires explicit aliases.
  if (process.platform === 'linux') {
    const second = createSocket('udp4')
    cleanup.push(() => second.close())
    await new Promise<void>((resolve) => second.bind(0, '127.0.0.2', resolve))
    await new Promise<void>((resolve, reject) =>
      second.send(packet(receiveKey, now), 47777, '127.0.0.1', (error) =>
        error ? reject(error) : resolve()
      )
    )
    await vi.waitFor(() => expect(lan.routes(node)).toHaveLength(2))
  }
  await send(replay)
  // Another authenticated packet is the barrier after the replay.
  await send(packet(receiveKey, now))
  await vi.waitFor(() =>
    expect(lan.routes(node).some((route) => route.address.includes(':12345/'))).toBe(true)
  )
  expect(lan.routes(node)).toHaveLength(process.platform === 'linux' ? 2 : 1)
  allowed = false
  tick!()
  expect(lan.routes(node)).toEqual([])
  allowed = true
  tick!()
  await send(packet(receiveKey, now))
  await vi.waitFor(() => expect(lan.routes(node)).toHaveLength(1))
  now += 31_000
  expect(lan.routes(node)).toEqual([])
  allowed = false
}, 10_000)
