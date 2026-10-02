import tls, { type TLSSocket } from 'node:tls'
import { describe, expect, it } from 'vitest'
import { NetError } from '../../../src/shared/net'
import { generateSelfSignedCert, fingerprint } from '../../../src/mms/net/link/selfSignedCert'
import { openSecureChannel } from '../../../src/mms/net/link/secureChannel'
import { memoryPair } from '../harness/MemoryTransport'

const credentials = [generateSelfSignedCert('node-a'), generateSelfSignedCert('node-b')]
async function opened() {
  const pair = memoryPair()
  const channels = await Promise.all([
    openSecureChannel(pair.a, { role: 'client', credentials: credentials[0], expectedPeerFingerprint: fingerprint(credentials[1].publicKeySpki), deadlineMs: 1_000 }),
    openSecureChannel(pair.b, { role: 'server', credentials: credentials[1], expectedPeerFingerprint: fingerprint(credentials[0].publicKeySpki), deadlineMs: 1_000 })
  ])
  return { pair, channels }
}
function read(stream: NodeJS.ReadableStream, expectedBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const data = (chunk: Buffer) => {
      chunks.push(chunk); size += chunk.length
      if (size >= expectedBytes) { stream.removeListener('data', data); stream.removeListener('error', reject); resolve(Buffer.concat(chunks)) }
    }
    stream.on('data', data)
    stream.once('error', reject)
  })
}

describe('pinned TLS channel', () => {
  it('authenticates both keys, negotiates TLS 1.3 and binds identical exporters', async () => {
    const { pair, channels: [a, b] } = await opened()
    try {
      expect(a.peerTransportKey).toBe(Buffer.from(credentials[1].publicKeySpki).toString('base64url'))
      expect(b.peerTransportKey).toBe(Buffer.from(credentials[0].publicKeySpki).toString('base64url'))
      expect((a.stream as TLSSocket).getProtocol()).toBe('TLSv1.3')
      expect((b.stream as TLSSocket).isSessionReused()).toBe(false)
      expect(a.exporter('EXPORTER-mousse-net-enroll', 32)).toEqual(b.exporter('EXPORTER-mousse-net-enroll', 32))
      expect(a.exporter('EXPORTER-mousse-net-other', 32)).not.toEqual(a.exporter('EXPORTER-mousse-net-enroll', 32))
    } finally { pair.cut() }
  })
  it('delivers data written immediately after open in both directions with backpressure', async () => {
    const { pair, channels: [a, b] } = await opened()
    try {
      const payload = Buffer.alloc(2 * 1024 * 1024, 0x65)
      const left = read(a.stream, 5), right = read(b.stream, payload.length)
      a.stream.write(payload)
      b.stream.write('hello')
      expect(await right).toEqual(payload)
      expect((await left).toString()).toBe('hello')
    } finally { pair.cut() }
  })
  it.each(['client', 'server'] as const)('rejects a wrong %s pin before exposing any application byte', async role => {
    const pair = memoryPair()
    let applicationBytes = 0
    const results = await Promise.allSettled([
      openSecureChannel(pair.a, { role: 'client', credentials: credentials[0], expectedPeerFingerprint: role === 'client' ? 'wrong' : fingerprint(credentials[1].publicKeySpki), deadlineMs: 500 })
        .then(channel => { channel.stream.on('data', chunk => { applicationBytes += chunk.length }); return channel }),
      openSecureChannel(pair.b, { role: 'server', credentials: credentials[1], expectedPeerFingerprint: role === 'server' ? 'wrong' : fingerprint(credentials[0].publicKeySpki), deadlineMs: 500 })
        .then(channel => { channel.stream.on('data', chunk => { applicationBytes += chunk.length }); return channel })
    ])
    expect(results[role === 'client' ? 0 : 1]).toMatchObject({ status: 'rejected', reason: { code: 'peer_key_mismatch' } })
    expect(applicationBytes).toBe(0)
    expect(pair.a.destroyed).toBe(true)
    expect(pair.b.destroyed).toBe(true)
  })
  it('does not release attacker data queued before a mismatched handshake', async () => {
    const pair = memoryPair()
    const attacker = tls.connect({ socket: pair.a, cert: credentials[0].cert, key: credentials[0].key, rejectUnauthorized: false, minVersion: 'TLSv1.3' })
    attacker.on('error', () => {})
    attacker.write('must never be accepted')
    await expect(openSecureChannel(pair.b, { role: 'server', credentials: credentials[1], expectedPeerFingerprint: 'wrong', deadlineMs: 500 })).rejects.toMatchObject({ code: 'peer_key_mismatch' })
    expect(pair.b.destroyed).toBe(true)
    attacker.destroy(); pair.cut()
  })
  it('rejects a client without a certificate', async () => {
    const pair = memoryPair()
    const client = tls.connect({ socket: pair.a, rejectUnauthorized: false, minVersion: 'TLSv1.3' })
    client.on('error', () => {})
    await expect(openSecureChannel(pair.b, { role: 'server', credentials: credentials[1], deadlineMs: 500 })).rejects.toMatchObject({ code: 'peer_key_mismatch' })
    client.destroy(); pair.cut()
  })
  it('times out a silent peer and aborts an in-flight handshake', async () => {
    const pair = memoryPair()
    await expect(openSecureChannel(pair.a, { role: 'client', credentials: credentials[0], deadlineMs: 20 })).rejects.toMatchObject({ code: 'deadline_exceeded' })
    const next = memoryPair(), controller = new AbortController()
    const opening = openSecureChannel(next.a, { role: 'client', credentials: credentials[0], deadlineMs: 1_000, signal: controller.signal })
    controller.abort('test cancellation')
    await expect(opening).rejects.toMatchObject({ code: 'cancelled', cause: 'test cancellation' })
    expect(next.a.destroyed).toBe(true)
  })
  it('maps a plaintext handshake failure and invalid TLS credentials into typed errors', async () => {
    const pair = memoryPair()
    const pending = openSecureChannel(pair.b, { role: 'server', credentials: credentials[1], deadlineMs: 500 })
    pair.a.write('HTTP/1.1 200 OK\r\n\r\n')
    await expect(pending).rejects.toBeInstanceOf(NetError)
    const next = memoryPair()
    await expect(openSecureChannel(next.a, { role: 'client', credentials: { cert: 'bad', key: 'bad' }, deadlineMs: 500 })).rejects.toMatchObject({ code: 'bad_request' })
    expect(next.a.destroyed).toBe(true)
  })
  it('honors cancellation that precedes creation', async () => {
    const pair = memoryPair(), controller = new AbortController()
    controller.abort()
    await expect(openSecureChannel(pair.a, { role: 'client', credentials: credentials[0], deadlineMs: 500, signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' })
    expect(pair.a.destroyed).toBe(true)
  })
})
