import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import WebSocket from 'ws'
import type { Duplex } from 'node:stream'
import { RelayServer } from '../../../src/mms/net/relay/server'
import { RelayTransport } from '../../../src/mms/net/transports/relay'
import { generateSigningKey, signBytes, signedDocument } from '../../../src/mms/net/identity/crypto'
import { relayProofBytes, type RelayAuth } from '../../../src/mms/net/relay/protocol'
import { newId } from '../../../src/shared/net/ids'
import { generateSelfSignedCert, fingerprint } from '../../../src/mms/net/link/selfSignedCert'
import { openSecureChannel } from '../../../src/mms/net/link/secureChannel'
import { createMux } from '../../../src/mms/net/link/mux'
import { FakeClock } from '../harness/FakeClock'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
function identity() {
  const key = generateSigningKey()
  return {
    node: newId('node'),
    signKey: key.publicKey,
    sign: (bytes: Uint8Array) => signBytes(bytes, key.privateKey)
  }
}
async function setup(options: Partial<ConstructorParameters<typeof RelayServer>[0]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mousse-relay-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const a = identity(),
    b = identity(),
    databasePath = join(directory, 'relay.sqlite')
  const server = new RelayServer({ databasePath, allowNodes: [a, b], ...options })
  cleanup.push(() => server.close())
  await server.listen()
  const transport = (
    who = a,
    enrollment?: ConstructorParameters<typeof RelayTransport>[0]['enrollment']
  ) => {
    const value = new RelayTransport({
      settings: { address: server.address() },
      identity: () => who,
      enrollment,
      clock: options.clock
    })
    cleanup.push(() => value.teardown())
    return value
  }
  return { server, a, b, transport, databasePath }
}
describe('self-hosted relay raw transport', () => {
  it('pairs real sockets carrying pinned mutual TLS and preserves large mux control records', async () => {
    const p = await setup(),
      a = p.transport(p.a),
      b = p.transport(p.b)
    await a.provision()
    await b.provision()
    const credentialsA = generateSelfSignedCert('relay-a'),
      credentialsB = generateSelfSignedCert('relay-b')
    let resolve!: (value: Awaited<ReturnType<typeof openSecureChannel>>) => void,
      reject!: (error: unknown) => void
    const inbound = new Promise<Awaited<ReturnType<typeof openSecureChannel>>>((res, rej) => {
      resolve = res
      reject = rej
    })
    await b.listen((raw) => {
      void openSecureChannel(raw, {
        role: 'server',
        credentials: credentialsB,
        expectedPeerFingerprint: fingerprint(credentialsA.publicKeySpki),
        deadlineMs: 3000
      }).then(resolve, reject)
    })
    const raw = await a.dial(b.status().routes[0], new AbortController().signal)
    const [channelA, channelB] = await Promise.all([
      openSecureChannel(raw, {
        role: 'client',
        credentials: credentialsA,
        expectedPeerFingerprint: fingerprint(credentialsB.publicKeySpki),
        deadlineMs: 3000
      }),
      inbound
    ])
    const muxA = createMux(channelA.stream),
      muxB = createMux(channelB.stream)
    cleanup.push(async () => {
      muxA.close()
      muxB.close()
      channelA.close()
      channelB.close()
    })
    const received = new Promise<unknown>((res) =>
      muxB.onMessage((_lane, message) => res(message.header))
    )
    await muxA.send('control', { header: { t: 'ping', n: 77, now: 0 }, parts: [] })
    expect(await received).toEqual({ t: 'ping', n: 77, now: 0 })
    const records = Array.from({ length: 14 }, (_, index) => ({
      seq: index + 1,
      epoch: 1,
      recvTs: index
    }))
    const parts = records.flatMap(() => [new Uint8Array(65536).fill(127), new Uint8Array(64)])
    const large = new Promise<number>((res) =>
      muxB.onMessage((_lane, message) => {
        if (message.header.t === 'events') res(message.parts[26][65535])
      })
    )
    await muxA.send('control', {
      header: {
        t: 'events',
        stream: newId('stream'),
        records,
        replay: false,
        parts: parts.map((part) => part.length)
      },
      parts
    })
    expect(await large).toBe(127)
    expect(channelA.exporter('EXPORTER-mousse-net-enroll', 32)).toEqual(
      channelB.exporter('EXPORTER-mousse-net-enroll', 32)
    )
  })
  it('requires allow-listed signing keys and never lets relay admission replace inner pinning', async () => {
    const p = await setup(),
      unknown = p.transport(identity())
    await unknown.provision()
    await expect(unknown.listen((raw) => raw.destroy())).rejects.toMatchObject({
      code: 'forbidden'
    })
    const a = p.transport(p.a),
      b = p.transport(p.b)
    await a.provision()
    await b.provision()
    const wrong = generateSelfSignedCert('wrong-pin'),
      correct = generateSelfSignedCert('correct')
    await b.listen((raw) => {
      void openSecureChannel(raw, { role: 'server', credentials: correct, deadlineMs: 2000 }).catch(
        () => {}
      )
    })
    const raw = await a.dial(b.status().routes[0], new AbortController().signal)
    await expect(
      openSecureChannel(raw, {
        role: 'client',
        credentials: wrong,
        expectedPeerFingerprint: fingerprint(wrong.publicKeySpki),
        deadlineMs: 2000
      })
    ).rejects.toMatchObject({ code: 'peer_key_mismatch' })
  })
  it('persists principal connection quotas across relay restart', async () => {
    const p = await setup({ connectionsPerHour: 1 }),
      a = p.transport(p.a)
    await a.provision()
    await a.listen((raw) => raw.destroy())
    await a.teardown()
    await p.server.close()
    const restarted = new RelayServer({
      databasePath: p.databasePath,
      allowNodes: [p.a, p.b],
      connectionsPerHour: 1
    })
    cleanup.push(() => restarted.close())
    await restarted.listen()
    const denied = new RelayTransport({
      settings: { address: restarted.address() },
      identity: () => p.a
    })
    cleanup.push(() => denied.teardown())
    await denied.provision()
    await expect(denied.listen((raw) => raw.destroy())).rejects.toMatchObject({
      code: 'quota_exceeded'
    })
  })
  it('rejects a duplicate waiting listener before reporting successful readiness', async () => {
    const p = await setup(),
      first = p.transport(p.b),
      duplicate = p.transport(p.b)
    await first.provision()
    await duplicate.provision()
    await first.listen((raw) => raw.destroy())
    await expect(duplicate.listen((raw) => raw.destroy())).rejects.toMatchObject({
      code: 'conflict'
    })
  })
  it('does not accept a signature captured from another relay challenge', async () => {
    const p = await setup()
    async function capture() {
      const ws = new WebSocket(p.server.address())
      ws.on('error', () => {})
      const [data] = await once(ws, 'message')
      return { ws, nonce: JSON.parse(data.toString()).nonce as string }
    }
    const first = await capture(),
      second = await capture()
    const claims: Omit<RelayAuth, 'sig'> = {
      t: 'auth',
      v: 1,
      nonce: first.nonce,
      node: p.a.node,
      signKey: p.a.signKey,
      role: 'listen',
      target: p.a.node
    }
    second.ws.send(
      JSON.stringify({
        ...claims,
        sig: Buffer.from(p.a.sign(relayProofBytes(claims))).toString('base64url')
      })
    )
    const [data] = await once(second.ws, 'message')
    expect(JSON.parse(data.toString())).toEqual({ t: 'error', code: 'bad_request' })
    first.ws.terminate()
    second.ws.terminate()
  })
  it('accepts a current root-verified user delegation and rejects its revoked evidence', async () => {
    const root = generateSigningKey(),
      user = newId('user'),
      a = identity(),
      now = Date.now()
    const credential = generateSelfSignedCert('relay-user')
    const delegation = signedDocument(
      {
        v: 1,
        kind: 'node',
        subject: a.node,
        owner: user,
        name: 'A',
        keys: {
          sign: a.signKey,
          agree: generateSigningKey().publicKey,
          transport: Buffer.from(credential.publicKeySpki).toString('base64url')
        },
        caps: ['read'],
        keyEpoch: 1,
        issuedAt: now - 1,
        expiresAt: now + 60_000
      },
      (bytes) => signBytes(bytes, root.privateKey)
    )
    const rosterValue = {
      v: 1,
      owner: user,
      rootKey: root.publicKey,
      recoveryEpoch: 0,
      lineage: 'relay-test-lineage',
      version: 1,
      authorityNode: a.node,
      nodes: [delegation],
      bots: [],
      revoked: [],
      issuedAt: now - 1
    }
    const roster = signedDocument(rosterValue, (bytes) => signBytes(bytes, root.privateKey))
    const p = await setup({ allowNodes: [], allowUsers: [{ user, rootKey: root.publicKey }] })
    const accepted = p.transport({ ...a, delegation, roster })
    await accepted.provision()
    await accepted.listen((raw) => raw.destroy())
    await accepted.teardown()
    const revoked = signedDocument(
      {
        ...rosterValue,
        version: 2,
        revoked: [{ subject: a.node, throughKeyEpoch: 1, revokedAt: now }]
      },
      (bytes) => signBytes(bytes, root.privateKey)
    )
    const denied = p.transport({ ...a, delegation, roster: revoked })
    await denied.provision()
    await expect(denied.listen((raw) => raw.destroy())).rejects.toMatchObject({ code: 'forbidden' })
  })
  it('supports signed short-lived rendezvous for the same unlisted joiner retry, denying other keys', async () => {
    const p = await setup(),
      b = p.transport(p.b)
    await b.provision()
    let accept!: (raw: Duplex) => void
    const received = new Promise<Duplex>((resolve) => {
      accept = resolve
    })
    await b.listen((raw) => accept(raw))
    const rendezvous = await b.prepareEnrollmentRendezvous({ expiresAt: Date.now() + 60_000 })
    expect(b.status().routes[0].address).not.toContain(rendezvous.ticket)
    const joiner = identity(),
      a = p.transport(joiner, rendezvous)
    await a.provision()
    const raw = await a.dial(b.status().routes[0], new AbortController().signal)
    const incoming = await received
    const arrived = new Promise<Buffer>((resolve) => incoming.once('data', resolve))
    raw.write(Buffer.from('opaque-first'))
    expect((await arrived).toString()).toBe('opaque-first')
    raw.destroy()
    await once(raw, 'close')
    const retried = await a.dial(b.status().routes[0], new AbortController().signal)
    retried.destroy()
    const impostor = p.transport(identity(), rendezvous)
    await impostor.provision()
    await expect(
      impostor.dial(b.status().routes[0], new AbortController().signal)
    ).rejects.toMatchObject({ code: 'invite_invalid' })
  })
  it('rejects expired rendezvous', async () => {
    const clock = new FakeClock(),
      p = await setup({ clock }),
      b = p.transport(p.b)
    await b.provision()
    await b.listen((raw) => raw.destroy())
    const rendezvous = await b.prepareEnrollmentRendezvous({ expiresAt: clock.now() + 1000 })
    clock.advance(1001)
    const joiner = p.transport(identity(), rendezvous)
    await joiner.provision()
    await expect(
      joiner.dial(b.status().routes[0], new AbortController().signal)
    ).rejects.toMatchObject({ code: 'invite_invalid' })
  })
  it('fails closed when quota clock moves backward after restart', async () => {
    const clock = new FakeClock(),
      p = await setup({ clock }),
      b = p.transport(p.b)
    await b.provision()
    await b.listen((raw) => raw.destroy())
    await b.teardown()
    await p.server.close()
    clock.setWallTime(clock.now() - 1)
    const restarted = new RelayServer({
      databasePath: p.databasePath,
      clock,
      allowNodes: [p.a, p.b]
    })
    cleanup.push(() => restarted.close())
    await restarted.listen()
    const denied = new RelayTransport({
      settings: { address: restarted.address() },
      identity: () => p.a,
      clock
    })
    cleanup.push(() => denied.teardown())
    await denied.provision()
    await expect(denied.listen((raw) => raw.destroy())).rejects.toMatchObject({
      code: 'clock_skew'
    })
  })
  it('persists a bound same-key retry after invite expiry without extending the original issuer lease', async () => {
    const clock = new FakeClock(),
      root = generateSigningKey(),
      user = newId('user'),
      issuer = identity(),
      start = clock.now(),
      transportKey = generateSelfSignedCert('retry-issuer')
    const nodeClaims = {
      v: 1,
      kind: 'node',
      subject: issuer.node,
      owner: user,
      name: 'Issuer',
      keys: {
        sign: issuer.signKey,
        agree: generateSigningKey().publicKey,
        transport: Buffer.from(transportKey.publicKeySpki).toString('base64url')
      },
      caps: ['read'],
      keyEpoch: 1,
      issuedAt: start,
      expiresAt: start + 5000
    }
    const signRoot = (bytes: Uint8Array) => signBytes(bytes, root.privateKey)
    const delegation = signedDocument(nodeClaims, signRoot),
      rosterClaims = {
        v: 1,
        owner: user,
        rootKey: root.publicKey,
        recoveryEpoch: 0,
        lineage: 'retry-lineage',
        version: 1,
        authorityNode: issuer.node,
        nodes: [delegation],
        bots: [],
        revoked: [],
        issuedAt: start
      }
    let current = { ...issuer, delegation, roster: signedDocument(rosterClaims, signRoot) }
    const p = await setup({
      clock,
      allowNodes: [],
      allowUsers: [{ user, rootKey: root.publicKey }]
    })
    const host = p.transport(current)
    await host.provision()
    await host.listen((raw) => raw.destroy())
    await expect(
      host.prepareEnrollmentRendezvous({ expiresAt: start + 5001 })
    ).rejects.toMatchObject({ code: 'bad_request' })
    const bound = await host.prepareEnrollmentRendezvous({ expiresAt: start + 1000 }),
      untouched = await host.prepareEnrollmentRendezvous({ expiresAt: start + 1000 }),
      joiner = identity()
    const initial = p.transport(joiner, bound)
    await initial.provision()
    ;(await initial.dial(host.status().routes[0], new AbortController().signal)).destroy()
    const originalPort = Number(new URL(p.server.address()).port)
    await initial.teardown()
    await host.teardown()
    await p.server.close()
    clock.advance(1001)
    const restarted = new RelayServer({
      databasePath: p.databasePath,
      port: originalPort,
      clock,
      allowUsers: [{ user, rootKey: root.publicKey }]
    })
    cleanup.push(() => restarted.close())
    await restarted.listen()
    const renewedDelegation = signedDocument(
      { ...nodeClaims, issuedAt: clock.now(), expiresAt: start + 20_000 },
      signRoot
    )
    current = {
      ...issuer,
      delegation: renewedDelegation,
      roster: signedDocument(
        { ...rosterClaims, issuedAt: clock.now(), version: 2, nodes: [renewedDelegation] },
        signRoot
      )
    }
    const renewedHost = new RelayTransport({
      settings: { address: restarted.address() },
      identity: () => current,
      clock
    })
    cleanup.push(() => renewedHost.teardown())
    await renewedHost.provision()
    await renewedHost.listen((raw) => raw.destroy())
    const retry = new RelayTransport({
      settings: { address: restarted.address() },
      identity: () => joiner,
      enrollment: bound,
      clock
    })
    cleanup.push(() => retry.teardown())
    await retry.provision()
    const recovered = await retry.dial(renewedHost.status().routes[0], new AbortController().signal)
    recovered.destroy()
    const late = new RelayTransport({
      settings: { address: restarted.address() },
      identity: () => joiner,
      enrollment: untouched,
      clock
    })
    cleanup.push(() => late.teardown())
    await late.provision()
    await expect(
      late.dial(renewedHost.status().routes[0], new AbortController().signal)
    ).rejects.toMatchObject({ code: 'invite_invalid' })
    clock.setWallTime(start + 5000)
    await expect(
      retry.dial(renewedHost.status().routes[0], new AbortController().signal)
    ).rejects.toMatchObject({ code: 'invite_invalid' })
  })
  it('bounds an enrollment ticket to 64 identical-key connection attempts', async () => {
    const p = await setup(),
      b = p.transport(p.b)
    await b.provision()
    await b.listen((raw) => raw.destroy())
    const rendezvous = await b.prepareEnrollmentRendezvous({ expiresAt: Date.now() + 60_000 }),
      a = p.transport(identity(), rendezvous)
    await a.provision()
    for (let index = 0; index < 64; index++)
      (await a.dial(b.status().routes[0], new AbortController().signal)).destroy()
    await expect(a.dial(b.status().routes[0], new AbortController().signal)).rejects.toMatchObject({
      code: 'invite_invalid'
    })
  })
})
