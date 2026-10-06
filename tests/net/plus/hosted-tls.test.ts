import { it, expect } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Duplex } from 'node:stream'
import { HostedRelayTransport } from '../../../src/mms/net/plus/wire/client'
import { generateSigningKey, signBytes } from '../../../src/mms/net/identity/crypto'
import { newId } from '../../../src/shared/net/ids'
import { generateSelfSignedCert, fingerprint } from '../../../src/mms/net/link/selfSignedCert'
import { openSecureChannel } from '../../../src/mms/net/link/secureChannel'
import { createMux } from '../../../src/mms/net/link/mux'
/** Explicit local cross-repository gate; this test has no shipped checkout dependency. */
it.skipIf(!process.env.MOUSSE_PLUS_ROOT)(
  'carries parallel pinned TLS/exporter/fragmented mux through the actual hosted gateway and rejects a wrong pin',
  async () => {
    const { NetRelayGateway } = await import(
      pathToFileURL(resolve(process.env.MOUSSE_PLUS_ROOT!, 'packages/net-relay/dist/index.js')).href
    )
    const http = createServer()
    http.listen(0, '127.0.0.1')
    await once(http, 'listening')
    const audience = `ws://127.0.0.1:${(http.address() as { port: number }).port}/v1/net/relay`,
      admissions = new Map<string, any>(),
      frames: number[] = []
    const policy = {
      async admit({ auth }: any) {
        const admission = {
          id: randomUUID(),
          ...auth,
          expiresAt: Date.now() + 60000,
          principal: auth.node,
          policyRevision: 1
        }
        admissions.set(admission.id, admission)
        return admission
      },
      async pair({ listener, dialer }: any) {
        return { id: randomUUID(), expiresAt: Math.min(listener.expiresAt, dialer.expiresAt) }
      },
      async renew({ admissionId }: any) {
        return { ...admissions.get(admissionId), expiresAt: Date.now() + 60000 }
      },
      async renewCircuit({ circuitId, listener, dialer }: any) {
        return { id: circuitId, expiresAt: Math.min(listener.expiresAt, dialer.expiresAt) }
      },
      async charge({ bytes }: any) {
        frames.push(bytes)
      },
      async release() {}
    }
    const gateway = new NetRelayGateway({
      audience,
      installationId: 'local-installation',
      gatewayId: 'gateway-one',
      policy
    })
    gateway.attach(http)
    const transports: HostedRelayTransport[] = [],
      channels: Array<Awaited<ReturnType<typeof openSecureChannel>>> = [],
      muxes: Array<ReturnType<typeof createMux>> = []
    const identity = () => {
      const key = generateSigningKey()
      return {
        node: newId('node'),
        signKey: key.publicKey,
        sign: (bytes: Uint8Array) => signBytes(bytes, key.privateKey)
      }
    }
    const create = () => {
      const who = identity(),
        transport = new HostedRelayTransport({
          id: 'plus-relay',
          audience,
          identity: () => who,
          registration: () => ({ registrationId: randomUUID(), generation: 1 })
        })
      transports.push(transport)
      return transport
    }
    try {
      const listener = create(),
        clients = [create(), create()],
        serverCredentials = generateSelfSignedCert('hosted-server'),
        clientCredentials = generateSelfSignedCert('hosted-client')
      await Promise.all(transports.map((t) => t.provision()))
      const inbound: Array<Promise<Awaited<ReturnType<typeof openSecureChannel>>>> = []
      await listener.listen((raw: Duplex) => {
        const opening = openSecureChannel(raw, {
          role: 'server',
          credentials: serverCredentials,
          deadlineMs: 5000
        })
        void opening.catch(() => {})
        inbound.push(opening)
      })
      const opened = await Promise.all(
        clients.map(async (client) => {
          const raw = await client.dial(listener.status().routes[0], new AbortController().signal)
          return openSecureChannel(raw, {
            role: 'client',
            credentials: clientCredentials,
            expectedPeerFingerprint: fingerprint(serverCredentials.publicKeySpki),
            deadlineMs: 5000
          })
        })
      )
      const accepted = await Promise.all(inbound)
      channels.push(...opened, ...accepted)
      expect(accepted).toHaveLength(2)
      await Promise.all(
        opened.map(async (client, index) => {
          const server = accepted.find((peer) =>
            Buffer.from(peer.exporter('EXPORTER-mousse-net-enroll', 32)).equals(
              client.exporter('EXPORTER-mousse-net-enroll', 32)
            )
          )!
          expect(server).toBeDefined()
          expect(client.peerTransportKey).toBe(
            Buffer.from(serverCredentials.publicKeySpki).toString('base64url')
          )
          const a = createMux(client.stream),
            b = createMux(server.stream)
          muxes.push(a, b)
          const received = new Promise<Uint8Array>((done) =>
            b.onMessage((_lane, message) => {
              if (message.header.t === 'events') done(message.parts[0])
            })
          )
          const payload = new Uint8Array(65536).fill(index + 33),
            records = Array.from({ length: 14 }, (_, n) => ({
              epoch: 1,
              seq: n + 1,
              recvTs: Date.now()
            })),
            parts = records.flatMap(() => [payload, new Uint8Array(64)])
          await a.send('control', {
            header: {
              t: 'events',
              stream: newId('stream'),
              records,
              replay: false,
              parts: parts.map((part) => part.length)
            },
            parts
          })
          expect(Buffer.from(await received)).toEqual(Buffer.from(payload))
        })
      )
      expect(frames.length).toBeGreaterThan(20)
      expect(Math.max(...frames)).toBeLessThanOrEqual(65536)
      const wrong = create()
      await wrong.provision()
      const raw = await wrong.dial(listener.status().routes[0], new AbortController().signal)
      await expect(
        openSecureChannel(raw, {
          role: 'client',
          credentials: clientCredentials,
          expectedPeerFingerprint: fingerprint(generateSelfSignedCert('wrong').publicKeySpki),
          deadlineMs: 5000
        })
      ).rejects.toMatchObject({ code: 'peer_key_mismatch' })
    } finally {
      muxes.forEach((mux) => mux.close())
      channels.forEach((channel) => channel.close())
      await Promise.all(transports.map((t) => t.teardown()))
      await gateway.close()
      await new Promise<void>((done) => http.close(() => done()))
    }
  },
  20000
)
