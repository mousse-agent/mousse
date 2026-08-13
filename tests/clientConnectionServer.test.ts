import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  approveClientConnection,
  ClientConnectionServer,
  REMOTE_METHOD_POLICY,
  revokeClientConnection
} from '../src/mms/http/ClientConnectionServer'
import { dispatchMethod } from '../src/mms/protocol/handlers'

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

async function authorize(base: string, home: string, scope = 'mousse:read'): Promise<{ clientId: string; access: string }> {
  const registered = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: `Mobile-${Math.random()}`, redirect_uris: ['com.example.mousse:/oauth/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) })
  const client = await registered.json() as { client_id: string }
  const verifier = randomBytes(48).toString('base64url'); const challenge = createHash('sha256').update(verifier).digest('base64url'); const state = randomBytes(16).toString('base64url')
  const authorization = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'com.example.mousse:/oauth/callback', scope, state, code_challenge: challenge, code_challenge_method: 'S256' })}`)
  const requestId = (await authorization.text()).match(/name="request_id" value="([^"]+)"/)?.[1]!
  const approvalCode = approveClientConnection(home, requestId)
  const consent = await fetch(`${base}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ request_id: requestId, approval_code: approvalCode, decision: 'approve' }) })
  const code = new URL(consent.headers.get('location')!).searchParams.get('code')!
  const issued = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code, redirect_uri: 'com.example.mousse:/oauth/callback', code_verifier: verifier }) })
  expect(issued.status).toBe(200)
  return { clientId: client.client_id, access: (await issued.json() as { access_token: string }).access_token }
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

  it('uses a closed scope/idempotency policy and never classifies setModel as read-only', () => {
    expect(REMOTE_METHOD_POLICY['threads.setModel']).toEqual({ scope: 'mousse:write', mutation: true })
    expect(REMOTE_METHOD_POLICY['agents.spawn']).toEqual({ scope: 'mousse:write', mutation: true })
    expect(REMOTE_METHOD_POLICY['publish.start']).toEqual({ scope: 'mousse:write', mutation: true })
    expect(REMOTE_METHOD_POLICY['files.read']).toEqual({ scope: 'mousse:read', mutation: false })
  })

  it('requires idempotency for every classified mutation and synchronizes CLI revocation', async () => {
    const { server, home } = createServer(); await server.start()
    try {
      const { clientId, access } = await authorize(server.address!, home, 'mousse:write')
      const missing = await fetch(`${server.address}/v1/rpc`, { method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'set-model', method: 'threads.setModel', params: {} }) })
      expect(missing.status).toBe(200)
      expect((await missing.json() as { error: { message: string } }).error.message).toContain('Idempotency-Key')
      revokeClientConnection(home, clientId)
      const revoked = await fetch(`${server.address}/v1/rpc`, { method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'health', method: 'health' }) })
      expect(revoked.status).toBe(401)
    } finally { await server.stop() }
  })

  it('does not derive discovery metadata from Host and rate limits registration', async () => {
    const { server } = createServer(); await server.start()
    try {
      const discovered = await fetch(`${server.address}/.well-known/oauth-authorization-server`, { headers: { Host: 'attacker.example' } })
      expect((await discovered.json() as { issuer: string }).issuer).toBe(server.address)
      const body = JSON.stringify({ client_name: 'Limited', redirect_uris: ['com.example.mousse:/oauth/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] })
      const responses = await Promise.all(Array.from({ length: 11 }, () => fetch(`${server.address}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })))
      expect(responses.some((response) => response.status === 429)).toBe(true)
    } finally { await server.stop() }
  })

  it('routes file and git operations through daemon-owned contained project roots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-project-'))
    const calls: string[] = []
    const mms = {
      projects: { getProject: (id: string) => id === 'project' ? { id, path: root } : undefined },
      threads: { getThread: () => undefined, getThreadDir: () => root },
      fileService: { listDir: async (cwd: string) => { calls.push(cwd); return [] }, readFile: async () => 'ok', writeFile: async () => 1, stat: async () => ({}) },
      gitService: { getStatus: async (cwd: string) => { calls.push(cwd); return {} }, getDiff: async () => '', getLog: async () => [], getBranches: async () => ({}), checkout: async () => undefined, commit: async () => undefined, push: async () => undefined }
    }
    await expect(dispatchMethod({ mms: mms as never, globalSequence: () => 0 }, 'files.read', { projectId: 'project', path: '../escape' })).rejects.toThrow('outside the project root')
    await dispatchMethod({ mms: mms as never, globalSequence: () => 0 }, 'files.list', { projectId: 'project', path: '.' })
    await dispatchMethod({ mms: mms as never, globalSequence: () => 0 }, 'git.status', { projectId: 'project' })
    expect(calls).toEqual([root, root])
    rmSync(root, { recursive: true, force: true })
  })

  it('feeds SSE replay from daemon, orchestrator, question, and PTY producers', () => {
    let bus: ((channel: string, data: unknown) => void) | undefined
    const home = mkdtempSync(join(tmpdir(), 'mousse-events-')); homes.push(home)
    const orchestrator = new EventEmitter(); const questions = new EventEmitter(); const ptyManager = new EventEmitter(); const threadRuntimes = new EventEmitter()
    const mms = { getHomeDir: () => home, events: { onAny: (handler: typeof bus) => { bus = handler } }, orchestrator, questions, ptyManager, threadRuntimes }
    const server = new ClientConnectionServer(mms as never, { host: '127.0.0.1', port: 0, serverName: 'Events' })
    bus!('orchestrator:thread-message', { threadId: 'thread', message: { text: 'hello' } })
    orchestrator.emit('turn-started', { threadId: 'thread' }); questions.emit('pending', { requestId: 'q', threadId: 'thread' }); ptyManager.emit('data', { ptyId: 'p', threadId: 'thread', data: 'output', sequence: 1 }); threadRuntimes.emit('agents.updated', { threadId: 'thread', agents: [] })
    expect((server as any).ring.replayAfter(0).events.map((event: { type: string }) => event.type)).toEqual(['thread.message', 'turn.started', 'questions.pending', 'pty.data', 'agents.updated'])
  })
})
