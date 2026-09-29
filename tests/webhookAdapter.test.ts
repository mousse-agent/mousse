import { request } from 'http'
import { afterEach, describe, expect, it } from 'vitest'
import { WebhookAdapter } from '../src/mms/channels/adapters/WebhookAdapter'
import type { InboundChannelMessage } from '../src/mms/channels/types'

const SECRET = 'test-secret-value'
let adapter: WebhookAdapter | null = null

afterEach(async () => {
  await adapter?.disconnect()
  adapter = null
})

async function start(secret = SECRET) {
  const inbound: InboundChannelMessage[] = []
  adapter = new WebhookAdapter({ enabled: true, webhookPort: 0, webhookSecret: secret })
  adapter.setInboundHandler((m) => {
    inbound.push(m)
    void adapter!.send({ platform: 'webhook', chatId: m.chatId, text: 'pong' })
  })
  await adapter.connect()
  return { port: adapter.getListenPort()!, inbound }
}

function post(
  port: number,
  opts: { headers?: Record<string, string>; body?: string | Buffer; host?: string; path?: string }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = opts.body ?? '{"text":"ping"}'
    const headers: Record<string, string | number> = {
      'content-type': 'application/json',
      'x-mousse-secret': SECRET,
      'content-length': Buffer.byteLength(body),
      ...opts.headers
    }
    if (opts.host) headers.host = opts.host
    const req = request(
      { host: '127.0.0.1', port, method: 'POST', path: opts.path ?? '/channels/webhook', headers },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

describe('WebhookAdapter hardening', () => {
  it.each(['', '   '])('refuses to connect with secret %j', async (secret) => {
    adapter = new WebhookAdapter({ enabled: true, webhookPort: 0, webhookSecret: secret })
    await expect(adapter.connect()).rejects.toThrow('Webhook secret is required')
    expect(adapter.getStatus()).toMatchObject({ state: 'error', error: 'Webhook secret is required' })
    expect(adapter.getListenPort()).toBeNull()
  })

  it('accepts a valid request and dispatches it', async () => {
    const { port, inbound } = await start()
    const res = await post(port, { headers: { 'content-type': 'application/json; charset=utf-8' } })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ replies: ['pong'] })
    expect(inbound).toHaveLength(1)
    expect(inbound[0].text).toBe('ping')
  })

  it('accepts localhost Host for the bound port', async () => {
    const { port } = await start()
    const res = await post(port, { host: `localhost:${port}` })
    expect(res.status).toBe(200)
  })

  it('rejects wrong, missing, and different-length secrets with 401', async () => {
    const { port, inbound } = await start()
    expect((await post(port, { headers: { 'x-mousse-secret': 'wrong-secret-valueX' } })).status).toBe(401)
    expect((await post(port, { headers: { 'x-mousse-secret': 'x' } })).status).toBe(401)
    expect((await post(port, { headers: { 'x-mousse-secret': '' } })).status).toBe(401)
    expect(inbound).toHaveLength(0)
  })

  it('rejects non-JSON content types with 415', async () => {
    const { port, inbound } = await start()
    const res = await post(port, { headers: { 'content-type': 'text/plain' } })
    expect(res.status).toBe(415)
    expect(inbound).toHaveLength(0)
  })

  it('rejects browser-originated requests with 403', async () => {
    const { port, inbound } = await start()
    expect((await post(port, { headers: { origin: 'http://evil.example' } })).status).toBe(403)
    expect((await post(port, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect(inbound).toHaveLength(0)
  })

  it('rejects unexpected Host headers with 403', async () => {
    const { port, inbound } = await start()
    expect((await post(port, { host: `evil.example:${port}` })).status).toBe(403)
    expect((await post(port, { host: '127.0.0.1:1' })).status).toBe(403)
    expect(inbound).toHaveLength(0)
  })

  it('rejects oversized bodies with 413', async () => {
    const { port, inbound } = await start()
    const big = Buffer.alloc(1024 * 1024 + 1, 'a')
    const res = await post(port, { body: big }).catch((err: NodeJS.ErrnoException) => ({
      status: 413,
      body: err.code ?? ''
    }))
    expect(res.status).toBe(413)
    expect(inbound).toHaveLength(0)
  })
})
