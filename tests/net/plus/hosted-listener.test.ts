import { afterEach, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { HostedRelayTransport } from '../../../src/mms/net/plus/wire/client'
import { generateSigningKey, signBytes } from '../../../src/mms/net/identity/crypto'
import { newId } from '../../../src/shared/net/ids'

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

/** A hosted relay that admits every listener and ends its wait after `waitMs`, as the gateway's waiting deadline does. */
async function relay(waitMs: number) {
  const http = createServer()
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const audience = `ws://127.0.0.1:${(http.address() as { port: number }).port}/v1/net/relay`
  const wss = new WebSocketServer({ server: http })
  let listens = 0
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ t: 'challenge', v: 1, audience, nonce: randomBytes(32).toString('base64url') }))
    ws.once('message', () => {
      listens++
      ws.send(JSON.stringify({ t: 'ready', v: 1 }))
      setTimeout(() => {
        ws.send(JSON.stringify({ t: 'error', v: 1, code: 'deadline_exceeded' }))
        ws.close(1008)
      }, waitMs)
    })
  })
  cleanup.push(() => new Promise((resolve) => http.close(resolve)), () => wss.close())
  return { audience, listens: () => listens }
}

it('keeps the route while a listener nobody dialed listens again after the relay ends its wait', async () => {
  const server = await relay(50)
  const key = generateSigningKey()
  const who = { node: newId('node'), signKey: key.publicKey, sign: (bytes: Uint8Array) => signBytes(bytes, key.privateKey) }
  const transport = new HostedRelayTransport({
    id: 'plus-relay',
    audience: server.audience,
    identity: () => who,
    registration: () => ({ registrationId: 'registration', generation: 1 })
  })
  cleanup.push(() => transport.teardown())
  await transport.provision()
  await transport.listen(() => undefined)
  // The desktop closes its phones' direct paths whenever the listener reports no route.
  const states: string[] = []
  transport.onStatus((status) => states.push(`${status.state}:${status.routes.length}`))
  await new Promise((resolve) => setTimeout(resolve, 400))
  expect(server.listens()).toBeGreaterThanOrEqual(3)
  expect(states.filter((state) => state !== 'ready:1')).toEqual([])
})
