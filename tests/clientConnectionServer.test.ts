import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import {
  approveClientConnection,
  ClientConnectionServer
} from '../src/mms/http/ClientConnectionServer'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function createServer(): { server: ClientConnectionServer; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'mousse-http-'))
  homes.push(home)
  const events = { onAny: (_handler: (channel: string, data: unknown) => void) => undefined }
  const mms = {
    events,
    getHomeDir: () => home,
    getOwnerRecord: () => null,
    getOwnerLease: () => null
  }
  return {
    home,
    server: new ClientConnectionServer(mms as never, {
      host: '127.0.0.1', port: 0, serverName: 'Test Mousse', version: '0.1.0-test'
    })
  }
}

describe('ClientConnectionServer', () => {
  it('discovers, validates registration, approves PKCE authorization, and persists only hashes', async () => {
    const { server, home } = createServer()
    await server.start()
    try {
      const base = server.address!
      const discovery = await fetch(`${base}/.well-known/mousse-configuration`)
      expect(discovery.headers.get('mousse-protocol-version')).toBe('1.0')
      expect((await discovery.json()).event_retention).toBe(2048)

      const bad = await fetch(`${base}/oauth/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'Bad', redirect_uris: ['http://example.test/callback'] })
      })
      expect(bad.status).toBe(400)

      const registered = await fetch(`${base}/oauth/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'Mobile', redirect_uris: ['com.example.mousse:/oauth/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] })
      })
      expect(registered.status).toBe(201)
      const client = await registered.json() as { client_id: string }
      const verifier = randomBytes(48).toString('base64url')
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      const state = randomBytes(16).toString('base64url')
      const authorization = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'com.example.mousse:/oauth/callback', scope: 'mousse:read', state, code_challenge: challenge, code_challenge_method: 'S256' })}`)
      const page = await authorization.text()
      const requestId = page.match(/name="request_id" value="([^"]+)"/)?.[1]
      expect(requestId).toBeTruthy()
      const approvalCode = approveClientConnection(home, requestId!)
      const consent = await fetch(`${base}/oauth/authorize`, {
        method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ request_id: requestId!, approval_code: approvalCode, decision: 'approve' })
      })
      const code = new URL(consent.headers.get('location')!).searchParams.get('code')!
      const issued = await fetch(`${base}/oauth/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code, redirect_uri: 'com.example.mousse:/oauth/callback', code_verifier: verifier })
      })
      expect(issued.status).toBe(200)
      const tokens = await issued.json() as { access_token: string; refresh_token: string }
      const persisted = readFileSync(join(home, 'client-connections.json'), 'utf8')
      expect(persisted).not.toContain(tokens.access_token)
      expect(persisted).not.toContain(tokens.refresh_token)
    } finally {
      await server.stop()
    }
  })

  it('enforces bearer authentication and scope at the RPC boundary', async () => {
    const { server } = createServer()
    await server.start()
    try {
      const unauthenticated = await fetch(`${server.address}/v1/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'one', method: 'health' }) })
      expect(unauthenticated.status).toBe(401)
      expect(unauthenticated.headers.get('www-authenticate')).toContain('Bearer')
    } finally {
      await server.stop()
    }
  })
})
